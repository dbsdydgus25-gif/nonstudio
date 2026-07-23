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
import { getSessionUserId } from '@/lib/auth';
import { getModelIdentityImage } from '@/lib/model-profile';

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
  /**
   * (2026-07-23) "모델 정보와 동일" 토글 — 저장된 모델 정보(모델 정보 페이지)의 참고 이미지가
   * 있으면 그걸 identity 앵커로 함께 넣는다. 실사용에서 포즈를 크게 바꿀 때 몸이 과하게
   * 근육질로 변하거나 핏줄이 생기고 얼굴이 살짝 달라지는 드리프트가 확인됐는데, Image 1
   * 한 장만으로는 gpt-image-2가 큰 리포즈 도중 "그럴듯한 커머셜 모델"쪽으로 슬쩍 밀리는
   * 경향이 있다. 기본은 켜짐 — 대부분의 바리에이션 입력이 대표님 본인 모델이기 때문.
   * 본인 모델이 아닌 사진(다른 사람 사진으로 포즈만 참고하는 경우)을 넣을 땐 꺼서, 그 사진에
   * 대표님 얼굴/체형을 억지로 입히지 않게 한다.
   */
  hasIdentityReferenceImage: boolean = false,
  /** 사용자가 자세 참고 사진과 텍스트를 동시에 입력했는지 — true면 poseInstruction은 사진 위에
   *  얹는 보조 디테일로, false(사진만)면 poseInstruction은 자동 생성된 "사진 그대로 따라라" 문장 */
  hasCustomPoseText: boolean = false,
  /**
   * (2026-07-23) 클로즈업 프레이밍 — 전신 결과물을 그대로 넣고 "이 옷 디테일만 가까이" 컷을
   * 뽑고 싶다는 요청. 바리에이션은 원래 "Image 1의 크롭을 그대로 유지"가 최우선 규칙이라
   * (얼굴 없는 크롭에 얼굴이 생기던 버그 방어), 클로즈업일 때만 그 규칙을 의도적으로 푼다 —
   * 대신 "안 보이는 부위를 지어내지 말라"는 원래 취지는 그대로 유지한다.
   */
  framing: 'full' | 'close' = 'full',
): string {
  const imageNotes: string[] = [
    'Image 1 (the base photo): the exact person and exact outfit to reproduce — the single source of truth for face, skin tone, body, and every garment/accessory.',
  ];
  if (hasIdentityReferenceImage) {
    imageNotes.push(
      `Image ${imageNotes.length + 1}: this person's saved MODEL IDENTITY reference — the authoritative reference for this exact person's face structure, body build, and skin tone. Image 1 still defines the CURRENT pose, framing, and outfit — do NOT copy this image's clothing, background, or pose. Use it only to correct drift: if re-rendering the pose in Image 1 would make the face, body shape, muscle definition, or skin look like a different person, match THIS image's face/body instead of inventing a more "commercial-model" physique.`,
    );
  }
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
  //
  // (2026-07-23) 자세 참고 사진 + 텍스트를 동시에 넣으면 사진이 무시되는 버그를 실측으로 확인.
  // 뒷모습 참고 사진 + "정면을 바라보며 카메라 응시"라는(사진과 정면충돌하는) 텍스트를 같이
  // 넣었더니, 실제로 정면 결과가 나왔다 — 원인은 병합 문구가 "사진이 우선"이라고 말해놓고
  // 바로 뒤에 충돌하는 텍스트를 그대로 붙여서, 모델이 그 텍스트도 "적용해야 할 지시"로 읽은
  // 것. 사진이 있을 땐 블록 전체를 별도로 구성해서 (a) 자세/각도/시선의 유일한 근거는 사진이고
  // (b) 텍스트는 사진과 충돌하면 그 부분만 무시하라고 명시적으로 못박는다 — Direction/turn
  // 키워드 게이트(텍스트에 "돌아서/측면/뒤돌아" 같은 단어가 없으면 각도를 그대로 유지하라는
  // 규칙)도 사진이 있을 땐 완전히 다른 전제라 여기서만 빼고 별도로 적용한다.
  const poseLine = isCustomPose
    ? hasPoseReferenceImage
      ? `MANDATORY POSE — THE POSE REFERENCE IMAGE IS THE ONLY SOURCE OF TRUTH for body pose, camera angle, body orientation, and gaze/head direction. Copy exactly what it shows — including whether the person faces the camera, looks to a side, or is shown from behind — even if this differs from the note below.
${
  hasCustomPoseText
    ? `The user also wrote this note: "${poseInstruction}". Apply ONLY the parts of this note that do NOT conflict with the reference image's pose, camera angle, or gaze — such as a held prop, hand position, or facial expression. If any part of this note names a different camera angle, body direction, or gaze than the reference image actually shows, ignore that specific part completely and keep following the image.`
    : 'Match the body pose, camera angle, and framing shown in the pose reference image exactly.'
}
- Apply only to body parts that are visible in Image 1.
- Accessory/prop handling: if Image 1 shows a hand-held item (bag, phone, etc.) and the new pose does not leave a hand free to hold it the same way (e.g. arms crossed, both hands in pockets), do NOT render it floating disconnected in mid-air with no visible support. Instead keep it physically plausible: hang it from the crook of the elbow, drape the strap over the forearm or shoulder, or adjust which hand/arm holds it — it must always look like gravity and a real grip are acting on it.
(STRICT: ONE person, ONE pose, ONE photograph — never render several people or a multi-pose lineup.)`
      : `MANDATORY POSE (user-specified — this is the actual pose to render, not a suggestion; overrides any default frontal/standing assumption): ${poseInstruction}
- Direction/turn: only change the camera-facing angle (three-quarter turn, side profile, back view, etc.) if the instruction explicitly uses a direction/turn word (e.g. "돌아서", "측면", "뒤돌아", "왼쪽/오른쪽을 보고", "back view", "profile"). A phrase about hand placement alone (e.g. "뒷주머니에 손" / "hand in back pocket") describes the HAND only — keep the body's camera-facing angle as it already is in Image 1 unless a separate direction word says otherwise; do NOT turn the whole body away from the camera just because a pocket or hand position is mentioned.
- If the instruction does give an explicit direction/turn, and especially if it specifies a numeric angle (e.g. "45도"), the body orientation AND camera framing must clearly and unambiguously show that amount of turn — a partial turn readable at a glance, not just a front-facing pose with a slight head tilt.
- Apply only to body parts that are visible in Image 1.
- Accessory/prop handling: if Image 1 shows a hand-held item (bag, phone, etc.) and the new pose does not leave a hand free to hold it the same way (e.g. arms crossed, both hands in pockets), do NOT render it floating disconnected in mid-air with no visible support. Instead keep it physically plausible: hang it from the crook of the elbow, drape the strap over the forearm or shoulder, or adjust which hand/arm holds it — it must always look like gravity and a real grip are acting on it.
(STRICT: ONE person, ONE pose, ONE photograph — never render several people or a multi-pose lineup.)`
    : `New pose (apply only to body parts that are visible in Image 1): ${poseInstruction}`;

  // 커스텀 장소일 때만 붙는 "실제로 거기서 찍은 사진" 블록.
  // 주의: 위 주석(2026-07-09)의 교훈대로 같은 개념을 반복하면 역효과가 나므로,
  // 각 항목을 한 번씩만 언급하고 블록을 짧게 유지한다.
  //
  // (2026-07-23) 실사용 확인 — 조명/그림자는 맞아도 "사람이 밴 옆에서 4미터 거인처럼" 나오는
  // 사고가 재현됐다. 원인: 이 블록이 빛(조명/그림자/피사계심도)만 다루고, 인물이 그 장면
  // 안에서 물리적으로 맞는 크기여야 한다는 말이 단 한 줄도 없었다. gpt-image-2는 배경 사진과
  // 인물 사진을 각자 "적당한 크기"로 합성해버려서, 차·건물·통행인 같은 실제 크기 기준이 있는
  // 사물 옆에 두면 스케일이 완전히 어긋난다. 이건 조명 불일치보다 훨씬 눈에 띄는 결함이라
  // 이 블록 맨 앞(최우선)에 스케일 규칙을 추가한다.
  const locationIntegrationBlock = isCustomLocation
    ? [
        '',
        '=== THE PERSON MUST LOOK GENUINELY PHOTOGRAPHED IN THIS PLACE (not pasted onto it) ===',
        'This is the single most important quality bar for this image. Two things must be true — scale and light:',
        '- SCALE (check this first): find the size cues already in the location image — parked vehicles, doorways/windows, utility poles, lane markings, furniture, or other people standing in the scene — and use them to fix how large the person must appear at this distance and camera height. A real adult standing next to a car is roughly chest-to-shoulder height against it, not taller than the car\'s roofline; a doorway typically clears the head by a small margin, not by feet. If the reference image contains other people, the subject must be a normal, comparable human height next to them — never noticeably larger or smaller. Getting this wrong (an oversized or undersized person) reads instantly as a bad composite, more than any lighting mismatch does.',
        '- LIGHT: the subject and the scene must have been lit by the same light — relight the person to match the scene\'s light direction, colour temperature, intensity, and softness. This is the ONE thing about the person that is allowed — and required — to change.',
        '- Ground the person physically: a correct contact shadow under the feet (and under any part touching a surface), falling in the direction the scene\'s light dictates, sized consistently with the scale fixed above.',
        '- Let the environment touch the subject: subtle bounce light and colour spill from nearby surfaces, and natural occlusion where the body meets the scene (e.g. partially behind a nearby object if the chosen framing places it in front of the subject).',
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
    // (2026-07-23) 자세 참고 사진이 있을 땐 이 규칙을 "카메라 앵글까지 Image 1과 똑같이"가
    // 아니라 "안 보이는 신체 부위를 지어내지 말라"는 원래 취지로만 좁힌다 — 안 그러면 참고
    // 사진이 다른 각도(예: 뒷모습)를 보여줘도 이 규칙이 그걸 되돌려버린다.
    framing === 'close'
      ? 'FRAMING RULE (CLOSE-UP — this overrides the usual "keep Image 1\'s crop" rule): crop in tight on the garment/product worn in Image 1, framing roughly the chest-to-waist area for a top or outer layer, the waist-to-knee area for a bottom, the feet for shoes, or the relevant body part for an accessory — a fashion detail photograph where the garment fills most of the frame. The face does NOT need to be in frame; it is completely fine for the head and most of the body to be cropped out. Zoom into what Image 1 already shows — never extend the frame or invent any body part, garment area, or detail that is not visible in Image 1; if a region is not present in Image 1, do not crop to it.'
      : hasPoseReferenceImage
      ? 'FRAMING RULE: match how much of the body Image 1 actually shows (do not invent a head/face if Image 1 is cropped at the neck or chest, do not invent feet if Image 1 crops above them). Within that limit, the CAMERA ANGLE and BODY ORIENTATION follow the pose reference image, not Image 1 — e.g. if the reference image shows a back view or profile, render a back view or profile here too, cropped to show the same vertical extent of the body as Image 1.'
      : 'FRAMING RULE (HIGHEST PRIORITY — overrides everything else in this prompt including the pose instruction): the output must have the exact same framing and crop as Image 1. If Image 1 does not show the head/face (cropped at the neck or chest), the output must be cropped identically and contain NO head and NO face — in that case, ignore every part of the pose instruction that mentions the head, face, chin, or gaze, and apply only the body/arm/leg parts of the pose. Never extend the frame or invent any body part (head, face, feet, etc.) that is not visible in Image 1.',
    ...(framing === 'close'
      ? [
          'CLOSE-UP DETAIL MANDATE: at this crop the fabric fills most of the frame, so its real structure must be legible — individual knit loops or weave threads, yarn thickness, ribbing direction, and real stitch threads at seams and edges, as an in-focus macro photograph of real cloth. Skin must read as real photographed skin with natural pores and the fine forearm hair already present in Image 1. This is a magnified view of the SAME garment in Image 1: do not re-texture, recolor, or reinterpret it — only resolve the detail that was already there at higher magnification.',
        ]
      : []),
    ...imageNotes,
    poseLine,
    // (2026-07-09) PERSONAL_BODY_SPEC 텍스트를 여기서 제거함 — 사용자 결정: AI 바리에이션은
    // "첨부된 사진을 그대로 가져와서 포즈만 바꾸는" 단계라, 텍스트 체형 스펙이 이미지와
    // 미묘하게 충돌해 재해석을 유발할 여지를 없앤다. 체형/피부톤/털/흉터 등 모델 정보는
    // 전부 AI 피팅(restyle) 단계에서만 주입되고, 바리에이션은 그 결과 사진 자체가 유일한 기준.
    // (2026-07-23) identity 앵커가 있을 때만 문구를 살짝 보강 — "다른 표준으로 조정하지 말라"에
    // 더해 근육/핏줄/스킨톤 드리프트를 구체적으로 금지한다(아래 NEGATIVE에도 중복 명시하되,
    // 이 줄은 "왜"를 설명하는 본문 문맥이라 완전히 겹치지 않는다).
    hasIdentityReferenceImage
      ? 'The person in Image 1 (confirmed by the identity reference image) IS the model — do not adjust the body, skin, or face toward any other standard, and do not make the physique look more toned, muscular, or veiny than it actually is.'
      : 'The person in Image 1 IS the model spec — do not adjust the body, skin, or face toward any other standard.',
    ...locationIntegrationBlock,
    '',
    '=== NEGATIVE CONSTRAINTS ===',
    // (2026-07-23) 실사용 확인 — 자세를 크게 바꾸면 몸이 과하게 근육질로 변하고 핏줄이 생기고
    // 얼굴이 미묘하게 달라지는 드리프트가 재현됐다. 매 컷 반드시 지켜야 하는 항목이라
    // identity 앵커 유무와 무관하게 항상 넣는다.
    'more muscular or toned than Image 1, added or exaggerated muscle definition, visible veins or vascularity not present in Image 1, tanned or darker skin than Image 1, different face shape, different facial features, different jawline, different eyes or nose, '
      + 'cartoon, illustration, CGI, 3D render, different person, different clothing, different color, different footwear, added or altered fabric pattern/texture, inventing body parts not shown in Image 1, extending the frame beyond Image 1\'s crop, extra limbs, bad hands, distorted anatomy, collage, split screen, multi-panel grid, watermark, text, logo, low resolution, blurry.'
      + (isCustomLocation
        ? ' cutout look, pasted-on subject, subject composited onto a backdrop, studio-lit subject standing in a location shot, missing contact shadow, floating above the ground, mismatched light direction between subject and scene, flat sticker-like silhouette edge, flat backdrop wall with no depth.'
        : ''),
    '',
    framing === 'close'
      ? `Single photorealistic commercial product DETAIL photograph — a tightly cropped close-up of the garment worn in Image 1, sharp focus on the fabric, ${isCustomLocation ? 'natural lighting consistent with the location' : 'professional studio lighting'}. Not a full-body shot.`
      : isCustomLocation
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
  quality: 'low' | 'medium' | 'high' = 'medium',
  isCustomPose: boolean = false,
  /** 배경 참고가 사용자가 올린 장소 사진인지 (기본 흰 스튜디오 참고 사진이면 false) */
  isCustomLocation: boolean = false,
  /** "모델 정보와 동일" 토글이 켜져 있고 저장된 모델 참고 이미지가 있을 때만 전달됨 */
  identityReferenceImage: { buffer: Buffer; mimeType: string } | null = null,
  /** 사용자가 이 컷에 자세 텍스트도 함께 입력했는지 — 사진과 병행 시 우선순위 판단용 */
  hasCustomPoseText: boolean = false,
  /** (2026-07-23) 'close'면 Image 1의 옷 부위를 확대한 디테일컷으로 뽑는다 */
  framing: 'full' | 'close' = 'full',
): Promise<{ imageUrl: string; engineUsed: string }> {
  // 입력 이미지는 1024px로 다운스케일 — 페이로드/입력 토큰 절감
  const source = await downscaleImage(sourceBuf, sourceMime);
  const sourceFile = await toOpenAIFile(source.buffer, source.mimeType, `source.${source.mimeType.split('/')[1] || 'jpg'}`);
  // 순서가 buildVariationPrompt의 imageNotes 구성 순서(identity → background → pose)와
  // 정확히 일치해야 "Image N" 번호가 서로 어긋나지 않는다.
  const rawRefs = [identityReferenceImage, backgroundReferenceImage, poseReferenceImage].filter(
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
    !!identityReferenceImage,
    hasCustomPoseText,
    framing,
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
      // (2026-07-23) "모델 정보와 동일" 토글 — 기본 켜짐. 대부분의 바리에이션 입력이 대표님
      // 본인 모델(AI 피팅 결과)이라, 저장된 모델 참고 이미지를 identity 앵커로 같이 넣어서
      // 리포즈 도중 몸/핏줄/얼굴이 드리프트하는 걸 막는다. 본인 모델이 아닌 사진을 올릴 땐
      // 프론트에서 꺼서 보낸다.
      matchModelIdentity,
      // (2026-07-23) 'close'면 Image 1의 옷 부위를 확대한 디테일컷 — 전신 결과물을 그대로
      // 넣고 "이 옷 디테일만 가까이" 컷을 뽑고 싶다는 요청.
      framing,
    } = await req.json();

    if (!sourceImageBase64) {
      return NextResponse.json({ success: false, error: 'AI 피팅 결과 사진 또는 직접 업로드한 사진이 필요합니다.' }, { status: 400 });
    }
    const oKey = openaiApiKey || process.env.OPENAI_API_KEY;
    if (!oKey) {
      return NextResponse.json({ success: false, error: 'OpenAI API 키가 필요합니다.' }, { status: 400 });
    }

    const resolvedFraming: 'full' | 'close' = framing === 'close' ? 'close' : 'full';
    // 클로즈업은 뭉개지면 안 되므로 low로는 안 내려가되(초안 모드여도 medium), high로는 올리지
    // 않는다 — 타이트 크롭 자체가 원단 픽셀을 크게 늘려 medium으로도 질감이 살고, high는 시간만
    // 크게 늘린다("너무 오래 걸린다" 신고 반영). AI 제품 피팅과 동일 정책.
    const resolvedQuality: 'low' | 'medium' | 'high' =
      resolvedFraming === 'close' ? 'medium' : draftMode ? 'low' : 'medium';

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
    const poses: Array<{
      pose: (typeof FULLBODY_POSES)[number];
      poseNumber: number | null;
      slotIndex: number;
      /** 사용자가 실제로 텍스트를 입력했는지 — 사진과 병행 시 우선순위 판단에 쓰인다 */
      hasCustomPoseText: boolean;
    }> =
      Array.from({ length: count }, (_, i) => {
        if (isCustomSlot(i)) {
          const text = customTexts[i];
          const hasImage = !!customPoseImages[i];
          // (2026-07-23) poseInstruction은 라벨/히스토리 표시용으로 원문 그대로 둔다 — 병합
          // 문구를 여기서 만들면 히스토리에 그 문구가 그대로 남고, "텍스트가 이미지와 충돌하면
          // 무시하라"는 우선순위 판단도 매번 새로 만든 병합 문장 안에 파묻혀 약해진다(실측
          // 확인 — "정면 응시"처럼 이미지와 정면충돌하는 텍스트가 실제로 이겨버렸다). 우선순위
          // 판단은 buildVariationPrompt 쪽에서 hasCustomPoseText로 명확히 분기해서 처리한다.
          const poseInstruction = hasImage && !text
            ? 'Match the body pose, camera angle, and framing shown in the pose reference image exactly.'
            : text;
          return {
            pose: { id: 'custom', label: count > 1 ? `커스텀 자세 ${i + 1}` : '커스텀 자세', poseInstruction },
            poseNumber: null,
            slotIndex: i,
            hasCustomPoseText: !!text,
          };
        }
        const picked = randomPosesForEmptySlots[randomCursor];
        randomCursor += 1;
        return { ...picked, slotIndex: i, hasCustomPoseText: false };
      });

    // 포즈마다 "처리 중" 행을 먼저 만들어 id를 즉시 반환한다 — 실제 생성은 아래 after()에서 진행.
    const jobs = await Promise.all(
      poses.map(async ({ pose, poseNumber, slotIndex, hasCustomPoseText }) => ({
        generationId: await createPendingGeneration({
          pipeline: 'restyle',
          modeOrCategory: 'variation',
          poseLabel: pose.label,
          prompt: pose.poseInstruction,
        }),
        pose,
        slotIndex,
        poseNumber,
        hasCustomPoseText,
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

      // (2026-07-23) "모델 정보와 동일" 토글 — 기본 켜짐(값이 안 왔거나 true일 때). 로그인 세션의
      // 저장된 모델 참고 이미지를 identity 앵커로 가져온다. 없으면(비로그인/미저장) 조용히
      // null로 진행 — 기존처럼 Image 1만으로 생성된다.
      const useModelIdentity = matchModelIdentity !== false;
      let identityReferenceImage: { buffer: Buffer; mimeType: string } | null = null;
      if (useModelIdentity) {
        try {
          const uid = await getSessionUserId();
          if (uid) identityReferenceImage = await getModelIdentityImage(uid);
        } catch (err) {
          console.warn('[api/variation] 모델 정체성 참고 이미지 조회 실패 — 앵커 없이 진행:', err);
        }
      }

      // 전체 병렬 대신 3개씩 배치 — 이미지 API 분당 한도(429)로 일부 포즈만 성공하는 것 방지
      await runWithConcurrency(jobs, 3, async ({ generationId, pose, poseNumber, slotIndex, hasCustomPoseText }) => {
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
            const { imageUrl } = await runSingleVariation(openai, sourceBuf, sourceMime, pose.poseInstruction, backgroundReferenceImage, poseReferenceImage, resolvedQuality, pose.id === 'custom', isCustomLocation, identityReferenceImage, hasCustomPoseText, resolvedFraming);
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
