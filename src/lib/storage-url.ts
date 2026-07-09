/**
 * storage-url.ts
 * Supabase 서명 URL에서 스토리지 경로를 추출한다.
 * 서명 URL은 발급 후 1시간이면 만료돼서, 페이지를 오래 열어둔 뒤 다운로드/크롭을 누르면
 * 그 URL로는 400이 난다 — 경로만 뽑아서 service role로 다시 받으면 만료와 무관해진다.
 * 예: https://xxx.supabase.co/storage/v1/object/sign/nonstudio-generations/restyle/123.png?token=...
 *     → restyle/123.png
 */

import { GENERATIONS_BUCKET } from './supabase';

export function extractStoragePath(imageUrl: string): string | null {
  try {
    const url = new URL(imageUrl);
    const marker = `/${GENERATIONS_BUCKET}/`;
    const idx = url.pathname.indexOf(marker);
    if (idx === -1) return null;
    const path = url.pathname.slice(idx + marker.length);
    return path ? decodeURIComponent(path) : null;
  } catch {
    return null;
  }
}
