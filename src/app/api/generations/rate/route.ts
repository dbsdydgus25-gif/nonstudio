/**
 * /api/generations/rate/route.ts
 * 매 생성 결과에 대한 👍/👎 평가 저장.
 */

import { NextResponse } from 'next/server';
import { rateGeneration } from '@/lib/generation-store';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const { generationId, rating, note } = await req.json();

    if (!generationId || (rating !== 'good' && rating !== 'bad')) {
      return NextResponse.json({ success: false, error: 'generationId와 rating(good|bad)이 필요합니다.' }, { status: 400 });
    }

    await rateGeneration(generationId, rating, note);

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[api/generations/rate] 처리 실패:', err);
    return NextResponse.json({ success: false, error: err.message || '평가 저장 중 오류가 발생했습니다.' }, { status: 500 });
  }
}
