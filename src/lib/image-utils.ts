/**
 * image-utils.ts — OpenAI 이미지 API 비용/안정성 유틸 (2026-07-10)
 *
 * 비용 구조 (OpenAI images/vision 문서 기준):
 * - 출력 이미지: quality(low/medium/high)와 크기로 과금 — medium 1024x1536이 현재 기본.
 *   low는 medium의 약 1/4 비용이라 "코디/색상 확인용 초안"에 적합.
 * - 입력 이미지: 토큰으로 환산 과금(GPT Image는 짧은 변을 512px로 축소 후 타일 계산).
 *   그래도 원본 그대로 보내면 업로드 페이로드/지연이 커지고, Vercel 요청 한도에도 부담 —
 *   참고 이미지는 1024px를 넘길 이유가 없어 서버에서 일괄 다운스케일한다.
 * - 실패한 생성도 과금될 수 있으므로, 5장 병렬 호출로 레이트리밋(429)에 걸려 실패하는
 *   것 자체가 돈 낭비 — 동시성 제한 + 429 재시도로 성공률을 올리는 것이 곧 절약이다.
 */

import sharp from 'sharp';

const MAX_INPUT_DIMENSION = 1024;

/** 참고/입력 이미지를 최대 1024px로 다운스케일 — 이미 작으면 원본 그대로 반환 */
export async function downscaleImage(
  buffer: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  try {
    const meta = await sharp(buffer).metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    if (!width || !height || Math.max(width, height) <= MAX_INPUT_DIMENSION) {
      return { buffer, mimeType };
    }
    // PNG(누끼/투명 배경)는 PNG 유지, 나머지는 JPEG로 재인코딩해 용량 추가 절감
    const resized = sharp(buffer).resize(MAX_INPUT_DIMENSION, MAX_INPUT_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    });
    if (mimeType.includes('png')) {
      return { buffer: await resized.png({ compressionLevel: 9 }).toBuffer(), mimeType: 'image/png' };
    }
    return { buffer: await resized.jpeg({ quality: 88 }).toBuffer(), mimeType: 'image/jpeg' };
  } catch {
    // 다운스케일 실패는 치명적이지 않음 — 원본으로 진행
    return { buffer, mimeType };
  }
}

/**
 * OpenAI 이미지 생성 호출 재시도 래퍼 — 429(레이트리밋)/일시적 5xx에서 대기 후 재시도.
 * 색상 5종 병렬 생성 시 이미지 API 분당 한도에 걸려 일부만 성공하던 문제의 방어책.
 */
export async function withImageRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 8000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const status = error?.status ?? error?.response?.status;
    const msg = error?.message || '';
    const retryable =
      status === 429 || status === 500 || status === 502 || status === 503 ||
      msg.includes('429') || msg.includes('rate limit') || msg.includes('Rate limit');
    if (retries > 0 && retryable) {
      console.warn(`[image-retry] ${status ?? ''} ${msg.slice(0, 80)} — ${delayMs / 1000}초 후 재시도 (${retries}회 남음)`);
      await new Promise((r) => setTimeout(r, delayMs));
      return withImageRetry(fn, retries - 1, delayMs * 1.5);
    }
    throw error;
  }
}

/** 배열을 동시성 제한으로 순차 배치 처리 — 전체 병렬 대신 batchSize개씩 나눠 실행 */
export async function runWithConcurrency<T>(
  items: T[],
  batchSize: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.allSettled(items.slice(i, i + batchSize).map(worker));
  }
}
