/**
 * /api/cron/cleanup-old-generations
 * 히스토리 UI는 파이프라인당 최근 24개만 보여주지만, 그 뒤로 밀린 생성 결과는 여태 아무도
 * 안 지워서 Storage/DB에 영원히 쌓이며 계속 과금됐다(egress/용량 초과의 실제 원인).
 * 7일 지난 `generations` 행 + 그 Storage 파일만 삭제한다. 모델정보/포즈프리셋/룩북
 * 기준컷은 이 테이블/경로 범위 밖이라 이 함수가 건드릴 방법 자체가 없다(안전).
 */
import { NextResponse } from 'next/server';
import { getSupabaseAdmin, GENERATIONS_BUCKET } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 60;

const RETENTION_DAYS = 7;

export async function GET(req: Request) {
  const auth = req.headers.get('authorization');
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: '인증 실패' }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error } = await supabase
    .from('generations')
    .select('id, output_storage_path')
    .lt('created_at', cutoff);
  if (error) {
    console.error('[cron/cleanup-old-generations] 조회 실패:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
  if (!rows || rows.length === 0) {
    return NextResponse.json({ success: true, deletedRows: 0, deletedFiles: 0 });
  }

  const paths = rows.map((r: any) => r.output_storage_path).filter((p: string) => !!p);
  let deletedFiles = 0;
  if (paths.length > 0) {
    const { data: removed, error: removeErr } = await supabase.storage.from(GENERATIONS_BUCKET).remove(paths);
    if (removeErr) {
      // 파일 삭제 실패는 행 삭제를 막지 않는다 — 이미 없는 파일이거나 일시적 오류일 수 있고,
      // DB 행이 안 지워지면 다음날 또 같은 행을 재시도하게 되어 더 안전하다.
      console.error('[cron/cleanup-old-generations] Storage 삭제 일부 실패:', removeErr);
    }
    deletedFiles = removed?.length || 0;
  }

  const ids = rows.map((r: any) => r.id);
  const { error: deleteErr } = await supabase.from('generations').delete().in('id', ids);
  if (deleteErr) {
    console.error('[cron/cleanup-old-generations] 행 삭제 실패:', deleteErr);
    return NextResponse.json({ success: false, error: deleteErr.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, deletedRows: ids.length, deletedFiles });
}
