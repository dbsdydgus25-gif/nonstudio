'use client';

/**
 * use-cancelable-run.ts (2026-07-22)
 * "생성 중 중단" 공용 훅 — AI 피팅 / 제품 피팅 / 바리에이션 / 영상이 전부 같은 비동기 구조
 * (pending id 발급 → 폴링)라서, 중단 로직도 한 곳에 모아 재사용한다.
 *
 * 중단 시 하는 일:
 *  1) 서버에 취소 표시 → 아직 시작 안 한 건은 API 호출 자체를 건너뛰어 비용이 절약된다
 *  2) AbortSignal로 폴링을 즉시 중단 → 화면이 붙잡히지 않는다
 *
 * 정직한 한계: 이미 OpenAI/Veo로 날아간 요청은 되돌릴 수 없고 그 건은 과금된다.
 * (이 점은 UI 문구로도 사용자에게 알린다.)
 */

import { useCallback, useRef, useState } from 'react';

export function useCancelableRun() {
  const abortRef = useRef<AbortController | null>(null);
  const idsRef = useRef<string[]>([]);
  const [isCanceling, setIsCanceling] = useState(false);
  /** 중단 직후 사용자에게 보여줄 안내 — "왜 몇 장은 그래도 나오는지"를 설명한다 */
  const [cancelNote, setCancelNote] = useState<string | null>(null);

  /** 실행 시작 시 호출 — 새 AbortController를 만들고 signal을 돌려준다 */
  const begin = useCallback(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    idsRef.current = [];
    setIsCanceling(false);
    setCancelNote(null);
    return controller.signal;
  }, []);

  /** 서버에서 generationId를 받으면 등록 — 중단 시 이 id들을 취소 처리한다 */
  const trackIds = useCallback((ids: string[]) => {
    idsRef.current = [...idsRef.current, ...ids];
  }, []);

  /** 실행이 끝나면(성공/실패 무관) 호출 */
  const finish = useCallback(() => {
    abortRef.current = null;
    idsRef.current = [];
    setIsCanceling(false);
  }, []);

  const cancel = useCallback(async () => {
    setIsCanceling(true);
    const ids = idsRef.current;
    // 서버 취소를 먼저 보낸다 — 폴링을 먼저 끊으면 남은 대기열이 그대로 생성돼버린다.
    if (ids.length > 0) {
      try {
        await fetch('/api/generations/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
      } catch {
        /* 취소 API 실패해도 폴링은 끊어서 화면은 풀어준다 */
      }
    }
    abortRef.current?.abort();
    // 실측: 4컷을 3개씩 돌릴 때 중단하면 대기 중이던 1건은 생성 자체를 건너뛰지만,
    // 이미 API로 날아간 3건은 그대로 완료된다. 이미 과금된 결과라 버리지 않고 히스토리에
    // 남기는데, 설명이 없으면 "중단이 안 됐다"고 오해하기 쉬워서 명시해둔다.
    setCancelNote('중단했습니다. 아직 시작 안 한 컷은 생성되지 않습니다. 이미 시작된 컷은 취소가 불가능해 그대로 완료되며(이미 과금된 건이라 버리지 않습니다), 잠시 후 히스토리에서 확인할 수 있습니다.');
  }, []);

  return { begin, trackIds, finish, cancel, isCanceling, cancelNote };
}

/** 폴링이 중단으로 끝났는지 판별 — 중단은 에러 알럿을 띄우면 안 된다 */
export function isCanceledError(err: unknown): boolean {
  return (err as { name?: string })?.name === 'GenerationCanceledError';
}
