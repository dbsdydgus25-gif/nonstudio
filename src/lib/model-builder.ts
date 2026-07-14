/**
 * model-builder.ts — "가상 모델 만들기" 프롬프트 빌더 (2026-07-14 신설)
 *
 * 플로우: 기본 정보(성별/나이/키/몸무게/신발) → 신체 특징(피부톤/털/핏줄/상처 등) →
 * 외모(프리셋 또는 직접 입력) → 초안 1장(low, 흰 스튜디오, 전신 정면) 미리보기 →
 * 확정 시 고품질 정면 + 뒤/좌/우 4컷을 계정 저장소에 저장.
 *
 * 규칙:
 * - 참고 이미지 속 모델은 남녀노소 무조건 "검은색 반팔 티셔츠 + 검은색 반바지" (맨발) —
 *   기준 사진의 옷/신발이 이후 생성으로 새어 나가는 leak을 원천 차단하는 중립 유니폼.
 * - 상세 영문 스펙(specText)은 여기서 결정적으로 조립되어 백엔드에만 저장되고,
 *   사용자에게는 입력한 큰 정보(성별/나이/수치/특징 요약)만 보여준다.
 * - 반복 강조는 과장을 유발하므로 각 특징은 한 번만 서술한다 (과거 핏줄/텍스처 교훈).
 */

import { DEFAULT_STUDIO_BACKGROUND } from './fitting-prompts';

export interface ModelBuilderInput {
  name: string;
  gender: 'male' | 'female';
  age: number;
  heightCm: number;
  weightKg: number;
  shoeSizeMm: number;
  /** 피부톤 프리셋 키 */
  skinTone: 'fair' | 'natural' | 'tan';
  /** 신체 특징 자유 입력 (핏줄/털/상처/점 등, 한국어 허용) */
  featuresText: string;
  /** 외모 프리셋 키 또는 'custom' */
  appearancePreset: 'clean_urban' | 'chic_editorial' | 'soft_warm' | 'custom';
  /** appearancePreset === 'custom'일 때 사용자 외모 프롬프트 */
  appearanceCustomText?: string;
}

export const SKIN_TONE_LABEL: Record<ModelBuilderInput['skinTone'], string> = {
  fair: '밝은 톤',
  natural: '자연스러운 톤',
  tan: '태닝 톤',
};

const SKIN_TONE_EN: Record<ModelBuilderInput['skinTone'], string> = {
  fair: 'a fair, bright and even Korean skin tone — clean and healthy, not porcelain-white or sickly pale',
  natural: 'a natural neutral Korean skin tone — like an ordinary healthy person, neither noticeably pale nor tanned',
  tan: 'a warm, sun-kissed tanned Korean skin tone — healthy and realistic, not an exaggerated or saturated dark tan',
};

export const APPEARANCE_PRESETS: Array<{
  key: Exclude<ModelBuilderInput['appearancePreset'], 'custom'>;
  label: string;
  desc: string;
}> = [
  { key: 'clean_urban', label: '깔끔한 도시형', desc: '단정한 머리, 호감형의 세련된 얼굴' },
  { key: 'chic_editorial', label: '시크한 모델형', desc: '뚜렷한 이목구비, 패션 화보 분위기' },
  { key: 'soft_warm', label: '부드러운 훈훈형', desc: '온화한 인상, 자연스러운 미소가 어울리는 얼굴' },
];

function appearanceEnglish(input: ModelBuilderInput): string {
  const genderNoun = input.gender === 'male' ? 'man' : 'woman';
  switch (input.appearancePreset) {
    case 'clean_urban':
      return `a clean-cut, polished urban Korean ${genderNoun} — neat well-groomed dark hair, approachable good-looking face with balanced features`;
    case 'chic_editorial':
      return `a chic, editorial-fashion-model Korean ${genderNoun} — sharp well-defined features, calm confident expression, high-fashion presence`;
    case 'soft_warm':
      return `a soft, warm-impression Korean ${genderNoun} — gentle friendly features, natural relaxed expression that suits a subtle smile`;
    case 'custom':
      return `(user-described appearance, follow faithfully): ${input.appearanceCustomText?.trim() || 'a natural, realistic Korean face'}`;
  }
}

/** 고정 유니폼 — 남녀노소 공통 */
const FIXED_OUTFIT =
  'OUTFIT (FIXED, NON-NEGOTIABLE): a plain solid-black fitted short-sleeve t-shirt and plain solid-black shorts. No logos, no prints, no accessories, no shoes — barefoot. This neutral uniform exists so nothing in the outfit distracts from the body itself.';

/**
 * 상세 영문 스펙 — 백엔드 전용. 이후 모든 생성(AI 피팅/제품 피팅)의 bodySpec으로 그대로 사용된다.
 * buildBodySpecFromProfile()의 중복 헤더 감지(/Height \d+cm/)와 맞물리도록 첫 줄 형식을 유지한다.
 */
export function buildModelSpecText(input: ModelBuilderInput): string {
  const genderLine = input.gender === 'male' ? 'Male' : 'Female';
  const lines = [
    `- Height ${input.heightCm}cm, Weight ${input.weightKg}kg, Shoe/foot size ${input.shoeSizeMm}mm (Korean ${input.shoeSizeMm} size).`,
    `- ${genderLine}, ${input.age} years old — the apparent age must clearly read as ${input.age}.`,
    `- Skin tone: ${SKIN_TONE_EN[input.skinTone]}.`,
    `- Appearance: ${appearanceEnglish(input)}.`,
  ];
  if (input.featuresText.trim()) {
    lines.push(
      `- Distinct body characteristics (follow each item exactly as written; keep every detail subtle and photo-realistic, visible only at the described intensity): ${input.featuresText.trim()}`,
    );
  }
  lines.push(
    '- This physique, face, and skin tone are a fixed personal standard and must stay identical across every generation.',
  );
  return lines.join('\n');
}

/**
 * 확정 정보(specText)와 참고 이미지 속 얼굴이 충돌할 때의 우선순위 안내 —
 * 사용자가 입력한 수치(키/몸무게/나이 등)와 텍스트 특징은 항상 참고 이미지보다 우선한다.
 * (참고 이미지는 "얼굴/헤어스타일/분위기"만 가져오는 용도로 스코프를 명확히 제한 —
 * 스코프 없는 우선순위 문구가 다른 섹션을 무력화시켰던 과거 사고 패턴을 피한다.)
 */
const REFERENCE_IMAGE_SCOPE =
  'One of the input images is an APPEARANCE REFERENCE ONLY — use it to match the face shape, facial features, hairstyle, and general impression of the person. Do NOT copy the clothing, pose, background, or lighting from that reference photo; those are fully replaced by the instructions below. If the reference photo conflicts with the MODEL SPEC below (age, height/weight impression, skin tone, etc.), the MODEL SPEC always wins.';

/** 초안(정면 전신 1장) 생성 프롬프트 — 참고 이미지가 있을 때 (images.edit 용) */
export function buildModelDraftFromReferencePrompt(input: ModelBuilderInput): string {
  return [
    '=== TASK: CREATE A VIRTUAL FITTING MODEL FROM AN APPEARANCE REFERENCE ===',
    'Generate a photorealistic full-body studio photograph of exactly ONE person — a virtual fashion fitting model for a clothing brand. This is a real-photo-grade image, not an illustration or 3D render.',
    '',
    REFERENCE_IMAGE_SCOPE,
    '',
    '=== MODEL SPEC (ground truth) ===',
    buildModelSpecText(input),
    '',
    FIXED_OUTFIT,
    '',
    '=== POSE & FRAMING (ABSOLUTE) ===',
    'Standing straight facing the camera, arms relaxed naturally at the sides, feet shoulder-width apart. FULL BODY — head to toe fully visible, nothing cropped. Gaze relaxed toward the camera, calm neutral expression.',
    `Background: ${DEFAULT_STUDIO_BACKGROUND}`,
    '',
    '=== NEGATIVE CONSTRAINTS ===',
    'cartoon, illustration, CGI, 3D render, airbrushed plastic skin, mannequin look, deformed anatomy, extra limbs, bad hands, multiple people, collage, split screen, text, watermark, logo.',
    '',
    '=== OUTPUT ===',
    'One single authentic studio photograph of one person. Natural skin texture with pores, natural fabric folds, professional soft studio lighting.',
  ].join('\n');
}

/** 초안(정면 전신 1장) 생성 프롬프트 — images.generate 용 */
export function buildModelDraftPrompt(input: ModelBuilderInput): string {
  return [
    '=== TASK: CREATE A VIRTUAL FITTING MODEL ===',
    'Generate a photorealistic full-body studio photograph of exactly ONE person — a virtual fashion fitting model for a clothing brand. This is a real-photo-grade image, not an illustration or 3D render.',
    '',
    '=== MODEL SPEC (ground truth) ===',
    buildModelSpecText(input),
    '',
    FIXED_OUTFIT,
    '',
    '=== POSE & FRAMING (ABSOLUTE) ===',
    'Standing straight facing the camera, arms relaxed naturally at the sides, feet shoulder-width apart. FULL BODY — head to toe fully visible, nothing cropped. Gaze relaxed toward the camera, calm neutral expression.',
    `Background: ${DEFAULT_STUDIO_BACKGROUND}`,
    '',
    '=== NEGATIVE CONSTRAINTS ===',
    'cartoon, illustration, CGI, 3D render, airbrushed plastic skin, mannequin look, deformed anatomy, extra limbs, bad hands, multiple people, collage, split screen, text, watermark, logo.',
    '',
    '=== OUTPUT ===',
    'One single authentic studio photograph of one person. Natural skin texture with pores, natural fabric folds, professional soft studio lighting.',
  ].join('\n');
}

/** 확정 단계 — 초안 이미지를 기반으로 고품질 정면을 다시 뽑는 프롬프트 (images.edit 용) */
export function buildModelFrontFinalPrompt(input: ModelBuilderInput): string {
  return [
    'The input image shows a virtual fitting model. Regenerate the SAME person — identical face, hair, skin tone, and body — as a higher-fidelity professional studio photograph.',
    'Keep everything about the person unchanged. Same outfit: plain black short-sleeve t-shirt, plain black shorts, barefoot.',
    'Standing straight facing the camera, arms relaxed at sides, FULL BODY head to toe, nothing cropped. Exactly ONE person.',
    `Background: ${DEFAULT_STUDIO_BACKGROUND}`,
    '',
    '=== MODEL SPEC (must match) ===',
    buildModelSpecText(input),
    '',
    'Photorealistic, natural skin texture, professional lighting. No CGI, no collage, no text.',
  ].join('\n');
}

/** 확정 단계 — 정면 확정본에서 뒤/좌/우 뷰를 뽑는 프롬프트 (images.edit 용) */
export function buildModelViewPrompt(view: 'back' | 'left' | 'right'): string {
  const viewLine =
    view === 'back'
      ? 'Turn the person to show a full BACK view — the camera sees the back of the head, back, and legs. Do not show the face.'
      : view === 'left'
        ? 'Turn the person to show a full LEFT-SIDE profile view — body rotated 90 degrees so the left side faces the camera, face in true side profile looking straight ahead (not at the camera).'
        : 'Turn the person to show a full RIGHT-SIDE profile view — body rotated 90 degrees so the right side faces the camera, face in true side profile looking straight ahead (not at the camera).';
  return [
    'The input image shows a virtual fitting model standing facing the camera. Generate the SAME person — identical face shape, hairstyle, skin tone, body proportions, and the exact same outfit (plain black short-sleeve t-shirt, plain black shorts, barefoot) — photographed in the same white studio, same lighting.',
    viewLine,
    'Standing straight, arms relaxed naturally at the sides. FULL BODY head to toe, nothing cropped. Exactly ONE person, one single frame.',
    `Background: ${DEFAULT_STUDIO_BACKGROUND}`,
    'Photorealistic, natural skin texture. No CGI, no collage, no text.',
  ].join('\n');
}
