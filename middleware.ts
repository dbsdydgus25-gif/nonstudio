/**
 * middleware.ts — 모든 /api 라우트를 로그인 세션으로 보호한다 (/api/auth/* 제외).
 *
 * 검증 전략:
 * - nf_session 쿠키의 access token을 GoTrue(/auth/v1/user)로 실검증하고,
 *   같은 토큰은 만료 전까지 인스턴스 메모리에 캐시해 요청마다 네트워크를 타지 않게 한다.
 * - 만료(또는 임박) 시 refresh token으로 자동 갱신하고 새 쿠키를 응답에 실어준다
 *   → 사용자는 30일 내 재로그인 없이 계속 사용.
 */

import { NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE = 'nf_session';

interface SessionTokens {
  at: string;
  rt: string;
}

// edge 인스턴스 수명 동안 유지되는 검증 캐시: token → 만료 epoch(초)
const verifiedTokens = new Map<string, number>();

function decodeSession(value: string | undefined): SessionTokens | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof parsed?.at === 'string' && typeof parsed?.rt === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

function encodeSession(tokens: SessionTokens): string {
  return btoa(JSON.stringify(tokens)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jwtExp(jwt: string): number {
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload?.exp === 'number' ? payload.exp : 0;
  } catch {
    return 0;
  }
}

function unauthorized(): NextResponse {
  return NextResponse.json(
    { success: false, error: '로그인이 필요합니다.', code: 'UNAUTHORIZED' },
    { status: 401 },
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 로그인/로그아웃/세션조회는 보호 대상에서 제외
  if (pathname.startsWith('/api/auth/')) return NextResponse.next();

  const session = decodeSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return unauthorized();

  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return unauthorized();

  const nowSec = Math.floor(Date.now() / 1000);
  const exp = jwtExp(session.at);
  const stillValid = exp > nowSec + 60;

  // 1) 캐시에 검증된 토큰이면 통과
  const cachedExp = verifiedTokens.get(session.at);
  if (cachedExp && cachedExp > nowSec + 60) return NextResponse.next();

  // 2) 만료 안 됐으면 GoTrue로 실검증 후 캐시
  if (stillValid) {
    const res = await fetch(`${url}/auth/v1/user`, {
      headers: { apikey: key, Authorization: `Bearer ${session.at}` },
      cache: 'no-store',
    });
    if (res.ok) {
      verifiedTokens.set(session.at, exp);
      return NextResponse.next();
    }
  }

  // 3) 만료(또는 검증 실패) → refresh 시도, 성공하면 새 쿠키 발급
  const refreshRes = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.rt }),
    cache: 'no-store',
  });
  if (!refreshRes.ok) return unauthorized();
  const data = await refreshRes.json();
  if (!data?.access_token || !data?.refresh_token) return unauthorized();

  const newValue = encodeSession({ at: data.access_token, rt: data.refresh_token });
  verifiedTokens.set(data.access_token, jwtExp(data.access_token));

  // 이번 요청의 라우트 핸들러도 새 토큰을 읽도록 요청 쿠키까지 교체
  const forwarded = new Headers(request.headers);
  const cookieHeader = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${SESSION_COOKIE}=`));
  cookieHeader.push(`${SESSION_COOKIE}=${newValue}`);
  forwarded.set('cookie', cookieHeader.join('; '));

  const response = NextResponse.next({ request: { headers: forwarded } });
  response.cookies.set(SESSION_COOKIE, newValue, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}

export const config = {
  matcher: '/api/:path*',
};
