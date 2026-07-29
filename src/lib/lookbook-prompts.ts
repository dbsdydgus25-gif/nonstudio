/**
 * AI 룩북(신규 섹션) 전용 프롬프트 빌더.
 * (2026-07-29) fitting-prompts.ts의 buildProductFittingPrompt를 확장하지 않고 새로 작성함 —
 * 그 함수는 "제품 피팅"에서 여러 번의 개별 사고를 패치하며 쌓인 특수 규칙이 많아서(패치 색
 * 반전, 카고 포켓 비대칭, 뮬 신발 등 이 파이프라인엔 대부분 무관), 그대로 확장하면 룩북도
 * 같은 복잡도를 물려받는다. 1단계(사람 없는 깨끗한 각도컷)는 애초에 사람이 안 들어가서
 * MODEL LOCK/정체성 오염 문제 자체가 발생하지 않는 게 핵심 설계 포인트.
 */
import { buildModelLockLines, DEFAULT_STUDIO_BACKGROUND } from '@/lib/fitting-prompts';
import type { GarmentAnalysis, GarmentConstructionMap, SourcedCategory } from '@/lib/fitting-prompts';

export type CleanAngle = 'front' | 'back' | 'left' | 'right';

const CATEGORY_LABEL: Record<SourcedCategory, string> = {
  top: '상의(윗옷)',
  bottom: '하의(바지/스커트)',
  outer: '아우터(재킷/가디건/코트 등)',
  shoes: '신발',
  accessory: '액세서리',
};

const ANGLE_INSTRUCTION: Record<CleanAngle, string> = {
  front: 'Front view — camera facing the garment straight-on, centered.',
  back: 'Back view — camera facing the garment from directly behind, showing back construction (back pockets, back yoke, closures, etc. exactly as they exist on the real product).',
  left: "Side view from the wearer's left — a clean 90-degree profile showing the side seam and silhouette depth.",
  right: "Side view from the wearer's right — a clean 90-degree profile showing the side seam and silhouette depth.",
};

function buildConstructionSummary(cm?: GarmentConstructionMap): string {
  if (!cm) return '';
  const lines = [
    cm.neckline && `Neckline/collar: ${cm.neckline}`,
    cm.sleeveCuffs && `Sleeve/cuffs: ${cm.sleeveCuffs}`,
    cm.hem && `Hem: ${cm.hem}`,
    cm.shoulderConstruction && `Shoulder construction: ${cm.shoulderConstruction}`,
    cm.closures && `Closures/hardware: ${cm.closures}`,
    cm.frontWaistband && `Front waistband: ${cm.frontWaistband}`,
    cm.backWaistband && `Back waistband: ${cm.backWaistband}`,
    cm.backPockets && `Back pockets: ${cm.backPockets}`,
    cm.sideSeams && `Side seams: ${cm.sideSeams}`,
    cm.asymmetryChecklist && `Asymmetric details (exist on ONE side only, do not mirror to the other side): ${cm.asymmetryChecklist}`,
  ].filter(Boolean);
  return lines.length ? `\n\nConstruction reference (from real product photos — reproduce exactly, do not invent or simplify):\n${lines.map((l) => `- ${l}`).join('\n')}` : '';
}

/**
 * 실제 스크래핑 사진들(사람이 찍혀 있을 수 있음)을 참고로 삼아, 사람/마네킹 얼굴 없이
 * 이 각도의 제품 단독 사진을 새로 만든다. 이 4컷이 이후 포즈 배치 피팅의 유일한 기준이 된다.
 */
export function buildCleanAngleShotPrompt(
  category: SourcedCategory,
  garmentAnalysis: GarmentAnalysis,
  angle: CleanAngle,
  colorOverride?: string,
  /** 앞면 결과를 앵커로 함께 넣는 경우 — 기장/품/톤을 그 컷에 맞추게 한다 */
  hasAnchor = false,
): string {
  const color = colorOverride?.trim() || garmentAnalysis.color;
  const anchorLine = hasAnchor
    ? `\n\nCONSISTENCY ANCHOR: the SECOND attached image is the already-approved FRONT view of this exact same garment, generated for this same set. Treat it as the ground truth for overall proportions: the total length, body width, sleeve length, shoulder width, hem line, fabric tone and the size/placement of any contrast trim MUST match it exactly. This shot is the same physical garment simply rotated — only the viewing angle changes, nothing about the garment itself.`
    : '';
  return `=== TASK: CLEAN PRODUCT-ONLY REFERENCE SHOT (NO PERSON) ===

Using the attached real reference photos of this ${CATEGORY_LABEL[category]} as ground truth for color/material/construction ONLY, produce a single clean studio product photograph of the garment ALONE — no person, no face, no visible mannequin head/limbs. Use whichever presentation renders most naturally for this garment type: an invisible ("ghost") mannequin form showing the garment's true 3D shape, or a neatly arranged flat lay — either is acceptable as long as NO person or mannequin body part is visible.

${ANGLE_INSTRUCTION[angle]}${anchorLine}

Background: pure seamless white studio background, soft even product-photography lighting, no props, no harsh shadows, no text overlay.

Garment spec (authoritative — follow exactly, do not default to a generic version of this garment type):
- Color: ${color}
- Material: ${garmentAnalysis.material}
- Texture: ${garmentAnalysis.texture}
- Stretch: ${garmentAnalysis.stretch}
- Lining: ${garmentAnalysis.lining}
- Fit/silhouette: ${garmentAnalysis.fitType}
- Details: ${garmentAnalysis.details}${buildConstructionSummary(garmentAnalysis.constructionMap)}

If any reference photo shows a person wearing this garment, completely ignore that person (face, body, pose) and the scene/background behind them — extract ONLY the garment's real color, material, and construction from what they're wearing. Do not blend or reference any human features from those photos in the output.`;
}

/**
 * 소싱 제품이 아닌 나머지 슬롯(하의/신발 등)을 무엇으로 입힐지 정하는 블록.
 * (2026-07-29) 처음엔 이 지시가 아예 없어서 "나머지 옷은 AI가 매번 알아서" 정해졌고,
 * 그러면 같은 배치 안에서도 컷마다 하의/신발이 바뀌어 룩북으로 못 쓴다(대표님 지적:
 * "다른 옷은 어떻게 착용할 건데?"). 대표님이 지정하면 그대로, 안 하면 아래 중립 기본값으로
 * 고정한다 — 핵심은 "매번 달라지지 않는 것"이라 기본값도 명시적으로 못박는다.
 */
const SLOT_LABEL_EN: Record<SourcedCategory, string> = {
  top: 'top',
  bottom: 'bottom (pants/skirt)',
  outer: 'outerwear',
  shoes: 'shoes',
  accessory: 'accessory',
};

/** 지정이 없을 때 쓰는 중립 기본 코디 — 소싱 제품이 주인공이 되도록 조용한 아이템으로 */
const DEFAULT_STYLING: Record<SourcedCategory, string> = {
  top: 'a plain white crew-neck cotton t-shirt, regular fit, tucked naturally',
  bottom: 'plain black straight-leg trousers, clean drape, no visible branding',
  outer: 'no outerwear — do not add a jacket, cardigan, or coat',
  shoes: 'plain white low-top leather sneakers, clean and unbranded',
  accessory: 'no accessories — no bag, hat, jewellery, or watch',
};

function buildStylingLines(
  sourced: SourcedCategory,
  hints?: Partial<Record<SourcedCategory, string>>,
): string {
  const slots: SourcedCategory[] = ['top', 'outer', 'bottom', 'shoes', 'accessory'];
  const lines = slots
    .filter((s) => s !== sourced)
    .map((s) => {
      const hint = hints?.[s]?.trim();
      return hint
        ? `- ${SLOT_LABEL_EN[s]}: ${hint} — MANDATORY, follow this literally. If it contains an exclusion ("no X", "X 아님"), that exclusion is equally mandatory.`
        : `- ${SLOT_LABEL_EN[s]}: ${DEFAULT_STYLING[s]}`;
    });
  return [
    'REST OF THE OUTFIT (fixed — every shot in this set must show the exact same items, never randomize between shots):',
    ...lines,
  ].join('\n');
}

/**
 * 2단계 — 1단계에서 승인한 "사람 없는 깨끗한 기준컷"을 제품 근거로 삼아, 등록된 가상 모델에게
 * 그 옷을 입히고 지정한 포즈 프리셋대로 촬영한 룩북 컷을 만든다.
 *
 * 이 파이프라인이 AI 제품 피팅보다 구조적으로 안전한 이유: 참고로 들어가는 제품 이미지가
 * 전부 우리가 만든 "사람 없는" 컷이라, 타사 모델 얼굴이 섞여 정체성이 오염될 여지가 없다
 * (2026-07-28에 실제로 터졌던 사고의 원인이 여기서는 입력 자체에 존재하지 않는다).
 *
 * 이미지 순서는 runGptImageEdit의 조립 순서와 반드시 일치해야 한다:
 *   Image 1 = 모델(identity), Image 2 = 기준 대표컷, Image 3.. = 나머지 기준컷,
 *   그 다음 = 포즈 참고사진(있으면), 마지막 = 배경.
 */
export function buildLookbookFittingPrompt(
  category: SourcedCategory,
  garmentAnalysis: GarmentAnalysis,
  poseInstruction: string,
  bodySpec: string,
  opts: {
    extraReferenceCount: number;
    hasPoseRefImage: boolean;
    hasBackgroundImage: boolean;
    colorOverride?: string;
    /** 소싱 제품이 아닌 나머지 슬롯을 뭘로 입힐지 — 비워두면 아래 기본 코디로 채운다 */
    styleHints?: Partial<Record<SourcedCategory, string>>;
    /** 판매자 제공 핏/디테일 스펙 (머슬핏, 크롭 기장 등) + 선택 사이즈 실측 */
    productNotes?: string;
    selectedSize?: { label: string; measurements?: string };
    /** 전신샷 / 클로즈업 */
    framing?: 'full' | 'close';
    /** 같은 배치에서 이미 확정된 첫 컷을 앵커로 함께 넣는지 */
    hasPoseAnchor?: boolean;
  },
): string {
  const { extraReferenceCount, hasPoseRefImage, hasBackgroundImage } = opts;
  const color = opts.colorOverride?.trim() || garmentAnalysis.color;
  const styling = buildStylingLines(category, opts.styleHints);
  const framing = opts.framing || 'full';

  // 이미지 번호 계산 — Image 1은 항상 모델, Image 2는 기준 대표컷.
  // 순서: [모델, 대표 기준컷, 나머지 기준컷…, 포즈참고, 배치앵커, 배경]
  const primaryRefNum = 2;
  const extraRefNums = Array.from({ length: extraReferenceCount }, (_, i) => primaryRefNum + 1 + i);
  let cursor = primaryRefNum + extraReferenceCount;
  const poseRefNum = hasPoseRefImage ? ++cursor : null;
  const anchorNum = opts.hasPoseAnchor ? ++cursor : null;
  const backgroundNum = hasBackgroundImage ? ++cursor : null;

  // 판매자 스펙 + 선택 사이즈 실측 — 숫자를 그대로 베끼지 말고 이 모델 체형 기준으로
  // "실제로 얼마나 헐렁/타이트하게 보이는지"를 추론하게 한다(제품 피팅에서 검증된 문구).
  const specParts = [opts.productNotes?.trim(), opts.selectedSize?.measurements?.trim()].filter(Boolean);
  const sizeLine = specParts.length
    ? `\nMANDATORY FIT/DETAIL SPEC from the seller${opts.selectedSize?.label ? ` (size ${opts.selectedSize.label})` : ''} — this overrides any fit impression you form from the photos, because shop photos are often shot loose on a different body: ${specParts.join(' / ')}. If this includes numeric measurements (chest, shoulder, total length, sleeve, waist, hip, thigh, rise, hem width), do NOT just repeat the numbers — reason about what they mean ON THIS SPECIFIC MODEL's body as described in the MODEL section below, and render the actual visual looseness, tightness, and drape they imply. For example: a chest width much narrower than a relaxed fit implies the fabric visibly hugs the chest and upper arms with no slack; a total length shorter than a standard tee on this height implies a visibly cropped hem sitting above the waistband; a hem/thigh width far wider than the leg implies a clearly baggy silhouette with extra fabric volume, not a tapered line.`
    : '';

  return [
    '=== TASK: DRESS THE FIXED MODEL IN THIS PRODUCT (LOOKBOOK SHOT) ===',
    '',
    `Image 1 is the FIXED MODEL reference — the face, body proportions, and skin tone of the one person this brand always shoots. Match that person exactly. Do NOT copy the clothing, background, or pose from Image 1; the outfit comes from the product references below and the pose comes from the POSE section.`,
    '',
    `Image ${primaryRefNum}${extraRefNums.length ? ` and Images ${extraRefNums.join(', ')}` : ''} show the SOURCED PRODUCT — clean product-only reference shots of this exact garment from different angles (front / back / left side / right side), already verified by the operator. These are the sole authority on the garment's color, material, construction, and proportions. Reproduce that exact garment on the model: same color, same fabric texture, same seams, pockets, closures and trims, in the same places. Do not substitute a generic version of this garment type and do not invent details that are absent from these references.`,
    extraRefNums.length
      ? `Before finalizing, cross-check against every angle: a front-facing pose must show the FRONT construction and a back-facing pose the BACK construction — never blend both sides into one view. Details that exist on only one side (per the spec below) stay on that one side and must not be mirrored.`
      : '',
    '',
    'PRODUCT SPEC (authoritative):',
    `- Color: ${color}`,
    `- Material: ${garmentAnalysis.material}`,
    `- Texture: ${garmentAnalysis.texture}`,
    `- Light reaction: ${garmentAnalysis.lightReaction}`,
    `- Stretch: ${garmentAnalysis.stretch}`,
    `- Lining: ${garmentAnalysis.lining}`,
    `- Fit/silhouette: ${garmentAnalysis.fitType}`,
    `- Details: ${garmentAnalysis.details}`,
    garmentAnalysis.constructionMap?.asymmetryChecklist
      ? `- Asymmetric details (exist on ONE side only — do not duplicate to the other side): ${garmentAnalysis.constructionMap.asymmetryChecklist}`
      : '',
    sizeLine,
    '',
    buildModelLockLines(bodySpec),
    '',
    styling,
    anchorNum
      ? `\nBATCH CONSISTENCY ANCHOR — Image ${anchorNum} is an already-approved shot from THIS SAME set: same person, same garment, same outfit, same studio. It is the ground truth for WHO and WHAT, never for HOW THEY STAND. The model's HEIGHT, head-to-body ratio, build, shoulder width, face, hair and skin tone must match it exactly, and every non-sourced item (the exact bottoms, their exact color and silhouette, the exact shoes) must be the identical item shown there — not a similar one, not a different shade. If anything about the body or the outfit would differ from Image ${anchorNum}, you are wrong — copy Image ${anchorNum}.\nCRITICAL EXCEPTION: do NOT take the pose, limb placement, body rotation, gaze, or camera angle from Image ${anchorNum}. Those come exclusively from the POSE section below. Image ${anchorNum} deliberately shows a DIFFERENT pose and reusing it would defeat the purpose of this shot.`
      : '',
    '',
    'POSE & FRAMING (mandatory — overrides any pose visible in ANY other attached image):',
    poseRefNum
      ? [
          `- PRIMARY POSE AUTHORITY — Image ${poseRefNum} is a POSE REFERENCE PHOTO. Reproduce the posture in that photo as literally as a photographer re-shooting it: the same torso rotation and body facing, the same head/gaze direction, the same placement of BOTH hands (note exactly whether each hand is in a FRONT pocket, a BACK pocket, crossed, hanging, or holding something — front and back pockets are NOT interchangeable), the same arm bend, the same weight distribution and foot position, and the same camera height and distance. If your first instinct differs from that photo, the photo is right and you are wrong.`,
          `- Copy ONLY the posture and camera angle from Image ${poseRefNum}. Completely ignore the person, face, clothing, and background in it — identity comes from Image 1 and the garment from the product references.`,
          `- The text description below is SECONDARY: use it only to settle details the photo cannot show or that it leaves ambiguous. It must never be used to justify a posture different from the photo.`,
          `- Pose details (secondary refinement): ${poseInstruction}`,
        ].join('\n')
      : `- ${poseInstruction} — follow every part of this literally, especially exact hand placement (a "back pocket" means the hand is behind the body in a rear pocket, never in a front pocket) and gaze direction.`,
    framing === 'close'
      ? `- CLOSE-UP framing: crop in tight on the sourced ${SLOT_LABEL_EN[category]} so it fills most of the frame, showing the fabric weave, stitching, and trims at real scale. The face may be partly or fully out of frame — that is expected. Keep the crop natural and photographic, not a zoomed-in blur.`
      : '- FULL-BODY commercial lookbook framing: the entire figure from head to shoes is inside the frame with comfortable margin, the whole outfit visible, photorealistic, shot on a professional camera.',
    '- Keep the camera distance and lens feel consistent with the rest of this set; do not zoom in or out arbitrarily.',
    '',
    `BACKGROUND: ${DEFAULT_STUDIO_BACKGROUND}`,
    backgroundNum
      ? `Image ${backgroundNum} is the exact studio backdrop to reproduce. The background comes only from there — never from the product reference photos or from Image 1.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}
