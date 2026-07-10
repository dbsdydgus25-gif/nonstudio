/**
 * /api/model-profile/route.ts
 * "모델 정보" 페이지용 — 윤용현 모델 프로필(참고 이미지 + 키/몸무게 + 상세 스펙 텍스트) 조회/저장.
 * GET: 현재 프로필 + 참고 이미지 미리보기 URL
 * PUT: 프로필 저장 (identityImageBase64가 있으면 참고 이미지도 교체)
 */

import { NextResponse } from 'next/server';
import {
  getModelProfile,
  saveModelProfile,
  saveIdentityImage,
  getIdentityImagePreviewUrl,
} from '@/lib/model-profile';

export const runtime = 'nodejs';

function parseBase64Image(dataUrl: string): { buffer: Buffer; mimeType: string } {
  if (dataUrl.startsWith('data:')) {
    const [header, data] = dataUrl.split(',');
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/png';
    return { buffer: Buffer.from(data, 'base64'), mimeType };
  }
  return { buffer: Buffer.from(dataUrl, 'base64'), mimeType: 'image/png' };
}

export async function GET() {
  try {
    const [profile, identityImageUrl] = await Promise.all([getModelProfile(), getIdentityImagePreviewUrl()]);
    return NextResponse.json({ success: true, profile, identityImageUrl });
  } catch (err: any) {
    console.error('[api/model-profile] 조회 실패:', err);
    return NextResponse.json({ success: false, error: err?.message || '모델 정보 조회에 실패했습니다.' }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const {
      name,
      heightCm,
      weightKg,
      shoeSizeMm,
      specText,
      identityImageBase64,
    }: {
      name: string;
      heightCm: number;
      weightKg: number;
      shoeSizeMm: number;
      specText: string;
      identityImageBase64?: string | null;
    } = await req.json();

    if (!specText?.trim()) {
      return NextResponse.json({ success: false, error: '상세 스펙 텍스트를 입력해주세요.' }, { status: 400 });
    }

    let hasCustomIdentityImage = (await getModelProfile()).hasCustomIdentityImage;
    if (identityImageBase64) {
      const { buffer, mimeType } = parseBase64Image(identityImageBase64);
      await saveIdentityImage(buffer, mimeType);
      hasCustomIdentityImage = true;
    }

    await saveModelProfile({
      name: name?.trim() || '윤용현',
      heightCm: Number(heightCm) || 177,
      weightKg: Number(weightKg) || 74,
      shoeSizeMm: Number(shoeSizeMm) || 270,
      specText: specText.trim(),
      hasCustomIdentityImage,
    });

    const [profile, identityImageUrl] = await Promise.all([getModelProfile(), getIdentityImagePreviewUrl()]);
    return NextResponse.json({ success: true, profile, identityImageUrl });
  } catch (err: any) {
    console.error('[api/model-profile] 저장 실패:', err);
    return NextResponse.json({ success: false, error: err?.message || '모델 정보 저장에 실패했습니다.' }, { status: 500 });
  }
}
