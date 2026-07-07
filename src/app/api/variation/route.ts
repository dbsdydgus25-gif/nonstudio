/**
 * /api/variation/route.ts
 * "AI 바리에이션" (구 "모델 피팅") — AI 피팅에서 확정된 "완성된 룩" 사진 1장(또는 직접 업로드한 사진)을
 * 그대로 입력받아, 몸/피부톤/전체 착장(색상·재질·핏·신발)은 100% 유지한 채 포즈만 다양하게 바꿔서
 * 룩북 촬영처럼 여러 장을 만든다. 새로운 옷을 입히거나 몸을 재형성하지 않는다 —
 * 이미 확정된 사진 자체가 가장 강한 참고 기준이라, 매번 몸을 새로 만드는 AI 피팅/구 리스타일링보다
 * 훨씬 일관성 있게 나올 것으로 기대됨.
 */

import { NextResponse } from 'next/server';
import OpenAI, { toFile } from 'openai';
import { FULLBODY_POSES } from '@/lib/fitting-prompts';
import { getDefaultBackgroundReferenceImage } from '@/lib/background-reference';
import { saveGeneration } from '@/lib/generation-store';

export const runtime = 'nodejs';
export const maxDuration = 120;

function parseBase64Image(dataUrl: string): { buffer: Buffer; mimeType: string } {
  if (dataUrl.startsWith('data:')) {
    const [header, data] = dataUrl.split(',');
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
    return { buffer: Buffer.from(data, 'base64'), mimeType };
  }
  return { buffer: Buffer.from(dataUrl, 'base64'), mimeType: 'image/jpeg' };
}

async function toOpenAIFile(buffer: Buffer, mimeType: string, name: string) {
  return await toFile(buffer, name, { type: mimeType });
}

/** OpenAI 응답 이미지(URL 또는 base64 data URL)를 Buffer로 통일 — Supabase 업로드용 */
async function resultImageToBuffer(imageUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (imageUrl.startsWith('data:')) {
    return parseBase64Image(imageUrl);
  }
  const res = await fetch(imageUrl);
  const arrayBuffer = await res.arrayBuffer();
  const mimeType = res.headers.get('content-type') || 'image/png';
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}

function buildVariationPrompt(poseInstruction: string, hasBackgroundReferenceImage: boolean): string {
  return [
    '=== TASK: POSE-ONLY VARIATION — THIS IS A REAL PRODUCT PHOTO, NOT A CREATIVE REINTERPRETATION ===',
    'The input image shows a real commercial product that will be sold online. The garment fabric, weave, knit pattern, print, and color in the input image are the ACTUAL PRODUCT TEXTURE — they must be pixel-faithful, not an artistic approximation. Treat the garment surface as a fixed texture map, not something to redraw or reimagine.',
    'Reproduce the EXACT same person (body shape, skin tone, face, proportions) and the EXACT same garments (same fabric weave/knit pattern, same color, same fit, same footwear, same accessories) with 100% fidelity to the input image.',
    'FORBIDDEN CHANGES: do NOT alter the fabric texture or knit/weave pattern, do NOT smooth out or simplify fabric grain, do NOT change garment color or shade, do NOT add or remove any pattern, do NOT change footwear style, do NOT reshape the body.',
    `THE ONLY PERMITTED CHANGE is the body pose: ${poseInstruction}`,
    '',
    '=== BACKGROUND ===',
    hasBackgroundReferenceImage
      ? 'One of the additional input images shows the EXACT target studio backdrop and lighting (soft frontal light, gentle top-down falloff, seamless cyclorama floor curve). Reproduce this exact background and lighting — do NOT invent a different location or mood.'
      : 'Keep the same clean white studio background and lighting as the input image.',
    '',
    '=== NEGATIVE CONSTRAINTS (ABSOLUTE) ===',
    'cartoon, illustration, CGI, 3D render, different person, different face, different clothing, different fabric texture, different weave pattern, invented pattern, different colors, different footwear, extra limbs, bad hands, distorted anatomy, collage, split screen, multi-panel, grid of photos, side-by-side comparison, watermark, text, logo, low resolution, blurry.',
    '',
    '=== OUTPUT QUALITY MANDATE ===',
    'Single authentic commercial lookbook photograph, full body shot head to toe, photorealistic, exact same fabric texture as the reference, professional studio lighting. No CGI, no collage, single subject only.',
  ].join('\n');
}

async function runSingleVariation(
  openai: OpenAI,
  sourceBuf: Buffer,
  sourceMime: string,
  poseInstruction: string,
  backgroundReferenceImage: { buffer: Buffer; mimeType: string } | null,
): Promise<{ imageUrl: string; engineUsed: string }> {
  const sourceFile = await toOpenAIFile(sourceBuf, sourceMime, `source.${sourceMime.split('/')[1] || 'jpg'}`);
  const imageInput = backgroundReferenceImage
    ? [sourceFile, await toOpenAIFile(backgroundReferenceImage.buffer, backgroundReferenceImage.mimeType, `background.${backgroundReferenceImage.mimeType.split('/')[1] || 'jpg'}`)]
    : sourceFile;

  const prompt = buildVariationPrompt(poseInstruction, !!backgroundReferenceImage);

  const res = await (openai.images as any).edit({
    model: 'gpt-image-2',
    image: imageInput,
    prompt: prompt.slice(0, 4000),
    n: 1,
    size: '1024x1536',
    quality: 'medium',
  });

  const item = res?.data?.[0];
  const imageUrl = item?.url || (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
  if (!imageUrl) throw new Error('빈 이미지 응답 (gpt-image-2 variation edit)');
  return { imageUrl, engineUsed: 'gpt-image-2 (pose variation)' };
}

export async function POST(req: Request) {
  try {
    const { sourceImageBase64, variationCount, openaiApiKey } = await req.json();

    if (!sourceImageBase64) {
      return NextResponse.json({ success: false, error: 'AI 피팅 결과 사진 또는 직접 업로드한 사진이 필요합니다.' }, { status: 400 });
    }
    const oKey = openaiApiKey || process.env.OPENAI_API_KEY;
    if (!oKey) {
      return NextResponse.json({ success: false, error: 'OpenAI API 키가 필요합니다.' }, { status: 400 });
    }

    const count = Math.min(4, Math.max(1, Number(variationCount) || 4));
    const { buffer: sourceBuf, mimeType: sourceMime } = parseBase64Image(sourceImageBase64);
    const openai = new OpenAI({ apiKey: oKey });

    // 배경은 예외 없이 고정 흰색 스튜디오 참고 사진을 사용한다 (AI 피팅과 동일 기준)
    const backgroundReferenceImage = getDefaultBackgroundReferenceImage();

    const poses = Array.from({ length: count }).map((_, i) => FULLBODY_POSES[i % FULLBODY_POSES.length]);

    const settled = await Promise.allSettled(
      poses.map(async (pose) => {
        const { imageUrl, engineUsed } = await runSingleVariation(openai, sourceBuf, sourceMime, pose.poseInstruction, backgroundReferenceImage);

        let generationId: string | null = null;
        try {
          const { buffer: outBuf, mimeType: outMime } = await resultImageToBuffer(imageUrl);
          generationId = await saveGeneration({
            pipeline: 'restyle',
            modeOrCategory: 'variation',
            prompt: pose.poseInstruction,
            poseLabel: pose.label,
            outputBuffer: outBuf,
            outputMimeType: outMime,
          });
        } catch (logErr) {
          console.warn('[api/variation] 생성 기록 저장 실패 (결과 반환은 정상 진행):', logErr);
        }

        return { imageUrl, engineUsed, prompt: pose.poseInstruction, variationLabel: pose.label, generationId };
      }),
    );

    const images = settled
      .filter((r): r is PromiseFulfilledResult<{ imageUrl: string; engineUsed: string; prompt: string; variationLabel: string; generationId: string | null }> => r.status === 'fulfilled')
      .map((r) => r.value);
    const errors = settled
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => {
        const reason = r.reason;
        const status = reason?.status ? ` (status ${reason.status})` : '';
        return `${reason?.message || String(reason)}${status}`;
      });

    if (images.length === 0) {
      return NextResponse.json({ success: false, error: '모든 포즈 생성에 실패했습니다.', errors }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      images,
      totalGenerated: images.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: any) {
    console.error('[api/variation] 처리 실패:', err);
    return NextResponse.json(
      { success: false, error: err.message || 'AI 바리에이션 처리 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
