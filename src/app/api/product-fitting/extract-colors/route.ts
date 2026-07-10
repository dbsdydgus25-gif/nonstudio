/**
 * /api/product-fitting/extract-colors/route.ts
 * 색상 샘플 시트에서 색상 옵션만 미리 추출 (생성 전 미리보기 단계).
 * 추출된 색상 목록을 UI에 보여주고, 사용자가 색상별로 코디 지시를 따로 입력한 뒤
 * 본 생성(/api/product-fitting, colorPlans)으로 이어진다.
 */

import { NextResponse } from 'next/server';
import { extractColorVariants } from '@/lib/garment-agent';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { imageBase64, geminiApiKey, openaiApiKey }: { imageBase64: string; geminiApiKey: string; openaiApiKey?: string } =
      await req.json();

    if (!imageBase64) {
      return NextResponse.json({ success: false, error: '샘플 이미지를 등록해주세요.' }, { status: 400 });
    }
    if (!geminiApiKey) {
      return NextResponse.json({ success: false, error: 'Gemini API 키가 필요합니다.' }, { status: 400 });
    }

    const colors = await extractColorVariants(imageBase64, geminiApiKey, openaiApiKey);
    return NextResponse.json({ success: true, colors });
  } catch (err: any) {
    console.error('[api/product-fitting/extract-colors] 처리 실패:', err);
    return NextResponse.json(
      { success: false, error: err?.message || '색상 추출 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
