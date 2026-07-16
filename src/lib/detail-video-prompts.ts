/**
 * detail-video-prompts.ts
 * "디테일컷" 짧은 영상(3초 안팎) 프롬프트 빌더 — 원단/촉감/핏 특성을 동작으로 보여주는
 * 세로형 숏폼용 영상을 Gemini(Veo)로 생성할 때 쓴다.
 *
 * 가장 중요한 제약: 입력 사진의 얼굴/체형/원단 재질은 절대 바뀌면 안 된다. Veo는 이미지를
 * "느슨한 영감"으로만 참고하고 새로 그려버리는 경향이 있어, 바리에이션(gpt-image-2 edit)과
 * 달리 "이 사진 자체가 정답"이라는 프레이밍을 프롬프트 맨 앞과 부정 제약 양쪽에 반복해서
 * 못박아야 한다.
 */

export function buildDetailVideoPrompt(detailInstruction: string): string {
  return [
    '=== TASK: SHORT PRODUCT-DETAIL VIDEO FROM A REAL COMMERCIAL PHOTO ===',
    'The attached image is the exact, unchangeable source of truth for the face, body, skin tone, and every garment (color, fabric, print, fit). Do not redesign, restyle, or reinterpret anything about the person or the clothing — this is the same photo brought to life with one small motion, not a new scene.',
    '',
    `MOTION TO SHOW (the only thing that should move/change across frames): ${detailInstruction}`,
    '',
    '=== NEGATIVE CONSTRAINTS (highest priority) ===',
    'different person, different face, different body shape, different skin tone, different garment color, different fabric pattern or texture, different fit or silhouette, new clothing items, changing background/location, camera cuts, scene changes, added text, logo, watermark, cartoon, illustration, CGI look.',
    '',
    'Single continuous shot, photorealistic, same framing as the source photo, natural handheld-adjacent camera stability, soft realistic lighting matching the source photo.',
  ].join('\n');
}

/** 자주 쓰는 디테일 동작 프리셋 — UI에서 바로 고를 수 있게. 필요하면 자유 텍스트로 대체 가능. */
export const DETAIL_VIDEO_PRESETS = [
  {
    id: 'fabric-touch',
    label: '원단 촉감 (손으로 문지르기)',
    instruction:
      "The model's hand gently rubs/brushes back and forth over the fabric of the garment (e.g. sleeve or chest area) to show how soft and smooth the material feels. Hand and fabric motion only — everything else stays still.",
  },
  {
    id: 'waistband-stretch',
    label: '밴딩 신축성 (늘렸다 놓기)',
    instruction:
      "The model's hands grip the waistband or hem of the garment and gently stretch it outward, then release it back to its original shape, to demonstrate elastic stretch and comfort. Hand and fabric motion only — everything else stays still.",
  },
  {
    id: 'fit-drape',
    label: '핏/드레이프 (몸을 살짝 틀기)',
    instruction:
      'The model turns their torso slightly side to side (a small, subtle weight shift, not a full body turn) so the way the garment drapes and falls on the body is visible. Keep the camera and framing fixed.',
  },
] as const;
