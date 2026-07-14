import { NextRequest, NextResponse } from 'next/server';
import {
  decodeSession,
  getUserFromToken,
  refreshSession,
  encodeSession,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from '@/lib/auth';

/** 현재 로그인 상태 조회 — 페이지 첫 로드 때 클라이언트가 호출 */
export async function GET(request: NextRequest) {
  const session = decodeSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ success: false, loggedIn: false }, { status: 401 });
  }

  let user = await getUserFromToken(session.at);
  if (!user) {
    // access 만료 → refresh 시도
    const refreshed = await refreshSession(session.rt);
    if (refreshed) {
      user = await getUserFromToken(refreshed.at);
      if (user) {
        const response = NextResponse.json({
          success: true,
          loggedIn: true,
          username: user.email.split('@')[0],
        });
        response.cookies.set(SESSION_COOKIE, encodeSession(refreshed), SESSION_COOKIE_OPTIONS);
        return response;
      }
    }
    return NextResponse.json({ success: false, loggedIn: false }, { status: 401 });
  }

  return NextResponse.json({ success: true, loggedIn: true, username: user.email.split('@')[0] });
}
