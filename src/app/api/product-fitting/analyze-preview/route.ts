/**
 * /api/product-fitting/analyze-preview/route.ts
 * 생성 전 미리보기 — 업로드/링크로 들어온 제품 이미지를 분석해 "사이즈 옵션"(과 참고용
 * 소재/카테고리)을 돌려준다. 상세페이지형 이미지 속 한글 사이즈표까지 Gemini 비전이 읽는다.
 * 색상 옵션은 기존 extract-colors 흐름을 그대로 쓰고, 여기서는 사이즈 선택을 위해 sizeOptions만
 * 필요로 하는 화면(이미지 업로드/링크 모드)에서 호출한다.
 */

import { NextResponse } from 'next/server';
import { analyzeGarment } from '@/lib/garment-agent';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { productImagesBase64, materialImagesBase64, category, geminiApiKey, openaiApiKey } = (await req.json()) as {
      productImagesBase64: string[];
      materialImagesBase64?: string[];
      category?: string;
      geminiApiKey: string;
      openaiApiKey?: string;
    };

    if (!productImagesBase64?.length) {
      return NextResponse.json({ success: false, error: '제품 이미지를 등록해주세요.' }, { status: 400 });
    }
    if (!geminiApiKey) {
      return NextResponse.json({ success: false, error: 'Gemini API 키가 필요합니다.' }, { status: 400 });
    }

    const analysis = await analyzeGarment(
      productImagesBase64,
      geminiApiKey,
      undefined,
      undefined,
      category,
      openaiApiKey,
      materialImagesBase64?.length ? materialImagesBase64 : undefined,
    );

    return NextResponse.json({
      success: true,
      sizeOptions: analysis.sizeOptions || [],
      category: analysis.category,
      color: analysis.color,
      material: analysis.material,
    });
  } catch (err: any) {
    console.error('[api/product-fitting/analyze-preview] 처리 실패:', err);
    return NextResponse.json(
      { success: false, error: err?.message || '분석 미리보기 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
