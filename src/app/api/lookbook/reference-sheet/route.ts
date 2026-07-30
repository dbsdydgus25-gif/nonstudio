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
      productText,
      productNotes,
      sourceUrl,
      draftMode,
      productImageUrls,
      materialImagesBase64,
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
      /** 상세페이지에서 뽑은 제품명·특징 텍스트 — 머슬핏/크롭/골지 같은 핏·재질 정보의 출처 */
      productText?: string;
      /** 대표님이 직접 적은 핏/디테일 메모 */
      productNotes?: string;
      sourceUrl?: string;
      /** 재질/절개선만 빠르게 확인할 땐 저화질로 — 출력 비용 약 1/8 */
      draftMode?: boolean;
      /**
       * (2026-07-29) 갤러리가 썸네일(512px)을 쓰기 때문에, 생성에는 원본을 다시 받아야 한다.
       * 선택된 컷의 원본 URL을 주면 서버가 직접 고해상도로 내려받아 사용한다(브라우저를
       * 왕복하며 수 MB를 나르지 않는다). 실패하면 넘어온 썸네일로 폴백.
       */
      productImageUrls?: string[];
      /** 원단/구조 클로즈업 — 생성기엔 안 넣고 재질·디테일 분석 근거로만 쓴다 */
      materialImagesBase64?: string[];
    } = await req.json();
    const quality = draftMode ? 'low' : 'medium';

    if (!productImagesBase64?.length) {
      return NextResponse.json({ success: false, error: '제품 이미지가 없습니다.' }, { status: 400 });
    }
    if (!openaiApiKey) {
      return NextResponse.json({ success: false, error: 'OpenAI API 키가 없습니다.' }, { status: 400 });
    }

    // (2026-07-29) 상세페이지 특징 텍스트(productText)와 대표님 메모를 rawSpecs로 함께 넘긴다 —
    // 사진만으로는 "머슬핏 / 크롭 기장 / 골지" 같은 핏·재질 정보를 알 수 없어서, 이걸 안 넣으면
    // 분석 결과가 일반적인 티셔츠로 뭉개진다(대표님 지적: "상세페이지 분석해서 저장되어야 한다").
    const rawSpecs = [productText?.trim(), productNotes?.trim()].filter(Boolean).join('\n') || undefined;
    const garmentAnalysis =
      providedAnalysis ||
      (await analyzeGarment(
        productImagesBase64,
        geminiApiKey,
        sourceUrl,
        rawSpecs,
        category,
        openaiApiKey,
        materialImagesBase64,
      ));

    if (garmentAnalysis.analysisFailed) {
      return NextResponse.json(
        { success: false, error: '제품 분석에 실패했습니다(Gemini/OpenAI 키 한도 등) — 다시 시도해주세요.' },
        { status: 502 },
      );
    }

    const openai = new OpenAI({ apiKey: openaiApiKey });
    const sheetId = providedSheetId || newSheetId();
    const targetAngles = angles?.length ? angles : ALL_ANGLES;

    // 원본 URL이 있으면 서버가 고해상도로 다시 받아 쓴다(썸네일로 생성하면 재질이 뭉개진다).
    const referer = (() => {
      try {
        return sourceUrl ? new URL(sourceUrl).origin + '/' : '';
      } catch {
        return '';
      }
    })();
    const fetchOriginal = async (u: string): Promise<{ buffer: Buffer; mimeType: string } | null> => {
      try {
        const res = await fetch(u, {
          headers: { 'User-Agent': 'Mozilla/5.0', ...(referer ? { Referer: referer } : {}) },
          signal: AbortSignal.timeout(12000),
        });
        if (!res.ok) return null;
        const ct = res.headers.get('content-type') || '';
        if (!ct.startsWith('image/')) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 4000) return null;
        return downscaleImage(buf, ct);
      } catch {
        return null;
      }
    };

    // 분석(analyzeGarment)은 넘어온 전부를 봤지만, 비싼 gpt-image-2 입력으로는 앞의 3장만
    // 쓴다 — 입력 이미지 장수가 곧 비용이고, 너무 많이 넣으면 오히려 서로 섞인다.
    const genSources = productImagesBase64.slice(0, 3);
    const referenceImages = await Promise.all(
      genSources.map(async (b64, i) => {
        const srcUrl = productImageUrls?.[i];
        if (srcUrl) {
          const original = await fetchOriginal(srcUrl);
          if (original) return original;
        }
        const parsed = parseBase64Image(b64);
        return downscaleImage(parsed.buffer, parsed.mimeType);
      }),
    );
    const [primary, ...rest] = referenceImages;
    const primaryBase64 = `data:${primary.mimeType};base64,${primary.buffer.toString('base64')}`;
    // (2026-07-29) gpt-image-2는 입력 이미지를 전부 고정밀도로 처리해 장당 입력 토큰 비용이
    // 붙는다 — 참고컷 4장씩 매 각도(4콜)에 실어 보내던 게 "4컷에 1.2달러"의 실제 원인이었다
    // (대표님 신고). 텍스트 분석(garmentAnalysis)이 이미 색/재질/구조를 담고 있어 사진은
    // 색·질감 검증용 최소한만 있으면 되므로 2장으로 줄인다.
    const realRefs = rest.slice(0, 2);

    const images: Partial<Record<CleanAngle, string>> = {};

    /** 한 각도를 만들고 Storage에 저장 + 응답용 base64 반환 */
    const generateAngle = async (
      angle: CleanAngle,
      anchor: { buffer: Buffer; mimeType: string } | null,
    ): Promise<{ buffer: Buffer; mimeType: string }> => {
      const prompt = buildCleanAngleShotPrompt(category, garmentAnalysis, angle, colorOverride, !!anchor);
      // identity/background 없음 — 사람이 안 들어가는 컷이라 MODEL LOCK 자체가 불필요.
      // 앵커(앞면 결과)가 있으면 그 자체가 이미 확정된 같은 옷이라 실제 사진은 1장이면
      // 충분하다(재질/색 재확인용) — 앵커 없는 앞면 생성만 2장을 다 쓴다.
      const extras = anchor ? [anchor, ...realRefs.slice(0, 1)] : realRefs;
      const imageUrl = await runGptImageEdit(openai, primaryBase64, prompt, null, null, quality, extras);
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
