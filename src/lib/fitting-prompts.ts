/**
 * fitting-prompts.ts
 * AI 피팅(전신 1장 확정) / AI 바리에이션(포즈 다양화) 두 파이프라인이 공유하는 프롬프트 빌딩 블록.
 * 변동성 최소화의 핵심 — 모든 AI 호출이 이 파일을 통과함
 */

// ─────────────────────────────────────────────────────────────────
// 0. 사용자 고정 체형 스펙 (단일 기준 — AI 피팅 / AI 바리에이션 두 파이프라인 모두 동일하게 적용)
// 어떤 사진을 넣든 항상 동일한 체형/피부톤/비율로 결과가 나오도록, 파이프라인마다 따로 적지 않고 여기 하나만 수정한다.
// ─────────────────────────────────────────────────────────────────
export const PERSONAL_BODY_SPEC = `
- Height 177cm, Weight 74kg, Shoe/foot size 270mm (Korean 270 size).
- Well-proportioned upper body — balanced shoulder-to-waist ratio, not top-heavy.
- Skin tone: noticeably tanned, medium-deep warm brown Korean skin tone — like someone who spends time outdoors. This must read as clearly tanned/sun-kissed, NOT pale, NOT light beige, NOT porcelain white. Do not lighten the skin tone under any circumstance.
- Build: athletic and visibly toned, lean muscular definition — NOT a bulky bodybuilder, NOT skinny.
- Arms: defined, toned forearms and biceps with natural muscle definition visible under the skin, but the skin surface itself must look smooth and healthy — NO visible veins anywhere on the arms or hands. Do not render vein lines at all, even faint ones.
- Chest: firm and toned with well-defined pecs. Absolutely NOT soft, puffy, or sagging — no gynecomastia-like chest under any circumstance.
- Legs: moderately toned and firm, athletic proportion — NOT the thin/skinny-lean leg type.
- This exact physique (toned build, subtle natural arm definition, defined chest) is a FIXED personal standard and must be reproduced identically in every single generation — not a random variation per photo.
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

export const FULLBODY_POSES: PoseVariation[] = [
  {
    id: 'full_relaxed_front',
    label: '전신 정면 자연스러운 포즈',
    poseInstruction: 'Pose: Standing naturally, arms resting relaxed at sides, hands loose. Entire silhouette is clean and balanced.',
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
    poseInstruction: 'Pose: Standing in a three-quarter turn, showing side silhouette and layering balance.',
  },
  {
    id: 'full_side_profile_right',
    label: '전신 완전 측면(우측) 포즈',
    poseInstruction: 'Pose: Standing in a full right-side profile, body turned a full 90 degrees so only the side silhouette faces the camera, chin turned slightly back toward the lens, one arm relaxed at the side.',
  },
  {
    id: 'full_back_three_quarter',
    label: '전신 백뷰 쿼터턴 포즈',
    poseInstruction: 'Pose: Standing with the back turned three-quarters away from the camera, head turned back over the shoulder toward the lens, showing the back of the outfit with a hint of the side profile.',
  },
  {
    id: 'full_side_lean_pocket',
    label: '전신 측면 체중이동 포켓 포즈',
    poseInstruction: 'Pose: Standing in a side-turned stance with weight shifted onto one leg, hand tucked casually into the pocket, shoulders angled away from the camera for a candid lookbook feel.',
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
cartoon, illustration, CGI, 3D render, digital art, video game graphics, airbrushed skin, plastic skin, mannequin texture, artificial doll look, low resolution, blurry, deformed body, incorrect anatomy, extra limbs, bad hands, overlapping fingers, unnatural pose, oversaturated colors, fake lighting, warped background, artifacts, logos, text, watermark, composite look, collage, split screen, multi-panel, grid of photos, side-by-side comparison, diptych, triptych, photo montage, layout of multiple images, soft puffy chest, sagging chest, gynecomastia-like chest, love handles, flabby untoned body, out-of-shape physique, hunched posture, awkward stiff pose, invented fabric pattern, fake jacquard or paisley print, embossed decorative texture not present on the real garment, moire pattern on fabric, unintended textile print, visible veins, vein lines on arms or hands, pale skin, white skin, porcelain skin tone.
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
): string {
  const stylingLines: string[] = [];
  if (stylingSuggestion.top) stylingLines.push(`- 상의: ${stylingSuggestion.top}`);
  if (stylingSuggestion.bottom) stylingLines.push(`- 하의: ${stylingSuggestion.bottom}`);
  if (stylingSuggestion.shoes) stylingLines.push(`- 신발: ${stylingSuggestion.shoes}`);
  if (stylingSuggestion.accessory) stylingLines.push(`- 액세서리: ${stylingSuggestion.accessory}`);

  // 사용자가 입력한 자세/소품 지시 — POSE & FRAMING 섹션 안에 두고 "필수 준수"로 명시해야 반영됨.
  // 예전엔 STYLING 섹션 맨 끝에 "추가 스타일링 지시"로 잘못 라벨링되어 있어서 포즈/소품 지시가
  // 거의 무시됐었음 (예: "한손엔 토트백"을 지시해도 가방이 안 나옴).
  const poseHintBlock = userAdditions.trim()
    ? ` MANDATORY POSE/PROP REQUIREMENT (overrides the generic pose direction above — must be included exactly as described, e.g. if it mentions holding an item, that item must be visibly held in the model's hand): ${userAdditions.trim()}`
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
    RESTYLE_BODY_SPEC + identityReferenceLine,
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
