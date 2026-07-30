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
  /** 판매자 스펙(소재·핏·포인트) — 사진만으론 안 보이는 정보 */
  productNotes?: string,
): string {
  const color = colorOverride?.trim() || garmentAnalysis.color;
  const notesLine = productNotes?.trim()
    ? `\n\nSELLER SPEC (authoritative over your visual guess): ${productNotes.trim()}`
    : '';
  const anchorLine = hasAnchor
    ? `\n\nCONSISTENCY ANCHOR: the SECOND attached image is the already-approved FRONT view of this exact same garment, generated for this same set. Treat it as the ground truth for overall proportions: the total length, body width, sleeve length, shoulder width, hem line, fabric tone and the size/placement of any contrast trim MUST match it exactly. This shot is the same physical garment simply rotated — only the viewing angle changes, nothing about the garment itself.`
    : '';
  return `=== TASK: CLEAN PRODUCT-ONLY REFERENCE SHOT (NO PERSON) ===

Using the attached real reference photos of this ${CATEGORY_LABEL[category]} as ground truth for color/material/construction ONLY, produce a single clean studio product photograph of the garment ALONE — no person, no face, no visible mannequin head/limbs. Use whichever presentation renders most naturally for this garment type: an invisible ("ghost") mannequin form showing the garment's true 3D shape, or a neatly arranged flat lay — either is acceptable as long as NO person or mannequin body part is visible.

${ANGLE_INSTRUCTION[angle]}${anchorLine}

Background: pure seamless white studio background, no props, no text overlay.

LIGHTING (critical — this is what makes the colour read correctly): light it like a real e-commerce studio, NOT flat. A large soft key light from the front-upper-left plus a fill on the right, so the fabric shows gentle highlights on the raised areas and soft gradual shading in the folds. The garment must look LIT — bright, open and true to its real shade — never sunk into shadow. Expose for the garment: mid-tones stay open and the colour stays clearly readable. A navy must read as NAVY (clearly blue, obviously lighter than black); a heather grey must stay light and airy. Do not add a moody, dim, or heavily contrasted look, and do not let the fabric go so dark that its hue disappears.

Garment spec (authoritative — follow exactly, do not default to a generic version of this garment type):
- Color: ${color}
- Material: ${garmentAnalysis.material}
- Texture: ${garmentAnalysis.texture}
- Stretch: ${garmentAnalysis.stretch}
- Lining: ${garmentAnalysis.lining}
- Fit/silhouette: ${garmentAnalysis.fitType}
- Details: ${garmentAnalysis.details}${buildConstructionSummary(garmentAnalysis.constructionMap)}

${notesLine}

COLOR FIDELITY (critical): sample the garment's colour straight from the attached reference photos and reproduce that exact hue, saturation and lightness. Do NOT darken, deepen, mute or "enrich" it, and do not stylise it toward a moodier tone — a mid-tone heather grey must stay a mid-tone heather grey, not charcoal; a navy must stay clearly blue and obviously lighter than black; a wine red must stay exactly as light or dark as the photo. Rendering a colour darker than the reference is the single most common failure here — if in doubt, err one step BRIGHTER, never darker. If the reference photos and your instinct disagree, the photos win.

MATERIAL FIDELITY (critical): reproduce the actual fabric named in the spec. Cotton jersey / knit tee fabric must read as matte cotton with a visible fine knit grain and normal fabric body — NOT as brushed fleece, velour, suede, satin or any soft fuzzy pile. Do not add sheen, nap or plushness that is not in the reference photos.

HEM & CUFFS: the body hem hangs straight and loose exactly as the real garment does — never fold, roll or tuck the bottom hem, and never crop it short. Reproduce sleeve cuffs exactly as the real product has them: if the product genuinely has a contrast rolled cuff, keep it; if it does not, leave the sleeves flat and unrolled. Do not invent a fold anywhere.

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
    '- JEWELLERY IS A CLOSED LIST: the accessory line above is the COMPLETE inventory of everything worn on the hands, wrists, neck and ears. If it names one bracelet, the model wears exactly that one bracelet and NOTHING else — no ring, no second bracelet, no watch, no necklace, no earring. If it says none, the hands and neck are completely bare. Any jewellery visible in the model reference photo, the pose reference photo, the product photos or the anchor shot is NOT part of this outfit — those people are wearing their own things, and you must strip all of it.',
    '- ACCESSORY CONSISTENCY: render the specified item as ONE exact object — same type, same metal colour, same link/band style, same width — identical in every shot of this set. Never substitute a similar-looking alternative between shots.',
    "- SIDE/HAND RULE: any instruction naming a side (left wrist, right hand, etc.) means the WEARER'S own side. In a front-facing photo the wearer's left wrist appears on the RIGHT side of the frame — account for that mirroring. The named side must be identical in every shot of this set; never flip it between shots.",
    "- HEM: the sourced garment's hem hangs loose and untucked over the waistband unless explicitly told otherwise. Never tuck it in, never fold or roll the bottom hem, and never crop it short — let it fall naturally.",
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
    /**
     * (2026-07-31) 포즈 참고사진을 Image 1(편집 베이스)로 넣는 모드.
     * gpt-image-2 edit는 첫 이미지를 "편집 대상"으로 취급해서, 모델 사진을 1번에 두면
     * 그 사진의 포즈·구도가 기준이 되어 포즈 참고사진이 텍스트로 아무리 우선순위를 줘도
     * 밀린다(대표님이 세 번 신고). 포즈를 지킬 땐 포즈 사진 자체를 베이스로 편집한다.
     */
    poseAsBase?: boolean;
  },
): string {
  const { extraReferenceCount, hasPoseRefImage, hasBackgroundImage } = opts;
  const color = opts.colorOverride?.trim() || garmentAnalysis.color;
  const styling = buildStylingLines(category, opts.styleHints);
  const framing = opts.framing || 'full';

  // 이미지 번호 계산 — Image 1은 항상 모델, Image 2는 기준 대표컷.
  // 순서: [모델, 대표 기준컷, 나머지 기준컷…, 포즈참고, 배치앵커, 배경]
  // poseAsBase: [포즈사진(1), 모델(2), 대표 기준컷(3), 나머지 기준컷…, 앵커, 배경]
  // 일반 모드: [모델(1), 대표 기준컷(2), 나머지 기준컷…, 포즈사진, 앵커, 배경]
  const poseAsBase = !!opts.poseAsBase && hasPoseRefImage;
  let cursor = 0;
  const poseRefNum = poseAsBase ? ++cursor : null;
  const identityNum = ++cursor;
  const primaryRefNum = ++cursor;
  const extraRefNums = Array.from({ length: extraReferenceCount }, () => ++cursor);
  const poseRefNumTail = !poseAsBase && hasPoseRefImage ? ++cursor : null;
  const poseNum = poseRefNum ?? poseRefNumTail;
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
    poseAsBase
      ? `Image ${poseRefNum} is the POSE BASE — you are editing THIS photograph. Keep its composition exactly: the same body posture, the same limb positions, the same head and gaze direction, the same camera angle, distance and crop. Replace only WHO is in it and WHAT they are wearing. The person becomes the fixed model defined by Image ${identityNum}, and the clothing becomes the outfit specified below. Everything about the pose stays as it is in Image ${poseRefNum}.`
      : '',
    `Image ${identityNum} is the FIXED MODEL reference — the face, body proportions, and skin tone of the one person this brand always shoots. Match that person exactly. Do NOT copy the clothing, background, or pose from Image ${identityNum}; the outfit comes from the product references below${poseAsBase ? ` and the pose comes from Image ${poseRefNum}` : ' and the pose comes from the POSE section'}.`,
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
      ? `\nBATCH CONSISTENCY ANCHOR — Image ${anchorNum} is an earlier shot from THIS SAME set. Use it ONLY for these three things, so the set looks like one photo session: (a) overall body proportions and HEIGHT / head-to-body ratio, (b) the exact non-sourced garments — the same bottoms in the same color and silhouette, the same shoes, not a similar item or a different shade, (c) the studio lighting and backdrop tone.\nDo NOT use Image ${anchorNum} for the FACE. The face, facial features, hairstyle and skin tone come from Image 1 (the registered model reference) and from the MODEL section spec — Image ${anchorNum} is itself a generated image, so copying its face compounds any drift and the person slowly stops looking like the registered model. Whenever Image 1 and Image ${anchorNum} disagree about the face, Image 1 wins.\nDo NOT use Image ${anchorNum} for the POSE either — pose, limb placement, body rotation, gaze and camera angle come exclusively from the POSE section below. Image ${anchorNum} deliberately shows a DIFFERENT pose.`
      : '',
    '',
    'POSE & FRAMING (mandatory — overrides any pose visible in ANY other attached image):',
    poseNum
      ? [
          `- PRIMARY POSE AUTHORITY — Image ${poseNum} is the POSE REFERENCE PHOTO. Reproduce its posture as literally as a photographer re-shooting the same frame: the same torso rotation and body facing, the same head/gaze direction, the same placement of BOTH hands (note exactly whether each hand is in a FRONT pocket, a BACK pocket, crossed, hanging, raised, or holding something — front and back pockets are NOT interchangeable), the same arm bend, the same weight distribution and foot position, and the same camera height, distance and crop. If your first instinct differs from that photo, the photo is right and you are wrong.`,
          `- Take ONLY posture and camera framing from Image ${poseNum}. Its person, face, clothing, jewellery and background are NOT to be copied — identity comes from Image ${identityNum}, the garment from the product references, accessories from the outfit list above.`,
          `- The text description below is SECONDARY: use it only to settle details the photo cannot show or leaves ambiguous. It must never justify a posture different from the photo.`,
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
