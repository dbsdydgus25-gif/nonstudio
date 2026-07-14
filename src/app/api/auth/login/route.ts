import { NextRequest, NextResponse } from 'next/server';
import {
  loginWithPassword,
  encodeSession,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from '@/lib/auth';

export async function POST(request: NextRequest) {
  try {
    const { username, password } = await request.json();
    if (!username?.trim() || !password) {
      return NextResponse.json(
        { success: false, error: '아이디와 비밀번호를 입력해 주세요.' },
        { status: 400 },
      );
    }

    const tokens = await loginWithPassword(username, password);
    if (!tokens) {
      return NextResponse.json(
        { success: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' },
        { status: 401 },
      );
    }

    const response = NextResponse.json({ success: true });
    response.cookies.set(SESSION_COOKIE, encodeSession(tokens), SESSION_COOKIE_OPTIONS);
    return response;
  } catch (error) {
    console.error('[auth/login] 실패:', error);
    return NextResponse.json({ success: false, error: '로그인 처리 중 오류가 발생했습니다.' }, { status: 500 });
  }
}
