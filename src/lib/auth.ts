/**
 * auth.ts — NON FITTING 계정 인증 (Supabase Auth 기반, 서버 전용)
 *
 * 구조:
 * - 아이디(username)는 내부적으로 `${username}@nonfitting.app` 이메일로 매핑해 Supabase Auth에 저장.
 * - 로그인 성공 시 access/refresh 토큰을 httpOnly 쿠키(nf_session) 하나에 담아 내려준다.
 *   → localStorage를 전혀 쓰지 않으므로 브라우저 로그아웃/데이터 삭제로 API 키가 날아가던 문제의
 *     근본 원인이 제거된다 (키는 이제 Supabase Storage의 계정별 settings.json에 있음).
 * - GoTrue REST 엔드포인트를 service_role 키를 apikey로 직접 호출한다.
 *   (.env.local에 anon 키가 없고 service_role만 있는 현재 구성 그대로 동작)
 */

import { cookies } from 'next/headers';

export const SESSION_COOKIE = 'nf_session';
const USERNAME_DOMAIN = 'nonfitting.app';

export interface SessionTokens {
  at: string; // access_token (JWT)
  rt: string; // refresh_token
}

function authBase(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 없습니다.');
  return { url: url.replace(/\/$/, ''), key };
}

export function usernameToEmail(username: string): string {
  const clean = username.trim().toLowerCase();
  return clean.includes('@') ? clean : `${clean}@${USERNAME_DOMAIN}`;
}

/** GoTrue password grant — 성공 시 토큰 쌍, 실패 시 null */
export async function loginWithPassword(
  username: string,
  password: string,
): Promise<SessionTokens | null> {
  const { url, key } = authBase();
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: usernameToEmail(username), password }),
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data?.access_token || !data?.refresh_token) return null;
  return { at: data.access_token, rt: data.refresh_token };
}

/** refresh_token으로 세션 갱신 — 실패 시 null */
export async function refreshSession(refreshToken: string): Promise<SessionTokens | null> {
  const { url, key } = authBase();
  const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data?.access_token || !data?.refresh_token) return null;
  return { at: data.access_token, rt: data.refresh_token };
}

/** access token 검증 (GoTrue /user) — 유효하면 {id, email} */
export async function getUserFromToken(
  accessToken: string,
): Promise<{ id: string; email: string } | null> {
  const { url, key } = authBase();
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data?.id) return null;
  return { id: data.id, email: data.email ?? '' };
}

// ---------- 쿠키 직렬화 ----------

export function encodeSession(tokens: SessionTokens): string {
  return Buffer.from(JSON.stringify(tokens), 'utf-8').toString('base64url');
}

export function decodeSession(cookieValue: string | undefined): SessionTokens | null {
  if (!cookieValue) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cookieValue, 'base64url').toString('utf-8'));
    if (typeof parsed?.at === 'string' && typeof parsed?.rt === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: 60 * 60 * 24 * 30, // 30일
};

// ---------- JWT payload 파싱 (서명 검증은 미들웨어에서 GoTrue 호출로 수행) ----------

export function parseJwtPayload(jwt: string): { sub?: string; exp?: number } | null {
  try {
    const part = jwt.split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

/**
 * 라우트 핸들러용 — 미들웨어가 이미 토큰을 검증/갱신했다는 전제 하에
 * 쿠키에서 사용자 id(uid)만 빠르게 꺼낸다. 세션 없으면 null.
 */
export async function getSessionUserId(): Promise<string | null> {
  const store = await cookies();
  const session = decodeSession(store.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const payload = parseJwtPayload(session.at);
  return payload?.sub ?? null;
}
