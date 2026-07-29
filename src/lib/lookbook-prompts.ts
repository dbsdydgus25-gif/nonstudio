/**
 * AI 룩북(신규 섹션) 전용 프롬프트 빌더.
 * (2026-07-29) fitting-prompts.ts의 buildProductFittingPrompt를 확장하지 않고 새로 작성함 —
 * 그 함수는 "제품 피팅"에서 여러 번의 개별 사고를 패치하며 쌓인 특수 규칙이 많아서(패치 색
 * 반전, 카고 포켓 비대칭, 뮬 신발 등 이 파이프라인엔 대부분 무관), 그대로 확장하면 룩북도
 * 같은 복잡도를 물려받는다. 1단계(사람 없는 깨끗한 각도컷)는 애초에 사람이 안 들어가서
 * MODEL LOCK/정체성 오염 문제 자체가 발생하지 않는 게 핵심 설계 포인트.
 */
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
): string {
  const color = colorOverride?.trim() || garmentAnalysis.color;
  return `=== TASK: CLEAN PRODUCT-ONLY REFERENCE SHOT (NO PERSON) ===

Using the attached real reference photos of this ${CATEGORY_LABEL[category]} as ground truth for color/material/construction ONLY, produce a single clean studio product photograph of the garment ALONE — no person, no face, no visible mannequin head/limbs. Use whichever presentation renders most naturally for this garment type: an invisible ("ghost") mannequin form showing the garment's true 3D shape, or a neatly arranged flat lay — either is acceptable as long as NO person or mannequin body part is visible.

${ANGLE_INSTRUCTION[angle]}

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
