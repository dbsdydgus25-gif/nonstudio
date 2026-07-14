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
- One small identifying detail: a faint, barely-noticeable scar about 1cm long on the forearm — very subtle, like an old healed scratch. Do not make it dramatic or dark; it should only be visible on close inspection.
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

const RESTYLE_QUALITY_CONSTRAINTS = `
CRITICAL NEGATIVE CONSTRAINTS (DO NOT GENERATE):
cartoon, illustration, CGI, 3D render, digital art, video game graphics, airbrushed skin, plastic skin, mannequin texture, artificial doll look, low resolution, blurry, deformed body, incorrect anatomy, extra limbs, bad hands, overlapping fingers, unnatural pose, oversaturated colors, fake lighting, warped background, artifacts, logos, text, watermark, composite look, collage, split screen, multi-panel, grid of photos, side-by-side comparison, diptych, triptych, photo montage, layout of multiple images, soft puffy chest, sagging chest, love handles, flabby untoned body, out-of-shape physique, hunched posture, awkward stiff pose, invented fabric pattern, fake jacquard or paisley print, embossed decorative texture not present on the real garment, moire pattern on fabric, unintended textile print.
`.trim();

// (2026-07-14) MODEL LOCK — AI 피팅과 AI 제품 피팅이 완전히 동일한 문구로 모델을 규정한다.
// 두 파이프라인의 모델 서술이 조금이라도 다르면 결과 모델이 서로 다르게 흔들리는 원인이 되므로,
// 핵심 고정 문구를 한 곳에서 관리한다. (반복 강조는 오히려 과장을 유발하므로 각 항목은 한 번만 서술)
export function buildModelLockLines(bodySpec: string): string {
  return `
MODEL LOCK — this brand uses ONE fixed model. Every generation must show the exact same person, as if the same model returned to the same white studio for another shot of the same campaign. A viewer comparing any two generations must believe they are photos of the same person taken the same day.
Body & identity spec (ground truth — reproduce exactly; do not idealize, slim down, bulk up, or beautify):
${bodySpec}
The following must match the spec and the reference photo exactly, never randomized between generations: facial features, skin tone, hairstyle, body-hair amount, moles and skin marks, faint scars, vein visibility, muscle definition, and overall body proportions.
`.trim();
}

// (2026-07-09) 모델 정보 페이지에서 스펙을 편집할 수 있도록 상수 조립 대신 함수로 전환 —
// bodySpec 미지정 시 기존 PERSONAL_BODY_SPEC이 그대로 쓰여서 동작이 변하지 않는다.
function buildRestyleBodySpec(bodySpec: string): string {
  return `
${buildModelLockLines(bodySpec)}
- Reshape the body in the input photo toward this spec — do not literally copy the input photo's actual body shape.
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
    ? ` MANDATORY POSE/PROP REQUIREMENT (overrides the generic pose direction above — must be included exactly as described, e.g. if it mentions holding an item, that item must be visibly held in the model's hand): ${userAdditions.trim()} (STRICT: the output is ONE photograph of exactly ONE person in ONE pose. If the requirement above lists multiple different poses, pick only the single most suitable one — NEVER render several people, a multi-pose lineup, or the same person repeated side by side in one image.)`
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
    `Original photo pose reference: ${poseDescription}. Regenerate into a clean, confident, polished commercial standing pose — neat posture, natural hand placement. You do NOT need to literally replicate the original casual pose or framing; prioritize making it look like a professional AI-styled fitting shot.${poseHintBlock}`,
    '',
    '=== NEW STYLING TO GENERATE ===',
    `Every item listed below REPLACES whatever the person is wearing in that slot in the input photo — the input photo's own bottom/shoes/accessories (other than the one protected sourced item above) are NOT the reference and must NOT be preserved, copied, or kept similar in silhouette/color/style. Generate exactly what is described below instead, even if it looks completely different from the input photo.`,
    stylingLines.length > 0 ? stylingLines.join('\n') : '- Complete the outfit naturally with cohesive, stylish items.',
    backgroundLine,
    '',
    '=== NEGATIVE CONSTRAINTS (ABSOLUTE) ===',
    RESTYLE_QUALITY_CONSTRAINTS,
    '',
    '=== OUTPUT QUALITY MANDATE ===',
    'Produce a single authentic commercial lookbook photograph — the kind a person would want to buy the product after seeing. Photorealistic, natural skin texture, natural fabric folds, professional photography lighting. No CGI, no collage, single subject only.',
  ].join('\n');
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
): string {
  const stylingLines: string[] = [];
  if (stylingSuggestion.top) stylingLines.push(`- 상의: ${stylingSuggestion.top}`);
  if (stylingSuggestion.bottom) stylingLines.push(`- 하의: ${stylingSuggestion.bottom}`);
  if (stylingSuggestion.shoes) stylingLines.push(`- 신발: ${stylingSuggestion.shoes}`);
  if (stylingSuggestion.accessory) stylingLines.push(`- 액세서리: ${stylingSuggestion.accessory}`);

  const poseHintBlock = userAdditions.trim()
    ? ` MANDATORY POSE/PROP REQUIREMENT (must be included exactly as described): ${userAdditions.trim()} (STRICT: the output is ONE photograph of exactly ONE person in ONE pose. If the requirement above lists multiple different poses, pick only the single most suitable one — NEVER render several people, a multi-pose lineup, or the same person repeated side by side in one image.)`
    : '';

  // (2026-07-09, 2차 강화) 이미지 순서를 [모델, 제품, 배경]으로 바꿨다 — gpt-image-2의 edit는
  // 첫 번째 이미지를 "편집할 대상"으로 취급하는 경향이 있어서, 제품 사진이 1번일 때는 그 사진
  // 속 타사 모델의 몸/피부가 계속 결과에 배어 나왔다 (AI 피팅이 모델 일관성이 좋은 이유도
  // 기준 인물 사진이 1번 이미지이기 때문). 이제 "Image 1의 사람을 편집해서 Image 2의 제품을
  // 입힌다"는 자연스러운 편집 구도가 된다.
  const productImageNumber = hasIdentityReferenceImage ? 2 : 1;
  const backgroundImageNumber = productImageNumber + 1;

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
  const productNotesLine = productNotes?.trim()
    ? `\n- MANDATORY PRODUCT FIT/DETAIL SPEC (provided by the seller — overrides visual guesses from the photo): ${productNotes.trim()}. Apply these fit, length, and detail characteristics exactly to how the garment fits on the model's body.`
    : '';

  // 사용자 코디 지시 원문 — Gemini 코디 제안이 "와이드"를 "테일러드"로 순화하는 등 지시가
  // 희석되는 경우가 있어, 원문을 문자 그대로 따르라고 최종 프롬프트에 한 번 더 박는다.
  const SLOT_LABELS: Record<string, string> = { top: '상의', bottom: '하의', shoes: '신발', accessory: '액세서리' };
  const mandateLines = Object.entries(userSlotMandates || {})
    .filter(([, text]) => typeof text === 'string' && text.trim())
    .map(
      ([slot, text]) =>
        `- USER MANDATE for ${SLOT_LABELS[slot] || slot}: "${text!.trim()}" — follow this LITERALLY. If it says 와이드/wide, the silhouette must be clearly and visibly wide-leg (NOT tapered, NOT slim); if it specifies a color/material/length, match it exactly. This mandate wins over the AI styling description above if they conflict.`,
    );
  const mandateBlock = mandateLines.length > 0 ? `\n${mandateLines.join('\n')}` : '';

  return [
    '=== TASK: DRESS THE MODEL IN THE PRODUCT ===',
    `${identityBlock}`,
    `Image ${productImageNumber} is a shop listing photo of a ${CATEGORY_PRESERVE_LABEL[category]} — it may be laid flat, on a hanger, a catalog shot, or worn by some other shop model. ONLY the product itself is the reference from Image ${productImageNumber}: completely ignore any person, body, face, pose, other garments, and background shown there. Produce a photorealistic commercial lookbook photograph of the Image 1 model actually WEARING this exact product, fitted naturally on the body.`,
    '',
    '=== MODEL (fixed personal standard) ===',
    buildModelLockLines(bodySpec),
    '',
    `=== PRODUCT FIDELITY (Image ${productImageNumber} is the source of truth) ===`,
    `- Reproduce the product in Image ${productImageNumber} with complete fidelity: exact same color and shade, same fabric texture, same details (buttons, stitching, pockets, prints, logos as shown), same overall silhouette — a customer must recognize it as the same product they saw in the shop listing.`,
    `- Reference spec — Color: ${garmentAnalysis.color}; Material: ${garmentAnalysis.material}; Fit: ${garmentAnalysis.fitType}; Surface texture: ${garmentAnalysis.texture}; Light reaction: ${garmentAnalysis.lightReaction}; Details: ${garmentAnalysis.details}.${colorVariantLine}${productNotesLine}`,
    `- CRITICAL COLOR RULE: ${colorVariant ? `the "${colorVariant}" colorway` : `the color shown in Image ${productImageNumber}`} is the actual product color being sold — match it precisely, do not shift the hue, saturation, or brightness.`,
    `- CRITICAL FABRIC RULE: reproduce ONLY the texture visible in Image ${productImageNumber} — do NOT invent, add, or embellish any decorative pattern, print, or embossed design that is not on the real product. A plain fabric must look boringly plain, like a studio product photo.`,
    '',
    '=== POSE & FRAMING (ABSOLUTE) ===',
    `Camera framing: FULL BODY SHOT ONLY — head to toe, both feet and full footwear fully visible in frame, nothing cropped. Clean, confident, polished commercial standing pose with natural hand placement.${poseHintBlock}`,
    '',
    '=== NEW STYLING TO GENERATE (everything except the product above) ===',
    (stylingLines.length > 0 ? stylingLines.join('\n') : '- Complete the outfit naturally with cohesive, stylish items that flatter the product.') + mandateBlock,
    backgroundLine,
    '- The model\'s face must be fully and clearly visible — bare face, no eyewear or headwear of any kind unless a USER MANDATE above explicitly asks for it.',
    '',
    '=== NEGATIVE CONSTRAINTS (ABSOLUTE) ===',
    RESTYLE_QUALITY_CONSTRAINTS,
    '',
    '=== OUTPUT QUALITY MANDATE ===',
    'Produce a single authentic commercial lookbook photograph — the kind a person would want to buy the product after seeing. Photorealistic, natural skin texture, natural fabric folds, professional photography lighting. No CGI, no collage, single subject only.',
  ].join('\n');
}
