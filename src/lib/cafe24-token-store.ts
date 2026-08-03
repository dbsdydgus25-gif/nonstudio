/**
 * cafe24-token-store.ts
 * 카페24 OAuth 토큰을 Supabase Storage에 저장 — Vercel 서버리스 함수는 매 호출이 무상태라
 * 기존 로컬 스크립트처럼 `.env` 파일에 다시 써넣는 방식이 안 된다. pose-presets.ts/
 * model-profile.ts와 같은 Storage-JSON 패턴을 그대로 재사용한다.
 *
 * 카페24 access_token은 수명이 짧고(2시간) refresh_token은 rotating(매 갱신마다 새로 발급)
 * 이지만 수명이 길다(2주). 매시간 별도로 깨워서 갱신할 필요 없이, "필요한 순간"(아침 크론
 * 실행 시) 그 자리에서 즉시 갱신해서 쓰면 충분하다 — 크론 job 하나를 통째로 아낀다.
 */
import { getSupabaseAdmin, GENERATIONS_BUCKET } from './supabase';

const TOKEN_PATH = 'system/cafe24-token.json';

interface Cafe24TokenState {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

export async function getCafe24TokenState(): Promise<Cafe24TokenState | null> {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase.storage.from(GENERATIONS_BUCKET).download(TOKEN_PATH);
    if (error || !data) return null;
    return JSON.parse(await data.text());
  } catch {
    return null;
  }
}

async function saveCafe24TokenState(state: Cafe24TokenState): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.storage
    .from(GENERATIONS_BUCKET)
    .upload(TOKEN_PATH, Buffer.from(JSON.stringify(state, null, 2), 'utf-8'), {
      contentType: 'application/json',
      upsert: true,
      // (2026-07-29 세션에서 배운 교훈) Supabase Storage 기본 캐시(3600초)를 그대로 두면
      // 갱신 직후에도 옛 토큰이 반환돼 "저장이 안 되는" 것처럼 보인다 — 반드시 끈다.
      cacheControl: '0',
    });
  if (error) throw error;
}

/** 1회성 시딩 전용 — 로컬 스크립트에서만 호출 */
export async function seedCafe24Token(refreshToken: string, accessToken: string): Promise<void> {
  await saveCafe24TokenState({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: new Date(0).toISOString(), // 즉시 만료 취급 → 다음 호출 때 바로 갱신
  });
}

/** 저장된 refresh_token으로 즉시 갱신해서 유효한 access_token을 반환한다 */
export async function getFreshCafe24AccessToken(env: {
  mallId: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const state = await getCafe24TokenState();
  if (!state) {
    throw new Error(
      '카페24 토큰이 시딩되지 않았습니다. scripts/seed-cafe24-token.mjs를 로컬에서 1회 실행해주세요.',
    );
  }

  const basicAuth = Buffer.from(`${env.clientId}:${env.clientSecret}`).toString('base64');
  const res = await fetch(`https://${env.mallId}.cafe24api.com/api/v2/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: state.refresh_token }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`카페24 토큰 갱신 실패 (status ${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();

  // 새 토큰을 즉시 저장 — rotating refresh_token이라 여기서 실패하면 다음 실행이 끊긴다.
  await saveCafe24TokenState({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
  });

  return data.access_token;
}
