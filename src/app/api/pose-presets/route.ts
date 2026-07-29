/**
 * /api/pose-presets
 * AI 룩북 포즈 프리셋 라이브러리 CRUD. 대표님이 등록한 포즈를 계정별로 저장해두고
 * 배치 생성 때 골라 쓴다. 이미지는 이 코드베이스 전반과 동일하게 base64 data URL로 주고받는다.
 */
import { NextResponse } from 'next/server';
import { getSessionUserId } from '@/lib/auth';
import { addPosePreset, deletePosePreset, getPosePresetRefUrl, listPosePresets } from '@/lib/pose-presets';
import { parseBase64Image } from '@/lib/gpt-image-edit';

export const runtime = 'nodejs';

export async function GET() {
  const uid = await getSessionUserId();
  if (!uid) return NextResponse.json({ success: false, error: '로그인이 필요합니다.' }, { status: 401 });

  const presets = await listPosePresets(uid);
  const withUrls = await Promise.all(
    presets.map(async (p) => ({
      ...p,
      refImageUrl: p.hasRefImage ? await getPosePresetRefUrl(uid, p.id) : null,
    })),
  );
  return NextResponse.json({ success: true, presets: withUrls });
}

export async function POST(req: Request) {
  const uid = await getSessionUserId();
  if (!uid) return NextResponse.json({ success: false, error: '로그인이 필요합니다.' }, { status: 401 });

  try {
    const { name, poseInstruction, refImageBase64 } = await req.json();
    if (!name?.trim() || !poseInstruction?.trim()) {
      return NextResponse.json({ success: false, error: '이름과 포즈 설명을 입력해주세요.' }, { status: 400 });
    }
    const preset = await addPosePreset(uid, {
      name,
      poseInstruction,
      refImage: refImageBase64 ? parseBase64Image(refImageBase64) : undefined,
    });
    return NextResponse.json({ success: true, preset });
  } catch (err: any) {
    console.error('[api/pose-presets] 저장 실패:', err);
    return NextResponse.json(
      { success: false, error: err?.message || '프리셋 저장 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}

export async function DELETE(req: Request) {
  const uid = await getSessionUserId();
  if (!uid) return NextResponse.json({ success: false, error: '로그인이 필요합니다.' }, { status: 401 });

  try {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return NextResponse.json({ success: false, error: '삭제할 프리셋 id가 없습니다.' }, { status: 400 });
    await deletePosePreset(uid, id);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[api/pose-presets] 삭제 실패:', err);
    return NextResponse.json(
      { success: false, error: err?.message || '프리셋 삭제 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
