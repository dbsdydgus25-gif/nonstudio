/**
 * gpt-image-2 images.edit 호출 공용 유틸.
 * (2026-07-29) product-fitting/route.ts의 runSingleProductFitting을 여기로 추출 —
 * AI 룩북(신규 섹션)의 "사람 없는 깨끗한 각도컷 생성"과 "포즈 프리셋 배치 피팅"도
 * 동일한 저수준 이미지 편집 호출이 필요해서, 두 라우트가 이 함수 하나를 공유한다.
 */
import OpenAI, { toFile } from 'openai';
import { downscaleImage, withImageRetry } from '@/lib/image-utils';

export function parseBase64Image(dataUrl: string): { buffer: Buffer; mimeType: string } {
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

export async function resultImageToBuffer(imageUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (imageUrl.startsWith('data:')) {
    return parseBase64Image(imageUrl);
  }
  const res = await fetch(imageUrl);
  const arrayBuffer = await res.arrayBuffer();
  const mimeType = res.headers.get('content-type') || 'image/png';
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}

export async function runGptImageEdit(
  openai: OpenAI,
  productImageBase64: string,
  prompt: string,
  identityReferenceImage: { buffer: Buffer; mimeType: string } | null,
  backgroundReferenceImage: { buffer: Buffer; mimeType: string } | null,
  quality: 'low' | 'medium' | 'high' = 'medium',
  /** 같은 제품의 다른 각도/디테일 참고 사진 — 색상 아님, 실루엣/디테일 교차 확인용 */
  otherProductImages: Array<{ buffer: Buffer; mimeType: string }> = [],
  /** 재질/텍스처 클로즈업 참고 사진 — 색상 아닌 원단/버튼/스티치 디테일 전용 */
  materialImages: Array<{ buffer: Buffer; mimeType: string }> = [],
  /** 소싱 제품이 아닌 슬롯(예: 상의) "이렇게 입혀줘" 참고 사진 — SLOT_ORDER(top,bottom,shoes,accessory)
   * 순서로 이미 정렬되어 들어온다. 호출부의 프롬프트 빌더가 계산한 이미지 개수와 순서가 반드시 일치해야 함. */
  styleReferenceImages: Array<{ buffer: Buffer; mimeType: string }> = [],
  /** 같은 색상의 이미 확정된 이전 포즈 컷 — 두 번째 포즈부터 구조 일관성 기준으로 함께 참고 */
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

  // 이미지 순서 [모델, 제품, 다른 각도, 재질, 배경] — gpt-image-2 edit는 첫 이미지를 편집 대상으로
  // 취급하는 경향이 있어, 모델 사진을 1번에 두면 모델(체형/피부/얼굴) 충실도가 크게 올라간다.
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
  if (!imageUrl) throw new Error('빈 이미지 응답 (gpt-image-2 edit)');
  return imageUrl;
}
