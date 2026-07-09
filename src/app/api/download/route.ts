/**
 * /api/download/route.ts
 * 결과 이미지 다운로드 프록시 — 클라이언트가 들고 있는 Supabase 서명 URL은 1시간이면
 * 만료되고, cross-origin이라 <a download>도 동작하지 않는다. 여기서 스토리지 경로를
 * 추출해 service role로 항상 신선하게 다시 받아서 base64 JSON으로 돌려준다.
 * (crop 라우트와 동일하게, raw binary 응답은 프로덕션에서 손상 이슈가 있어 base64 사용)
 */

import { NextResponse } from 'next/server';
import { getSupabaseAdmin, GENERATIONS_BUCKET } from '@/lib/supabase';
import { extractStoragePath } from '@/lib/storage-url';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const { imageUrl } = await req.json();
    if (!imageUrl) {
      return NextResponse.json({ success: false, error: 'imageUrl이 필요합니다.' }, { status: 400 });
    }

    let buffer: Buffer;
    let mimeType = 'image/png';

    const storagePath = extractStoragePath(imageUrl);
    if (storagePath) {
      // 우리 버킷 이미지 — 만료된 서명 URL이어도 경로로 다시 받는다
      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase.storage.from(GENERATIONS_BUCKET).download(storagePath);
      if (error || !data) throw error || new Error('스토리지에서 이미지를 찾을 수 없습니다.');
      buffer = Buffer.from(await data.arrayBuffer());
      mimeType = data.type || 'image/png';
    } else if (imageUrl.startsWith('data:')) {
      return NextResponse.json({ success: true, dataUrl: imageUrl });
    } else {
      const res = await fetch(imageUrl);
      if (!res.ok) throw new Error(`이미지 다운로드 실패 (status ${res.status})`);
      buffer = Buffer.from(await res.arrayBuffer());
      mimeType = res.headers.get('content-type') || 'image/png';
    }

    return NextResponse.json({
      success: true,
      dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
    });
  } catch (err: any) {
    console.error('[api/download] 처리 실패:', err);
    return NextResponse.json(
      { success: false, error: err?.message || '다운로드 처리 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
