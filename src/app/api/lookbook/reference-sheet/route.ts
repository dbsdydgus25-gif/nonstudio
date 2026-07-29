/**
 * /api/lookbook/reference-sheet
 * AI 룩북 1단계 — 큐레이션된 실제 사진을 참고해 사람 없는 깨끗한
 * 앞/뒤/옆(좌)/옆(우) 4컷을 gpt-image-2로 생성한다. 이 4컷이 2단계(포즈 배치 피팅)의
 * 유일한 기준 이미지가 되어, 매번 지저분한 실제 스크래핑 사진을 다시 참고할 필요가 없다.
 *
 * (2026-07-29 수정) 4각도를 완전 병렬로 만들었더니 각 컷이 서로를 모르는 채 그려져서
 * 좌/우 측면의 기장·품이 눈에 띄게 달라지는 문제가 있었다(대표님 신고). 이제 앞면을 먼저
 * 만들고 그 결과를 나머지 3컷의 추가 참고 이미지로 넣어 같은 옷으로 수렴시킨다.
 */
import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { analyzeGarment } from '@/lib/garment-agent';
import { buildCleanAngleShotPrompt, type CleanAngle } from '@/lib/lookbook-prompts';
import type { SourcedCategory, GarmentAnalysis } from '@/lib/fitting-prompts';
import { runGptImageEdit, resultImageToBuffer, parseBase64Image } from '@/lib/gpt-image-edit';
import { downscaleImage } from '@/lib/image-utils';
import { getSessionUserId } from '@/lib/auth';
import { getReferenceShot, newSheetId, saveReferenceShot } from '@/lib/lookbook-store';

export const runtime = 'nodejs';
export const maxDuration = 280;

const ALL_ANGLES: CleanAngle[] = ['front', 'back', 'left', 'right'];

export async function POST(req: Request) {
  try {
    const uid = await getSessionUserId();
    if (!uid) return NextResponse.json({ success: false, error: '로그인이 필요합니다.' }, { status: 401 });

    const {
      productImagesBase64,
      category,
      geminiApiKey,
      openaiApiKey,
      colorOverride,
      angles,
      sheetId: providedSheetId,
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
      /** 개별 재생성 시 기존 시트에 덮어쓰기 위한 id */
      sheetId?: string;
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
    const sheetId = providedSheetId || newSheetId();
    const targetAngles = angles?.length ? angles : ALL_ANGLES;

    const referenceImages = await Promise.all(
      productImagesBase64.map(async (b64) => {
        const parsed = parseBase64Image(b64);
        return downscaleImage(parsed.buffer, parsed.mimeType);
      }),
    );
    const [primary, ...rest] = referenceImages;
    const primaryBase64 = `data:${primary.mimeType};base64,${primary.buffer.toString('base64')}`;
    const realRefs = rest.slice(0, 4);

    const images: Partial<Record<CleanAngle, string>> = {};

    /** 한 각도를 만들고 Storage에 저장 + 응답용 base64 반환 */
    const generateAngle = async (
      angle: CleanAngle,
      anchor: { buffer: Buffer; mimeType: string } | null,
    ): Promise<{ buffer: Buffer; mimeType: string }> => {
      const prompt = buildCleanAngleShotPrompt(category, garmentAnalysis, angle, colorOverride, !!anchor);
      // identity/background 없음 — 사람이 안 들어가는 컷이라 MODEL LOCK 자체가 불필요.
      // 앵커(앞면 결과)가 있으면 실제 사진보다 앞에 두어 "같은 옷"으로 수렴시킨다.
      const extras = anchor ? [anchor, ...realRefs.slice(0, 3)] : realRefs;
      const imageUrl = await runGptImageEdit(openai, primaryBase64, prompt, null, null, 'medium', extras);
      const out = await resultImageToBuffer(imageUrl);
      await saveReferenceShot(uid, sheetId, angle, out.buffer, out.mimeType);
      images[angle] = `data:${out.mimeType};base64,${out.buffer.toString('base64')}`;
      return out;
    };

    // 앞면이 이번 요청에 포함되면 그것부터 만들고, 아니면 이미 저장된 앞면을 앵커로 불러온다.
    let anchor: { buffer: Buffer; mimeType: string } | null = null;
    if (targetAngles.includes('front')) {
      const front = await generateAngle('front', null);
      anchor = await downscaleImage(front.buffer, front.mimeType);
    } else if (providedSheetId) {
      const savedFront = await getReferenceShot(uid, providedSheetId, 'front');
      anchor = savedFront ? await downscaleImage(savedFront.buffer, savedFront.mimeType) : null;
    }

    const remaining = targetAngles.filter((a) => a !== 'front');
    await Promise.all(remaining.map((a) => generateAngle(a, anchor)));

    return NextResponse.json({ success: true, sheetId, garmentAnalysis, images });
  } catch (err: any) {
    console.error('[api/lookbook/reference-sheet] 처리 실패:', err);
    return NextResponse.json(
      { success: false, error: err?.message || '기준컷 생성 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
