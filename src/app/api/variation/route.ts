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
import { FULLBODY_POSES } from '@/lib/fitting-prompts';
import { getDefaultBackgroundReferenceImage } from '@/lib/background-reference';
import { getPoseReferenceImage } from '@/lib/pose-reference';
import { createPendingGeneration, markGenerationCompleted, markGenerationFailed } from '@/lib/generation-store';
import { downscaleImage, withImageRetry, runWithConcurrency } from '@/lib/image-utils';

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
  /** (2026-07-14) 사용자가 직접 자세를 지정했는지 — true면 프리셋보다 우선한다는 문구를 강조한다 */
  isCustomPose: boolean = false,
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

  const poseLine = isCustomPose
    ? `MANDATORY POSE (user-specified — this is the actual pose to render, not a suggestion; overrides any default frontal/standing assumption. If it specifies a direction or turn — e.g. facing left/right, three-quarter turn, back view — the body orientation AND camera framing must clearly and unambiguously show that turn, not a front-facing pose with only a slight head tilt. Apply only to body parts that are visible in Image 1): ${poseInstruction} (STRICT: ONE person, ONE pose, ONE photograph — never render several people or a multi-pose lineup.)`
    : `New pose (apply only to body parts that are visible in Image 1): ${poseInstruction}`;

  return [
    '=== TASK: POSE-ONLY EDIT OF A REAL COMMERCIAL PRODUCT PHOTO ===',
    'This is the same photo, just with a different body pose. Keep everything else pixel-faithful to Image 1 — same face, same skin tone, same body, and the exact same garments (same color, same fabric, same fit, same shoes, same accessories). Do not redraw, re-texture, sharpen, or reinterpret the clothing in any way.',
    // (2026-07-09) 목 위(얼굴)가 안 나오게 크롭된 사진을 넣었는데 결과물에 얼굴이 새로 생성되던
    // 버그 — 이전 버전이 "head to toe visible"을 무조건 강제해서, 입력 사진에 없는 신체 부위까지
    // 억지로 만들어내고 있었다. 입력 사진의 크롭/프레이밍 자체를 그대로 유지하도록 명시.
    // (2026-07-09 2차) 프레이밍 규칙을 넣었는데도 얼굴이 다시 생성됨 — 포즈 지시문 안의
    // 고개/시선 문구("head turned back...", "gaze looking down...")가 "머리가 존재해야 한다"는
    // 신호로 작용해 프레이밍 규칙을 이기고 있었다. 머리가 안 보이는 입력이면 포즈 지시의
    // 고개/시선 부분 자체를 무시하라고 우선순위를 명시적으로 못박는다.
    'FRAMING RULE (HIGHEST PRIORITY — overrides everything else in this prompt including the pose instruction): the output must have the exact same framing and crop as Image 1. If Image 1 does not show the head/face (cropped at the neck or chest), the output must be cropped identically and contain NO head and NO face — in that case, ignore every part of the pose instruction that mentions the head, face, chin, or gaze, and apply only the body/arm/leg parts of the pose. Never extend the frame or invent any body part (head, face, feet, etc.) that is not visible in Image 1.',
    ...imageNotes,
    poseLine,
    // (2026-07-09) PERSONAL_BODY_SPEC 텍스트를 여기서 제거함 — 사용자 결정: AI 바리에이션은
    // "첨부된 사진을 그대로 가져와서 포즈만 바꾸는" 단계라, 텍스트 체형 스펙이 이미지와
    // 미묘하게 충돌해 재해석을 유발할 여지를 없앤다. 체형/피부톤/털/흉터 등 모델 정보는
    // 전부 AI 피팅(restyle) 단계에서만 주입되고, 바리에이션은 그 결과 사진 자체가 유일한 기준.
    'The person in Image 1 IS the model spec — do not adjust the body, skin, or face toward any other standard.',
    '',
    '=== NEGATIVE CONSTRAINTS ===',
    'cartoon, illustration, CGI, 3D render, different person, different face, different clothing, different color, different footwear, added or altered fabric pattern/texture, inventing body parts not shown in Image 1, extending the frame beyond Image 1\'s crop, extra limbs, bad hands, distorted anatomy, collage, split screen, multi-panel grid, watermark, text, logo, low resolution, blurry.',
    '',
    'Single photorealistic commercial lookbook photograph, same framing/crop as Image 1, professional studio lighting.',
  ].join('\n');
}

async function runSingleVariation(
  openai: OpenAI,
  sourceBuf: Buffer,
  sourceMime: string,
  poseInstruction: string,
  backgroundReferenceImage: { buffer: Buffer; mimeType: string } | null,
  poseReferenceImage: { buffer: Buffer; mimeType: string } | null,
  quality: 'low' | 'medium' = 'medium',
  isCustomPose: boolean = false,
): Promise<{ imageUrl: string; engineUsed: string }> {
  // 입력 이미지는 1024px로 다운스케일 — 페이로드/입력 토큰 절감
  const source = await downscaleImage(sourceBuf, sourceMime);
  const sourceFile = await toOpenAIFile(source.buffer, source.mimeType, `source.${source.mimeType.split('/')[1] || 'jpg'}`);
  const rawRefs = [backgroundReferenceImage, poseReferenceImage].filter(
    (r): r is { buffer: Buffer; mimeType: string } => !!r,
  );
  const refs = await Promise.all(rawRefs.map((r) => downscaleImage(r.buffer, r.mimeType)));
  const refFiles = await Promise.all(
    refs.map((r, i) => toOpenAIFile(r.buffer, r.mimeType, `reference-${i}.${r.mimeType.split('/')[1] || 'jpg'}`)),
  );
  const imageInput = refFiles.length > 0 ? [sourceFile, ...refFiles] : sourceFile;

  const prompt = buildVariationPrompt(poseInstruction, !!backgroundReferenceImage, !!poseReferenceImage, isCustomPose);

  const res: any = await withImageRetry(() => (openai.images as any).edit({
    model: 'gpt-image-2',
    image: imageInput,
    // restyle과 동일한 이유로 4000자 → 12000자로 상향 (OpenAI 공식 한도 32,000자)
    prompt: prompt.slice(0, 12000),
    n: 1,
    size: '1024x1536',
    quality, // medium 기본, 초안 모드는 low (약 1/4 비용)
  }));

  const item = res?.data?.[0];
  const imageUrl = item?.url || (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
  if (!imageUrl) throw new Error('빈 이미지 응답 (gpt-image-2 variation edit)');
  return { imageUrl, engineUsed: 'gpt-image-2 (pose variation)' };
}

export async function POST(req: Request) {
  try {
    const { sourceImageBase64, variationCount, openaiApiKey, draftMode, customPoseText } = await req.json();

    if (!sourceImageBase64) {
      return NextResponse.json({ success: false, error: 'AI 피팅 결과 사진 또는 직접 업로드한 사진이 필요합니다.' }, { status: 400 });
    }
    const oKey = openaiApiKey || process.env.OPENAI_API_KEY;
    if (!oKey) {
      return NextResponse.json({ success: false, error: 'OpenAI API 키가 필요합니다.' }, { status: 400 });
    }

    const count = Math.min(4, Math.max(1, Number(variationCount) || 4));
    const customPose = typeof customPoseText === 'string' ? customPoseText.trim() : '';

    // (2026-07-14) 사용자가 자세를 직접 지정하면 프리셋 랜덤 풀 대신 그 자세로 count장을 만든다
    // (포즈 참고 이미지는 프리셋 번호에 매칭되는 것이라 커스텀 자세에는 적용하지 않는다).
    const poses: Array<{ pose: (typeof FULLBODY_POSES)[number]; poseNumber: number | null }> = customPose
      ? Array.from({ length: count }, () => ({ pose: { id: 'custom', label: '커스텀 자세', poseInstruction: customPose }, poseNumber: null }))
      : pickRandomPoses(count);

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

      // 전체 병렬 대신 3개씩 배치 — 이미지 API 분당 한도(429)로 일부 포즈만 성공하는 것 방지
      await runWithConcurrency(jobs, 3, async ({ generationId, pose, poseNumber }) => {
          try {
            // 사용자가 public/reference_poses/pose_{N}.png 에 포즈 참고 사진을 넣어두면 자동으로 같이 참고한다.
            // 커스텀 자세(poseNumber=null)는 프리셋 번호가 없으므로 건너뛴다.
            const poseReferenceImage = poseNumber ? getPoseReferenceImage(poseNumber) : null;
            const { imageUrl } = await runSingleVariation(openai, sourceBuf, sourceMime, pose.poseInstruction, backgroundReferenceImage, poseReferenceImage, draftMode ? 'low' : 'medium', !!customPose);
            const { buffer: outBuf, mimeType: outMime } = await resultImageToBuffer(imageUrl);
            await markGenerationCompleted(generationId, { outputBuffer: outBuf, outputMimeType: outMime, prompt: pose.poseInstruction });
          } catch (err: any) {
            console.error('[api/variation][after] 포즈 생성 실패:', pose.label, err);
            await markGenerationFailed(generationId, err?.message || '포즈 생성 중 오류가 발생했습니다.');
          }
      });
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
