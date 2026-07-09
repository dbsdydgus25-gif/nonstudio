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
import { getIdentityReferenceImage } from '@/lib/identity-reference';

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
  referenceImages: Array<{ buffer: Buffer; mimeType: string }>,
): Promise<string> {
  const { buffer, mimeType } = parseBase64Image(productImageBase64);
  const productFile = await toOpenAIFile(buffer, mimeType, `product.${mimeType.split('/')[1] || 'jpg'}`);
  const refFiles = await Promise.all(
    referenceImages.map((ref, i) =>
      toOpenAIFile(ref.buffer, ref.mimeType, `reference-${i}.${ref.mimeType.split('/')[1] || 'jpg'}`),
    ),
  );
  const imageInput = refFiles.length > 0 ? [productFile, ...refFiles] : productFile;

  const res = await (openai.images as any).edit({
    model: 'gpt-image-2',
    image: imageInput,
    prompt: prompt.slice(0, 12000),
    n: 1,
    size: '1024x1536',
    quality: 'medium',
  });

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
    }: {
      /** 색상 옵션별 제품 이미지 (1장 이상) — 각 이미지마다 1장씩 생성된다 */
      productImagesBase64: string[];
      category: string;
      geminiApiKey: string;
      openaiApiKey: string;
      userAdditions?: string;
      userPreferenceHints?: StyleHintsBySlot;
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

    // 색상 옵션 이미지마다 pending 행을 만들어 id 배열을 즉시 반환한다.
    const jobs = await Promise.all(
      images.map(async (imageBase64, i) => ({
        generationId: await createPendingGeneration({
          pipeline: 'restyle',
          modeOrCategory: 'product',
          poseLabel: images.length > 1 ? `색상 옵션 ${i + 1}` : 'AI 제품 피팅 결과',
          prompt: '',
        }),
        imageBase64,
      })),
    );

    after(async () => {
      const openai = new OpenAI({ apiKey: openaiApiKey });
      const backgroundReferenceImage = getDefaultBackgroundReferenceImage();
      const identityReferenceImage = await getIdentityReferenceImage();
      const referenceImages = [identityReferenceImage, backgroundReferenceImage].filter(
        (r): r is { buffer: Buffer; mimeType: string } => !!r,
      );

      await Promise.allSettled(
        jobs.map(async ({ generationId, imageBase64 }) => {
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

            const stylingSuggestion = await generateStylingSuggestion(
              sourcedCategory,
              garmentAnalysis,
              '제품 단독 사진 (착용자 없음) — 모델 포즈는 자유로운 커머셜 스탠딩 포즈로 새로 생성됨',
              geminiApiKey,
              openaiApiKey,
              userPreferenceHints,
            );
            // 배경은 예외 없이 고정 흰색 스튜디오 (요구사항)
            stylingSuggestion.background = DEFAULT_STUDIO_BACKGROUND;

            const prompt = buildProductFittingPrompt(
              sourcedCategory,
              garmentAnalysis,
              stylingSuggestion,
              userAdditions || '',
              !!backgroundReferenceImage,
              !!identityReferenceImage,
            );

            const imageUrl = await runSingleProductFitting(openai, imageBase64, prompt, referenceImages);
            const { buffer: outBuf, mimeType: outMime } = await resultImageToBuffer(imageUrl);
            await markGenerationCompleted(generationId, { outputBuffer: outBuf, outputMimeType: outMime, prompt });
          } catch (err: any) {
            console.error('[api/product-fitting][after] 생성 실패:', err);
            await markGenerationFailed(generationId, err?.message || 'AI 제품 피팅 처리 중 오류가 발생했습니다.');
          }
        }),
      );
    });

    return NextResponse.json({
      success: true,
      jobs: jobs.map(({ generationId }, i) => ({
        generationId,
        label: images.length > 1 ? `색상 옵션 ${i + 1}` : 'AI 제품 피팅 결과',
      })),
    });
  } catch (err: any) {
    console.error('[api/product-fitting] 처리 실패:', err);
    return NextResponse.json(
      { success: false, error: err.message || 'AI 제품 피팅 처리 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
