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
import { analyzeGarment, generateStylingSuggestion, verifyGarmentRender, type StyleHintsBySlot } from '@/lib/garment-agent';
import { buildProductFittingPrompt, buildDefectCorrectionBlock, DEFAULT_STUDIO_BACKGROUND, pickRandomPoses, type SourcedCategory } from '@/lib/fitting-prompts';
import {
  createPendingGeneration,
  markGenerationCompleted,
  markGenerationFailed,
  isGenerationCanceled,
} from '@/lib/generation-store';
import { getDefaultBackgroundReferenceImage } from '@/lib/background-reference';
import { getModelProfile, getModelIdentityImage, buildBodySpecFromProfile } from '@/lib/model-profile';
import { getSessionUserId } from '@/lib/auth';
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
  quality: 'low' | 'medium' | 'high' = 'medium',
  /** (2026-07-14) 같은 제품의 다른 각도/디테일 참고 사진 — 색상 아님, 실루엣/디테일 교차 확인용 */
  otherProductImages: Array<{ buffer: Buffer; mimeType: string }> = [],
  /** (2026-07-14) 재질/텍스처 클로즈업 참고 사진 — 색상 아닌 원단/버튼/스티치 디테일 전용 */
  materialImages: Array<{ buffer: Buffer; mimeType: string }> = [],
  /** (2026-07-17) 소싱 제품이 아닌 슬롯(예: 상의) "이렇게 입혀줘" 참고 사진 — SLOT_ORDER(top,bottom,shoes,accessory)
   * 순서로 이미 정렬되어 들어온다. buildProductFittingPrompt의 styleReferenceImageCountsBySlot과 순서가 반드시 일치해야 함. */
  styleReferenceImages: Array<{ buffer: Buffer; mimeType: string }> = [],
  /** (2026-07-17) 같은 색상의 이미 확정된 이전 포즈 컷 — 두 번째 포즈부터 구조 일관성 기준으로 함께 참고 */
  poseAnchorImage: { buffer: Buffer; mimeType: string } | null = null,
): Promise<string> {
  // 입력 이미지는 1024px로 다운스케일 — 업로드 페이로드/입력 토큰 절감 (출력 품질과 무관)
  const parsed = parseBase64Image(productImageBase64);
  const { buffer, mimeType } = await downscaleImage(parsed.buffer, parsed.mimeType);
  const productFile = await toOpenAIFile(buffer, mimeType, `product.${mimeType.split('/')[1] || 'jpg'}`);

  const otherProductFiles = await Promise.all(
    otherProductImages.map((img, i) =>
      toOpenAIFile(img.buffer, img.mimeType, `product-angle-${i}.${img.mimeType.split('/')[1] || 'jpg'}`),
    ),
  );
  const materialFiles = await Promise.all(
    materialImages.map((img, i) =>
      toOpenAIFile(img.buffer, img.mimeType, `material-${i}.${img.mimeType.split('/')[1] || 'jpg'}`),
    ),
  );
  const styleReferenceFiles = await Promise.all(
    styleReferenceImages.map((img, i) =>
      toOpenAIFile(img.buffer, img.mimeType, `style-ref-${i}.${img.mimeType.split('/')[1] || 'jpg'}`),
    ),
  );
  const poseAnchorFile = poseAnchorImage
    ? await toOpenAIFile(poseAnchorImage.buffer, poseAnchorImage.mimeType, 'pose-anchor.jpg')
    : null;

  // (2026-07-09) 이미지 순서를 [모델, 제품, 배경]으로 변경 — gpt-image-2 edit는 첫 이미지를
  // 편집 대상으로 취급하는 경향이 있어, 모델 사진을 1번에 두면 "이 사람에게 제품을 입힌다"는
  // 자연스러운 편집이 되어 모델(체형/피부/얼굴) 충실도가 크게 올라간다.
  // (2026-07-14) 순서를 [모델, 제품, 다른 각도, 재질, 배경]으로 확장 — buildProductFittingPrompt의
  // 이미지 번호 계산(extraProductImageCount, materialImageCount)과 반드시 함께 맞춰져 있어야 함.
  // identity/background는 호출부에서 이미 다운스케일된 상태로 전달됨(job마다 재사용, 중복 계산 방지).
  const backgroundFile = backgroundReferenceImage
    ? await toOpenAIFile(backgroundReferenceImage.buffer, backgroundReferenceImage.mimeType, 'background.jpg')
    : null;
  const identityFile = identityReferenceImage
    ? await toOpenAIFile(identityReferenceImage.buffer, identityReferenceImage.mimeType, 'identity.jpg')
    : null;

  const imageInput = [
    ...(identityFile ? [identityFile] : []),
    productFile,
    ...otherProductFiles,
    ...materialFiles,
    ...styleReferenceFiles,
    ...(poseAnchorFile ? [poseAnchorFile] : []),
    ...(backgroundFile ? [backgroundFile] : []),
  ];

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
      materialImagesBase64,
      infoImagesBase64,
      category,
      geminiApiKey,
      openaiApiKey,
      userAdditions,
      userPreferenceHints,
      extractColors,
      colorPlans,
      productNotes,
      selectedSize,
      colorOverride,
      productText,
      draftMode,
      poseCount,
      customPoseTexts,
      styleReferenceImagesBySlot,
      framing,
    }: {
      /** 제품 사진 — extractColors/colorPlans 없으면 전부 "같은 제품의 다른 각도" 참고 사진으로 함께 쓰인다 */
      productImagesBase64: string[];
      /** (2026-07-14) 재질/텍스처 클로즈업 참고 사진 — 색상 아닌 원단/버튼/스티치 디테일 전용, 별도 슬롯 */
      materialImagesBase64?: string[];
      /** (2026-07-23) 분석 전용 이미지(사이즈표/스와치/텍스트 카드) — 소재/사이즈 텍스트를 읽는
       * 데만 쓰고 생성기(gpt-image-2)엔 절대 안 넣는다. 링크 임포터가 역할 판별해 따로 준다. */
      infoImagesBase64?: string[];
      category: string;
      geminiApiKey: string;
      openaiApiKey: string;
      userAdditions?: string;
      userPreferenceHints?: StyleHintsBySlot;
      /** 제품 핏/디테일 지시 (예: '머슬핏, 크롭 기장감') — 사진만으로 안 보이는 정보 보강 */
      productNotes?: string;
      /** (2026-07-19) 사용자가 선택한 사이즈 — 라벨 + 있으면 실측치. 실측은 핏 참고로만 반영. */
      selectedSize?: { label: string; measurements?: string };
      /** (2026-07-21) 링크로 가져온 판매 컬러웨이 중 참고 사진과 다른 색을 선택했을 때의 override
       * (예: 사진은 BROWN인데 "NAVY" 선택) — 실제 판매 색상 중 의도적 선택이라 색상 규칙의 유일한 예외. */
      colorOverride?: string;
      /** (2026-07-21) 링크 상세페이지에서 뽑은 제품명·특징 텍스트 — analyzeGarment의 rawSpecs로 넘겨
       * "머슬핏/크롭/골지" 같은 핏·재질 특징이 분석과 프롬프트에 반영되게 한다. */
      productText?: string;
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
      /** (2026-07-17) 색상(또는 기본 1건)당 뽑을 포즈 컷 수 — 1~4, 기본 1. AI 바리에이션과 달리
       * 재질/코디 분석 정보가 이미 다 있는 상태로 포즈만 바꿔 여러 장 생성한다. */
      poseCount?: number;
      /** 컷별 자세 지시(비우면 그 컷은 프리셋 포즈 중 랜덤) — poseCount>1일 때만 의미 있음 */
      customPoseTexts?: string[];
      /** (2026-07-17) 소싱 제품이 아닌 슬롯(예: 상의)을 말로 설명하기 어려울 때 첨부하는
       * "이렇게 입혀줘" 참고 사진 — 슬롯당 최대 3장 */
      styleReferenceImagesBySlot?: Partial<Record<SourcedCategory, string[]>>;
      /** (2026-07-23) 카메라 프레이밍 — 기본 전신('full'), 'close'면 상반신 위주 클로즈업 디테일샷 */
      framing?: 'full' | 'close';
    } = await req.json();

    if (!productImagesBase64?.length) {
      return NextResponse.json({ success: false, error: '제품 이미지를 등록해주세요.' }, { status: 400 });
    }
    const validCategories: string[] = ['top', 'bottom', 'outer', 'shoes', 'accessory'];
    if (!validCategories.includes(category)) {
      return NextResponse.json({ success: false, error: '제품 카테고리를 선택해주세요.' }, { status: 400 });
    }
    if (!geminiApiKey || !openaiApiKey) {
      return NextResponse.json({ success: false, error: 'Gemini/OpenAI API 키가 필요합니다.' }, { status: 400 });
    }

    const sourcedCategory = category as SourcedCategory;
    const resolvedFraming: 'full' | 'close' = framing === 'close' ? 'close' : 'full';
    // (2026-07-23) 클로즈업은 뭉개지면 안 되므로 low로는 안 내려간다(초안 모드여도 medium 유지).
    // 처음엔 high로 올렸다가 "너무 오래 걸린다"는 신고를 받고 medium으로 되돌렸다 — 애초에
    // 타이트 크롭 자체가 원단에 픽셀을 훨씬 많이 배분해서 medium이라도 전신 대비 질감이 크게
    // 살아나고, high는 시간을 크게 늘리는 대비 이득이 작았다(무엇보다 검증 오탐 재생성과 겹쳐
    // 타임아웃을 유발했다). 최고 화질이 정말 필요하면 나중에 별도 토글로 뺀다.
    const resolvedQuality: 'low' | 'medium' | 'high' =
      resolvedFraming === 'close' ? 'medium' : draftMode ? 'low' : 'medium';

    // (2026-07-19) 선택 사이즈를 productNotes에 접붙여 기존 "치수→여유분 추론" 로직(productNotesLine)을
    // 그대로 재사용한다. 실측치가 있으면 그 숫자를 근거로, 없으면 라벨만 참고로 넘어간다.
    const effectiveProductNotes = [
      productNotes?.trim(),
      selectedSize?.label
        ? `착용 사이즈: ${selectedSize.label}${selectedSize.measurements ? ` (실측 ${selectedSize.measurements})` : ''}`
        : '',
    ]
      .filter(Boolean)
      .join(' / ');
    const images = productImagesBase64.slice(0, 6); // 색상 옵션 과다 등록 방지

    // 로그인 계정의 모델 정보를 쓰기 위해 uid를 응답 전에 확보한다 (after() 안에서는 쿠키 접근 불가).
    const uid = await getSessionUserId();
    if (!uid) {
      return NextResponse.json({ success: false, error: '로그인이 필요합니다.' }, { status: 401 });
    }

    // 생성 단위(job) 구성 — 세 가지 모드:
    // (a) 기본: 업로드한 이미지 1장당 1개 생성 (공통 코디 지시 적용)
    // (b) colorPlans: 색상 추출 미리보기를 거쳐 사용자가 색상별 코디까지 확정한 계획 —
    //     색상마다 코디가 다를 수 있으므로 styleHints를 색상별로 덮어쓴다
    // (c) extractColors(레거시/직접 API 호출): 서버에서 즉석 추출해 색상별 생성
    // 색상 시트 모드에서는 해당 색상 영역만 잘라서 보낸다 — 여러 벌이 한 장에 있으면
    // gpt-image-2가 "어느 옷인지" 섞어버려 제품 재현이 깨지던 문제의 근본 대응.
    let jobPlans: Array<{ imageBase64: string; label: string; colorVariant?: string; styleHints?: StyleHintsBySlot; otherAngles?: string[] }>;
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
      // (2026-07-14) 이전엔 이미지가 2장 이상이면 각각 별도 "색상 옵션 N"으로 쪼개 색상이
      // 아닌데도 별개 생성이 되어버리는 문제가 있었음 — extractColors/colorPlans를 쓰지 않는 한
      // 여러 장은 전부 "같은 제품의 다른 각도/디테일" 참고 사진으로 취급해 단일 생성에 함께 쓴다.
      jobPlans = [
        {
          imageBase64: images[0],
          label: 'AI 제품 피팅 결과',
          otherAngles: images.slice(1),
        },
      ];
    }

    // (2026-07-17) 색상(job)당 뽑을 포즈 컷 수 — AI 바리에이션과 달리 재질/코디 분석 정보가
    // 이미 있는 상태에서 포즈만 바꿔 여러 장을 만든다(바리에이션은 그 정보가 없어 handoff 후
    // 디테일이 흐려지는 문제가 있었음). 1장뿐이면 기존 동작과 완전히 동일하다.
    const resolvedPoseCount = Math.min(4, Math.max(1, Number(poseCount) || 1));
    const customPoseTextsArr: string[] = Array.isArray(customPoseTexts)
      ? customPoseTexts.slice(0, resolvedPoseCount).map((t) => (typeof t === 'string' ? t.trim() : ''))
      : [];
    function resolvePoseTextsForOneColor(): string[] {
      if (resolvedPoseCount <= 1) return [customPoseTextsArr[0] || userAdditions?.trim() || ''];
      const emptySlotCount = Array.from({ length: resolvedPoseCount }, (_, i) => customPoseTextsArr[i] || '').filter(
        (t) => !t,
      ).length;
      const randomPicks = pickRandomPoses(emptySlotCount);
      let cursor = 0;
      return Array.from({ length: resolvedPoseCount }, (_, i) => {
        const custom = customPoseTextsArr[i];
        if (custom) return custom;
        const picked = randomPicks[cursor];
        cursor += 1;
        return picked.pose.poseInstruction;
      });
    }

    // job마다(색상×포즈 조합마다) pending 행을 만들어 id 배열을 즉시 반환한다.
    // planIdx로 같은 색상에서 나온 포즈 컷들을 묶어, after()에서 분석(재질/코디)은 색상당
    // 한 번만 하고 이미지 생성만 포즈 수만큼 반복한다 — 안 그러면 Gemini 분석 호출이
    // 포즈 수만큼 불필요하게 곱연산되어 비용이 새어나간다.
    const jobs = (
      await Promise.all(
        jobPlans.map(async (plan, planIdx) => {
          const poseTexts = resolvePoseTextsForOneColor();
          return Promise.all(
            poseTexts.map(async (poseInstruction, poseIdx) => {
              const unitLabel = resolvedPoseCount > 1 ? `${plan.label} · 포즈 ${poseIdx + 1}` : plan.label;
              return {
                generationId: await createPendingGeneration({
                  pipeline: 'restyle',
                  modeOrCategory: 'product',
                  poseLabel: unitLabel,
                  prompt: '',
                }),
                ...plan,
                label: unitLabel,
                planIdx,
                poseInstruction,
              };
            }),
          );
        }),
      )
    ).flat();

    after(async () => {
      // (2026-07-23) 이 함수 전체가 maxDuration(280초) 안에서 끝나야 한다 — 넘기면 런타임이
      // 통째로 죽어서 아직 pending인 컷들이 영영 pending으로 남고, 사용자에겐 "시간이 오래
      // 걸린다"만 보인다. 검증 불합격 시의 교정 재생성은 이미지 생성을 한 번 더 하는 거라
      // 가장 큰 변동 요인이므로, 남은 시간이 부족하면 재생성을 건너뛰고 첫 결과를 저장한다
      // (완벽하진 않아도 저장된 결과가 아무것도 없는 것보다 낫다).
      const routeStartedAt = Date.now();
      const RETRY_DEADLINE_MS = 175_000; // 이 시점을 넘겼으면 교정 재생성(≈60~120초)은 포기
      const hasTimeForCorrectionRetry = () => Date.now() - routeStartedAt < RETRY_DEADLINE_MS;

      const openai = new OpenAI({ apiKey: openaiApiKey });
      // 참고 이미지도 다운스케일 — job마다 반복 업로드되므로 절감 효과가 색상 수만큼 곱해진다
      const rawBackground = getDefaultBackgroundReferenceImage();
      const backgroundReferenceImage = rawBackground
        ? await downscaleImage(rawBackground.buffer, rawBackground.mimeType)
        : null;
      // 모델 정보(참고 이미지 + 체형 스펙)는 "모델 정보" 페이지에서 편집하는 프로필에서 로드
      const modelProfile = await getModelProfile(uid);
      const rawIdentity = await getModelIdentityImage(uid);
      const identityReferenceImage = rawIdentity ? await downscaleImage(rawIdentity.buffer, rawIdentity.mimeType) : null;
      const bodySpec = buildBodySpecFromProfile(modelProfile);

      // (2026-07-19) 전신 컷에서는 재질 참고 사진을 생성기(gpt-image-2)에 이미지로 넣지 않는다 —
      // 제품 이미지가 색/디자인/기장/실루엣의 유일한 주(主) 기준이고, 재질 참고는 "원단/질감을
      // 분석해 설명(텍스트)으로 얹는" 보조 역할이다. 재질 클로즈업을 생성기에 직접 넣으면
      // 확대된 짜임이 옷 전체의 패턴으로, 다른 조명의 색이 색상으로 오염돼 색·패턴이 틀어졌다.
      //
      // (2026-07-23) 단, 클로즈업 프레이밍에서는 정반대다 — 화면 대부분을 원단이 채우므로
      // 텍스트 설명("smooth cotton knit")만으로는 실제 짜임을 절대 재현 못 하고, 실제로
      // "재질이 아예 다르게 나온다"는 신고가 있었다. 위 부작용(확대 짜임이 전체 패턴이 됨)은
      // 애초에 전신 컷에서 스케일이 안 맞아 생긴 것이라, 크롭 배율이 실제로 비슷한 클로즈업에선
      // 해당되지 않는다. 그래서 클로즈업일 때만 재질 사진을 생성기에 함께 넣는다.
      const materialImagesDownscaled =
        resolvedFraming === 'close' && materialImagesBase64?.length
          ? await Promise.all(
              materialImagesBase64.slice(0, 3).map(async (b64) => {
                const parsed = parseBase64Image(b64);
                return downscaleImage(parsed.buffer, parsed.mimeType);
              }),
            )
          : [];

      // (2026-07-17) 소싱 제품이 아닌 슬롯(예: 상의) "이렇게 입혀줘" 참고 사진 — 슬롯당 최대
      // 3장, 색상/포즈와 무관하게 공통이라 한 번만 다운스케일한다. SLOT_ORDER 고정 순서로
      // buildProductFittingPrompt의 번호 배정과 반드시 같은 순서를 유지해야 한다.
      const SLOT_ORDER: SourcedCategory[] = ['top', 'bottom', 'shoes', 'accessory'];
      const styleReferenceCountsBySlot: Partial<Record<SourcedCategory, number>> = {};
      const styleReferenceImagesFlat: Array<{ buffer: Buffer; mimeType: string }> = [];
      for (const slot of SLOT_ORDER) {
        const imgs = (styleReferenceImagesBySlot?.[slot] || []).slice(0, 3);
        if (imgs.length === 0) continue;
        styleReferenceCountsBySlot[slot] = imgs.length;
        const downs = await Promise.all(
          imgs.map(async (b64) => {
            const parsed = parseBase64Image(b64);
            return downscaleImage(parsed.buffer, parsed.mimeType);
          }),
        );
        styleReferenceImagesFlat.push(...downs);
      }

      // planIdx로 묶어서, 색상당 분석(재질/코디)은 한 번만 수행하고 그 결과를 포즈 컷마다 재사용한다.
      const jobsByPlan = new Map<number, typeof jobs>();
      for (const job of jobs) {
        const arr = jobsByPlan.get(job.planIdx) || [];
        arr.push(job);
        jobsByPlan.set(job.planIdx, arr);
      }

      // 색상(플랜) 단위는 2개씩, 그 안에서 포즈 컷도 2개씩 병렬 — 이전(3개 동시)과 비슷한
      // 총 동시 호출 수를 유지하면서 429로 인한 재시도(=비용 낭비)를 방지한다.
      await runWithConcurrency(Array.from(jobsByPlan.values()), 2, async (unitsForThisPlan) => {
        const first = unitsForThisPlan[0];
        try {
          // 색상 옵션마다 색/디테일이 다르므로 이미지별로 개별 분석한다 — 같은 제품의 다른
          // 각도(otherAngles)는 색상/핏 분석에 함께 쓰고, 재질 사진은 텍스처 전용으로 분리한다.
          const garmentAnalysis = await analyzeGarment(
            [first.imageBase64, ...(first.otherAngles || [])],
            geminiApiKey,
            undefined,
            productText?.trim() || undefined, // rawSpecs — 링크 상세페이지의 핏/재질 특징 텍스트
            sourcedCategory,
            openaiApiKey,
            // 재질 참고 + info(사이즈표/텍스트 카드)를 분석에 함께 넘긴다 — analyzeGarment는
            // 이 이미지들을 "소재/질감/텍스트를 읽는 용도"로만 쓰고 색/실루엣엔 반영하지 않으므로,
            // 텍스트 카드가 섞여도 안전하다. 생성기엔 여기 이미지들이 절대 안 들어간다.
            (() => {
              const forAnalysis = [...(materialImagesBase64 || []), ...(infoImagesBase64 || [])];
              return forAnalysis.length ? forAnalysis.slice(0, 6) : undefined;
            })(),
          );

          // (2026-07-23) 분석이 실패(Gemini 한도 초과 등)하면 여기서 즉시 멈춘다.
          // 예전엔 analysisFailed를 이 경로에서 아무도 안 봤다 — 그래서 색/재질/구조 지도가
          // 전부 일반 폴백값("as shown in image", constructionMap 없음)인 채로 그대로 생성돼
          // "한참 잘 되다가 갑자기 재질이 뭉개지고 옷이 이상하게 나오는" 증상이 났고,
          // 사용자는 원인을 알 수 없었다(생성 후 자동 검증도 constructionMap이 없으면 건너뜀).
          // 이 상태로 계속 진행해봐야 결과물은 못 쓰고 이미지 생성 비용만 나가므로,
          // 비싼 생성에 들어가기 전에 이유를 명확히 알리고 중단하는 편이 낫다.
          if (garmentAnalysis.analysisFailed) {
            throw new Error(
              '제품 분석에 실패해 생성을 중단했습니다 (Gemini 사용량 한도 초과 가능성이 가장 큽니다). ' +
                '이대로 진행하면 재질·색상·구조가 반영되지 않은 결과가 나오고 비용만 발생해서 미리 멈췄습니다. ' +
                '잠시 후 다시 시도하거나 API 설정에서 Gemini 키 사용량을 확인해주세요.',
            );
          }

          // 색상마다 어울리는 코디가 다를 수 있음 — 색상별 지시(styleHints)가 있는 슬롯은
          // 공통 지시(userPreferenceHints)를 덮어쓰고, 비어 있는 슬롯은 공통을 그대로 쓴다.
          const mergedHints: StyleHintsBySlot = { ...userPreferenceHints };
          for (const [slot, hint] of Object.entries(first.styleHints || {})) {
            if (typeof hint === 'string' && hint.trim()) mergedHints[slot as keyof StyleHintsBySlot] = hint.trim();
          }

          // 색상 시트 모드에서는 분석 결과의 color가 여러 색을 뭉뚱그려 설명함 —
          // 코디 자동 제안과 프롬프트 스펙이 "이번에 생성할 색상" 기준으로 잡히도록 교체한다.
          const analysisForThisColor = first.colorVariant ? { ...garmentAnalysis, color: first.colorVariant } : garmentAnalysis;

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

          // (2026-07-23) 생성기에 넣는 "다른 각도" 참고 컷은 최대 2장으로 제한한다 — 분석(analyzeGarment)은
          // first.otherAngles를 전부 읽지만, gpt-image-2에 참고 이미지를 6~8장씩 밀어넣으면
          // 서로 다른 컷을 뒤섞어 "완전히 다른 옷"이 나오는 게 실측 확인됐다(대표님 신고). 생성 정확도는
          // 깨끗한 대표컷 1장 + 보조 1~2장일 때 가장 높다.
          const otherAngleImagesDownscaled = await Promise.all(
            (first.otherAngles || []).slice(0, 2).map(async (b64) => {
              const parsed = parseBase64Image(b64);
              return downscaleImage(parsed.buffer, parsed.mimeType);
            }),
          );

          // 분석/코디는 이 색상에서 한 번만 계산했고, 여기서부터는 포즈 컷마다 프롬프트의
          // 포즈 지시만 바꿔서 이미지 생성만 반복한다.
          // (2026-07-17) gpt-image-2는 seed가 없어 같은 텍스트 스펙을 줘도 포즈마다 절개선/
          // 포켓/패치 위치를 조금씩 다르게 그리는 문제가 실제로 재현됨 — AI 바리에이션처럼
          // "이미 확정된 사진"을 기준 삼아야 일관되므로, 첫 포즈를 먼저 만들고 그 결과물을
          // 나머지 포즈들의 추가 참고 이미지(poseAnchorImage)로 재사용한다.
          const generateOneUnit = async (
            unit: (typeof unitsForThisPlan)[number],
            poseAnchorImage: { buffer: Buffer; mimeType: string } | null,
          ): Promise<{ buffer: Buffer; mimeType: string } | null> => {
            const { generationId, imageBase64, colorVariant, poseInstruction } = unit;
            try {
              // (2026-07-22) 사용자가 중단했으면 이 컷은 생성하지 않는다 — 색상×포즈로 건수가
              // 많은 파이프라인이라 여기서 걸러지는 양이 곧 절약되는 비용이다.
              if (await isGenerationCanceled(generationId)) return null;
              // (2026-07-17) 기준 사진(poseAnchorImage)이 있으면 그 사진 자체가 이미 검증된
              // "완성본"이라 재질/각도/스타일 참고 사진들은 중복 정보다 — 오히려 한 번에 너무
              // 많은 이미지(제품4+재질4+스타일참고+기준+배경 10장 이상)를 넣으면 gpt-image-2가
              // 헷갈려서 재질/구조를 뭉개는 문제가 실제로 재현됨. 기준 사진이 있을 땐 원본
              // 참고 사진들을 비우고 [모델, 제품 대표컷, 기준사진, 배경]만 남겨 집중시킨다.
              const otherAngleForThisCall = poseAnchorImage ? [] : otherAngleImagesDownscaled;
              // 재질 참고 이미지 — 전신 컷에선 빈 배열(위 주석 참고), 클로즈업에선 원단 재현의
              // 핵심 근거라 함께 넣는다. 기준 사진이 있을 땐 그쪽이 이미 확정본이라 생략.
              const materialForThisCall = poseAnchorImage ? [] : materialImagesDownscaled;
              const styleRefForThisCall = poseAnchorImage ? [] : styleReferenceImagesFlat;
              const styleRefCountsForThisCall = poseAnchorImage ? {} : styleReferenceCountsBySlot;

              const prompt = buildProductFittingPrompt(
                sourcedCategory,
                analysisForThisColor,
                stylingSuggestion,
                poseInstruction || '',
                !!backgroundReferenceImage,
                !!identityReferenceImage,
                bodySpec,
                colorVariant,
                effectiveProductNotes,
                mergedHints,
                otherAngleForThisCall.length,
                materialForThisCall.length,
                styleRefCountsForThisCall,
                !!poseAnchorImage,
                colorOverride?.trim() || '',
                resolvedFraming,
              );

              const imageUrl = await runSingleProductFitting(
                openai,
                imageBase64,
                prompt,
                identityReferenceImage,
                backgroundReferenceImage,
                resolvedQuality,
                otherAngleForThisCall,
                materialForThisCall,
                styleRefForThisCall,
                poseAnchorImage,
              );
              let { buffer: outBuf, mimeType: outMime } = await resultImageToBuffer(imageUrl);
              let finalPrompt = prompt;

              // (2026-07-19) 생성 후 자동 검증 — 비대칭 디테일(한쪽 다리 패치가 양쪽에 복제 등)과
              // 좌우 턴 방향 무시는 프롬프트 지시만으로 못 막는 게 반복 확인됨. Gemini가 생성
              // 결과를 구조맵·참고사진과 대조해 불합격이면, 발견된 결함을 교정 지시로 프롬프트
              // 맨 앞에 붙여 딱 1회 재생성한다. (검증은 Flash라 저렴, 재생성은 불합격시에만)
              if (analysisForThisColor.constructionMap) {
                // 스타일링 기대값(사용자 원문 우선) — 색/종류 무시(베이지 샌들→검정 등)를 검증에서 잡는다.
                const VERIFY_SLOT_LABELS: Record<string, string> = { top: '상의', bottom: '하의', shoes: '신발', accessory: '액세서리' };
                const styleChecklist = (['top', 'bottom', 'shoes', 'accessory'] as const)
                  .filter((s) => s !== sourcedCategory)
                  .map((slot) => {
                    const raw = mergedHints[slot as keyof StyleHintsBySlot]?.trim();
                    const gen = stylingSuggestion[slot as keyof typeof stylingSuggestion];
                    const text = raw || (typeof gen === 'string' ? gen : '');
                    return text ? { label: VERIFY_SLOT_LABELS[slot], text } : null;
                  })
                  .filter((x): x is { label: string; text: string } => !!x);

                const verdict = await verifyGarmentRender(
                  `data:${outMime};base64,${outBuf.toString('base64')}`,
                  analysisForThisColor.constructionMap,
                  analysisForThisColor,
                  poseInstruction || '',
                  geminiApiKey,
                  [imageBase64, ...(first.otherAngles || [])],
                  styleChecklist,
                  effectiveProductNotes,
                  resolvedFraming,
                );
                if (!verdict.pass && verdict.defects.length > 0 && !hasTimeForCorrectionRetry()) {
                  // 남은 시간이 부족하면 재생성을 포기하고 첫 결과를 그대로 저장한다 —
                  // 여기서 무리하면 런타임이 죽어 이 컷 자체가 pending으로 방치된다.
                  console.warn(
                    '[api/product-fitting][after] 검증 불합격이지만 시간이 부족해 교정 재생성을 건너뜁니다:',
                    verdict.defects,
                  );
                } else if (!verdict.pass && verdict.defects.length > 0) {
                  console.warn('[api/product-fitting][after] 자동 검증 불합격 — 교정 재생성 1회 시도:', verdict.defects);
                  try {
                    const retryPrompt = `${buildDefectCorrectionBlock(verdict.defects)}\n\n${prompt}`;
                    const retryUrl = await runSingleProductFitting(
                      openai,
                      imageBase64,
                      retryPrompt,
                      identityReferenceImage,
                      backgroundReferenceImage,
                      resolvedQuality,
                      otherAngleForThisCall,
                      materialForThisCall,
                      styleRefForThisCall,
                      poseAnchorImage,
                    );
                    ({ buffer: outBuf, mimeType: outMime } = await resultImageToBuffer(retryUrl));
                    finalPrompt = retryPrompt;
                  } catch (retryErr) {
                    // 재생성 실패 시 원본 결과를 그대로 쓴다 — 검증 루프가 생성 자체를 망치면 안 됨
                    console.error('[api/product-fitting][after] 교정 재생성 실패 — 원본 결과 사용:', retryErr);
                  }
                }
              }

              await markGenerationCompleted(generationId, { outputBuffer: outBuf, outputMimeType: outMime, prompt: finalPrompt });
              // 다음 포즈들의 기준 사진으로 재사용할 수 있도록 다운스케일해서 반환
              return downscaleImage(outBuf, outMime);
            } catch (err: any) {
              console.error('[api/product-fitting][after] 포즈 생성 실패:', err);
              await markGenerationFailed(generationId, err?.message || 'AI 제품 피팅 처리 중 오류가 발생했습니다.');
              return null;
            }
          };

          if (unitsForThisPlan.length <= 1) {
            if (unitsForThisPlan[0]) await generateOneUnit(unitsForThisPlan[0], null);
          } else {
            const [firstUnit, ...restUnits] = unitsForThisPlan;
            const anchorImage = await generateOneUnit(firstUnit, null);
            await runWithConcurrency(restUnits, 2, async (unit) => {
              await generateOneUnit(unit, anchorImage);
            });
          }
        } catch (err: any) {
          // 분석 자체가 실패하면 이 색상의 모든 포즈 컷을 실패 처리한다.
          console.error('[api/product-fitting][after] 분석 실패:', err);
          for (const unit of unitsForThisPlan) {
            await markGenerationFailed(unit.generationId, err?.message || 'AI 제품 피팅 분석 중 오류가 발생했습니다.');
          }
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
