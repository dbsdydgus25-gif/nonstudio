/**
 * /api/generations/history/route.ts
 * AI 피팅 / AI 바리에이션 결과 히스토리 조회 — 페이지 이동/새로고침해도 이전 결과를 볼 수 있도록
 * Supabase generations 테이블에서 불러온다.
 */

import { NextResponse } from 'next/server';
import { listRecentGenerations } from '@/lib/generation-store';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const source = searchParams.get('source') === 'variation' ? 'variation' : 'fitting';
  const items = await listRecentGenerations(source);
  return NextResponse.json({ success: true, items });
}
