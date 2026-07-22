/**
 * poll-generations.ts
 * 비동기 생성 아키텍처의 프론트엔드 폴링 헬퍼 — /api/restyle, /api/variation이 즉시 반환한
 * generationId(들)을 이 함수로 폴링해서 pending → completed/failed 전환을 감지한다.
 */

export interface PolledGenerationStatus {
  id: string;
  status: 'pending' | 'completed' | 'failed';
  imageUrl: string | null;
  prompt: string;
  poseLabel: string | null;
  errorMessage: string | null;
}

/**
 * 완료(성공/실패 모두)될 때까지 주기적으로 상태를 조회하며 매 tick마다 onUpdate로 현재 스냅샷을 알려준다.
 * 전부 completed/failed가 되면 그 최종 배열을 반환한다.
 */
/** 사용자가 "중단"을 눌렀을 때 폴링 루프를 빠져나오기 위해 던지는 에러 */
export class GenerationCanceledError extends Error {
  constructor() {
    super('사용자가 중단했습니다.');
    this.name = 'GenerationCanceledError';
  }
}

export async function pollGenerationStatuses(
  ids: string[],
  onUpdate: (items: PolledGenerationStatus[]) => void,
  opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<PolledGenerationStatus[]> {
  const intervalMs = opts.intervalMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 240000; // 4분 — gpt-image-2 90~100초 + 여유
  const startedAt = Date.now();
  const signal = opts.signal;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // (2026-07-22) 중단 요청이 들어오면 즉시 루프를 빠져나온다 — 대기 중에 눌러도 바로
    // 반응하도록 아래 sleep에서도 한 번 더 확인한다.
    if (signal?.aborted) throw new GenerationCanceledError();
    const res = await fetch(`/api/generations/status?ids=${ids.join(',')}`);
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || '상태 조회 중 오류가 발생했습니다.');
    }
    const items: PolledGenerationStatus[] = data.items;
    onUpdate(items);

    const allSettled = items.length > 0 && items.every((i) => i.status === 'completed' || i.status === 'failed');
    if (allSettled) return items;

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('생성 시간이 너무 오래 걸리고 있습니다. 잠시 후 히스토리 화면에서 결과를 확인해주세요.');
    }

    // 대기 도중에 중단을 누르면 다음 폴링을 기다리지 않고 바로 빠져나온다.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, intervalMs);
      function onAbort() {
        clearTimeout(timer);
        reject(new GenerationCanceledError());
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
