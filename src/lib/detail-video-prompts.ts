/**
 * detail-video-prompts.ts
 * "AI 영상" 프롬프트 빌더 — 제품 착용 컷을 짧은 세로형 영상(4초)으로 만들 때 쓴다.
 *
 * 가장 중요한 제약: 입력 사진의 얼굴/체형/원단 재질은 절대 바뀌면 안 된다. Veo는 이미지를
 * "느슨한 영감"으로만 참고하고 새로 그려버리는 경향이 있어, 바리에이션(gpt-image-2 edit)과
 * 달리 "이 사진 자체가 정답"이라는 프레이밍을 프롬프트 맨 앞과 부정 제약 양쪽에 반복해서
 * 못박아야 한다.
 *
 * (2026-07-22) 두 가지 모드로 분리:
 * - 'detail' — 프레이밍 고정, 손/원단만 움직이는 작은 동작 (원단 촉감·신축성 등)
 * - 'motion' — 인물이 실제로 움직임 (걷기·몸 돌리기). 기존 프롬프트는 "same framing" /
 *   "one small motion"을 강제해서 걷는 영상에는 정면으로 충돌했다.
 *
 * 부정 제약을 프롬프트 본문에 두는 이유: Veo 3.1 lite는 SDK의 `negativePrompt` 파라미터를
 * 지원하지 않는다(실측 400 INVALID_ARGUMENT). 그래서 본문에 넣는 것이 유일한 경로다.
 */

export type MotionKind = 'detail' | 'motion';

/** 두 모드 공통 — 인물/의상 동일성 못박기 (맨 앞과 부정 제약에 각각 한 번씩) */
const IDENTITY_LOCK =
  'The attached image is the exact, unchangeable source of truth for the face, body, skin tone, and every garment (color, fabric, print, fit). Do not redesign, restyle, or reinterpret anything about the person or the clothing — this is the same photo brought to life, not a new scene.';

const COMMON_NEGATIVES =
  'different person, different face, different body shape, different skin tone, different garment color, different fabric pattern or texture, different fit or silhouette, new clothing items, changing location, camera cuts, scene changes, added text, logo, watermark, cartoon, illustration, CGI look, warped hands, extra limbs.';

export function buildDetailVideoPrompt(detailInstruction: string, kind: MotionKind = 'detail'): string {
  if (kind === 'motion') {
    return [
      '=== TASK: SHORT FASHION MOTION VIDEO FROM A REAL COMMERCIAL PHOTO ===',
      IDENTITY_LOCK,
      '',
      `MOTION TO PERFORM: ${detailInstruction}`,
      '',
      '=== HOW THE MOVEMENT SHOULD LOOK ===',
      '- Real human movement: natural weight shift, believable balance, relaxed limbs. Not a stiff mannequin turn, not a looping animation cycle.',
      '- The garment must move WITH the body — fabric sways, folds shift, and hems settle with real cloth weight and inertia. This is the point of the shot: show how the clothing actually behaves on a moving person.',
      '- Keep the person fully in frame for the whole clip. The camera may hold still or follow gently, but stay in one continuous shot in the same place.',
      '- Keep it to one simple, complete action over the clip — do not rush through several different moves.',
      '',
      '=== NEGATIVE CONSTRAINTS (highest priority) ===',
      COMMON_NEGATIVES + ' floating or gliding feet, sliding without steps, teleporting, morphing body, rubber-limb motion, speed ramping.',
      '',
      'Single continuous photorealistic shot, vertical framing, natural lighting consistent with the source photo, steady professional camera.',
    ].join('\n');
  }

  return [
    '=== TASK: SHORT PRODUCT-DETAIL VIDEO FROM A REAL COMMERCIAL PHOTO ===',
    IDENTITY_LOCK + ' Only one small motion happens; everything else holds still.',
    '',
    `MOTION TO SHOW (the only thing that should move/change across frames): ${detailInstruction}`,
    '',
    '=== NEGATIVE CONSTRAINTS (highest priority) ===',
    COMMON_NEGATIVES + ' whole-body movement, walking, changing pose, re-framing the shot.',
    '',
    'Single continuous shot, photorealistic, same framing as the source photo, natural handheld-adjacent camera stability, soft realistic lighting matching the source photo.',
  ].join('\n');
}

/** 자주 쓰는 동작 프리셋 — UI에서 바로 고를 수 있게. 필요하면 자유 텍스트로 대체 가능. */
export const DETAIL_VIDEO_PRESETS = [
  // ── 디테일 모션 (프레이밍 고정, 손/원단만 움직임) ──────────────────────────
  {
    id: 'fabric-touch',
    kind: 'detail' as const,
    label: '원단 촉감 (손으로 문지르기)',
    instruction:
      "The model's hand gently rubs/brushes back and forth over the fabric of the garment (e.g. sleeve or chest area) to show how soft and smooth the material feels. Hand and fabric motion only — everything else stays still.",
  },
  {
    id: 'waistband-stretch',
    kind: 'detail' as const,
    label: '밴딩 신축성 (늘렸다 놓기)',
    instruction:
      "The model's hands grip the waistband or hem of the garment and gently stretch it outward, then release it back to its original shape, to demonstrate elastic stretch and comfort. Hand and fabric motion only — everything else stays still.",
  },
  {
    id: 'fit-drape',
    kind: 'detail' as const,
    label: '핏/드레이프 (몸을 살짝 틀기)',
    instruction:
      'The model turns their torso slightly side to side (a small, subtle weight shift, not a full body turn) so the way the garment drapes and falls on the body is visible. Keep the camera and framing fixed.',
  },
  // ── 전신 모션 (인물이 실제로 움직임) ──────────────────────────────────────
  {
    id: 'walk-toward',
    kind: 'motion' as const,
    label: '걸어오기 (정면으로 걷기)',
    instruction:
      'The model walks forward toward the camera with a natural, relaxed stride — normal everyday walking pace, arms swinging naturally, feet clearly making contact with the ground on each step. The garment sways and settles with each step.',
  },
  {
    id: 'walk-away',
    kind: 'motion' as const,
    label: '뒤돌아 걸어가기 (뒷모습)',
    instruction:
      'The model turns and walks away from the camera at a relaxed pace, showing the back of the outfit. Natural stride with clear ground contact; the back of the garment moves with the body.',
  },
  {
    id: 'turn-around',
    kind: 'motion' as const,
    label: '한 바퀴 돌기 (360도)',
    instruction:
      'Standing in place, the model turns their whole body around smoothly and evenly to show the outfit from every side, then settles facing the camera again. Feet step naturally through the turn; the garment follows the rotation with real fabric weight.',
  },
  {
    id: 'shift-weight',
    kind: 'motion' as const,
    label: '자연스러운 무게중심 이동',
    instruction:
      'The model shifts their weight from one leg to the other and adjusts their posture in a natural, candid way, as if between shots on a photoshoot. Subtle full-body movement; the garment settles naturally with the shift.',
  },
] as const;
