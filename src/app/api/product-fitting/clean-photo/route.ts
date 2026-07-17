/**
 * /api/product-fitting/clean-photo/route.ts
 * "사진 정리" (신규, 2026-07-17) — 신상마켓 등에서 캡처한 지저분한 원본 사진(옷걸이, 여러 벌이
 * 겹친 컷, 사람이 입은 배경 등)을 배경/소품/사람 없이 흰 배경 위 제품 단독 컷으로 정리한다.
 * 목적은 "더 예쁘게"가 아니라 "다음 분석 단계(AI 제품 피팅)가 절개선/포켓/패치 위치를 더 정확히
 * 읽도록" — 그래서 프롬프트는 재해석/리디자인을 엄격히 금지하고 배경 제거+정렬만 지시한다.
 *
 * 사용자가 사진마다 선택적으로 누르는 버튼이라 여기선 단일 이미지, 동기(sync) 응답으로 처리한다
 * (배치/비동기 큐가 필요 없을 만큼 짧고, 결과를 바로 보고 다음 사진도 정리할지 판단해야 하므로).
 */

import { NextResponse } from 'next/server';
import OpenAI, { toFile } from 'openai';
import { downscaleImage, withImageRetry } from '@/lib/image-utils';

export const runtime = 'nodejs';
export const maxDuration = 60;

function parseBase64Image(dataUrl: string): { buffer: Buffer; mimeType: string } {
  if (dataUrl.startsWith('data:')) {
    const [header, data] = dataUrl.split(',');
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
    return { buffer: Buffer.from(data, 'base64'), mimeType };
  }
  return { buffer: Buffer.from(dataUrl, 'base64'), mimeType: 'image/jpeg' };
}

const CLEAN_PHOTO_PROMPT = `
=== TASK: BACKGROUND/PROP CLEANUP OF A REAL PRODUCT PHOTO (NOT A REDESIGN) ===
The input photo shows one real garment, possibly cluttered with a background, hanger, other overlapping garments, a person wearing it, price tags, or store fixtures.

Produce a clean e-commerce product shot of ONLY this exact garment:
- Remove the background entirely — replace it with a plain, seamless pure white studio background.
- Remove any hanger, hook, string, price tag, or other garments that are not this one item.
- If a person is wearing it, remove the person and present the garment alone, laid out flat (flat-lay) or as if on an invisible mannequin — do NOT keep any part of a person's body, skin, or face.
- Straighten and center the garment, fully visible, with even studio lighting and soft natural shadow only.

=== ABSOLUTE FIDELITY RULE (MOST IMPORTANT) ===
This is a cleanup/isolation task, NOT a redesign. Every real detail of the garment must be pixel-faithful to the input: exact color and shade, exact fabric texture, exact seam and panel lines, exact pocket count/type/placement, exact logo/patch/print placement (do not add, remove, duplicate, or move any of them), exact buttons/zippers/drawstrings/closures (same count, same position), exact stitching. Do NOT invent, beautify, simplify, or "improve" any design element. Do NOT change the silhouette or fit. If a detail is unclear or partially hidden in the input, leave that area ambiguous/soft rather than inventing a confident guess.

Output: a single photorealistic product photo, plain white background, no text, no watermark, no logo overlay, no collage, no multiple views in one image.
`.trim();

export async function POST(req: Request) {
  try {
    const { imageBase64, openaiApiKey } = await req.json();
    if (!imageBase64) {
      return NextResponse.json({ success: false, error: '정리할 사진이 필요합니다.' }, { status: 400 });
    }
    const oKey = openaiApiKey || process.env.OPENAI_API_KEY;
    if (!oKey) {
      return NextResponse.json({ success: false, error: 'OpenAI API 키가 필요합니다.' }, { status: 400 });
    }

    const { buffer: rawBuf, mimeType: rawMime } = parseBase64Image(imageBase64);
    const { buffer, mimeType } = await downscaleImage(rawBuf, rawMime);
    const file = await toFile(buffer, `product.${mimeType.split('/')[1] || 'jpg'}`, { type: mimeType });

    const openai = new OpenAI({ apiKey: oKey });
    const res: any = await withImageRetry(() =>
      (openai.images as any).edit({
        model: 'gpt-image-2',
        image: file,
        prompt: CLEAN_PHOTO_PROMPT,
        n: 1,
        size: '1024x1536',
        // 디테일 보존이 핵심 목적이라 초안(low) 대신 medium 고정 — 여기서 화질을 낮추면
        // 정작 살리려던 절개선/패치 디테일이 뭉개진다.
        quality: 'medium',
      }),
    );

    const item = res?.data?.[0];
    const imageUrl = item?.url || (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
    if (!imageUrl) throw new Error('빈 이미지 응답 (gpt-image-2 clean-photo)');

    let outDataUrl = imageUrl;
    if (imageUrl.startsWith('http')) {
      const r = await fetch(imageUrl);
      const ab = await r.arrayBuffer();
      const outMime = r.headers.get('content-type') || 'image/png';
      outDataUrl = `data:${outMime};base64,${Buffer.from(ab).toString('base64')}`;
    }

    return NextResponse.json({ success: true, imageBase64: outDataUrl });
  } catch (err: any) {
    console.error('[api/product-fitting/clean-photo] 처리 실패:', err);
    return NextResponse.json(
      { success: false, error: err.message || '사진 정리 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
