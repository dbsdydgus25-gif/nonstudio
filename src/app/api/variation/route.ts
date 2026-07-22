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
import { FULLBODY_POSES, pickRandomPoses } from '@/lib/fitting-prompts';
import { getDefaultBackgroundReferenceImage } from '@/lib/background-reference';
import { getPoseReferenceImage } from '@/lib/pose-reference';
import {
  createPendingGeneration,
  markGenerationCompleted,
  markGenerationFailed,
  isGenerationCanceled,
} from '@/lib/generation-store';
import { downscaleImage, withImageRetry, runWithConcurrency } from '@/lib/image-utils';
import { resultImageToBuffer } from '@/lib/image-source';

export const runtime = 'nodejs';
// Vercel Hobby+Fluid Compute는 함수당 최대 300초까지 허용한다 — 포즈 4개를 병렬로 생성해도
// 개별 gpt-image-2 호출이 90~100초라 여유있게 잡는다.
export const maxDuration = 280;

async function toOpenAIFile(buffer: Buffer, mimeType: string, name: string) {
  return await toFile(buffer, name, { type: mimeType });
}

// (2026-07-09) 재질/색감이 미묘하게 계속 바뀌는 문제가 있었다 — 원인을 다시 보니, 이전
// 버전은 "texture/fabric/weave/grain/pattern" 관련 단어를 다섯 군데에서 반복하고 있었다.
// 이번 세션에서 이미 한 번 확인된 패턴(피부 핏줄을 negative로 반복 언급했더니 오히려 핏줄이
// 더 두드러지게 나온 것)과 동일한 원리로, "텍스처를 정확히 유지하라"는 말을 너무 여러 번
// 반복하면 모델이 그 텍스처 자체에 과도하게 주의를 기울여 오히려 원단 결을 새로 그려내거나
// 과장하는 것으로 보인다. 이번엔 텍스처 언급을 단 한 번으로 줄이고, "이건 같은 사진이다 —
// 포즈만 바뀐다"는 단순하고 명확한 프레이밍으로 대체한다.
// (2026-07-22) "카페 배경을 넣었더니 카페에 모델만 오려 붙인 것처럼 나온다" — 원인은 3가지였다.
// (1) 배경 참고 이미지에 "reproduce this exact backdrop"이라고 지시해서 배경판을 그대로 복사했고,
// (2) 마지막 줄의 "professional studio lighting"이 배경과 무관하게 항상 붙어서 인물만 스튜디오
//     조명을 받고 있었으며(합성 티의 진짜 주범), (3) "keep everything else pixel-faithful"이
//     인물 조명까지 묶어버려서 새 환경에 맞춘 재조명 자체를 막고 있었다.
// 해결: 배경 참고를 두 모드로 분리한다.
//   - 기본 흰 스튜디오(고정 참고 사진) → 지금처럼 정확히 복제 (컷마다 배경이 흔들리면 안 됨)
//   - 사용자가 올린 장소 사진 → "장소/무드 참고"로 격하. 같은 장소의 새 앵글을 자연스럽게
//     만들고, 인물을 그 장면의 빛에 맞춰 재조명한다.
function buildVariationPrompt(
  poseInstruction: string,
  hasBackgroundReferenceImage: boolean,
  hasPoseReferenceImage: boolean,
  /** (2026-07-14) 사용자가 직접 자세를 지정했는지 — true면 프리셋보다 우선한다는 문구를 강조한다 */
  isCustomPose: boolean = false,
  /** true면 배경 참고가 사용자가 올린 "장소 사진" — 복제가 아니라 장면 재구성 + 인물 재조명 */
  isCustomLocation: boolean = false,
): string {
  const imageNotes: string[] = [
    'Image 1 (the base photo): the exact person and exact outfit to reproduce — the single source of truth for face, skin tone, body, and every garment/accessory.',
  ];
  if (hasBackgroundReferenceImage) {
    imageNotes.push(
      isCustomLocation
        ? `Image ${imageNotes.length + 1}: LOCATION reference — this is a mood/scene reference, NOT a backdrop to copy. Keep the same kind of place, same time of day, same overall mood and color palette, but compose a NEW, believable view of that place: a camera angle and framing that suit the pose, with real spatial depth (natural foreground, mid-ground, and background layers) rather than a flat wall behind the subject. Ignore any person shown in this image.`
        : `Image ${imageNotes.length + 1}: background/lighting reference only — reproduce this exact backdrop and lighting, ignore everything else about this image.`,
    );
  }
  if (hasPoseReferenceImage) {
    imageNotes.push(
      `Image ${imageNotes.length + 1}: pose reference only — copy the body pose, camera angle, and framing shown here. Completely ignore the person, clothing, and background shown in this image; those must come only from Image 1.`,
    );
  }

  // (2026-07-15) 실제 사용자 배치 테스트로 3가지 구조적 문제 확인:
  // (1) "뒷주머니에 손" 같은 손 위치 지시가 "뒤돌아선 백뷰"로 잘못 해석됨 — 명시적 방향/턴 단어가
  //     없는데도 카메라 앵글 자체를 바꿔버림.
  // (2) "45도 돌려서" 같은 각도 지시가 살짝 몸만 트는 정도로 약하게만 반영됨.
  // (3) 원본 사진에서 손으로 들고 있던 가방/소품이, 팔짱 낀 자세처럼 두 손이 다 막힌 포즈에서
  //     쥘 손이 없어지자 허공에 붕 뜬 채로 렌더링됨(어느 손/팔에도 걸쳐있지 않음).
  const poseLine = isCustomPose
    ? `MANDATORY POSE (user-specified — this is the actual pose to render, not a suggestion; overrides any default frontal/standing assumption): ${poseInstruction}
- Direction/turn: only change the camera-facing angle (three-quarter turn, side profile, back view, etc.) if the instruction explicitly uses a direction/turn word (e.g. "돌아서", "측면", "뒤돌아", "왼쪽/오른쪽을 보고", "back view", "profile"). A phrase about hand placement alone (e.g. "뒷주머니에 손" / "hand in back pocket") describes the HAND only — keep the body's camera-facing angle as it already is in Image 1 unless a separate direction word says otherwise; do NOT turn the whole body away from the camera just because a pocket or hand position is mentioned.
- If the instruction does give an explicit direction/turn, and especially if it specifies a numeric angle (e.g. "45도"), the body orientation AND camera framing must clearly and unambiguously show that amount of turn — a partial turn readable at a glance, not just a front-facing pose with a slight head tilt.
- Apply only to body parts that are visible in Image 1.
- Accessory/prop handling: if Image 1 shows a hand-held item (bag, phone, etc.) and the new pose does not leave a hand free to hold it the same way (e.g. arms crossed, both hands in pockets), do NOT render it floating disconnected in mid-air with no visible support. Instead keep it physically plausible: hang it from the crook of the elbow, drape the strap over the forearm or shoulder, or adjust which hand/arm holds it — it must always look like gravity and a real grip are acting on it.
(STRICT: ONE person, ONE pose, ONE photograph — never render several people or a multi-pose lineup.)`
    : `New pose (apply only to body parts that are visible in Image 1): ${poseInstruction}`;

  // 커스텀 장소일 때만 붙는 "실제로 거기서 찍은 사진" 블록.
  // 주의: 위 주석(2026-07-09)의 교훈대로 같은 개념을 반복하면 역효과가 나므로,
  // 각 항목을 한 번씩만 언급하고 블록을 짧게 유지한다.
  const locationIntegrationBlock = isCustomLocation
    ? [
        '',
        '=== THE PERSON MUST LOOK GENUINELY PHOTOGRAPHED IN THIS PLACE (not pasted onto it) ===',
        'This is the single most important quality bar for this image. The subject and the scene must have been lit by the same light:',
        '- Relight the person to match the scene: same light direction, colour temperature, intensity, and softness as the location. This is the ONE thing about the person that is allowed — and required — to change.',
        '- Ground the person physically: a correct contact shadow under the feet (and under any part touching a surface), falling in the direction the scene\'s light dictates.',
        '- Let the environment touch the subject: subtle bounce light and colour spill from nearby surfaces, and natural occlusion where the body meets the scene.',
        '- Match the optics: consistent lens perspective and eye level, with the background falling off in natural depth of field while the subject stays in focus.',
        '- Match the capture: the same grain, white balance, and colour grade across subject and scene, so both look like one exposure from one camera.',
      ]
    : [];

  return [
    '=== TASK: POSE-ONLY EDIT OF A REAL COMMERCIAL PRODUCT PHOTO ===',
    isCustomLocation
      ? 'This is the same person in the same outfit, with a different body pose, photographed on location. The face, skin tone, body, and every garment/accessory stay exactly as in Image 1 (same color, same fabric, same fit, same shoes) — do not redraw, re-texture, sharpen, or reinterpret the clothing in any way. The ONLY thing that may differ is how the light of the new location falls on them (see the lighting section below).'
      : 'This is the same photo, just with a different body pose. Keep everything else pixel-faithful to Image 1 — same face, same skin tone, same body, and the exact same garments (same color, same fabric, same fit, same shoes, same accessories). Do not redraw, re-texture, sharpen, or reinterpret the clothing in any way.',
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
    ...locationIntegrationBlock,
    '',
    '=== NEGATIVE CONSTRAINTS ===',
    'cartoon, illustration, CGI, 3D render, different person, different face, different clothing, different color, different footwear, added or altered fabric pattern/texture, inventing body parts not shown in Image 1, extending the frame beyond Image 1\'s crop, extra limbs, bad hands, distorted anatomy, collage, split screen, multi-panel grid, watermark, text, logo, low resolution, blurry.'
      + (isCustomLocation
        ? ' cutout look, pasted-on subject, subject composited onto a backdrop, studio-lit subject standing in a location shot, missing contact shadow, floating above the ground, mismatched light direction between subject and scene, flat sticker-like silhouette edge, flat backdrop wall with no depth.'
        : ''),
    '',
    isCustomLocation
      ? 'Single photorealistic commercial lookbook photograph shot on location, same framing/crop as Image 1, natural lighting consistent with the location.'
      : 'Single photorealistic commercial lookbook photograph, same framing/crop as Image 1, professional studio lighting.',
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
  /** 배경 참고가 사용자가 올린 장소 사진인지 (기본 흰 스튜디오 참고 사진이면 false) */
  isCustomLocation: boolean = false,
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

  const prompt = buildVariationPrompt(
    poseInstruction,
    !!backgroundReferenceImage,
    !!poseReferenceImage,
    isCustomPose,
    isCustomLocation,
  );

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
    const {
      sourceImageBase64,
      variationCount,
      openaiApiKey,
      draftMode,
      customPoseTexts,
      // (2026-07-22) 컷별 "이 자세로" 참고 사진 — 텍스트 지시만으로는 각도/프레이밍이 흔들려서,
      // 사진이 있으면 프리셋 참고 사진 대신 이걸 쓴다.
      customPoseImagesBase64,
      customBackgroundImageBase64,
    } = await req.json();

    if (!sourceImageBase64) {
      return NextResponse.json({ success: false, error: 'AI 피팅 결과 사진 또는 직접 업로드한 사진이 필요합니다.' }, { status: 400 });
    }
    const oKey = openaiApiKey || process.env.OPENAI_API_KEY;
    if (!oKey) {
      return NextResponse.json({ success: false, error: 'OpenAI API 키가 필요합니다.' }, { status: 400 });
    }

    const count = Math.min(4, Math.max(1, Number(variationCount) || 4));
    // (2026-07-15) 컷마다 자세를 따로 지정할 수 있도록 배열로 받는다 — 인덱스가 비어있으면
    // 그 컷만 기존처럼 프리셋 랜덤 포즈를 쓴다(전부 채우지 않아도 됨, 컷별로 섞어 쓸 수 있음).
    const customTexts: string[] = Array.isArray(customPoseTexts)
      ? customPoseTexts.slice(0, count).map((t: unknown) => (typeof t === 'string' ? t.trim() : ''))
      : [];
    const customPoseImages: string[] = Array.isArray(customPoseImagesBase64)
      ? customPoseImagesBase64.slice(0, count).map((v: unknown) => (typeof v === 'string' ? v.trim() : ''))
      : [];

    // (2026-07-22) 자세 참고 사진만 올리고 텍스트는 비워둘 수 있어야 한다 — 사진이 있는데도
    // 프리셋 랜덤 포즈를 뽑아버리면 사진과 정면으로 충돌한다. 그래서 "텍스트 또는 사진"이
    // 있으면 그 슬롯은 커스텀으로 본다.
    const isCustomSlot = (i: number) => !!customTexts[i] || !!customPoseImages[i];

    // 커스텀이 아닌 슬롯 개수만큼만 프리셋 풀에서 무작위로 뽑고, 순서대로 채워 넣는다.
    const emptySlotCount = Array.from({ length: count }, (_, i) => i).filter((i) => !isCustomSlot(i)).length;
    const randomPosesForEmptySlots = pickRandomPoses(emptySlotCount);
    let randomCursor = 0;
    const poses: Array<{ pose: (typeof FULLBODY_POSES)[number]; poseNumber: number | null; slotIndex: number }> =
      Array.from({ length: count }, (_, i) => {
        if (isCustomSlot(i)) {
          const text = customTexts[i];
          return {
            pose: {
              id: 'custom',
              label: count > 1 ? `커스텀 자세 ${i + 1}` : '커스텀 자세',
              // 사진만 올린 경우엔 참고 사진 자체가 지시가 된다.
              poseInstruction:
                text ||
                'Match the body pose, camera angle, and framing shown in the pose reference image exactly.',
            },
            poseNumber: null,
            slotIndex: i,
          };
        }
        const picked = randomPosesForEmptySlots[randomCursor];
        randomCursor += 1;
        return { ...picked, slotIndex: i };
      });

    // 포즈마다 "처리 중" 행을 먼저 만들어 id를 즉시 반환한다 — 실제 생성은 아래 after()에서 진행.
    const jobs = await Promise.all(
      poses.map(async ({ pose, poseNumber, slotIndex }) => ({
        generationId: await createPendingGeneration({
          pipeline: 'restyle',
          modeOrCategory: 'variation',
          poseLabel: pose.label,
          prompt: pose.poseInstruction,
        }),
        pose,
        slotIndex,
        poseNumber,
      })),
    );

    after(async () => {
      // (2026-07-15) "바리에이션으로 보내기"로 넘어온 이미지는 base64가 아니라 Supabase 서명 URL
      // (https://...)이다 — parseBase64Image는 data: URL만 처리해서, URL 문자열을 그대로 base64로
      // 디코딩하려다 깨진 이미지가 되어 OpenAI가 "Invalid image file" 400을 반환하던 버그.
      // resultImageToBuffer는 URL/data: 둘 다 처리하므로 이걸로 통일한다.
      const { buffer: sourceBuf, mimeType: sourceMime } = await resultImageToBuffer(sourceImageBase64);
      const openai = new OpenAI({ apiKey: oKey });
      // (2026-07-17) 사용자가 원하는 배경/장소 사진을 올리면 그걸 배경 참고로 쓰고,
      // 없으면 기존과 동일하게 고정 흰색 스튜디오 참고 사진을 기본값으로 사용한다.
      // (2026-07-22) 이 둘은 프롬프트에서 다르게 다뤄야 한다 — 기본 스튜디오 사진은 "정확히 복제",
      // 사용자가 올린 장소 사진은 "장면 재구성 + 인물 재조명". isCustomLocation이 그 분기점.
      const isCustomLocation = !!customBackgroundImageBase64;
      const backgroundReferenceImage = isCustomLocation
        ? await resultImageToBuffer(customBackgroundImageBase64)
        : getDefaultBackgroundReferenceImage();

      // 전체 병렬 대신 3개씩 배치 — 이미지 API 분당 한도(429)로 일부 포즈만 성공하는 것 방지
      await runWithConcurrency(jobs, 3, async ({ generationId, pose, poseNumber, slotIndex }) => {
          try {
            // (2026-07-22) 사용자가 중단했으면 남은 컷은 아예 생성하지 않는다 — 4컷을 3개씩
            // 나눠 돌기 때문에, 뒤쪽 배치는 여기서 걸러져 그만큼 비용이 절약된다.
            if (await isGenerationCanceled(generationId)) return;
            // 자세 참고 사진 우선순위: 사용자가 이 컷에 직접 올린 사진 > 프리셋 번호에 대응하는
            // public/reference_poses/pose_{N}.png. 커스텀 자세(poseNumber=null)엔 프리셋이 없다.
            const uploadedPoseImage = customPoseImages[slotIndex];
            const poseReferenceImage = uploadedPoseImage
              ? await resultImageToBuffer(uploadedPoseImage)
              : poseNumber
                ? getPoseReferenceImage(poseNumber)
                : null;
            const { imageUrl } = await runSingleVariation(openai, sourceBuf, sourceMime, pose.poseInstruction, backgroundReferenceImage, poseReferenceImage, draftMode ? 'low' : 'medium', pose.id === 'custom', isCustomLocation);
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
