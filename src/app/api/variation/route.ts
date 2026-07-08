/**
 * /api/variation/route.ts
 * "AI 바리에이션" (구 "모델 피팅") — AI 피팅에서 확정된 "완성된 룩" 사진 1장(또는 직접 업로드한 사진)을
 * 그대로 입력받아, 몸/피부톤/전체 착장(색상·재질·핏·신발)은 100% 유지한 채 포즈만 다양하게 바꿔서
 * 룩북 촬영처럼 여러 장을 만든다. 새로운 옷을 입히거나 몸을 재형성하지 않는다 —
 * 이미 확정된 사진 자체가 가장 강한 참고 기준이라, 매번 몸을 새로 만드는 AI 피팅/구 리스타일링보다
 * 훨씬 일관성 있게 나올 것으로 기대됨.
 *
 * (2026-07-08) 비동기 아키텍처로 전환 — 포즈마다 "처리 중" 행을 먼저 만들어 id 배열을 즉시
 * 반환하고, 실제 gpt-image-2 생성은 `after()`로 응답 이후 백그라운드에서 병렬 진행한다.
 * 프론트는 /api/generations/status?ids=... 폴링으로 각 포즈의 완료 여부를 확인한다.
 */

import { NextResponse } from 'next/server';
import { after } from 'next/server';
import OpenAI, { toFile } from 'openai';
import { FULLBODY_POSES, PERSONAL_BODY_SPEC } from '@/lib/fitting-prompts';
import { getDefaultBackgroundReferenceImage } from '@/lib/background-reference';
import { getPoseReferenceImage } from '@/lib/pose-reference';
import { createPendingGeneration, markGenerationCompleted, markGenerationFailed } from '@/lib/generation-store';

export const runtime = 'nodejs';
// Vercel Hobby+Fluid Compute는 함수당 최대 300초까지 허용한다 — 포즈 4개를 병렬로 생성해도
// 개별 gpt-image-2 호출이 90~100초라 여유있게 잡는다.
export const maxDuration = 280;

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

/**
 * 포즈 풀에서 매번 무작위로 count개를 뽑는다 (기존엔 배열 앞 N개를 고정 순서로만 써서 항상 같은
 * 포즈만 나오던 버그가 있었음). poseNumber는 FULLBODY_POSES 배열상의 1-based 순번으로,
 * public/poses/pose_{poseNumber}.png 참고 사진과 매칭하기 위해 셔플 이후에도 유지한다.
 */
function pickRandomPoses(count: number): Array<{ pose: (typeof FULLBODY_POSES)[number]; poseNumber: number }> {
  const pool = FULLBODY_POSES.map((pose, i) => ({ pose, poseNumber: i + 1 }));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  if (count <= pool.length) return pool.slice(0, count);
  const result = [...pool];
  while (result.length < count) {
    result.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  return result;
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

// (2026-07-09) 재질/색감이 미묘하게 계속 바뀌는 문제가 있었다 — 원인을 다시 보니, 이전
// 버전은 "texture/fabric/weave/grain/pattern" 관련 단어를 다섯 군데에서 반복하고 있었다.
// 이번 세션에서 이미 한 번 확인된 패턴(피부 핏줄을 negative로 반복 언급했더니 오히려 핏줄이
// 더 두드러지게 나온 것)과 동일한 원리로, "텍스처를 정확히 유지하라"는 말을 너무 여러 번
// 반복하면 모델이 그 텍스처 자체에 과도하게 주의를 기울여 오히려 원단 결을 새로 그려내거나
// 과장하는 것으로 보인다. 이번엔 텍스처 언급을 단 한 번으로 줄이고, "이건 같은 사진이다 —
// 포즈만 바뀐다"는 단순하고 명확한 프레이밍으로 대체한다.
function buildVariationPrompt(
  poseInstruction: string,
  hasBackgroundReferenceImage: boolean,
  hasPoseReferenceImage: boolean,
): string {
  const imageNotes: string[] = [
    'Image 1 (the base photo): the exact person and exact outfit to reproduce — the single source of truth for face, skin tone, body, and every garment/accessory.',
  ];
  if (hasBackgroundReferenceImage) {
    imageNotes.push(
      `Image ${imageNotes.length + 1}: background/lighting reference only — reproduce this exact backdrop and lighting, ignore everything else about this image.`,
    );
  }
  if (hasPoseReferenceImage) {
    imageNotes.push(
      `Image ${imageNotes.length + 1}: pose reference only — copy the body pose, camera angle, and framing shown here. Completely ignore the person, clothing, and background shown in this image; those must come only from Image 1.`,
    );
  }

  return [
    '=== TASK: POSE-ONLY EDIT OF A REAL COMMERCIAL PRODUCT PHOTO ===',
    'This is the same photo, just with a different body pose. Keep everything else pixel-faithful to Image 1 — same face, same skin tone, same body, and the exact same garments (same color, same fabric, same fit, same shoes, same accessories). Do not redraw, re-texture, sharpen, or reinterpret the clothing in any way.',
    ...imageNotes,
    `New pose: ${poseInstruction}`,
    `Body must still match this fixed physique spec: ${PERSONAL_BODY_SPEC}`,
    '',
    '=== NEGATIVE CONSTRAINTS ===',
    'cartoon, illustration, CGI, 3D render, different person, different face, different clothing, different color, different footwear, added or altered fabric pattern/texture, extra limbs, bad hands, distorted anatomy, collage, split screen, multi-panel grid, watermark, text, logo, low resolution, blurry.',
    '',
    'Single photorealistic full-body commercial lookbook photograph, head to toe visible, professional studio lighting.',
  ].join('\n');
}

async function runSingleVariation(
  openai: OpenAI,
  sourceBuf: Buffer,
  sourceMime: string,
  poseInstruction: string,
  backgroundReferenceImage: { buffer: Buffer; mimeType: string } | null,
  poseReferenceImage: { buffer: Buffer; mimeType: string } | null,
): Promise<{ imageUrl: string; engineUsed: string }> {
  const sourceFile = await toOpenAIFile(sourceBuf, sourceMime, `source.${sourceMime.split('/')[1] || 'jpg'}`);
  const refs = [backgroundReferenceImage, poseReferenceImage].filter(
    (r): r is { buffer: Buffer; mimeType: string } => !!r,
  );
  const refFiles = await Promise.all(
    refs.map((r, i) => toOpenAIFile(r.buffer, r.mimeType, `reference-${i}.${r.mimeType.split('/')[1] || 'jpg'}`)),
  );
  const imageInput = refFiles.length > 0 ? [sourceFile, ...refFiles] : sourceFile;

  const prompt = buildVariationPrompt(poseInstruction, !!backgroundReferenceImage, !!poseReferenceImage);

  const res = await (openai.images as any).edit({
    model: 'gpt-image-2',
    image: imageInput,
    // restyle과 동일한 이유로 4000자 → 12000자로 상향 (OpenAI 공식 한도 32,000자)
    prompt: prompt.slice(0, 12000),
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
    const poses = pickRandomPoses(count);

    // 포즈마다 "처리 중" 행을 먼저 만들어 id를 즉시 반환한다 — 실제 생성은 아래 after()에서 진행.
    const jobs = await Promise.all(
      poses.map(async ({ pose, poseNumber }) => ({
        generationId: await createPendingGeneration({
          pipeline: 'restyle',
          modeOrCategory: 'variation',
          poseLabel: pose.label,
          prompt: pose.poseInstruction,
        }),
        pose,
        poseNumber,
      })),
    );

    after(async () => {
      const { buffer: sourceBuf, mimeType: sourceMime } = parseBase64Image(sourceImageBase64);
      const openai = new OpenAI({ apiKey: oKey });
      // 배경은 예외 없이 고정 흰색 스튜디오 참고 사진을 사용한다 (AI 피팅과 동일 기준)
      const backgroundReferenceImage = getDefaultBackgroundReferenceImage();

      await Promise.allSettled(
        jobs.map(async ({ generationId, pose, poseNumber }) => {
          try {
            // 사용자가 public/poses/pose_{N}.png 에 포즈 참고 사진을 넣어두면 자동으로 같이 참고한다.
            // 없으면 조용히 건너뛰고 텍스트 포즈 지시만으로 진행(기존 동작 그대로).
            const poseReferenceImage = getPoseReferenceImage(poseNumber);
            const { imageUrl } = await runSingleVariation(openai, sourceBuf, sourceMime, pose.poseInstruction, backgroundReferenceImage, poseReferenceImage);
            const { buffer: outBuf, mimeType: outMime } = await resultImageToBuffer(imageUrl);
            await markGenerationCompleted(generationId, { outputBuffer: outBuf, outputMimeType: outMime, prompt: pose.poseInstruction });
          } catch (err: any) {
            console.error('[api/variation][after] 포즈 생성 실패:', pose.label, err);
            await markGenerationFailed(generationId, err?.message || '포즈 생성 중 오류가 발생했습니다.');
          }
        }),
      );
    });

    return NextResponse.json({
      success: true,
      jobs: jobs.map(({ generationId, pose }) => ({ generationId, poseLabel: pose.label, prompt: pose.poseInstruction })),
    });
  } catch (err: any) {
    console.error('[api/variation] 처리 실패:', err);
    return NextResponse.json(
      { success: false, error: err.message || 'AI 바리에이션 처리 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
