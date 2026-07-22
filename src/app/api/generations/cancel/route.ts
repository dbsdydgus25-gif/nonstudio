/**
 * /api/generations/cancel/route.ts
 * 생성 중단 — 사용자가 "중단"을 누르면 아직 진행 중인 건들을 취소 표시한다.
 *
 * 정직한 한계: 이미 OpenAI/Veo로 날아간 요청 자체는 되돌릴 수 없고 그 건은 과금된다.
 * 이 API가 실제로 아끼는 건 (1) 아직 시작 안 한 대기열(예: 4컷 중 뒤쪽 컷들)과
 * (2) 백그라운드 작업이 다음 단계로 넘어가기 전 확인하는 지점이다.
 * 프론트에서는 폴링을 즉시 멈춰서 화면이 붙잡히지 않게 한다.
 */

import { NextResponse } from 'next/server';
import { cancelGenerations } from '@/lib/generation-store';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const { ids } = (await req.json()) as { ids?: unknown };
    const list = Array.isArray(ids) ? ids.filter((v): v is string => typeof v === 'string' && !!v.trim()) : [];
    if (list.length === 0) {
      return NextResponse.json({ success: false, error: '중단할 생성 ID가 없습니다.' }, { status: 400 });
    }

    const canceledCount = await cancelGenerations(list);
    return NextResponse.json({ success: true, canceledCount });
  } catch (err: any) {
    console.error('[api/generations/cancel] 중단 처리 실패:', err);
    return NextResponse.json(
      { success: false, error: err?.message || '중단 처리 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
