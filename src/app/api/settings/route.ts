import { NextRequest, NextResponse } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { getUserSettings, saveUserSettings } from '@/lib/user-settings';

/** 로그인 계정의 API 키 조회 (미들웨어가 세션 검증 후 도달) */
export async function GET() {
  const uid = await getSessionUserId();
  if (!uid) return NextResponse.json({ success: false }, { status: 401 });

  const settings = await getUserSettings(uid);
  return NextResponse.json({ success: true, settings });
}

/** 로그인 계정의 API 키 저장 */
export async function PUT(request: NextRequest) {
  const uid = await getSessionUserId();
  if (!uid) return NextResponse.json({ success: false }, { status: 401 });

  try {
    const { geminiKey, openaiKey } = await request.json();
    await saveUserSettings(uid, {
      geminiKey: typeof geminiKey === 'string' ? geminiKey.trim() : '',
      openaiKey: typeof openaiKey === 'string' ? openaiKey.trim() : '',
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[settings] 저장 실패:', error);
    return NextResponse.json({ success: false, error: '설정 저장에 실패했습니다.' }, { status: 500 });
  }
}
