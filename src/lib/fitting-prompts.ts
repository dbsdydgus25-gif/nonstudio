/**
 * fitting-prompts.ts
 * AI 피팅(전신 1장 확정) / AI 바리에이션(포즈 다양화) 두 파이프라인이 공유하는 프롬프트 빌딩 블록.
 * 변동성 최소화의 핵심 — 모든 AI 호출이 이 파일을 통과함
 */

// ─────────────────────────────────────────────────────────────────
// 0. "윤용현 모델 정보" — 고정 체형/피부 스펙 (AI 피팅 / AI 제품 피팅에서 사용)
// 어떤 사진을 넣든 항상 동일한 체형/피부톤/비율로 결과가 나오도록, 파이프라인마다 따로 적지 않고 여기 하나만 수정한다.
// 나중에 서비스화하면 모델별로 이 스펙을 여러 개 저장하는 구조가 될 예정 — 지금은 윤용현 1인 고정.
// AI 바리에이션에는 넣지 않는다 — 바리에이션은 첨부된 사진 자체가 유일한 기준 (2026-07-09 원칙 확립).
// ─────────────────────────────────────────────────────────────────
// (2026-07-09) 이전엔 "노골적으로 태닝된 medium-deep warm brown, 절대 밝게 하지 마라"처럼
// 강하게 밀어붙였더니 실제보다 너무 까맣게 나오고, veins를 반복 언급했더니 오히려 부자연스럽게
// 도드라진 핏줄이 생기는 부작용이 있었음(negative로 언급해도 그 개념 자체가 강조되는 효과) —
// 톤을 낮추고 문구도 간결화함.
export const PERSONAL_BODY_SPEC = `
- Height 177cm, Weight 74kg, Shoe/foot size 270mm (Korean 270 size).
- Skin tone: a natural warm tan Korean skin tone — like an ordinary person who spends a normal amount of time outdoors. Healthy and realistic, not pale/porcelain white, but also not an exaggerated dark tan. It should look like real human skin in a photo, not a stylized or saturated color.
- Build: a slim, long-limbed fashion-model physique — lean editorial proportions with a slim waist and a long clean silhouette. Shoulders moderately broad; arms and chest naturally toned and defined just enough to fill a fitted knit cleanly, but clearly on the slim side — NOT a gym-built or bulky body. Think lean Korean fashion model, not fitness model.
- Arms and hands: smooth, even, ordinary skin. Veins may be at most faintly suggested near the hands, but forearms should read as smooth — no bulging, ropey, or sharply defined veins anywhere.
- Body hair: a modest, natural amount of fine short vellus-like hair on the forearms and lower legs — subtle and realistic, the way arm hair looks on an ordinary Korean man in a photo. Not thick or dense, but NOT perfectly hairless either; completely smooth hairless arms look artificial.
- Skin marks: clean, even skin with NO moles, NO scars, NO birthmarks, and NO other distinctive skin marks anywhere — do not add any identifying mark. (2026-07-17: 이전 스펙의 팔뚝 흉터/점은 생성마다 좌우가 바뀌어 오히려 일관성을 해쳐서 제거함.)
- This physique and skin tone are a fixed personal standard and should stay consistent across every generation.
`.trim();

// AI 바리에이션에서 사용자가 배경을 따로 지시하지 않았을 때 AI가 매번 다른 장소를 지어내지
// 않도록, 이 고정 문구를 그대로 재사용한다. (실제 참고 사진은 background-reference.ts가 담당)
export const DEFAULT_STUDIO_BACKGROUND = 'Clean minimalist white studio background with soft professional photographic lighting — same neutral studio backdrop as standard product shots, no colorful gels, no outdoor or location scenery.';

// ─────────────────────────────────────────────────────────────────
// 의류 분석 결과 타입
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
  /**
   * (2026-07-19) 사이즈 옵션 — 상세페이지형 이미지 속 사이즈표(한글, 이미지 안 텍스트)나
   * 링크 텍스트에서 읽어낸 판매 사이즈들. label은 표시용(S/M/L/FREE 등), measurements는
   * 있으면 실측(허리/총장/밑위/허벅지/가슴 등) 원문. 실측은 피팅 시 핏 참고로만 쓴다.
   */
  sizeOptions?: Array<{ label: string; measurements?: string }>;
  /**
   * (2026-07-17) 구조 지도 — 뷰(앞/뒤)별 × 착용자 기준 좌/우별로 뭐가 어디 붙어있는지의
   * 체계적 목록. "디테일 나열"(details)만으로는 패치가 반대 다리에 붙거나 양쪽에 복제되는
   * 사고를 못 막아서, 위치를 좌표처럼 고정하는 필드를 분리했다. 착용자 기준(wearer's
   * left/right)으로 서술 — 앞면 사진에서는 거울 반전(화면 왼쪽=착용자 오른쪽)임을 분석
   * 단계에서 이미 보정한 결과여야 한다.
   * (2026-07-17 2차) 느슨한 자유 텍스트 한 필드로는 Gemini가 대충 쓰거나 통째로 빼먹어도
   * 조용히 통과됐다(실제 재현 확인 — 고리+패치가 한쪽 다리에 뭉쳐서 나옴). 존마다 별도
   * 필수 필드로 쪼개고 Gemini responseSchema로 강제해서 빈 값이 나올 수 없게 한다.
   */
  constructionMap?: GarmentConstructionMap;
  /**
   * (2026-07-21) 분석(Gemini/OpenAI)이 둘 다 실패해 일반 폴백값으로 채워졌는지 표시.
   * 실제 사고: Gemini 무료 등급 하루 20회 한도를 넘겨 429가 나는데도 조용히 폴백해서,
   * 구조 지도·재질·디테일이 통째로 빈 채 생성이 진행됐다(품질이 무너지는데 원인이 안 보임).
   * 이 플래그를 UI까지 올려 "분석 실패" 를 사용자가 알 수 있게 한다.
   */
  analysisFailed?: boolean;
}

export interface GarmentConstructionMap {
  /** 입력 사진마다 앞/뒤/옆/클로즈업 판별 + 근거 (예: "Photo 1: 지퍼 보임 → 앞면") */
  photoClassification: string;
  /**
   * (2026-07-21) 상의 전용 존 — 목/소매/밑단은 상의에서 가장 자주 틀리는 부위다.
   * 실제 사고: 목·소매엔 흑백 대조 휘프스티치, 밑단은 대조 스티치 없는 골지 밴드인 제품인데
   * 셋을 구분 못 해 밑단 마감과 트림이 뭉개졌다. 부위별로 "마감 종류 + 대조 트림 유무"를 고정한다.
   */
  neckline: string;
  sleeveCuffs: string;
  hem: string;
  frontWaistband: string;
  /** 착용자 기준 왼쪽 다리 — 앞면 */
  frontLeftLeg: string;
  /** 착용자 기준 오른쪽 다리 — 앞면 */
  frontRightLeg: string;
  backWaistband: string;
  /** 착용자 기준 왼쪽 다리 — 뒷면 */
  backLeftLeg: string;
  /** 착용자 기준 오른쪽 다리 — 뒷면 */
  backRightLeg: string;
  backPockets: string;
  sideSeams: string;
  /**
   * (2026-07-19) 비대칭 체크리스트 — "한쪽에만 있는" 디테일만 골라 명시적으로 나열.
   * 존별 행에 같은 디테일이 여러 번 등장하면(예: 뒷주머니가 왼다리 행/오른다리 행/
   * backPockets 행에 3번) 생성 모델이 "양쪽에 다 있다"로 읽는 사고가 실제로 발생해서,
   * "이 디테일은 정확히 이쪽 한 곳, 반대쪽엔 없음" 형태의 전용 필드를 분리했다.
   */
  asymmetryChecklist: string;
}

// ─────────────────────────────────────────────────────────────────
// AI 바리에이션용 포즈 라이브러리 (룩북 촬영 스타일 전신 포즈)
// ─────────────────────────────────────────────────────────────────
export interface PoseVariation {
  id: string;
  label: string;
  poseInstruction: string;
}

// (2026-07-09) 모든 포즈에서 얼굴이 항상 카메라를 정면으로 응시하는 뻣뻣한 느낌이 있었음 —
// 포즈 지시에 시선 방향을 명시하지 않으면 모델이 기본값으로 "카메라 정면 응시"를 택하는
// 경향이 있는 것으로 보임(입력 사진의 얼굴이 카메라를 보고 있으면 그 습성을 그대로 따라가는
// 듯). 매 포즈마다 자연스러운 시선/고개 방향을 구체적으로 명시해서 화보처럼 다양한 표정이
// 나오게 함 — 무조건 카메라를 피하라는 게 아니라, 포즈마다 그 상황에 자연스러운 시선을 지정.
export const FULLBODY_POSES: PoseVariation[] = [
  {
    id: 'full_relaxed_front',
    label: '전신 정면 자연스러운 포즈',
    poseInstruction: 'Pose: Standing naturally, arms resting relaxed at sides, hands loose. Entire silhouette is clean and balanced. Gaze relaxed and slightly softened, looking just past the camera into the middle distance — not a stiff, wide-eyed stare directly into the lens.',
  },
  {
    id: 'full_walking_front',
    label: '전신 걷는 포즈',
    poseInstruction: 'Pose: Walking forward confidently, relaxed arms, showcasing realistic movement folds in both top and bottom garments. Head and gaze looking naturally ahead in the walking direction, as if genuinely mid-stride rather than posing for a photo — not locked onto the camera.',
  },
  {
    id: 'full_relaxed_pocket',
    label: '전신 릴렉스 포켓 포즈',
    poseInstruction: 'Pose: Hands casually tucked in pants pockets, feet shoulder-width apart, showing natural layering of top over bottom. Head tilted slightly downward, gaze looking down and off to one side in a relaxed, candid manner — not staring directly into the lens.',
  },
  {
    id: 'full_quarter_turn',
    label: '전신 쿼터뷰 측면 포즈',
    poseInstruction: 'Pose: Standing in a three-quarter turn, showing side silhouette and layering balance. Head naturally follows the body\'s turn, gaze drifting off to the side into the distance — not twisted back to face the camera.',
  },
  {
    id: 'full_side_profile_right',
    label: '전신 완전 측면(우측) 포즈',
    poseInstruction: 'Pose: Standing in a full right-side profile, body turned a full 90 degrees so only the side silhouette faces the camera, one arm relaxed at the side. Head and gaze face the same direction as the body (a true side profile of the face too) — do not twist the neck to look back at the camera.',
  },
  {
    id: 'full_back_three_quarter',
    label: '전신 백뷰 쿼터턴 포즈',
    poseInstruction: 'Pose: Standing with the back turned three-quarters away from the camera, showing the back of the outfit with a hint of the side profile. Head turned back gently over the shoulder with a soft, relaxed gaze — a natural candid glance, not a stiff stare directly into the lens.',
  },
  {
    id: 'full_side_lean_pocket',
    label: '전신 측면 체중이동 포켓 포즈',
    poseInstruction: 'Pose: Standing in a side-turned stance with weight shifted onto one leg, hand tucked casually into the pocket, shoulders angled away from the camera for a candid lookbook feel. Head tilted down slightly, gaze looking downward and away in an unposed, candid manner.',
  },
];

// ─────────────────────────────────────────────────────────────────
// AI 피팅 (실사 기반, 전신 1장을 레퍼런스로 재생성)
// ─────────────────────────────────────────────────────────────────

/** 사용자가 실제로 입고/착용한 실사 사진 속에서 "소싱한 실물 제품"에 해당하는 부위 */
export type SourcedCategory = 'top' | 'bottom' | 'shoes' | 'accessory';

/** 보존되지 않는 나머지 슬롯에 대해 AI가 자동 제안하는 코디 설명 */
export interface StylingSuggestion {
  top?: string;
  bottom?: string;
  shoes?: string;
  accessory?: string;
  background: string;
}

// (2026-07-17) 착장 전체(상의/하의/신발/액세서리)에 적용되는 좌우 일관성 규칙 — 소싱 제품의
// construction map과 별개로, 참고 사진이 있는 모든 슬롯의 비대칭 디테일(한쪽 가슴 로고,
// 한쪽 다리 패치, 신발 옆면 마크 등)이 생성마다 좌우로 튀지 않도록 공통으로 강제한다.
// 앞모습 사진의 거울 반전(화면 왼쪽=착용자 오른쪽)까지 명시해야 실제로 지켜진다.
const GARMENT_SIDE_CONSISTENCY_RULE = `
GARMENT LEFT/RIGHT CONSISTENCY (applies to EVERY worn item — top, bottom, shoes, accessories, and any reference-image garment): any asymmetric detail (a chest logo on one side, a patch or loop on one leg, a brand mark on the outer side of one shoe, a bag worn on one shoulder) must appear on the SAME wearer's side as shown in its reference image, exactly once — never mirrored to the other side, never duplicated onto both sides, never randomly flipped between generations. Remember the mirror rule when reading reference photos: in a FRONT-view photo the wearer's LEFT appears on the VIEWER'S RIGHT; in a BACK-view photo it does not mirror. Convert to the wearer's true side first, then keep that side in the output.
`.trim();

const RESTYLE_QUALITY_CONSTRAINTS = `
CRITICAL NEGATIVE CONSTRAINTS (DO NOT GENERATE):
cartoon, illustration, CGI, 3D render, digital art, video game graphics, airbrushed skin, plastic skin, mannequin texture, artificial doll look, low resolution, blurry, deformed body, incorrect anatomy, extra limbs, bad hands, overlapping fingers, unnatural pose, oversaturated colors, fake lighting, warped background, artifacts, logos, text, watermark, composite look, collage, split screen, multi-panel, grid of photos, side-by-side comparison, diptych, triptych, photo montage, layout of multiple images, soft puffy chest, sagging chest, love handles, flabby untoned body, out-of-shape physique, hunched posture, awkward stiff pose, invented fabric pattern, fake jacquard or paisley print, embossed decorative texture not present on the real garment, moire pattern on fabric, unintended textile print, invented seam line, invented panel line, extra topstitching not on the real garment, fake stitch line near the hem or side, decorative seams added to a plain garment.
`.trim();

// (2026-07-14) MODEL LOCK — AI 피팅과 AI 제품 피팅이 완전히 동일한 문구로 모델을 규정한다.
// 두 파이프라인의 모델 서술이 조금이라도 다르면 결과 모델이 서로 다르게 흔들리는 원인이 되므로,
// 핵심 고정 문구를 한 곳에서 관리한다. (반복 강조는 오히려 과장을 유발하므로 각 항목은 한 번만 서술)
export function buildModelLockLines(bodySpec: string): string {
  return `
MODEL LOCK — this brand uses ONE fixed model. Every generation must show the exact same person, as if the same model returned to the same white studio for another shot of the same campaign. A viewer comparing any two generations must believe they are photos of the same person taken the same day.
Body & identity spec (ground truth — reproduce exactly; do not idealize, slim down, bulk up, or beautify):
${bodySpec}
The following must match the spec and the reference photo exactly, never randomized between generations: facial features, skin tone, hairstyle, body-hair amount, vein visibility, muscle definition, and overall body proportions.
SKIN RULE: render clean, even skin with NO moles, NO scars, NO birthmarks, and NO other distinctive skin marks anywhere on the body — even if the reference photo appears to show one, do not reproduce it. (Identifying marks flip sides between generations and break consistency, so this model is defined as mark-free.)
`.trim();
}

// (2026-07-09) 모델 정보 페이지에서 스펙을 편집할 수 있도록 상수 조립 대신 함수로 전환 —
// bodySpec 미지정 시 기존 PERSONAL_BODY_SPEC이 그대로 쓰여서 동작이 변하지 않는다.
// (2026-07-15) MODEL LOCK 문구를 앞에 두면 "reshape 필수" 지시가 뒤로 밀려서 희석되는 회귀가
// 있었음(사용자 신고: "모델 정보에 안맞게 몸이 나온다") — AI 피팅은 입력 이미지(image #1)가
// 사용자의 실제 몸을 담은 사진이라, "이 사진의 실제 체형을 그대로 베끼지 말고 스펙으로 바꿔라"는
// 지시가 가장 먼저, 가장 강하게 와야 한다(이 코드베이스의 반복된 교훈: 지시문의 "위치"가 반영
// 여부를 크게 좌우함). MODEL LOCK 블록은 그 뒤에 붙여 스펙 자체는 동일하게 유지한다.
function buildRestyleBodySpec(bodySpec: string): string {
  return `
- CRITICAL: the input photo shows this person's ACTUAL current real-life body. You MUST reshape the output body to match the spec below — do NOT literally copy or preserve the input photo's real body shape, proportions, or build. The spec is the ground truth for the output body, the input photo is not.
${buildModelLockLines(bodySpec)}
- Keep the same face and general identity recognizable — this is a refinement of the same person, not a different person.
`.trim();
}

const CATEGORY_PRESERVE_LABEL: Record<SourcedCategory, string> = {
  top: '상의(윗옷)',
  bottom: '하의(바지/스커트)',
  shoes: '신발',
  accessory: '액세서리(가방/시계/주얼리 등)',
};

function buildGarmentFidelityBlock(category: SourcedCategory, garmentAnalysis: GarmentAnalysis): string {
  return `
- The ${CATEGORY_PRESERVE_LABEL[category]} visible in the input photo IS the real sourced product. Faithfully reproduce its color, fabric texture, fit, and silhouette — this is the hero item and must be recognizable as the same product — but you have freedom to adjust how it drapes on the reshaped body.
- Reference spec of the sourced item — Color: ${garmentAnalysis.color}; Material: ${garmentAnalysis.material}; Fit: ${garmentAnalysis.fitType}; Surface texture: ${garmentAnalysis.texture}; Light reaction: ${garmentAnalysis.lightReaction}; Details: ${garmentAnalysis.details}.
- CRITICAL FABRIC RULE: reproduce ONLY the surface texture described above — do NOT invent, add, or embellish any decorative pattern, print, jacquard motif, embossed design, paisley, damask, moire, or graphic texture that is not explicitly listed. If the fabric is a plain solid-color knit/weave, render it perfectly plain and uniform with only natural fabric grain or knit-loop texture — absolutely no added print or pattern of any kind.
- The fabric surface must look like an actual photograph of a real garment — flat, clean, with only natural soft folds/wrinkles from body movement and gravity. Do NOT render any algorithmic or "AI-texture-filter" look: no fine repeating micro-pattern, no engraved/embossed swirl texture, no synthetic noise grain, no digital fabric-simulation artifacts. A plain knit or weave should look boringly plain, like a studio product photo, not like a rendered material map.
- SCOPE OF THIS RULE (do not over-apply): this fidelity requirement applies ONLY to the ${CATEGORY_PRESERVE_LABEL[category]}'s own color/print/texture — it does NOT mean preserving the rest of the original photo. The body shape, pose, background, and every other garment/accessory MUST still be changed exactly as instructed in the other sections below (MODEL BODY RESHAPE, POSE & FRAMING, NEW STYLING) — do not keep the original room, original pose, or original bottom/shoes just because this section asks for fidelity on one item. Use the input photo only as a color/texture reference for this ONE item, not as a template to copy wholesale.
`.trim();
}

/**
 * AI 피팅 프롬프트 빌더 — 항상 전신 1장을 생성한다.
 * 소싱 제품의 질감/색상은 충실히 재현하되, 몸은 177/74 마른 근육형으로 리셰이프하고
 * 포즈도 정갈한 커머셜 포즈로 자유롭게 다듬는다 (원본 사진을 픽셀 단위로 고정하지 않음).
 * AI가 자동 생성한 코디 제안(stylingSuggestion)은 STYLING 섹션에, 사용자가 직접 쓴 자세/소품 지시(userAdditions)는
 * POSE & FRAMING 섹션 안에 "필수 준수" 문구로 배치한다 — 상하의 스타일은 generateStylingSuggestion의
 * userPreferenceHint로 이미 반영되어 여기 들어오는 userAdditions는 순수 자세/소품 지시만 남는다.
 */
export function buildRestylePrompt(
  category: SourcedCategory,
  garmentAnalysis: GarmentAnalysis,
  poseDescription: string,
  stylingSuggestion: StylingSuggestion,
  userAdditions: string = '',
  hasBackgroundReferenceImage: boolean = false,
  hasIdentityReferenceImage: boolean = false,
  bodySpec: string = PERSONAL_BODY_SPEC,
): string {
  const stylingLines: string[] = [];
  if (stylingSuggestion.top) stylingLines.push(`- 상의: ${stylingSuggestion.top}`);
  if (stylingSuggestion.bottom) stylingLines.push(`- 하의: ${stylingSuggestion.bottom}`);
  if (stylingSuggestion.shoes) stylingLines.push(`- 신발: ${stylingSuggestion.shoes}`);
  if (stylingSuggestion.accessory) stylingLines.push(`- 액세서리: ${stylingSuggestion.accessory}`);

  // 사용자가 입력한 자세/소품 지시 — POSE & FRAMING 섹션 안에 두고 "필수 준수"로 명시해야 반영됨.
  // 예전엔 STYLING 섹션 맨 끝에 "추가 스타일링 지시"로 잘못 라벨링되어 있어서 포즈/소품 지시가
  // 거의 무시됐었음 (예: "한손엔 토트백"을 지시해도 가방이 안 나옴).
  // (2026-07-14) 사용자가 자세 칸에 "다양한 포즈 / 하나는 팔짱 / 하나는..."처럼 여러 포즈를
  // 나열하면 gpt-image-2가 한 프레임에 사람 여러 명(포즈별 1명씩)을 그려버리는 사고가 있었음 —
  // 지시를 받아들이되 "한 장 = 한 명 = 한 포즈"를 지시문 안에서 직접 강제한다.
  const poseHintBlock = userAdditions.trim()
    ? ` MANDATORY POSE/PROP REQUIREMENT (overrides the generic pose direction above — must be included exactly as described, e.g. if it mentions holding an item, that item must be visibly held in the model's hand): ${userAdditions.trim()} (If this specifies a direction or turn — e.g. facing left/right, three-quarter turn, back view — the body orientation AND camera framing must clearly and unambiguously show that turn; do not default to a front-facing pose with only a slight head tilt. STRICT: the output is ONE photograph of exactly ONE person in ONE pose. If the requirement above lists multiple different poses, pick only the single most suitable one — NEVER render several people, a multi-pose lineup, or the same person repeated side by side in one image.)`
    : '';

  const backgroundLine = hasBackgroundReferenceImage
    ? `- Background: one of the additional input images shows the EXACT target studio backdrop and lighting setup (soft frontal light, gentle top-down falloff, seamless cyclorama floor curve). Reproduce this exact background, light direction, and shadow softness on the subject — do NOT invent a different location or lighting mood. (${stylingSuggestion.background})`
    : `- Background: ${stylingSuggestion.background}`;

  // 승격된 기준 참고 이미지가 있으면 이미지가 같이 들어가는데, 이 이미지가 "무엇을 위한 것인지"
  // 설명하는 문구가 전혀 없으면 gpt-image-2가 그 사진의 신발/코디까지 통째로 따라 그려서
  // NEW STYLING 지시(이번에 새로 지정한 하의/신발)를 무시하는 문제가 있었다 — 용도를 명확히 한정한다.
  const identityReferenceLine = hasIdentityReferenceImage
    ? '\n- One of the additional input images is a FACE / BODY SHAPE / SKIN TONE reference ONLY. Match the same face, body proportions, and skin tone shown there. Do NOT copy the clothing, shoes, bag, or any accessory worn in that reference photo — completely ignore its outfit. The outfit for THIS generation is defined entirely by the SOURCED PRODUCT FIDELITY and NEW STYLING sections below, which take full priority over anything worn in that reference photo.'
    : '';

  return [
    '=== MODEL BODY RESHAPE (IMPORTANT — DO NOT KEEP THE ORIGINAL BODY AS-IS) ===',
    buildRestyleBodySpec(bodySpec) + identityReferenceLine,
    '',
    '=== SOURCED PRODUCT FIDELITY ===',
    buildGarmentFidelityBlock(category, garmentAnalysis),
    '',
    '=== POSE & FRAMING (ABSOLUTE) ===',
    `Camera framing: FULL BODY SHOT ONLY — head to toe, both feet and full footwear fully visible in frame, nothing cropped. This is a single confirmed lookbook shot, not a close-up or partial crop.`,
    `Original photo pose reference: ${poseDescription}. Regenerate into a clean, confident, polished commercial standing pose — neat posture, natural hand placement. You do NOT need to literally replicate the original casual pose or framing; prioritize making it look like a professional AI-styled fitting shot. Default gaze/head direction: face and eyes toward or near the camera, in a natural relaxed way — do NOT habitually turn the head to one side (e.g. always to the right); only turn the head or gaze away from the camera if the pose instruction below explicitly calls for it.${poseHintBlock}`,
    '',
    '=== NEW STYLING TO GENERATE ===',
    `Every item listed below REPLACES whatever the person is wearing in that slot in the input photo — the input photo's own bottom/shoes/accessories (other than the one protected sourced item above) are NOT the reference and must NOT be preserved, copied, or kept similar in silhouette/color/style. Generate exactly what is described below instead, even if it looks completely different from the input photo.`,
    stylingLines.length > 0 ? stylingLines.join('\n') : '- Complete the outfit naturally with cohesive, stylish items.',
    backgroundLine,
    GARMENT_SIDE_CONSISTENCY_RULE,
    '',
    '=== NEGATIVE CONSTRAINTS (ABSOLUTE) ===',
    RESTYLE_QUALITY_CONSTRAINTS,
    '',
    '=== OUTPUT QUALITY MANDATE ===',
    'Produce a single authentic commercial lookbook photograph — the kind a person would want to buy the product after seeing. Photorealistic, natural skin texture, natural fabric folds, professional photography lighting. No CGI, no collage, single subject only.',
  ].join('\n');
}

/**
 * 포즈 풀에서 매번 무작위로 count개를 뽑는다 (AI 바리에이션 / AI 제품 피팅 공통) — 배열 앞
 * N개를 고정 순서로만 쓰면 항상 같은 포즈만 나오는 문제를 방지한다. poseNumber는
 * FULLBODY_POSES 배열상의 1-based 순번으로, public/poses/pose_{poseNumber}.png 참고 사진과
 * 매칭하기 위해 셔플 이후에도 유지한다.
 */
export function pickRandomPoses(count: number): Array<{ pose: PoseVariation; poseNumber: number }> {
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

/**
 * (2026-07-22) 한글 핏 용어를 gpt-image-2가 실제로 반영하는 명시적 지시로 번역한다.
 *
 * 문제: "머슬핏, 팔이랑 목 부분 타이트함"이라고 분명히 적어도 헐렁한 레귤러핏이 나왔다.
 * 원인은 두 가지였다 — (1) 사진에서 추정한 fitType("regular")이 지시문과 나란히 들어가
 * 정면충돌했고, (2) 한글 핏 용어를 그대로 넘기면 모델이 "이 옷이 몸에 어떻게 붙어야 하는지"를
 * 구체적인 그림으로 옮기지 못했다. 여기서는 (2)를 해결한다: 감지된 용어에 대해서만
 * "어디가 어떻게 붙는지"를 한 줄씩 명시한다.
 *
 * 감지된 항목만 내보낸다 — 파일 상단 주석(2026-07-09)의 교훈대로, 안 해당되는 규칙까지
 * 잔뜩 붙이면 오히려 모델의 주의가 분산된다.
 */
function buildFitEmphasisLines(productNotes: string): string[] {
  const n = productNotes.toLowerCase();
  const has = (...keys: string[]) => keys.some((k) => n.includes(k.toLowerCase()));

  const tight = has('타이트', '꽉', '슬림', 'slim fit', 'tight', 'fitted', 'snug', '밀착');
  const lines: string[] = [];

  if (has('머슬핏', '머슬 핏', 'muscle fit', 'musclefit')) {
    lines.push(
      '- MUSCLE FIT (mandatory): the garment is cut close to the body through the chest, shoulders, and upper arms. The fabric follows the contour of the pecs, shoulders, and biceps with no slack — you can read the shape of the torso through it. It must NOT hang loose, billow, or drape away from the body anywhere.',
    );
  }
  if (has('목') && tight) {
    lines.push(
      '- TIGHT NECKLINE (mandatory): the neckline sits high and hugs the base of the neck closely, like a snug crew neck. Do NOT render a wide, loose, stretched, or dropped neckline, and do NOT expose the collarbone or trapezius.',
    );
  }
  if (has('팔', '소매', 'sleeve', 'arm') && tight) {
    lines.push(
      '- TIGHT SLEEVES (mandatory): the sleeves hug the upper arm and biceps closely, with the sleeve opening gripping the arm. Do NOT render wide, boxy, or loosely hanging sleeves.',
    );
  }
  if (has('크롭', 'cropped', 'crop 기장')) {
    lines.push(
      '- CROPPED LENGTH (mandatory): the hem is visibly short — it ends at or just above the waistband rather than covering the hips. Do NOT render a standard or long hem.',
    );
  }
  if (has('오버핏', '오버 핏', 'oversize', 'oversized', '루즈', 'loose fit', '박시', 'boxy', '와이드핏')) {
    lines.push(
      '- OVERSIZED FIT (mandatory): the garment is visibly larger than the body — dropped shoulder seams, generous room through the chest and sleeves, and fabric that drapes away from the torso.',
    );
  }
  // 머슬핏/오버핏 같은 구체 용어 없이 "타이트"만 적힌 경우의 폴백
  if (tight && lines.length === 0) {
    lines.push(
      '- TIGHT FIT (mandatory): the garment sits close to the body with no slack, following the body\'s contour rather than draping away from it.',
    );
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────
// AI 제품 피팅 (신규, 2026-07-09) — 착용 사진 없이 "제품 단독 이미지"만으로
// 윤용현 모델(PERSONAL_BODY_SPEC + 아이덴티티 참고 사진)이 그 제품을 입은 화보를 생성한다.
// 소싱 단계에서 샘플을 직접 못 입어보는 문제 해결용 — 색상 옵션 이미지별로 병렬 생성 가능.
// AI 피팅과의 차이: 입력 이미지가 "사람이 입은 사진"이 아니라 "제품 자체"라서,
// 몸 리셰이프가 아니라 모델 전체를 참고 사진 기준으로 새로 그려야 한다.
// ─────────────────────────────────────────────────────────────────
export function buildProductFittingPrompt(
  category: SourcedCategory,
  garmentAnalysis: GarmentAnalysis,
  stylingSuggestion: StylingSuggestion,
  userAdditions: string = '',
  hasBackgroundReferenceImage: boolean = false,
  hasIdentityReferenceImage: boolean = false,
  bodySpec: string = PERSONAL_BODY_SPEC,
  /** 한 장에 여러 색상이 나온 샘플 시트에서 특정 색상만 뽑아 생성할 때 지정 (예: 'jet black') */
  colorVariant?: string,
  /** 사용자가 직접 적는 제품 핏/디테일 지시 (예: '머슬핏, 크롭 기장감') — 사진만으로 안 보이는 정보 보강 */
  productNotes?: string,
  /** 사용자 코디 지시 원문 (슬롯별) — 코디 자동 제안(Gemini)을 거치며 "와이드"가 순화되는 문제가
   * 있어서, 원문을 최종 프롬프트에도 문자 그대로 한 번 더 강제한다 */
  userSlotMandates?: Partial<Record<'top' | 'bottom' | 'shoes' | 'accessory', string>>,
  /** (2026-07-14) 같은 제품의 다른 각도/디테일 참고 사진 개수 — 색상 아님, 실루엣/디테일 교차 확인용 */
  extraProductImageCount: number = 0,
  /** (2026-07-14) 재질/텍스처 클로즈업 참고 사진 개수 — 색상 아닌 원단/버튼/스티치 디테일 전용 */
  materialImageCount: number = 0,
  /** (2026-07-17) 소싱 제품이 아닌 나머지 슬롯(예: 상의)을 말로 설명하기 어려울 때, 슬롯별로
   * "이렇게 입혀줘" 참고 사진을 첨부할 수 있다(슬롯당 최대 3장) — 순서는 SLOT_ORDER 고정. */
  styleReferenceImageCountsBySlot?: Partial<Record<'top' | 'bottom' | 'shoes' | 'accessory', number>>,
  /**
   * (2026-07-17) 같은 색상의 이전 포즈 컷(이미 확정된 정상 결과물) — 포즈 여러 장을 뽑을 때
   * 두 번째 컷부터 이 사진을 "이 구조가 정답"인 기준으로 함께 참고시킨다. gpt-image-2는 seed가
   * 없어 텍스트 스펙만으로는 절개선/포켓/패치 위치가 포즈마다 조금씩 달라지는 문제가 있었는데
   * (실제 재현 확인), AI 바리에이션처럼 "이미 확정된 사진"을 기준 삼으면 훨씬 일관되게 나온다.
   */
  hasPoseAnchorImage: boolean = false,
  /**
   * (2026-07-21) 링크로 가져온 상품의 판매 컬러웨이 중, 참고 사진과 다른 색을 명시적으로
   * 선택했을 때의 override(예: 사진은 BROWN인데 "NAVY"를 선택). 사용자가 실제로 판매되는
   * 색상 중 하나를 의도적으로 고른 것이므로, 아래 CRITICAL COLOR RULE의 "사진 색이 곧 정답"
   * 원칙에 대한 유일한 예외로 취급한다 — 참고 사진 없는 텍스트 추측과는 다르다.
   */
  colorOverrideNote: string = '',
): string {
  const stylingLines: string[] = [];
  if (stylingSuggestion.top) stylingLines.push(`- 상의: ${stylingSuggestion.top}`);
  if (stylingSuggestion.bottom) stylingLines.push(`- 하의: ${stylingSuggestion.bottom}`);
  if (stylingSuggestion.shoes) stylingLines.push(`- 신발: ${stylingSuggestion.shoes}`);
  if (stylingSuggestion.accessory) stylingLines.push(`- 액세서리: ${stylingSuggestion.accessory}`);

  // (2026-07-17) poseHintBlock(덧붙임 방식) 제거 — POSE & FRAMING 섹션에서 포즈 지시가 있으면
  // 기본 스탠딩 문구를 통째로 교체하는 방식으로 전환 (포즈 3장이 전부 동일하게 나오던 원인).

  // (2026-07-09, 2차 강화) 이미지 순서를 [모델, 제품, (다른 각도), (재질), 배경]으로 구성한다 —
  // gpt-image-2의 edit는 첫 번째 이미지를 "편집할 대상"으로 취급하는 경향이 있어서, 제품 사진이
  // 1번일 때는 그 사진 속 타사 모델의 몸/피부가 계속 결과에 배어 나왔다 (AI 피팅이 모델 일관성이
  // 좋은 이유도 기준 인물 사진이 1번 이미지이기 때문). "Image 1의 사람을 편집해서 Image 2의
  // 제품을 입힌다"는 자연스러운 편집 구도가 된다.
  const productImageNumber = hasIdentityReferenceImage ? 2 : 1;
  const extraProductImageNumbers = Array.from({ length: extraProductImageCount }, (_, i) => productImageNumber + 1 + i);
  const materialImageStart = productImageNumber + 1 + extraProductImageCount;
  const materialImageNumbers = Array.from({ length: materialImageCount }, (_, i) => materialImageStart + i);

  // (2026-07-17) 슬롯별 스타일 참고 사진 — SLOT_ORDER 고정 순서로 번호를 배정한다(프론트에서도
  // 같은 순서로 이미지를 보내야 서로 어긋나지 않음. product-fitting/route.ts 참고).
  const SLOT_ORDER = ['top', 'bottom', 'shoes', 'accessory'] as const;
  const styleRefStart = materialImageStart + materialImageCount;
  let cursor = styleRefStart;
  const styleRefNumbersBySlot: Partial<Record<(typeof SLOT_ORDER)[number], number[]>> = {};
  for (const slot of SLOT_ORDER) {
    const n = styleReferenceImageCountsBySlot?.[slot] || 0;
    if (n > 0) {
      styleRefNumbersBySlot[slot] = Array.from({ length: n }, (_, i) => cursor + i);
      cursor += n;
    }
  }
  const totalStyleRefCount = cursor - styleRefStart;
  const poseAnchorImageNumber = styleRefStart + totalStyleRefCount;
  const backgroundImageNumber = poseAnchorImageNumber + (hasPoseAnchorImage ? 1 : 0);

  const poseAnchorLine = hasPoseAnchorImage
    ? `\n- Image ${poseAnchorImageNumber} shows this EXACT same product already correctly rendered on this exact same model in a previous shot (same colorway, same construction). Treat Image ${poseAnchorImageNumber}'s garment construction (seam/panel lines, pocket shapes and placement, patch/logo placement, stitching, fabric weight/texture) as the PRIMARY ground-truth reference for consistency — copy it exactly, do not reinterpret, lighten, smooth over, or redraw it differently. CRITICAL SCOPE LIMIT: copy ONLY the garment's physical construction and fabric from Image ${poseAnchorImageNumber} — completely IGNORE and do NOT copy its body pose, body turn/direction, camera angle, or framing. The pose, turn direction, and camera angle for THIS shot come ENTIRELY from the POSE & FRAMING instruction below, even if that means the body faces a completely different direction than Image ${poseAnchorImageNumber} — a left/right turn instruction below must still be followed exactly regardless of which way Image ${poseAnchorImageNumber} was turned.`
    : '';

  const backgroundLine = hasBackgroundReferenceImage
    ? `- Background: Image ${backgroundImageNumber} shows the EXACT target studio backdrop and lighting setup (soft frontal light, gentle top-down falloff, seamless cyclorama floor curve). Reproduce this exact background, light direction, and shadow softness on the subject. (${stylingSuggestion.background})`
    : `- Background: ${stylingSuggestion.background}`;

  const identityBlock = hasIdentityReferenceImage
    ? `Image 1 shows THE model — the exact person who must appear in the output. Keep Image 1's face, skin tone, and body identical. Do NOT copy any clothing or accessory from Image 1; the outfit is defined entirely by the PRODUCT and NEW STYLING sections below.`
    : 'Generate the model described in the MODEL section below.';

  // 색상 옵션 지정 시 — 샘플 시트에 여러 색상이 있어도 이 색상 하나만 입혀서 생성
  const colorVariantLine = colorVariant
    ? `\n- COLORWAY TO GENERATE: this product is sold in multiple colors and Image ${productImageNumber} may show several colorways together. Generate ONLY the "${colorVariant}" colorway — the garment worn by the model must be exactly this color, using the matching colorway in Image ${productImageNumber} as the color/texture source of truth. Ignore the other colorways in the image entirely.`
    : '';

  // 사용자가 직접 적은 제품 핏/디테일 (머슬핏, 크롭 기장 등) — 사진만으로는 판단이 어려운
  // 실착 핏 정보를 판매자/사용자가 아는 대로 보강하는 것이라 시각 추정보다 우선한다.
  // (2026-07-17) 대표님이 실제 치수(허리 35-43, 총장 62, 바지통 36.5 등)를 적어주시는 경우가
  // 많은데, gpt-image-2는 실측 cm를 픽셀 단위로 계산해서 그리는 능력이 없다 — 숫자를 그대로
  // "적용해라"라고만 하면 AI가 얼마나 헐렁한지/타이트한지를 알아서 추측하게 방치된다. 고정
  // 모델 체형(마른 체형, 슬림한 허리) 대비 이 치수가 뜻하는 여유분을 직접 판단해서 그 "헐렁함/
  // 핏의 정도"를 시각적으로 반영하라는 지시를 명시적으로 추가한다.
  const productNotesLine = productNotes?.trim()
    ? `\n- MANDATORY PRODUCT FIT/DETAIL SPEC (provided by the seller — overrides visual guesses from the photo): ${productNotes.trim()}. If this includes numeric measurements (waist, hip, thigh, rise, hem width, chest, shoulder, sleeve length, etc.), reason about what those measurements mean relative to the fixed model's slim, lean build described above (do not just repeat the numbers) — e.g. a waist range far wider than a slim waist implies a banded/elastic waistband with visible loose gathering and drape, not a snug fit; a hem/thigh width much larger than the leg implies a clearly baggy wide silhouette with visible extra fabric volume and movement, not a tapered line skimming the leg. Render the ACTUAL visual looseness/tightness and drape that these measurements imply on this specific body, not just a generic version of the garment type.`
    : '';

  // 사용자 코디 지시 원문 — Gemini 코디 제안이 "와이드"를 "테일러드"로 순화하는 등 지시가
  // 희석되는 경우가 있어, 원문을 문자 그대로 따르라고 최종 프롬프트에 한 번 더 박는다.
  const SLOT_LABELS: Record<string, string> = { top: '상의', bottom: '하의', shoes: '신발', accessory: '액세서리' };
  const mandateLines = Object.entries(userSlotMandates || {})
    .filter(([, text]) => typeof text === 'string' && text.trim())
    .map(
      ([slot, text]) =>
        `- USER MANDATE for ${SLOT_LABELS[slot] || slot}: "${text!.trim()}" — follow this LITERALLY. If it says 와이드/wide, the silhouette must be clearly and visibly wide-leg (NOT tapered, NOT slim); if it specifies a color/material/length, match it exactly. If this mandate contains a negation or exclusion (e.g., "not X", "no X", "X 아님", "(X 제외)"), that exclusion is just as mandatory as the positive part — the output must NOT show X; actively check the result against this before finalizing. This mandate wins over the AI styling description above if they conflict.`,
    );
  const mandateBlock = mandateLines.length > 0 ? `\n${mandateLines.join('\n')}` : '';

  // (2026-07-17) 이전엔 "실루엣/버튼/포켓/칼라/밑단 정도"만 언급해서, gpt-image-2가 실제 절개선
  // 위치·포켓 개수와 정확한 부착 위치·로고 패치 위치·앞/뒤 구분을 거의 참고하지 않고 지어내는
  // 사고가 반복 확인됨(패치가 중복되거나, 절개선이 사진과 다른 곳에 생기거나, 드로스트링을
  // 없던 자리에 만들어내는 등). "각도 사진"이라는 표현 대신, 이게 이 옷의 실제 구조를 보여주는
  // 유일한 자료라는 점과, 스펙(garmentAnalysis.details)에 적힌 것과 정확히 대조해서 확인하라는
  // 지시를 명시적으로 추가한다.
  const extraAngleLine = extraProductImageNumbers.length
    ? `\n- Image${extraProductImageNumbers.length > 1 ? 's' : ''} ${extraProductImageNumbers.join(', ')} show ADDITIONAL real photos of this EXACT SAME product from other angles (front, back, laid flat, hanging, etc.) — NOT a different product, NOT a different color. These are the ONLY real evidence of this garment's actual construction — do NOT guess or default to a generic/typical version of this garment type. Before finalizing, cross-check every item in the "Details" spec below against these images one by one: the exact seam/panel lines, the exact number and placement of pockets, the exact placement of any logo/patch (do NOT duplicate a patch that appears once, do NOT place it on the wrong side or the wrong pocket), and any drawstring/toggle/closure only where these images actually show one. First determine which of these images is the FRONT and which is the BACK of the garment (a garment does not look the same on both sides) — then render only the side that matches the pose being generated (a front-facing pose shows the front construction, a back-facing pose shows the back construction; never blend both sides' details into one view). If any part of a person is visible in ${extraProductImageNumbers.length > 1 ? 'these images' : 'this image'} (worn on a different shop model, for example), COMPLETELY IGNORE that person just like in Image ${productImageNumber} — their face and identity must have ZERO influence on the output.`
    : '';
  // (2026-07-17) "재질 참고 사진"이 실제로는 원단 클로즈업이 아니라 앞/뒤/디테일을 보여주는
  // 일반 제품 사진인 경우가 많다는 사용자 피드백 반영 — 이전엔 "텍스처만 보고 구조는 무시하라"고
  // 못박아서, 사용자가 핏/구조를 보라고 올린 사진을 AI가 통째로 무시하는 결과를 낳았다. 이제
  // 재질(있으면)과 구조(seam/pocket/patch/앞뒤구분) 둘 다 이 사진에서 확인하도록 확장한다.
  const materialLine = materialImageNumbers.length
    ? `\n- Image${materialImageNumbers.length > 1 ? 's' : ''} ${materialImageNumbers.join(', ')} ${materialImageNumbers.length > 1 ? 'are' : 'is'} additional REFERENCE photo${materialImageNumbers.length > 1 ? 's' : ''} of this exact product — use ${materialImageNumbers.length > 1 ? 'them' : 'it'} for BOTH the fabric surface (texture, weave/knit structure, sheen) AND the exact construction (seam/panel lines, pocket count and placement, logo/patch placement, drawstrings/closures, front vs back design — do not duplicate or misplace any of these; if it shows a side not visible in Image ${productImageNumber}, that side's construction must come from here, not be invented). Do NOT use ${materialImageNumbers.length > 1 ? 'them' : 'it'} as a color reference — Image ${productImageNumber} remains the source of truth for color. If any part of a person (skin, neck, jaw, hand, face, hair) is visible in ${materialImageNumbers.length > 1 ? 'these reference images' : 'this reference image'}, COMPLETELY IGNORE that person — their identity, skin tone, and face must have ZERO influence on the output. The model's face and identity come ONLY from Image 1.`
    : '';

  // (2026-07-17) 소싱 제품이 아닌 슬롯(예: 하의 소싱 시 상의)을 말로 설명하기 어려울 때 쓰는
  // "이렇게 입혀줘" 참고 사진 — 색상/재질 참고(materialLine)와 달리 이건 그 슬롯 전체의
  // 디자인/실루엣 자체를 지정하는 것이므로, 있으면 텍스트 스타일링 제안보다 우선한다.
  const styleReferenceLines = SLOT_ORDER.map((slot) => {
    const nums = styleRefNumbersBySlot[slot];
    if (!nums?.length) return null;
    return `- Image${nums.length > 1 ? 's' : ''} ${nums.join(', ')} ${nums.length > 1 ? 'are' : 'is'} a STYLING REFERENCE for the ${SLOT_LABELS[slot]} slot (not the sourced product) — dress the model in a ${SLOT_LABELS[slot]} matching this exact garment's design, color, and fit. Completely ignore any person, body, or background shown in ${nums.length > 1 ? 'these images' : 'this image'}. This reference image takes priority over any text styling description for the ${SLOT_LABELS[slot]} slot below when they conflict.`;
  }).filter((l): l is string => !!l);

  // (2026-07-19) 최우선 체크리스트 — 이 코드베이스의 반복 교훈("지시문 위치가 반영을 좌우한다").
  // 실제 실패 사례: 스타일링/포즈/핏 지시가 프롬프트 맨 끝에 있어, 앞쪽 제품 정밀재현 기계
  // (CONSTRUCTION MAP 등 수천 단어)에 밀려 gpt-image-2가 색(베이지 샌들→검정, 갈색 가방→검정,
  // 워싱 데님→검정 슬랙스)·핏(목 타이트→헐렁)을 통째로 무시함. 자주 놓치는 지시를 프롬프트 최상단에
  // 사용자 "원문 그대로"로 끌어올리고, 회색 제품에 맞춰 전체를 모노톤으로 뭉개는 관성을 명시적으로 차단.
  const CHECKLIST_SLOT_LABELS = { top: '상의', bottom: '하의', shoes: '신발', accessory: '액세서리' } as const;
  const styledSlotOrder = (['top', 'bottom', 'shoes', 'accessory'] as const).filter((s) => s !== category);
  const checklistStyleLines = styledSlotOrder
    .map((slot) => {
      const raw = userSlotMandates?.[slot]?.trim();
      const gen = stylingSuggestion[slot as keyof StylingSuggestion];
      const text = raw || (typeof gen === 'string' ? gen : '');
      if (!text) return null;
      return `  - ${CHECKLIST_SLOT_LABELS[slot]}: ${text}`;
    })
    .filter((l): l is string => !!l);

  // (2026-07-22) 예전엔 여기서 `${garmentAnalysis.fitType} fit`을 사용자 지시보다 먼저,
  // 그것도 확정 사실처럼 적었다. 그 값은 사진에서 추정한 것이라 상세페이지 원문과 자주
  // 충돌했고("머슬핏 타이트"인데 추정은 "regular"), 앞에 나온 쪽이 이겨서 헐렁하게 나왔다.
  // 사용자/상세페이지 지시가 있으면 그쪽이 핏의 유일한 기준이고, 추정값은 아예 언급하지 않는다.
  const hasFitSpec = !!productNotes?.trim();
  const fitEmphasisLines = hasFitSpec ? buildFitEmphasisLines(productNotes!.trim()) : [];

  const priorityChecklistBlock = [
    '=== OUTFIT & POSE — HIGHEST-PRIORITY CHECKLIST (read and obey this FIRST; these exact instructions are the ones most often missed, so they come before everything else) ===',
    `SOURCED PRODUCT (this is the ${CATEGORY_PRESERVE_LABEL[category]} the model actually wears; full spec in PRODUCT FIDELITY below): ${garmentAnalysis.color}${hasFitSpec ? '' : `, ${garmentAnalysis.fitType} fit`}.${hasFitSpec ? ` KEY FIT — THIS IS THE SELLER'S OWN SPEC AND IS THE ONLY AUTHORITY ON HOW THE GARMENT FITS. Obey it exactly, and ignore any conflicting fit impression you form from the photo (shop photos are often shot loose on a different body): ${productNotes!.trim()}` : ''}${colorOverrideNote?.trim() ? ` MANDATORY SOLD COLORWAY OVERRIDE: ${colorOverrideNote.trim()} — this is a deliberate choice of a real colorway this product is sold in, not a guess; render the SAME garment (identical construction, texture, fit) recolored to this colorway instead of the reference photo's color. This is the ONE exception to the color rule below.` : ''}`,
    // 한글 핏 용어를 "몸에 어떻게 붙는지"로 풀어서 못박는다 — 해당되는 항목만 나온다.
    ...fitEmphasisLines,
    ...(checklistStyleLines.length
      ? [
          'STYLE THE REMAINING ITEMS EXACTLY AS WRITTEN — each item\'s stated COLOR and garment TYPE are mandatory. They are usually DIFFERENT from the product; do NOT recolor them to match the product and do NOT collapse the outfit into a black/grey/monochrome look:',
          ...checklistStyleLines,
          'COLOR & TYPE ARE NON-NEGOTIABLE: read each item\'s exact words and match them literally — 베이지(beige) sandals are BEIGE not black; 갈색(brown) bag is BROWN not black; 워싱 와이드 데님(washed wide denim) is blue washed wide-leg denim, NOT black slacks and NOT a side-stripe trouser. Verify every styled item\'s color and type against the words above before finalizing.',
        ]
      : []),
    `POSE (obey exactly): ${userAdditions.trim() || 'clean, confident commercial standing pose, facing camera'}`,
    // (2026-07-19) "AI가 없는 실밥선/절개선을 밑단·측면에 지어내는" 품질 문제 — 최우선으로 못박음.
    `PRODUCT SURFACE — ADD NOTHING: reproduce ONLY the seams, topstitching, panel lines, pockets, and details that are actually visible on the sourced product in its reference photo. Do NOT add any extra stitch line, seam, panel line, or topstitching that is not on the real product — especially do NOT invent decorative stitch/seam lines near the hem, side, or chest. If the product is a plain simple garment, keep it plain: fewer lines, not more.`,
    '',
  ];

  return [
    '=== TASK: DRESS THE MODEL IN THE PRODUCT ===',
    `${identityBlock}`,
    `Image ${productImageNumber} is a shop listing photo of a ${CATEGORY_PRESERVE_LABEL[category]} — it may be laid flat, on a hanger, a catalog shot, or worn by some other shop model. ONLY the product itself is the reference from Image ${productImageNumber}: completely ignore any person, body, face, pose, other garments, and background shown there. Produce a photorealistic commercial lookbook photograph of the Image 1 model actually WEARING this exact product, fitted naturally on the body.`,
    '',
    ...priorityChecklistBlock,
    '=== MODEL (fixed personal standard) ===',
    buildModelLockLines(bodySpec),
    '',
    `=== PRODUCT FIDELITY (Image ${productImageNumber} is the source of truth for color/fit) ===`,
    `- Reproduce the product in Image ${productImageNumber} with complete fidelity: exact same color and shade, same fabric texture, same details (buttons, stitching, pockets, prints, logos as shown), same overall silhouette — a customer must recognize it as the same product they saw in the shop listing. Do NOT add a button/detail that is not shown, and do NOT drop or omit a button/detail that IS shown — match the exact count and placement.`,
    // (2026-07-19) 대표님 지시: 제품 이미지가 겉모습의 유일한 주(主) 기준, 재질은 "원단 느낌"
    // 텍스트로만 얹는 보조. 재질 참고 이미지는 아예 생성기에 안 들어오므로(=텍스트만), 여기서
    // "색·패턴·디자인·기장은 오직 제품 이미지에서만" 을 최우선으로 못박아 혼용을 원천 차단한다.
    `- PRIMARY VISUAL SOURCE (highest priority, overrides every other reference): Image ${productImageNumber}${extraProductImageNumbers.length ? ` (and the other-angle product photo${extraProductImageNumbers.length > 1 ? 's' : ''} ${extraProductImageNumbers.join(', ')})` : ''} is the ONE AND ONLY source for the garment's COLOR, PATTERN/PRINT, overall DESIGN, LENGTH, and SILHOUETTE${colorOverrideNote?.trim() ? ' (EXCEPT color, if a MANDATORY SOLD COLORWAY OVERRIDE is specified above — that wins for color only; pattern/design/length/silhouette still come from this photo)' : ''}. These four things come exclusively from the product photo — no textual note and no other reference may change the color, invent a pattern, or alter the design/length. If the product photo shows a plain solid fabric, the output MUST be plain and solid.`,
    // (2026-07-22) 핏은 판매자 지시(KEY FIT)가 있으면 여기서 추정값을 아예 빼서 두 번째 충돌
    // 지점을 없앤다 — 예전엔 이 줄의 "Fit: regular"가 상단의 "머슬핏 타이트"를 되돌리고 있었다.
    `- Reference spec — Color: ${garmentAnalysis.color}; Material: ${garmentAnalysis.material}; ${hasFitSpec ? 'Fit: see KEY FIT in the checklist above (seller spec — authoritative)' : `Fit: ${garmentAnalysis.fitType}`}; Surface texture: ${garmentAnalysis.texture}; Light reaction: ${garmentAnalysis.lightReaction}; Details: ${garmentAnalysis.details}.${colorVariantLine}${productNotesLine}${extraAngleLine}${materialLine}${poseAnchorLine}`,
    // 재질/원단은 "만졌을 때의 표면 느낌"으로만 반영 — 그 자체가 색이나 무늬를 바꾸면 안 된다.
    `- MATERIAL/TEXTURE IS SURFACE-FEEL ONLY: the "Material / Surface texture / Light reaction" fields above describe how the fabric FEELS and reflects light (weave/knit hand, thickness, matte/sheen). Apply them ONLY as the surface finish on top of the product's actual look — they must NOT change the color, must NOT become a visible repeating pattern or print, and must NOT alter the design. A weave/knit structure is fabric texture, NOT a decorative motif — never render it as a printed pattern across the garment.`,
    `- CRITICAL COLOR RULE: ${
      colorOverrideNote?.trim()
        ? `render the MANDATORY SOLD COLORWAY OVERRIDE color specified above, NOT the color shown in Image ${productImageNumber} — the reference photo's own color is superseded by that explicit override.`
        : colorVariant
          ? `the "${colorVariant}" colorway`
          : `the color shown in Image ${productImageNumber}`
    }${colorOverrideNote?.trim() ? '' : ' is the actual product color being sold — match it precisely, do not shift the hue, saturation, or brightness. Do NOT pull color from any other image or from the texture description.'}`,
    `- CRITICAL FABRIC RULE: reproduce ONLY the texture visible in Image ${productImageNumber} — do NOT invent, add, or embellish any decorative pattern, print, or embossed design that is not on the real product. A plain fabric must look boringly plain, like a studio product photo.`,
    `- CRITICAL BUTTON/HARDWARE COUNT RULE: before finalizing, actually count the buttons, snaps, zippers, or other hardware visible in ${materialImageNumbers.length ? `the close-up material reference image${materialImageNumbers.length > 1 ? 's' : ''} (Image ${materialImageNumbers.join(', ')}) — this is the clearest, most zoomed-in view and is the authoritative source for the exact count and spacing` : `Image ${productImageNumber}`}. The output must show that exact same count in the exact same positions — neither more nor fewer. This is a common failure mode: do not casually add an extra button or omit one out of habit. Every button must sit directly on the actual fabric placket opening with a real, visible buttonhole/gap beneath it — never place a button on a closed, seamless section of the knit/fabric where there is no opening, and never render two buttons stacked or duplicated at the same spot. The button placket must look structurally coherent, like a real garment construction photo.`,
    `- CRITICAL SEAM/POCKET/PATCH RULE: the "Details" spec above lists the exact seam/panel lines, pocket type+location, and logo/patch placement found by directly inspecting the real product photos. Treat this list as a checklist — reproduce each item at its stated location, in the stated quantity, and invent NOTHING beyond what is listed (no extra pocket, no extra patch, no seam line that isn't described). A single patch mentioned once must appear exactly once, at the location described — never mirrored onto both sides or duplicated. This is a common failure mode when the model isn't given a clear reference photo of the construction, so double-check the reference image(s) directly rather than defaulting to a generic version of this garment type.`,
    // (2026-07-21) 상의 전용 구조 지도 — 목/소매/밑단. 이 세 부위는 마감(골지 밴드/일반 시접)과
    // 대조 트림 유무가 서로 달라서 가장 자주 틀린다(실제 사고: 목·소매엔 흑백 휘프스티치, 밑단은
    // 대조 스티치 없는 골지 밴드인데 뭉개짐). 하의용 다리/포켓 행은 상의에 무의미하므로 빼고
    // 이 세 존만 좌표처럼 고정한다.
    ...(garmentAnalysis.constructionMap && category !== 'bottom'
      ? [
          [
            `- EDGE CONSTRUCTION MAP (neckline / cuffs / hem — the three edges of a top are finished DIFFERENTLY from each other and are the most commonly mis-rendered part; treat each line as exact ground truth):`,
            `  NECKLINE: ${garmentAnalysis.constructionMap.neckline}`,
            `  SLEEVE CUFFS: ${garmentAnalysis.constructionMap.sleeveCuffs}`,
            `  BOTTOM HEM: ${garmentAnalysis.constructionMap.hem}`,
            `  Side seams: ${garmentAnalysis.constructionMap.sideSeams}`,
            `  EDGE RENDERING RULE: render each of the three edges exactly as its line describes, and treat them as INDEPENDENT. A contrast trim/stitch belongs ONLY on the edges whose line actually names it — if the neckline and cuffs have a contrast whipstitch but the hem line says a plain band with no contrast stitching, the hem must be rendered plain, with the contrast stitch absent there. Never copy one edge's trim onto another edge, never omit a trim that IS named, and never replace a described ribbed band with a plain raw edge (or vice versa). Match the trim's stated colors and stitch style, and keep the band's stated width/proportion.`,
          ].join('\n'),
        ]
      : []),
    ...(garmentAnalysis.constructionMap && category === 'bottom'
      ? [
          [
            `- CONSTRUCTION MAP (zone-by-zone ground truth, in the WEARER'S left/right — this is the authoritative placement checklist, it wins over any generic assumption about this garment type):`,
            `  Photo classification: ${garmentAnalysis.constructionMap.photoClassification}`,
            `  FRONT waistband: ${garmentAnalysis.constructionMap.frontWaistband}`,
            `  FRONT wearer-LEFT leg: ${garmentAnalysis.constructionMap.frontLeftLeg}`,
            `  FRONT wearer-RIGHT leg: ${garmentAnalysis.constructionMap.frontRightLeg}`,
            `  BACK waistband: ${garmentAnalysis.constructionMap.backWaistband}`,
            `  BACK wearer-LEFT leg: ${garmentAnalysis.constructionMap.backLeftLeg}`,
            `  BACK wearer-RIGHT leg: ${garmentAnalysis.constructionMap.backRightLeg}`,
            `  BACK pockets: ${garmentAnalysis.constructionMap.backPockets}`,
            `  Side seams: ${garmentAnalysis.constructionMap.sideSeams}`,
            `  ASYMMETRY CHECKLIST (one-side-only details — the single most commonly failed part of this task): ${garmentAnalysis.constructionMap.asymmetryChecklist}`,
            `  RENDERING RULE for this map: decide the pose's camera-facing side FIRST (front-facing pose → render ONLY the FRONT waistband/left-leg/right-leg lines above; back-facing pose → render ONLY the BACK waistband/left-leg/right-leg/pockets lines above — never mix rows from both). A feature listed under "wearer-LEFT" must end up on the wearer's actual left leg and a feature under "wearer-RIGHT" on the wearer's actual right leg — these are two DIFFERENT features on two DIFFERENT legs, never merge them onto one leg and never put both on the same side. Remember the mirror rule when placing on the image: in a front-facing shot, the wearer's LEFT leg appears on the RIGHT side of the image; in a back-facing shot, the wearer's left leg appears on the left side of the image. A row that says "none" must be rendered with that zone plain/empty, and a row that says "not visible" must be rendered as the plainest reasonable continuation with no invented decoration.`,
            `  ASYMMETRY RENDERING RULE: every item in the ASYMMETRY CHECKLIST exists on EXACTLY ONE leg/side of the garment. Rendering it on both legs is a FAILED output. For each checklist item: put it on the stated wearer's side, then actively verify the OPPOSITE leg is plain, with no copy, echo, or mirrored version of that detail. Symmetric pairs (e.g. "two back pockets, one per side") are listed outside the checklist and are the ONLY details allowed to appear on both sides.`,
          ].join('\n'),
        ]
      : []),
    `- CRITICAL FRONT/BACK CONSISTENCY RULE: real garments look different from the front and back. Use garment anatomy to tell them apart in the reference photos — for BOTTOMS, the FRONT is the side with the center fly (button/zipper) and slanted side-entry pockets, and the BACK is the side with patch pockets/yoke/elastic gathering and NO fly; for TOPS, the front has the placket/graphic/forward-opening collar. Then render ONLY the side that matches the pose: a front-facing pose must show the fly and must NOT show back patch pockets wrapping around to the front; a back-facing pose must show the back construction and no fly. Never combine front details and back details into a single view, and never guess at an unseen side beyond a plain, undecorated continuation.`,
    '',
    '=== POSE & FRAMING (ABSOLUTE) ===',
    // (2026-07-17) 포즈 지시가 있는데도 "단정한 정면 스탠딩"이 고정 선두 문구로 있어서 지시가
    // 뒤에 덧붙는 구조였음 — 포즈 3장을 뽑아도 전부 같은 정면 스탠딩으로 나오는 원인(이 코드
    // 베이스의 반복 교훈: 지시문 위치가 반영을 좌우한다). 포즈 지시가 있으면 그게 유일한 포즈
    // 문장이 되도록 교체하고, 기본 스탠딩 문구는 지시가 없을 때만 쓴다.
    userAdditions.trim()
      ? `Camera framing: FULL BODY SHOT ONLY — head to toe, both feet and full footwear fully visible in frame, nothing cropped.
THE POSE FOR THIS SHOT (mandatory — this IS the pose to render, not a suggestion; do NOT default to a generic frontal standing pose, and do NOT default to whatever pose/turn direction any other reference image happens to show): ${userAdditions.trim()}
(If this specifies a direction or turn — e.g. facing left/right, three-quarter turn, side profile, back view, walking — the body orientation AND camera framing must clearly and unambiguously show it, exactly as worded (left means left, right means right) — this pose instruction is the ONLY authority on body direction and wins over every other image in this request. A back-view pose must actually show the model's back with the garment's BACK-zone construction. STRICT: the output is ONE photograph of exactly ONE person in ONE pose — if multiple poses are listed, pick only the single most suitable one, never render several people or a multi-pose lineup.)`
      : `Camera framing: FULL BODY SHOT ONLY — head to toe, both feet and full footwear fully visible in frame, nothing cropped. Clean, confident, polished commercial standing pose with natural hand placement. Default gaze/head direction: face and eyes toward or near the camera, in a natural relaxed way — do NOT habitually turn the head to one side (e.g. always to the right).`,
    '',
    '=== NEW STYLING TO GENERATE (everything except the product above) ===',
    (stylingLines.length > 0 ? stylingLines.join('\n') : '- Complete the outfit naturally with cohesive, stylish items that flatter the product.') + mandateBlock,
    ...styleReferenceLines,
    backgroundLine,
    GARMENT_SIDE_CONSISTENCY_RULE,
    '- The model\'s face must be fully and clearly visible — bare face, no eyewear or headwear of any kind unless a USER MANDATE above explicitly asks for it.',
    '',
    '=== NEGATIVE CONSTRAINTS (ABSOLUTE) ===',
    RESTYLE_QUALITY_CONSTRAINTS,
    '',
    '=== OUTPUT QUALITY MANDATE ===',
    'Produce a single authentic commercial lookbook photograph — the kind a person would want to buy the product after seeing. Photorealistic, natural skin texture, natural fabric folds, professional photography lighting. No CGI, no collage, single subject only.',
  ].join('\n');
}

/**
 * (2026-07-19) 생성 후 자동 검증에서 결함이 발견됐을 때, 재생성 프롬프트 맨 앞에 붙이는
 * 교정 블록. 맨 앞에 두는 이유: 이 코드베이스의 반복 교훈 — 지시문 위치가 반영을 좌우한다.
 * 같은 프롬프트로 다시 돌리면 같은 실수를 반복하므로, "직전 시도가 정확히 어떤 검사에서
 * 떨어졌는지"를 최우선 지시로 명시해야 교정된다.
 */
export function buildDefectCorrectionBlock(defects: string[]): string {
  return [
    '=== MANDATORY CORRECTIONS (a previous attempt at this exact shot FAILED automated inspection — fix every item below; these corrections override any conflicting habit) ===',
    ...defects.map((d, i) => `${i + 1}. ${d}`),
    'Re-render the shot with every correction applied. Everything else in the brief below stays the same.',
  ].join('\n');
}
