/**
 * /api/lookbook/reference-sheet
 * AI 룩북(신규 섹션) 1단계 — 큐레이션된 실제 사진을 참고해 사람 없는 깨끗한
 * 앞/뒤/옆(좌)/옆(우) 4컷을 gpt-image-2로 생성한다. 이 4컷이 2단계(포즈 배치 피팅)의
 * 유일한 기준 이미지가 되어, 매번 지저분한 실제 스크래핑 사진을 다시 참고할 필요가 없다.
 */
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { analyzeGarment } from '@/lib/garment-agent';
import { buildCleanAngleShotPrompt, type CleanAngle } from '@/lib/lookbook-prompts';
import type { SourcedCategory, GarmentAnalysis } from '@/lib/fitting-prompts';
import { runGptImageEdit, resultImageToBuffer, parseBase64Image } from '@/lib/gpt-image-edit';
import { downscaleImage } from '@/lib/image-utils';

export const runtime = 'nodejs';
export const maxDuration = 280;

const ALL_ANGLES: CleanAngle[] = ['front', 'back', 'left', 'right'];

export async function POST(req: Request) {
  try {
    const {
      productImagesBase64,
      category,
      geminiApiKey,
      openaiApiKey,
      colorOverride,
      angles,
      garmentAnalysis: providedAnalysis,
    }: {
      /** 색상별로 큐레이션된 실제 스크래핑 사진(대표컷 먼저) */
      productImagesBase64: string[];
      category: SourcedCategory;
      geminiApiKey: string;
      openaiApiKey: string;
      colorOverride?: string;
      /** 지정하면 이 각도들만 생성(개별 재생성용). 생략하면 4개 전부 */
      angles?: CleanAngle[];
      /** 재생성 시 이미 있는 분석 결과를 넘기면 재분석 생략(비용 절감) */
      garmentAnalysis?: GarmentAnalysis;
    } = await req.json();

    if (!productImagesBase64?.length) {
      return NextResponse.json({ success: false, error: '제품 이미지가 없습니다.' }, { status: 400 });
    }
    if (!openaiApiKey) {
      return NextResponse.json({ success: false, error: 'OpenAI API 키가 없습니다.' }, { status: 400 });
    }

    const garmentAnalysis =
      providedAnalysis ||
      (await analyzeGarment(productImagesBase64, geminiApiKey, undefined, undefined, category, openaiApiKey));

    if (garmentAnalysis.analysisFailed) {
      return NextResponse.json(
        { success: false, error: '제품 분석에 실패했습니다(Gemini/OpenAI 키 한도 등) — 다시 시도해주세요.' },
        { status: 502 },
      );
    }

    const openai = new OpenAI({ apiKey: openaiApiKey });
    const targetAngles = angles?.length ? angles : ALL_ANGLES;

    const referenceImages = await Promise.all(
      productImagesBase64.map(async (b64) => {
        const parsed = parseBase64Image(b64);
        return downscaleImage(parsed.buffer, parsed.mimeType);
      }),
    );
    const [primary, ...rest] = referenceImages;
    const primaryBase64 = `data:${primary.mimeType};base64,${primary.buffer.toString('base64')}`;

    const results = await Promise.all(
      targetAngles.map(async (angle) => {
        const prompt = buildCleanAngleShotPrompt(category, garmentAnalysis, angle, colorOverride);
        // identity/background 없음 — 사람이 안 들어가는 컷이라 MODEL LOCK 자체가 불필요.
        // 나머지 실제 사진은 다른 각도/디테일 참고로 최대 4장까지만(과부하 방지).
        const imageUrl = await runGptImageEdit(openai, primaryBase64, prompt, null, null, 'medium', rest.slice(0, 4));
        const { buffer, mimeType } = await resultImageToBuffer(imageUrl);
        return { angle, imageBase64: `data:${mimeType};base64,${buffer.toString('base64')}` };
      }),
    );

    const images: Partial<Record<CleanAngle, string>> = {};
    for (const r of results) images[r.angle] = r.imageBase64;

    return NextResponse.json({ success: true, garmentAnalysis, images });
  } catch (err: any) {
    console.error('[api/lookbook/reference-sheet] 처리 실패:', err);
    return NextResponse.json(
      { success: false, error: err?.message || '기준컷 생성 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
