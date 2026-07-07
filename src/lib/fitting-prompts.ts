/**
 * fitting-prompts.ts
 * 피팅 모드별 고정 시스템 프롬프트 + 사용자 추가 프롬프트 병합 엔진
 * 변동성 최소화의 핵심 — 모든 AI 호출이 이 파일을 통과함
 */

export type FittingMode = 'top' | 'bottom' | 'fullbody';

// ─────────────────────────────────────────────────────────────────
// 0. 사용자 고정 체형 스펙 (단일 기준 — 모델 피팅 / AI 리스타일링 두 파이프라인 모두 동일하게 적용)
// 어떤 사진을 넣든 항상 동일한 체형/피부톤/비율로 결과가 나오도록, 파이프라인마다 따로 적지 않고 여기 하나만 수정한다.
// ─────────────────────────────────────────────────────────────────
export const PERSONAL_BODY_SPEC = `
- Height 177cm, Weight 74kg, Shoe/foot size 270mm (Korean 270 size).
- Well-proportioned upper body — balanced shoulder-to-waist ratio, not top-heavy.
- Skin tone: light tan with warm undertone — a common, natural Korean skin tone (NOT pale white, NOT deeply dark).
- Build: athletic and visibly toned, lean muscular definition — NOT a bulky bodybuilder, NOT skinny.
- Arms: defined, toned forearms and biceps with natural muscle definition visible under the skin. At most one or two very faint forearm veins may show when the arm is flexed or holding an object — this must read as ordinary healthy skin, like a fit regular person, NOT a bodybuilder. Avoid thick, dark, prominent, or excessive vein lines.
- Chest: firm and toned with well-defined pecs. Absolutely NOT soft, puffy, or sagging — no gynecomastia-like chest under any circumstance.
- Legs: moderately toned and firm, athletic proportion — NOT the thin/skinny-lean leg type.
- This exact physique (toned build, subtle natural arm definition, defined chest) is a FIXED personal standard and must be reproduced identically in every single generation — not a random variation per photo.
`.trim();

// ─────────────────────────────────────────────────────────────────
// 1. 얼굴 포함 모델 정보 (도저히 구도가 안 나와서 얼굴을 그려야 할 때)
// ─────────────────────────────────────────────────────────────────
export const MODEL_BODY_SPEC_WITH_FACE = `
Model Identity (Face-Included):
- Handsome young Korean male model, age 25-30.
- Hair: short, neatly styled black hair with a subtle wave, swept back from the forehead with natural volume on top.
- Face & Features: refined oval face shape, taper jawline, light-to-medium clean skin tone. Dark, almond-shaped eyes (monolid or very subtle crease), a straight, well-defined nose with a subtle rounded tip, and a strong tapering chin. Neat groomed dark eyebrows.
${PERSONAL_BODY_SPEC}
- Note on original image clothes (TO BE REPLACED): The model in the input image is wearing a basic black t-shirt and black pants, which should be completely replaced with the new garments described below.
`.trim();

// ─────────────────────────────────────────────────────────────────
// 공통 ID 보존 지시 동적 생성기 (얼굴/배경 매핑 처리)
// ─────────────────────────────────────────────────────────────────
function getIdentityLock(generateFace: boolean, hasCustomBackground: boolean): string {
  const bgInstruction = hasCustomBackground
    ? "- Blend the model naturally into the specified background setting, ensuring realistic shadows and light integration. Do NOT keep it a white studio."
    : "- Do NOT modify the background. Keep it a clean white studio background.";

  const poseLock = "- Strict Pose & Joint Lock: Maintain the model's original physical body pose, leg stance, arm placement, and hand positions exactly as shown in the input base image. Do NOT warp, twist, or modify the limbs or body joints. Only replace the clothing fabric on top of the body.";

  if (generateFace) {
    return `
CRITICAL IDENTITY & SAFETY LOCK:
- Keep the model's body shape, posture, and skin tone 100% identical to the reference.
- Maintain the specified Korean handsome model face and neat hairstyle consistently in all shots.
${poseLock}
${bgInstruction}
- Anatomical & Physical Plausibility: Hands, fingers, and arms must look 100% natural and physically plausible. If the model holds a cup/object, their fingers must wrap around it realistically. No floating cups, no overlapping joints, no distorted hand anatomy.
- Focus strictly on clothing fitting. Avoid hallucinating extra elements.
`.trim();
  } else {
    return `
CRITICAL IDENTITY & SAFETY LOCK:
- Keep the model's body shape, posture, and skin tone 100% identical to the reference.
- Do NOT generate a face, hair, eyes, or head. The top edge of the photo must naturally cut off the head.
${poseLock}
${bgInstruction}
- Anatomical & Physical Plausibility: Hands, fingers, and arms must look 100% natural and physically plausible. If the model holds a cup/object, their fingers must wrap around it realistically. No floating cups, no overlapping joints, no distorted hand anatomy.
- Focus strictly on clothing fitting. Avoid hallucinating extra elements.
`.trim();
  }
}

const NEGATIVE_CONSTRAINTS_WITH_FACE = `
CRITICAL NEGATIVE CONSTRAINTS (DO NOT GENERATE):
bag, handbag, duffel bag, backpack, luggage, purse, wallet, accessories, head cropped incorrectly, cartoon, illustration, CGI, 3D render, digital art, video game graphics, airbrushed skin, plastic skin, smooth glossy face, mannequin texture, artificial doll look, low resolution, blurry, deformed body, incorrect anatomy, extra limbs, bad hands, floating cup, floating coffee, overlapping fingers, unnatural pose, oversaturated colors, unrealistic clothing folds, fake lighting, warped background, artifacts, logos, text, watermark, composite look, collage, split screen, multi-panel, grid of photos, side-by-side comparison, diptych, triptych, photo montage, layout of multiple images.
`.trim();

const TOP_FIXED_PROMPT_WITH_FACE = `
Camera framing: Tight upper body shot — close-up of chest, shoulders, and sleeves. The lower body (below the waistband), hips, thighs, legs, and feet are COMPLETELY cropped out and must NOT be visible. Focus on chest up to the chin and head naturally.
The garment must be worn naturally on the model's body.
Fit accuracy rules:
  - If the garment is OVERSIZED/BOXY: fabric hangs loose from shoulders, chest has significant ease, waist is not fitted, showing boxy fit.
  - If the garment is REGULAR FIT: natural drape, slight ease at chest and waist.
  - If the garment is SLIM FIT: fabric hugs the body closely, chest and waist contours visible.
Fabric texture, material sheen, wrinkle pattern, and garment details (pockets, zippers, buttons, drawstrings, logos) must be reproduced with 100% accuracy.
`.trim();

const FULLBODY_FIXED_PROMPT_WITH_FACE = `
Camera framing: Full body shot — head to toe. 177cm height ratio must be accurate.
The complete outfit must be shown with accurate proportions reflecting the 177cm/74kg body spec above.
Both top and bottom garment fit rules apply simultaneously.
Footwear: simple slide sandals or casual sneakers, sized for a 270mm (Korean 270) foot.
Garment layering, overlap, and proportion between top and bottom must look natural and cohesive.
`.trim();

// ─────────────────────────────────────────────────────────────────
// 2. 얼굴 없는 모델 정보 (기본값 - 자연스러운 카메라 크롭)
// ─────────────────────────────────────────────────────────────────
export const MODEL_BODY_SPEC_FACELESS = `
Model Identity (Faceless Crop):
- Athletic male fashion model.
- Cropped naturally at the collarbone/neck so the head is outside the photo frame.
${PERSONAL_BODY_SPEC}
- Note on original image clothes (TO BE REPLACED): The model in the input image is wearing a basic black t-shirt and black pants, which should be completely replaced with the new garments described below.
`.trim();

const NEGATIVE_CONSTRAINTS_FACELESS = `
CRITICAL NEGATIVE CONSTRAINTS (DO NOT GENERATE):
face, head, hair, bag, handbag, duffel bag, backpack, luggage, purse, wallet, accessories, head cropped incorrectly, cartoon, illustration, CGI, 3D render, digital art, video game graphics, airbrushed skin, plastic skin, smooth glossy skin, mannequin texture, artificial doll look, low resolution, blurry, deformed body, incorrect anatomy, extra limbs, bad hands, floating cup, floating coffee, overlapping fingers, unnatural pose, oversaturated colors, unrealistic clothing folds, fake lighting, warped background, artifacts, logos, text, watermark, composite look, collage, split screen, multi-panel, grid of photos, side-by-side comparison, diptych, triptych, photo montage, layout of multiple images.
`.trim();

const TOP_FIXED_PROMPT_FACELESS = `
Camera framing: Tight upper body shot — close-up of chest, shoulders, and sleeves. The lower body (below the waistband), hips, thighs, legs, and feet are COMPLETELY cropped out and must NOT be visible. 
Crucially, the head must be positioned above the top frame border, so it is cropped out naturally by the camera (no white boxes, no flat horizontal neck line, just a natural photographic crop at the lower neck).
The garment must be worn naturally on the model's body.
Fit accuracy rules:
  - If the garment is OVERSIZED/BOXY: fabric hangs loose from shoulders, chest has significant ease, waist is not fitted, showing boxy fit.
  - If the garment is REGULAR FIT: natural drape, slight ease at chest and waist.
  - If the garment is SLIM FIT: fabric hugs the body closely, chest and waist contours visible.
Fabric texture, material sheen, wrinkle pattern, and garment details (pockets, zippers, buttons, drawstrings, logos) must be reproduced with 100% accuracy.
`.trim();

const FULLBODY_FIXED_PROMPT_FACELESS = `
Camera framing: Full body shot from the neck down. The head must be naturally cropped out at the top of the frame. 177cm height ratio must be accurate.
The complete outfit must be shown with accurate proportions reflecting the 177cm/74kg body spec above.
Both top and bottom garment fit rules apply simultaneously.
Footwear: simple slide sandals or casual sneakers, sized for a 270mm (Korean 270) foot.
Garment layering, overlap, and proportion between top and bottom must look natural and cohesive.
`.trim();

// ─────────────────────────────────────────────────────────────────
// 공통 고정 환경 설정 (모든 모드에 적용)
// ─────────────────────────────────────────────────────────────────
const FIXED_ENVIRONMENT = `
Studio environment:
- Clean minimalist white studio background with soft professional photographic lighting.
- Realistic clothing folds, natural fabric tension and drape.
- Captured on a professional 35mm lens, f/4 aperture, sharp focus on garment details.
- Authentic human skin texture with natural fine pores and subtle film grain. No CGI look.
`.trim();

// 모델 피팅과 동일한 기본 배경 문구 — 리스타일링에서 사용자가 배경을 따로 지시하지 않았을 때
// AI가 매번 다른 장소를 지어내지 않도록, 이 고정 문구를 그대로 재사용한다.
export const DEFAULT_STUDIO_BACKGROUND = 'Clean minimalist white studio background with soft professional photographic lighting — same neutral studio backdrop as standard product shots, no colorful gels, no outdoor or location scenery.';

// ─────────────────────────────────────────────────────────────────
// 하의 피팅 고정 프롬프트 (얼굴 유무와 상관없이 항상 하체 위주)
// ─────────────────────────────────────────────────────────────────
const BOTTOM_FIXED_PROMPT = `
Camera framing: Lower body shot — from waist to ankle/floor. No upper torso or head visible.
Model waist: 74-78cm (30-31 inch), Hip: athletic fit.
Fit accuracy rules:
  - Waistband position and fit must be accurate.
  - Thigh room, crotch depth, leg taper must match the garment's actual cut.
  - If WIDE LEG: significant ease throughout, fabric stacks at ankle.
  - If SLIM/SKINNY: close fit from hip to ankle.
  - If REGULAR/STRAIGHT: straight leg, moderate ease.
Inseam length, hem style, fabric drape and weight must be precisely reproduced.
Fabric texture & washing fidelity:
  - Heavy emphasis on authentic denim wash: The denim must show high-contrast fading, natural slub texture, visible twill weave patterns, and realistic wear-and-tear wrinkles. 
  - Thigh and knee area sandwashed fading effects must be clearly visible and contrast-rich.
  - Do NOT generate flat solid blue colors on the jeans; protect the natural denim grain and washing details.
`.trim();

// ─────────────────────────────────────────────────────────────────
// 의류 분석 결과 → 프롬프트 블록 생성
// ─────────────────────────────────────────────────────────────────
export interface GarmentAnalysis {
  color: string;
  material: string;
  fitType: 'oversized' | 'boxy' | 'regular' | 'slim' | 'wide-leg' | 'skinny' | 'straight' | 'unknown';
  category: 'top' | 'bottom' | 'outer' | 'dress' | 'shoes' | 'bag' | 'accessory' | 'unknown';
  details: string;          // 디테일 (지퍼, 주머니, 자수 등)
  texture: string;          // 질감 표현
  lightReaction: string;    // 빛 받을 때 표현 (광택, 무광, 셔링 등)
  chestWidth?: string;      // 가슴 단면
  length?: string;          // 기장
}

function buildGarmentBlock(analysis: GarmentAnalysis): string {
  return `
Garment to dress the model in:
- Color: ${analysis.color}
- Material/Fabric: ${analysis.material}
- Texture: ${analysis.texture}
- Light reaction: ${analysis.lightReaction}
- Fit type: ${analysis.fitType.toUpperCase()}
- Details: ${analysis.details}
${analysis.chestWidth ? `- Chest measurement: ${analysis.chestWidth}` : ''}
${analysis.length ? `- Length: ${analysis.length}` : ''}
Reproduce ALL garment details with photographic accuracy.
`.trim();
}

// ─────────────────────────────────────────────────────────────────
// 사전 설정된 모드별 포즈 바리에이션
// ─────────────────────────────────────────────────────────────────
export interface PoseVariation {
  id: string;
  label: string;
  poseInstruction: string;
}

export const TOP_POSES: PoseVariation[] = [
  {
    id: 'top_front_relaxed',
    label: '상의 정면 자연스러운 포즈',
    poseInstruction: 'Pose: Standing directly facing camera, arms relaxed at sides, hands loose. Focuses on chest width and sleeve fit.',
  },
  {
    id: 'top_arms_crossed',
    label: '상의 팔짱 포즈',
    poseInstruction: 'Pose: Standing facing camera with arms crossed over chest, hands tucked. Emphasizes shoulder breadth and fabric tension.',
  },
  {
    id: 'top_pocket_tuck',
    label: '상의 손 주머니 포즈',
    poseInstruction: 'Pose: Standing facing camera, hands casually tucked into front pants pockets. Highlights waist drape and side-front profile.',
  },
  {
    id: 'top_quarter_profile',
    label: '상의 쿼터뷰 측면 포즈',
    poseInstruction: 'Pose: Body turned 30 degrees side profile showing sleeve length, side seams, and shoulder-to-arm drape.',
  },
];

export const BOTTOM_POSES: PoseVariation[] = [
  {
    id: 'bottom_front_straight',
    label: '하의 정면 포즈',
    poseInstruction: 'Pose: Standing straight front view, feet slightly apart, showing clean front drape and waistband fit.',
  },
  {
    id: 'bottom_walking_stance',
    label: '하의 걷는 포즈',
    poseInstruction: 'Pose: Mid-stride walking stance with one leg slightly forward, showing leg width and fabric flow.',
  },
  {
    id: 'bottom_hand_pocket',
    label: '하의 손 주머니 포즈',
    poseInstruction: 'Pose: Standing naturally, thumbs or hands tucked into front pockets, showing waistband shape and pocket lines.',
  },
  {
    id: 'bottom_side_profile',
    label: '하의 측면 쿼터뷰 포즈',
    poseInstruction: 'Pose: Standing at a 45-degree angle, showing leg profile, side pocket seams, and back leg drape.',
  },
];

export const FULLBODY_POSES: PoseVariation[] = [
  {
    id: 'full_relaxed_front',
    label: '전신 정면 자연스러운 포즈',
    poseInstruction: 'Pose: Standing naturally, arms resting relaxed at sides, hands loose, wearing casual slide sandals. Entire silhouette is clean and balanced.',
  },
  {
    id: 'full_walking_front',
    label: '전신 걷는 포즈',
    poseInstruction: 'Pose: Walking forward confidently, relaxed arms, showcasing realistic movement folds in both top and bottom garments.',
  },
  {
    id: 'full_relaxed_pocket',
    label: '전신 릴렉스 포켓 포즈',
    poseInstruction: 'Pose: Hands casually tucked in pants pockets, feet shoulder-width apart, showing natural layering of top over bottom.',
  },
  {
    id: 'full_quarter_turn',
    label: '전신 쿼터뷰 측면 포즈',
    poseInstruction: 'Pose: Standing in a three-quarter turn, showing side silhouette, shoe details (slide sandals), and layering balance.',
  },
];

// ─────────────────────────────────────────────────────────────────
// 최종 포즈 주입형 프롬프트 병합 함수 (얼굴 생성 플래그 포함)
// ─────────────────────────────────────────────────────────────────
export function buildFittingPromptWithPose(
  mode: FittingMode,
  garmentAnalysis: GarmentAnalysis,
  pose: PoseVariation,
  userAdditions: string = '',
  customBackground?: string,
  generateFace: boolean = false
): string {
  // 1. 얼굴 유무 분기 처리
  const bodySpec = generateFace ? MODEL_BODY_SPEC_WITH_FACE : MODEL_BODY_SPEC_FACLESS_FALLBACK();
  const identityLock = getIdentityLock(generateFace, !!customBackground);
  const negativeConstraints = generateFace ? NEGATIVE_CONSTRAINTS_WITH_FACE : NEGATIVE_CONSTRAINTS_FACELESS;

  const modePrompt =
    mode === 'top'
      ? (generateFace ? TOP_FIXED_PROMPT_WITH_FACE : TOP_FIXED_PROMPT_FACELESS)
      : mode === 'bottom'
      ? BOTTOM_FIXED_PROMPT
      : (generateFace ? FULLBODY_FIXED_PROMPT_WITH_FACE : FULLBODY_FIXED_PROMPT_FACELESS);

  // 헬퍼: NFD 매핑 에러 방지용 함수
  function MODEL_BODY_SPEC_FACLESS_FALLBACK() {
    return MODEL_BODY_SPEC_FACELESS;
  }

  // 2. 의류 카테고리별/모드별 구체적인 교체 지시문 작성 (DALL-E 의류 고정 오버라이드)
  let replacementInstruction = "";
  const category = garmentAnalysis.category; // 'top' | 'bottom' | 'outer' | 'dress' | 'shoes' | 'bag' | 'accessory' | 'unknown'

  if (mode === 'top') {
    replacementInstruction = "REPLACEMENT INSTRUCTION (CRITICAL): Completely replace the model's original upper garment/shirt in the input image with the new garment described in the GARMENT SPECIFICATION below. The new shirt must replace the old one perfectly. Keep the model's original pants and belt.";
  } else if (mode === 'bottom') {
    replacementInstruction = "REPLACEMENT INSTRUCTION (CRITICAL): Completely replace the model's original lower garment/pants in the input image with the new garment described in the GARMENT SPECIFICATION below. The new pants must replace the old ones perfectly. Keep the model's original upper garment/shirt.";
  } else {
    // 전신 피팅 (fullbody)
    if (category === 'top') {
      replacementInstruction = "REPLACEMENT INSTRUCTION (CRITICAL): Completely replace the model's original upper garment/shirt in the input image with the new garment described in the GARMENT SPECIFICATION below. Keep the model's original lower garment/pants.";
    } else if (category === 'bottom') {
      replacementInstruction = "REPLACEMENT INSTRUCTION (CRITICAL): Completely replace the model's original lower garment/pants in the input image with the new garment described in the GARMENT SPECIFICATION below. Keep the model's original upper garment/shirt.";
    } else if (category === 'shoes') {
      replacementInstruction = "REPLACEMENT INSTRUCTION (CRITICAL): Replace the model's original sandals/shoes in the input image with the new footwear described in the GARMENT SPECIFICATION below. Keep the model's original upper garment and pants.";
    } else if (category === 'bag') {
      replacementInstruction = "REPLACEMENT INSTRUCTION (CRITICAL): Add or replace the bag held by the model or on the shoulder in the input image with the new bag described in the GARMENT SPECIFICATION below. Keep the model's original upper garment and pants.";
    } else if (category === 'accessory') {
      replacementInstruction = "REPLACEMENT INSTRUCTION (CRITICAL): Add the accessory described in the GARMENT SPECIFICATION below (e.g. watch, bracelet, necklace, sunglasses) onto the model's body in the input image. Keep the model's original upper garment and pants.";
    } else {
      replacementInstruction = "REPLACEMENT INSTRUCTION (CRITICAL): Completely replace both the model's original upper garment/shirt and lower garment/pants in the input image with the new garment/outfit described in the GARMENT SPECIFICATION below.";
    }
  }

  const userBlock = userAdditions.trim()
    ? `\nAdditional styling instructions from user:\n${userAdditions.trim()}`
    : '';

  const envPrompt = customBackground?.trim()
    ? `
Studio/Location environment:
- Background: ${customBackground.trim()}
- Lighting: Blend the model naturally into the environment lighting, physically accurate shadows and realistic light integration.
- Camera: Canon EOS R5 equivalent quality, sharp focus on garment.
- Photorealistic, commercial fashion photography style.
- 8K resolution quality.
`.trim()
    : FIXED_ENVIRONMENT;

  return [
    '=== IDENTITY PRESERVATION (ABSOLUTE) ===',
    identityLock,
    '',
    '=== MODEL BODY SPECIFICATION ===',
    bodySpec,
    '',
    '=== STUDIO ENVIRONMENT (DYNAMIC) ===',
    envPrompt,
    '',
    `=== FITTING MODE: ${mode.toUpperCase()} ===`,
    modePrompt,
    '',
    '=== REPLACEMENT DIRECTIVE ===',
    replacementInstruction,
    '',
    '=== POSE REFERENCE ===',
    pose.poseInstruction,
    '',
    '=== GARMENT SPECIFICATION ===',
    buildGarmentBlock(garmentAnalysis),
    userBlock,
    '',
    '=== NEGATIVE CONSTRAINTS (ABSOLUTE) ===',
    negativeConstraints,
    '',
    '=== OUTPUT QUALITY MANDATE ===',
    generateFace 
      ? 'Produce a single individual authentic commercial catalog photograph showing only one model in a single view. Absolutely NO collages, NO split screens, NO multi-panel layouts, NO side-by-side or multiple shots. Must have real skin pores, natural clothing folds, and look like a real human. No CGI, no 3D renders, no artificial smooth plastic skin.'
      : 'Produce a single individual authentic commercial catalog photograph showing only one model in a single view. Faceless crop: the head is naturally cropped out of the frame at the top. Absolutely NO collages, NO split screens, NO multi-panel layouts, NO side-by-side or multiple shots. Must have real skin pores, natural clothing folds. No CGI, no 3D renders, no artificial smooth plastic skin.'
  ].join('\n');
}

export const FITTING_MODE_INFO: Record<FittingMode, { label: string; icon: string; description: string }> = {
  top: {
    label: '상의 피팅',
    icon: '👕',
    description: '상반신 집중 컷. 옷의 어깨폭, 가슴 여유, 소매 핏 표현에 최적화.',
  },
  bottom: {
    label: '하의 피팅',
    icon: '👖',
    description: '하반신 집중 컷. 허리~발목 프레임(상체 없음). 밑위, 허벅지 여유, 기장, 핏감 표현에 최적화.',
  },
  fullbody: {
    label: '전신 피팅',
    icon: '🧍',
    description: '전신 컷. 전체 실루엣, 상하의 비율 연출에 최적화.',
  },
};

export const USER_ADDITION_EXAMPLES = [
  '주머니에 손을 넣고 있어줘',
  '은색 팔찌 차고 있게 해줘',
  '후드는 올려줘',
  '지퍼는 반만 내려줘',
  '한 손은 허리에 올려줘',
  '살짝 옆으로 돌아선 쿼터뷰로 찍어줘',
];

// ─────────────────────────────────────────────────────────────────
// 실사 기반 AI 리스타일링 (실사 사진 1장을 레퍼런스로 전신 재생성)
// ─────────────────────────────────────────────────────────────────

/** 사용자가 실제로 입고/착용한 실사 사진 속에서 "소싱한 실물 제품"에 해당하는 부위 */
export type SourcedCategory = 'top' | 'bottom' | 'shoes' | 'accessory';

/** 보존되지 않는 나머지 슬롯에 대해 AI가 자동 제안하는 코디 설명 */
export interface StylingSuggestion {
  bottom?: string;
  shoes?: string;
  accessory?: string;
  background: string;
}

const RESTYLE_QUALITY_CONSTRAINTS = `
CRITICAL NEGATIVE CONSTRAINTS (DO NOT GENERATE):
cartoon, illustration, CGI, 3D render, digital art, video game graphics, airbrushed skin, plastic skin, mannequin texture, artificial doll look, low resolution, blurry, deformed body, incorrect anatomy, extra limbs, bad hands, overlapping fingers, unnatural pose, oversaturated colors, fake lighting, warped background, artifacts, logos, text, watermark, composite look, collage, split screen, multi-panel, grid of photos, side-by-side comparison, diptych, triptych, photo montage, layout of multiple images, soft puffy chest, sagging chest, gynecomastia-like chest, love handles, flabby untoned body, out-of-shape physique, hunched posture, awkward stiff pose.
`.trim();

const RESTYLE_BODY_SPEC = `
MODEL BODY SPEC (reshape the body toward this — do not literally copy the input photo's actual body shape):
${PERSONAL_BODY_SPEC}
- Keep the same face and general identity recognizable — this is a refinement of the same person, not a different person.
`.trim();

const CATEGORY_PRESERVE_LABEL: Record<SourcedCategory, string> = {
  top: '상의(윗옷)',
  bottom: '하의(바지/스커트)',
  shoes: '신발',
  accessory: '액세서리(가방/시계/주얼리 등)',
};

function buildGarmentFidelityBlock(category: SourcedCategory, garmentAnalysis: GarmentAnalysis): string {
  return `
- The ${CATEGORY_PRESERVE_LABEL[category]} visible in the input photo IS the real sourced product. Faithfully reproduce its color, fabric texture, fit, and silhouette — this is the hero item and must be recognizable as the same product — but you have freedom to adjust how it drapes on the reshaped body.
- Reference spec of the sourced item — Color: ${garmentAnalysis.color}; Material: ${garmentAnalysis.material}; Fit: ${garmentAnalysis.fitType}; Details: ${garmentAnalysis.details}.
`.trim();
}

/**
 * 실사 사진 기반 리스타일링 프롬프트 빌더.
 * 소싱 제품의 질감/색상은 충실히 재현하되, 몸은 177/74 마른 근육형으로 리셰이프하고
 * 포즈도 정갈한 커머셜 포즈로 자유롭게 다듬는다 (원본 사진을 픽셀 단위로 고정하지 않음).
 * AI가 자동 생성한 코디 제안(stylingSuggestion) + 사용자가 직접 쓴 추가 프롬프트(userAdditions)를 하나로 합친다.
 */
export function buildRestylePrompt(
  category: SourcedCategory,
  garmentAnalysis: GarmentAnalysis,
  poseDescription: string,
  stylingSuggestion: StylingSuggestion,
  userAdditions: string = '',
  hasBackgroundReferenceImage: boolean = false,
): string {
  const stylingLines: string[] = [];
  if (stylingSuggestion.bottom) stylingLines.push(`- 하의: ${stylingSuggestion.bottom}`);
  if (stylingSuggestion.shoes) stylingLines.push(`- 신발: ${stylingSuggestion.shoes}`);
  if (stylingSuggestion.accessory) stylingLines.push(`- 액세서리: ${stylingSuggestion.accessory}`);

  const userBlock = userAdditions.trim()
    ? `\n\nAdditional user styling instructions (combine with the auto-generated styling above):\n${userAdditions.trim()}`
    : '';

  const backgroundLine = hasBackgroundReferenceImage
    ? `- Background: one of the additional input images shows the EXACT target studio backdrop and lighting setup (soft frontal light, gentle top-down falloff, seamless cyclorama floor curve). Reproduce this exact background, light direction, and shadow softness on the subject — do NOT invent a different location or lighting mood. (${stylingSuggestion.background})`
    : `- Background: ${stylingSuggestion.background}`;

  return [
    '=== MODEL BODY RESHAPE (IMPORTANT — DO NOT KEEP THE ORIGINAL BODY AS-IS) ===',
    RESTYLE_BODY_SPEC,
    '',
    '=== SOURCED PRODUCT FIDELITY ===',
    buildGarmentFidelityBlock(category, garmentAnalysis),
    '',
    '=== POSE ===',
    `Original photo pose reference: ${poseDescription}. Regenerate into a clean, confident, polished commercial standing pose — neat posture, natural hand placement. You do NOT need to literally replicate the original casual pose or framing; prioritize making it look like a professional AI-styled fitting shot.`,
    '',
    '=== NEW STYLING TO GENERATE ===',
    stylingLines.length > 0 ? stylingLines.join('\n') : '- Complete the outfit naturally with cohesive, stylish items.',
    backgroundLine,
    userBlock,
    '',
    '=== NEGATIVE CONSTRAINTS (ABSOLUTE) ===',
    RESTYLE_QUALITY_CONSTRAINTS,
    '',
    '=== OUTPUT QUALITY MANDATE ===',
    'Produce a single authentic commercial lookbook photograph — the kind a person would want to buy the product after seeing. Photorealistic, natural skin texture, natural fabric folds, professional photography lighting. No CGI, no collage, single subject only.',
  ].join('\n');
}
