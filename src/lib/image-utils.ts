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

/**
 * 색상 샘플 시트에서 특정 색상 영역만 잘라낸다 — box는 [ymin, xmin, ymax, xmax] (0~1000 정규화,
 * Gemini 바운딩 박스 규격). 여러 벌이 한 장에 있으면 gpt-image-2가 "어느 옷인지" 섞어버리는
 * 문제가 있어, 생성 전에 해당 색상 한 벌만 크게 잘라 보낸다. 여백 5%를 둬서 소매/밑단이
 * 잘리지 않게 한다. 실패하면 원본 그대로 반환.
 */
export async function cropToBox(
  base64DataUrl: string,
  box: [number, number, number, number],
): Promise<string> {
  try {
    const [header, data] = base64DataUrl.startsWith('data:')
      ? base64DataUrl.split(',')
      : ['data:image/png;base64', base64DataUrl];
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/png';
    const buffer = Buffer.from(data, 'base64');
    const meta = await sharp(buffer).metadata();
    const W = meta.width || 0;
    const H = meta.height || 0;
    if (!W || !H) return base64DataUrl;

    const [ymin, xmin, ymax, xmax] = box;
    const pad = 0.05; // 5% 여백
    const left = Math.max(0, Math.round(((xmin / 1000) - pad) * W));
    const top = Math.max(0, Math.round(((ymin / 1000) - pad) * H));
    const right = Math.min(W, Math.round(((xmax / 1000) + pad) * W));
    const bottom = Math.min(H, Math.round(((ymax / 1000) + pad) * H));
    const width = right - left;
    const height = bottom - top;
    // 박스가 비정상적으로 작으면(오탐) 크롭하지 않는 게 안전
    if (width < W * 0.1 || height < H * 0.05) return base64DataUrl;

    const out = await sharp(buffer).extract({ left, top, width, height }).png().toBuffer();
    return `data:image/png;base64,${out.toString('base64')}`;
  } catch {
    return base64DataUrl;
  }
}

/**
 * 소스 이미지를 목표 화면비로 센터 크롭한다 (2026-07-22, 영상 생성용).
 *
 * 실측으로 확인한 문제: Veo는 입력 이미지의 비율을 따라가지 않고 **항상 자기 캔버스
 * (16:9 또는 9:16)에 검은 여백을 채워 넣는다.** 우리 파이프라인 결과물은 1024x1536(2:3)이라
 * 그대로 넣으면 aspectRatio '9:16' 지정 시 위아래에, 생략 시(16:9) 좌우에 검은 띠가 생겼다.
 * 그래서 영상에 보내기 전에 정확히 9:16으로 잘라서 여백이 생길 여지 자체를 없앤다.
 *
 * 세로 크롭이 필요한 경우엔 위쪽을 기준으로 자른다 — 전신 컷에서 머리가 잘리는 게
 * 발밑이 잘리는 것보다 훨씬 치명적이기 때문.
 */
export async function cropToAspectRatio(
  buffer: Buffer,
  mimeType: string,
  targetRatio: number, // width / height (9:16 = 0.5625)
): Promise<{ buffer: Buffer; mimeType: string }> {
  try {
    const meta = await sharp(buffer).metadata();
    const W = meta.width || 0;
    const H = meta.height || 0;
    if (!W || !H) return { buffer, mimeType };

    const currentRatio = W / H;
    // 이미 목표 비율이면(반올림 오차 범위) 건드리지 않는다
    if (Math.abs(currentRatio - targetRatio) < 0.01) return { buffer, mimeType };

    let cropW: number;
    let cropH: number;
    let left: number;
    let top: number;

    if (currentRatio > targetRatio) {
      // 원본이 더 넓다 → 높이는 그대로, 폭만 잘라낸다 (가로 중앙)
      cropH = H;
      cropW = Math.round(H * targetRatio);
      left = Math.round((W - cropW) / 2);
      top = 0;
    } else {
      // 원본이 더 길쭉하다 → 폭은 그대로, 높이를 잘라낸다 (위쪽 기준 = 머리 보존)
      cropW = W;
      cropH = Math.round(W / targetRatio);
      left = 0;
      top = 0;
    }

    const out = sharp(buffer).extract({ left, top, width: cropW, height: cropH });
    if (mimeType.includes('png')) {
      return { buffer: await out.png({ compressionLevel: 9 }).toBuffer(), mimeType: 'image/png' };
    }
    return { buffer: await out.jpeg({ quality: 92 }).toBuffer(), mimeType: 'image/jpeg' };
  } catch {
    // 크롭 실패는 치명적이지 않음 — 원본으로 진행 (검은 여백이 생길 뿐)
    return { buffer, mimeType };
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
