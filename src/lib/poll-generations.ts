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
  // (2026-07-23) 240초(4분)였는데 서버 라우트의 maxDuration이 280초라, 서버가 아직 작업 중인데
  // 클라이언트가 40초 먼저 포기해서 "시간이 오래 걸린다"는 에러가 뜨는 구조였다(실제 신고).
  // 포즈 여러 장(첫 컷을 기준 사진으로 쓰느라 순차 실행) + 클로즈업 고화질 + 검증 불합격 시
  // 1회 재생성까지 겹치면 4분을 넘기는 게 정상 범위다. 서버 한도(280초)보다 뒤에 끝나도록 맞춘다.
  const timeoutMs = opts.timeoutMs ?? 300000;
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
      throw new Error(
        '생성이 아직 진행 중입니다 — 화면 대기만 종료했을 뿐 서버에서는 계속 만들고 있습니다. 잠시 후 새로고침하면 히스토리에 결과가 나타납니다. (컷 수가 많거나 클로즈업 고화질일수록 오래 걸립니다)',
      );
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
