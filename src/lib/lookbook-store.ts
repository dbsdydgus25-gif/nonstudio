/**
 * lookbook-store.ts
 * AI 룩북 1단계에서 만든 "기준컷 4장"을 서버(Supabase Storage)에 보관한다.
 *
 * (2026-07-29) 처음엔 기준컷을 프론트가 base64로 들고 있다가 배치 생성 요청에 그대로 다시
 * 실어 보냈는데, 1024x1536 PNG 4장이면 요청 본문이 수 MB라 Vercel 요청 크기 한도를 넘겨
 * "Request Entity Too Large"(HTML 응답)가 돌아왔다 — 프론트는 그걸 JSON으로 파싱하려다
 * "Unexpected token 'R'"로 터졌다(대표님 신고). 어차피 우리 서버가 만든 이미지를 클라이언트를
 * 거쳐 되돌려받을 이유가 없으므로, 만든 자리에서 저장하고 배치 때는 sheetId만 주고받는다.
 */

import { getSupabaseAdmin, GENERATIONS_BUCKET } from './supabase';

export type CleanAngle = 'front' | 'back' | 'left' | 'right';

function shotPath(uid: string, sheetId: string, angle: CleanAngle): string {
  return `users/${uid}/lookbook/${sheetId}/${angle}.png`;
}

export function newSheetId(): string {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function saveReferenceShot(
  uid: string,
  sheetId: string,
  angle: CleanAngle,
  buffer: Buffer,
  mimeType: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.storage
    .from(GENERATIONS_BUCKET)
    .upload(shotPath(uid, sheetId, angle), buffer, { contentType: mimeType, upsert: true });
  if (error) throw error;
}

export async function getReferenceShot(
  uid: string,
  sheetId: string,
  angle: CleanAngle,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase.storage
      .from(GENERATIONS_BUCKET)
      .download(shotPath(uid, sheetId, angle));
    if (error || !data) return null;
    return { buffer: Buffer.from(await data.arrayBuffer()), mimeType: data.type || 'image/png' };
  } catch {
    return null;
  }
}
