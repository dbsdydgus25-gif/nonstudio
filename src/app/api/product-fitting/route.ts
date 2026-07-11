/**
 * /api/product-fitting/route.ts
 * "AI 제품 피팅" (신규, 2026-07-09) — 소싱 단계에서 샘플을 직접 못 입어볼 때,
 * 제품 단독 이미지(누끼/행거/카탈로그 컷)만으로 윤용현 모델(저장된 모델 정보 + 아이덴티티
 * 참고 사진)이 그 제품을 실제로 입은 룩북 화보를 생성한다.
 * - 색상 옵션 이미지를 여러 장 넣으면 색상별로 병렬 생성 (각 생성마다 해당 색상 이미지가 기준)
 * - 나머지 슬롯(하의/신발 등)과 자세는 프롬프트로 지시 가능, 배경은 흰색 스튜디오 고정
 * - AI 피팅과 동일한 비동기 패턴: pending 행 생성 → 즉시 id 반환 → after()에서 실제 생성 → 폴링
 */

import { NextResponse } from 'next/server';
import { after } from 'next/server';
import OpenAI, { toFile } from 'openai';
import { analyzeGarment, generateStylingSuggestion, type StyleHintsBySlot } from '@/lib/garment-agent';
import { buildProductFittingPrompt, DEFAULT_STUDIO_BACKGROUND, type SourcedCategory } from '@/lib/fitting-prompts';
import { createPendingGeneration, markGenerationCompleted, markGenerationFailed } from '@/lib/generation-store';
import { getDefaultBackgroundReferenceImage } from '@/lib/background-reference';
import { getModelProfile, getModelIdentityImage, buildBodySpecFromProfile } from '@/lib/model-profile';
import { downscaleImage, withImageRetry, runWithConcurrency, cropToBox } from '@/lib/image-utils';

export const runtime = 'nodejs';
export const maxDuration = 280;

function parseBase64Image(dataUrl: string): { buffer: Buffer; mimeType: string } {
  if (dataUrl.startsWith('data:')) {
    const [header, data] = dataUrl.split(',');
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
    return { buffer: Buffer.from(data, 'base64'), mimeType };
  }
  return { buffer: Buffer.from(dataUrl, 'base64'), mimeType: 'image/jpeg' };
}

async function toOpenAIFile(buffer: Buffer, mimeType: string, name: string) {
  return await toFile(buffer, name, { type: mimeType });
}

async function resultImageToBuffer(imageUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (imageUrl.startsWith('data:')) {
    return parseBase64Image(imageUrl);
  }
  const res = await fetch(imageUrl);
  const arrayBuffer = await res.arrayBuffer();
  const mimeType = res.headers.get('content-type') || 'image/png';
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}

async function runSingleProductFitting(
  openai: OpenAI,
  productImageBase64: string,
  prompt: string,
  identityReferenceImage: { buffer: Buffer; mimeType: string } | null,
  backgroundReferenceImage: { buffer: Buffer; mimeType: string } | null,
  quality: 'low' | 'medium' = 'medium',
): Promise<string> {
  // 입력 이미지는 1024px로 다운스케일 — 업로드 페이로드/입력 토큰 절감 (출력 품질과 무관)
  const parsed = parseBase64Image(productImageBase64);
  const { buffer, mimeType } = await downscaleImage(parsed.buffer, parsed.mimeType);
  const productFile = await toOpenAIFile(buffer, mimeType, `product.${mimeType.split('/')[1] || 'jpg'}`);
  // (2026-07-09) 이미지 순서를 [모델, 제품, 배경]으로 변경 — gpt-image-2 edit는 첫 이미지를
  // 편집 대상으로 취급하는 경향이 있어, 모델 사진을 1번에 두면 "이 사람에게 제품을 입힌다"는
  // 자연스러운 편집이 되어 모델(체형/피부/얼굴) 충실도가 크게 올라간다. 프롬프트의 이미지
  // 번호(buildProductFittingPrompt)와 반드시 함께 맞춰져 있어야 함.
  const refs = [identityReferenceImage, backgroundReferenceImage].filter(
    (r): r is { buffer: Buffer; mimeType: string } => !!r,
  );
  const refFiles = await Promise.all(
    refs.map((ref, i) =>
      toOpenAIFile(ref.buffer, ref.mimeType, `reference-${i}.${ref.mimeType.split('/')[1] || 'jpg'}`),
    ),
  );
  const imageInput = identityReferenceImage
    ? [refFiles[0], productFile, ...refFiles.slice(1)] // [모델, 제품, 배경]
    : [productFile, ...refFiles]; // 모델 사진 없으면 기존 순서

  // 429(분당 이미지 한도)/일시적 5xx는 대기 후 재시도 — 색상 5종 병렬 생성 시 일부만
  // 성공하고 나머지가 조용히 실패하던 문제("결과가 하나만 나옴")의 방어책.
  const res: any = await withImageRetry(() =>
    (openai.images as any).edit({
      model: 'gpt-image-2',
      image: imageInput,
      prompt: prompt.slice(0, 12000),
      n: 1,
      size: '1024x1536',
      // 초안 모드(low)는 medium 대비 약 1/4 비용 — 코디/색상 확인용
      quality,
    }),
  );

  const item = res?.data?.[0];
  const imageUrl = item?.url || (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
  if (!imageUrl) throw new Error('빈 이미지 응답 (gpt-image-2 product fitting)');
  return imageUrl;
}

export async function POST(req: Request) {
  try {
    const {
      productImagesBase64,
      category,
      geminiApiKey,
      openaiApiKey,
      userAdditions,
      userPreferenceHints,
      extractColors,
      colorPlans,
      productNotes,
      draftMode,
    }: {
      /** 색상 옵션별 제품 이미지 (1장 이상) — 각 이미지마다 1장씩 생성된다 */
      productImagesBase64: string[];
      category: string;
      geminiApiKey: string;
      openaiApiKey: string;
      userAdditions?: string;
      userPreferenceHints?: StyleHintsBySlot;
      /** 제품 핏/디테일 지시 (예: '머슬핏, 크롭 기장감') — 사진만으로 안 보이는 정보 보강 */
      productNotes?: string;
      /** true면 초안 품질(low)로 생성 — medium 대비 약 1/4 비용 */
      draftMode?: boolean;
      /** true면 첫 이미지(색상 샘플 시트)에서 색상 옵션을 자동 추출해 색상별로 생성 */
      extractColors?: boolean;
      /**
       * 색상 추출 미리보기(extract-colors)를 거쳐 사용자가 확정한 색상별 계획.
       * 있으면 서버 추출을 건너뛰고 이대로 생성 — styleHints는 색상별 코디 덮어쓰기
       * (비어 있는 슬롯은 공통 userPreferenceHints를 그대로 사용).
       */
      colorPlans?: Array<{
        label: string;
        color: string;
        styleHints?: StyleHintsBySlot;
        /** 시트 안 해당 색상 위치 (0~1000 정규화, 추출 시 획득) — 있으면 그 영역만 잘라서 생성 */
        box?: [number, number, number, number];
      }>;
    } = await req.json();

    if (!productImagesBase64?.length) {
      return NextResponse.json({ success: false, error: '제품 이미지를 등록해주세요.' }, { status: 400 });
    }
    const validCategories: string[] = ['top', 'bottom', 'shoes', 'accessory'];
    if (!validCategories.includes(category)) {
      return NextResponse.json({ success: false, error: '제품 카테고리를 선택해주세요.' }, { status: 400 });
    }
    if (!geminiApiKey || !openaiApiKey) {
      return NextResponse.json({ success: false, error: 'Gemini/OpenAI API 키가 필요합니다.' }, { status: 400 });
    }

    const sourcedCategory = category as SourcedCategory;
    const images = productImagesBase64.slice(0, 6); // 색상 옵션 과다 등록 방지

    // 생성 단위(job) 구성 — 세 가지 모드:
    // (a) 기본: 업로드한 이미지 1장당 1개 생성 (공통 코디 지시 적용)
    // (b) colorPlans: 색상 추출 미리보기를 거쳐 사용자가 색상별 코디까지 확정한 계획 —
    //     색상마다 코디가 다를 수 있으므로 styleHints를 색상별로 덮어쓴다
    // (c) extractColors(레거시/직접 API 호출): 서버에서 즉석 추출해 색상별 생성
    // 색상 시트 모드에서는 해당 색상 영역만 잘라서 보낸다 — 여러 벌이 한 장에 있으면
    // gpt-image-2가 "어느 옷인지" 섞어버려 제품 재현이 깨지던 문제의 근본 대응.
    let jobPlans: Array<{ imageBase64: string; label: string; colorVariant?: string; styleHints?: StyleHintsBySlot }>;
    if (colorPlans?.length) {
      jobPlans = await Promise.all(
        colorPlans.slice(0, 6).map(async (plan) => ({
          imageBase64: plan.box ? await cropToBox(images[0], plan.box) : images[0],
          label: plan.label,
          colorVariant: plan.color,
          styleHints: plan.styleHints,
        })),
      );
    } else if (extractColors) {
      const { extractColorVariants } = await import('@/lib/garment-agent');
      const colors = await extractColorVariants(images[0], geminiApiKey, openaiApiKey);
      jobPlans = await Promise.all(
        colors.map(async (c) => ({
          imageBase64: c.box ? await cropToBox(images[0], c.box) : images[0],
          label: c.label,
          colorVariant: c.color,
        })),
      );
    } else {
      jobPlans = images.map((imageBase64, i) => ({
        imageBase64,
        label: images.length > 1 ? `색상 옵션 ${i + 1}` : 'AI 제품 피팅 결과',
      }));
    }

    // job마다 pending 행을 만들어 id 배열을 즉시 반환한다.
    const jobs = await Promise.all(
      jobPlans.map(async (plan) => ({
        generationId: await createPendingGeneration({
          pipeline: 'restyle',
          modeOrCategory: 'product',
          poseLabel: plan.label,
          prompt: '',
        }),
        ...plan,
      })),
    );

    after(async () => {
      const openai = new OpenAI({ apiKey: openaiApiKey });
      // 참고 이미지도 다운스케일 — job마다 반복 업로드되므로 절감 효과가 색상 수만큼 곱해진다
      const rawBackground = getDefaultBackgroundReferenceImage();
      const backgroundReferenceImage = rawBackground
        ? await downscaleImage(rawBackground.buffer, rawBackground.mimeType)
        : null;
      // 모델 정보(참고 이미지 + 체형 스펙)는 "모델 정보" 페이지에서 편집하는 프로필에서 로드
      const modelProfile = await getModelProfile();
      const rawIdentity = await getModelIdentityImage();
      const identityReferenceImage = rawIdentity ? await downscaleImage(rawIdentity.buffer, rawIdentity.mimeType) : null;
      const bodySpec = buildBodySpecFromProfile(modelProfile);

      // 전체 병렬 대신 3개씩 배치 실행 — OpenAI 이미지 분당 한도(429)로 일부 색상만
      // 성공하던 문제 방지. 실패한 호출도 과금될 수 있어 성공률이 곧 비용 절감이다.
      await runWithConcurrency(jobs, 3, async ({ generationId, imageBase64, colorVariant, styleHints }) => {
          try {
            // 색상 옵션마다 색/디테일이 다르므로 이미지별로 개별 분석한다
            const garmentAnalysis = await analyzeGarment(
              [imageBase64],
              geminiApiKey,
              undefined,
              undefined,
              sourcedCategory,
              openaiApiKey,
            );

            // 색상마다 어울리는 코디가 다를 수 있음 — 색상별 지시(styleHints)가 있는 슬롯은
            // 공통 지시(userPreferenceHints)를 덮어쓰고, 비어 있는 슬롯은 공통을 그대로 쓴다.
            const mergedHints: StyleHintsBySlot = { ...userPreferenceHints };
            for (const [slot, hint] of Object.entries(styleHints || {})) {
              if (typeof hint === 'string' && hint.trim()) mergedHints[slot as keyof StyleHintsBySlot] = hint.trim();
            }

            // 색상 시트 모드에서는 분석 결과의 color가 여러 색을 뭉뚱그려 설명함 —
            // 코디 자동 제안과 프롬프트 스펙이 "이번에 생성할 색상" 기준으로 잡히도록 교체한다.
            const analysisForThisColor = colorVariant ? { ...garmentAnalysis, color: colorVariant } : garmentAnalysis;

            const stylingSuggestion = await generateStylingSuggestion(
              sourcedCategory,
              analysisForThisColor,
              '제품 단독 사진 (착용자 없음) — 모델 포즈는 자유로운 커머셜 스탠딩 포즈로 새로 생성됨',
              geminiApiKey,
              openaiApiKey,
              mergedHints,
            );
            // 배경은 예외 없이 고정 흰색 스튜디오 (요구사항)
            stylingSuggestion.background = DEFAULT_STUDIO_BACKGROUND;

            const prompt = buildProductFittingPrompt(
              sourcedCategory,
              analysisForThisColor,
              stylingSuggestion,
              userAdditions || '',
              !!backgroundReferenceImage,
              !!identityReferenceImage,
              bodySpec,
              colorVariant,
              productNotes,
              mergedHints,
            );

            const imageUrl = await runSingleProductFitting(
              openai,
              imageBase64,
              prompt,
              identityReferenceImage,
              backgroundReferenceImage,
              draftMode ? 'low' : 'medium',
            );
            const { buffer: outBuf, mimeType: outMime } = await resultImageToBuffer(imageUrl);
            await markGenerationCompleted(generationId, { outputBuffer: outBuf, outputMimeType: outMime, prompt });
          } catch (err: any) {
            console.error('[api/product-fitting][after] 생성 실패:', err);
            await markGenerationFailed(generationId, err?.message || 'AI 제품 피팅 처리 중 오류가 발생했습니다.');
          }
      });
    });

    return NextResponse.json({
      success: true,
      jobs: jobs.map(({ generationId, label }) => ({ generationId, label })),
    });
  } catch (err: any) {
    console.error('[api/product-fitting] 처리 실패:', err);
    return NextResponse.json(
      { success: false, error: err.message || 'AI 제품 피팅 처리 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
