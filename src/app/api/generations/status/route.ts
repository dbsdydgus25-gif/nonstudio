/**
 * /api/generations/status/route.ts
 * 비동기 생성 폴링용 — ?ids=a,b,c 로 여러 generationId의 현재 상태(pending/completed/failed)를 한 번에 조회.
 */

import { NextResponse } from 'next/server';
import { getGenerationStatuses } from '@/lib/generation-store';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const idsParam = searchParams.get('ids') || '';
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);

  if (ids.length === 0) {
    return NextResponse.json({ success: false, error: 'ids 파라미터가 필요합니다.' }, { status: 400 });
  }

  try {
    const items = await getGenerationStatuses(ids);
    return NextResponse.json({ success: true, items });
  } catch (err: any) {
    console.error('[api/generations/status] 처리 실패:', err);
    return NextResponse.json({ success: false, error: err.message || '상태 조회 중 오류가 발생했습니다.' }, { status: 500 });
  }
}
