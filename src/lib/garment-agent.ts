/**
 * garment-agent.ts
 * Gemini Vision 또는 OpenAI GPT-4o-mini 비전으로 옷 사진을 분석해 구조화된 GarmentAnalysis 객체 반환
 * 항상 동일한 분석 스키마를 반환해 프롬프트 일관성 보장
 */

import { GoogleGenAI, Type } from '@google/genai';
import OpenAI from 'openai';
import type { GarmentAnalysis, GarmentConstructionMap, StylingSuggestion, SourcedCategory } from './fitting-prompts';

// (2026-07-17) 존별 필드를 Gemini responseSchema로 강제 — 자유 텍스트 한 필드로는 Gemini가
// 대충 쓰거나 통째로 빼먹어도 조용히 통과됐다(고리+패치가 한쪽 다리에 뭉쳐서 나오는 사고로
// 실제 재현 확인). required로 걸어두면 필드 자체가 없는 응답은 나올 수 없다.
// (2026-07-19) 행 간 중복 금지 — 같은 디테일(예: 뒷주머니 한 쌍)이 왼다리 행/오른다리 행/
// backPockets 행에 반복 등장하면 생성 모델이 "여러 개가 양쪽에 있다"로 읽는 사고가 실제
// 프롬프트에서 재현됨. 대칭 쌍은 전용 행(backPockets 등)에만, 다리별 행에는 "그 다리에만
// 있는" 비대칭 디테일만 적게 하고, 비대칭 디테일 전용 체크리스트 필드를 추가했다.
const CONSTRUCTION_MAP_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    photoClassification: { type: Type.STRING, description: 'Per-photo FRONT/BACK/side/close-up classification with the anatomical cue used (e.g. "Photo 1: center fly visible → FRONT; Photo 2: patch pockets + elastic waistband, no fly → BACK")' },
    neckline: { type: Type.STRING, description: 'TOPS: the neckline — collar shape (crew/v/mock/polo), the band construction (ribbed band, bound edge, self-fabric), and CRITICALLY whether a contrast trim/stitch runs along it (state the trim colors and stitch style, e.g. "crew neck with narrow ribbed band edged by a black-and-white contrast whipstitch"). "none" if the garment is not a top' },
    sleeveCuffs: { type: Type.STRING, description: 'TOPS: the sleeve hem/cuff — band type (ribbed cuff, plain folded hem, raw edge) and whether the SAME contrast trim/stitch as the neckline appears here or not. Be explicit; this is frequently rendered wrong. "none" if not a top' },
    hem: { type: Type.STRING, description: 'TOPS: the BOTTOM hem of the garment — band type (wide ribbed band, plain hem, drawcord) and whether a contrast trim/stitch is present. If the neckline/cuffs have contrast trim but the hem does NOT, say so explicitly ("plain ribbed hem band, NO contrast stitching"). "none" if not a top' },
    closures: { type: Type.STRING, description: 'ALL closures and hardware, with EXACT COUNTS as digits. Look closely at the photos and literally COUNT them — do not estimate or assume a typical number. State: how many buttons and where they run (e.g. "5 buttons down a full-length center front placket, spaced evenly"), how many are on cuffs/pockets/collar, plus any zipper (state its length/type/pull colour, e.g. "1 full-length gold metal zipper"), snaps, toggles, hooks, or drawcords. Name the hardware colour and material (matte black plastic / gold metal / tortoiseshell / self-fabric covered). If the garment is a pullover with NO closures at all, write exactly "none — pullover, no buttons, no zipper, no closures of any kind". Never invent a placket or button that is not clearly visible in the photos' },
    frontWaistband: { type: Type.STRING, description: 'Front waistband construction: fly type, buttons/zip, belt loops, whether elastic is visible from front' },
    frontLeftLeg: { type: Type.STRING, description: "Wearer's LEFT leg, front view — ONLY details that exist on this leg and NOT on the other leg (a symmetric pair present on both legs does NOT belong here). \"none\" if this leg has no unique detail" },
    frontRightLeg: { type: Type.STRING, description: "Wearer's RIGHT leg, front view — ONLY details that exist on this leg and NOT on the other leg. \"none\" if this leg has no unique detail" },
    backWaistband: { type: Type.STRING, description: 'Back waistband construction: elastic gathering, yoke, or none' },
    backLeftLeg: { type: Type.STRING, description: "Wearer's LEFT leg, back view — ONLY details that exist on this leg and NOT on the other leg (do NOT repeat the shared back-pocket pair here; that belongs in backPockets only). \"none\" if this leg has no unique detail" },
    backRightLeg: { type: Type.STRING, description: "Wearer's RIGHT leg, back view — ONLY details that exist on this leg and NOT on the other leg (do NOT repeat the shared back-pocket pair here). \"none\" if this leg has no unique detail" },
    backPockets: { type: Type.STRING, description: 'The symmetric back pocket pair ONLY: count, shape, placement (e.g. "two large rectangular patch pockets, one per side, upper back"), or "none". A pocket that exists on ONE side only goes in that leg\'s row instead, not here' },
    sideSeams: { type: Type.STRING, description: 'Side seam construction, or "not visible in provided photos" if unseen' },
    asymmetryChecklist: { type: Type.STRING, description: 'EVERY one-side-only detail of this garment, each as "<detail> — wearer\'s <LEFT|RIGHT> <leg/side> ONLY, the opposite side has NO such detail", separated by "; ". Example: "hammer loop — wearer\'s LEFT leg ONLY, the opposite side has NO loop; cargo patch pocket with woven brand patch — wearer\'s RIGHT leg ONLY, the opposite side has NO cargo pocket and NO patch". Write "none — all details are symmetric" if truly nothing is one-sided' },
  },
  required: ['photoClassification', 'neckline', 'sleeveCuffs', 'hem', 'closures', 'frontWaistband', 'frontLeftLeg', 'frontRightLeg', 'backWaistband', 'backLeftLeg', 'backRightLeg', 'backPockets', 'sideSeams', 'asymmetryChecklist'],
};

/** OpenAI 폴백은 responseSchema 강제가 안 되므로, 필드가 빠지거나 문자열째로 와도 안전하게 정규화한다. */
function normalizeConstructionMap(cm: any): GarmentConstructionMap | undefined {
  if (!cm) return undefined;
  const fallback = 'not visible in provided photos — do not invent';
  if (typeof cm === 'string') {
    // 스키마 없이 자유 텍스트로 온 경우 — 그대로는 존별 렌더링 규칙과 안 맞아 못 씀
    return undefined;
  }
  return {
    photoClassification: cm.photoClassification || 'not provided',
    neckline: cm.neckline || fallback,
    sleeveCuffs: cm.sleeveCuffs || fallback,
    hem: cm.hem || fallback,
    closures: cm.closures || fallback,
    frontWaistband: cm.frontWaistband || fallback,
    frontLeftLeg: cm.frontLeftLeg || fallback,
    frontRightLeg: cm.frontRightLeg || fallback,
    backWaistband: cm.backWaistband || fallback,
    backLeftLeg: cm.backLeftLeg || fallback,
    backRightLeg: cm.backRightLeg || fallback,
    backPockets: cm.backPockets || fallback,
    sideSeams: cm.sideSeams || fallback,
    asymmetryChecklist: cm.asymmetryChecklist || 'none — all details are symmetric',
  };
}

/** 사이즈 옵션 정규화 — 라벨 없는/중복 항목 제거, 최대 12개. */
function normalizeSizeOptions(raw: any): Array<{ label: string; measurements?: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: Array<{ label: string; measurements?: string }> = [];
  for (const item of raw) {
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const measurements = typeof item?.measurements === 'string' && item.measurements.trim() ? item.measurements.trim() : undefined;
    out.push({ label, measurements });
    if (out.length >= 12) break;
  }
  return out.length ? out : undefined;
}

// Gemini의 responseSchema는 응답 전체 형태를 강제한다 — constructionMap만 스키마를 걸고
// 나머지 필드는 텍스트 지시로만 두면 모델이 다른 필드를 누락할 수 있어, 전체를 여기서 정의한다.
const GARMENT_ANALYSIS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    color: { type: Type.STRING },
    material: { type: Type.STRING },
    fitType: { type: Type.STRING, enum: ['oversized', 'boxy', 'regular', 'slim', 'wide-leg', 'skinny', 'straight', 'unknown'] },
    category: { type: Type.STRING, enum: ['top', 'bottom', 'outer', 'dress', 'shoes', 'bag', 'accessory', 'unknown'] },
    details: { type: Type.STRING },
    texture: { type: Type.STRING },
    lightReaction: { type: Type.STRING },
    chestWidth: { type: Type.STRING, nullable: true },
    length: { type: Type.STRING, nullable: true },
    sizeOptions: {
      type: Type.ARRAY,
      description: 'All sale size options found by READING any size chart / spec text embedded inside the provided images (Korean 상세페이지 이미지 속 텍스트 포함) or in the accompanying spec text. Empty array if no size info is present.',
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING, description: 'Size label as shown, e.g. "S", "M", "L", "FREE", "1", "30"' },
          measurements: { type: Type.STRING, nullable: true, description: 'Verbatim measurements for this size if a size chart is present, e.g. "허리 35 총장 62 밑위 30 허벅지 36.5" — else null. Do NOT invent numbers.' },
        },
        required: ['label'],
      },
    },
    constructionMap: CONSTRUCTION_MAP_SCHEMA,
  },
  required: ['color', 'material', 'fitType', 'category', 'details', 'texture', 'lightReaction', 'constructionMap'],
};

function parseBase64(dataUrl: string): { data: string; mimeType: string } {
  if (dataUrl.startsWith('data:')) {
    const [header, data] = dataUrl.split(',');
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
    return { data, mimeType };
  }
  return { data: dataUrl, mimeType: 'image/jpeg' };
}

// 도매처 URL에서 텍스트 스크래핑
async function fetchUrlText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(6000),
    });
    const html = await res.text();
    // HTML 태그 제거 + 공백 정리
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 3000); // 최대 3000자
    return text.trim();
  } catch {
    return ''; // URL 스크래핑 실패 시 조용히 넘어감
  }
}

// 429 할당량 초과 에러 발생 시 백오프 지연 후 재시도하는 헬퍼 함수
async function retryOn429<T>(fn: () => Promise<T>, retries = 3, delayMs = 4000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    const errMsg = error?.message || '';
    const isRateLimit = 
      error?.status === 429 || 
      errMsg.includes('429') || 
      errMsg.includes('Quota exceeded') || 
      errMsg.includes('RESOURCE_EXHAUSTED') ||
      errMsg.includes('rate limit');

    if (retries > 0 && isRateLimit) {
      console.warn(`[Gemini API] 429 Rate Limit 감지됨. ${delayMs / 1000}초 대기 후 재시도... (${retries}회 남음)`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return retryOn429(fn, retries - 1, delayMs * 1.5); // 지연 시간 점진적 증가
    }
    throw error;
  }
}

const ANALYSIS_SYSTEM_PROMPT = `
You are a professional fashion analyst for a Korean menswear e-commerce studio.
Analyze the garment image provided and return a structured JSON object with EXACT fields below.
Be precise and specific. Use English for all values.

CRITICAL RULES:
1. Describe ONLY the single physical garment itself.
2. Do NOT describe the image layout, photo composition, multiple views, collages, split-screen, or models (e.g., do NOT write "The photo shows a front and back view of a model", "collage", or "diptych").
3. Describe the item as a single individual garment (e.g., "A pair of washed blue denim jeans").
4. MANDATORY STRUCTURAL SCAN — before writing "details", actually look at the garment piece by piece and identify EVERY one of the following if present, with its exact location (e.g. "left thigh", "back right pocket", "center chest", "outer side seam"):
   - Seams and panel/paneling lines (where fabric pieces are joined — e.g. a contrast yoke, a side panel, a curved seam)
   - Pockets: type (cargo flap pocket, welt pocket, patch pocket, coin pocket, slit pocket) and exact placement on the garment
   - Any logo, brand patch, embroidery, print, or label — exact placement AND exact appearance (patch/background color, text/graphic color, shape — rectangular/round/shield, and the visible text or symbol if legible), e.g. "small rectangular woven patch on the left thigh cargo pocket flap, navy-blue background with white text" — do NOT describe placement alone; a wrong-colored or wrong-shaped patch is just as much a defect as a missing one
   - Closures: buttons (count + placement), zippers, drawstrings, toggles, snaps, velcro — exact placement and count
   - Any topstitching, contrast stitching color, or decorative stitch lines
   - Hem style (raw hem, cuffed/rolled, elastic, drawcord)
   This structural scan applies to EVERY garment type, not only denim — cargo pants, shorts, jackets, and knitwear all have real construction details that must be found and reported; do not skip this because the item isn't denim.
5. For jeans/denim specifically, ALSO be extremely detailed about the washing texture, sandwashed fading on thighs/knees, vertical slub lines, whiskering lines at the crotch, and exact denim twill texture grain — in addition to the structural scan above, not instead of it.
6. MANDATORY CONSTRUCTION MAP ("constructionMap" field) — this is the most important field. Build a systematic view-by-view, side-by-side map:
   a. First classify EACH provided photo as FRONT view, BACK view, side view, or close-up — using garment anatomy, not guesswork:
      - BOTTOMS: the FRONT has the fly (center button and/or zipper), a center-front waistband closure, and usually slanted/curved side entry pockets; the BACK has patch pockets, a yoke seam, often visible elastic gathering on the waistband, and NO fly. If you see a center button/zip fly → it is the FRONT. If you see large patch pockets at the top and no fly → it is the BACK.
      - TOPS: the FRONT has the button placket/zipper/graphic/chest logo and the collar opens forward; the BACK is typically plainer with a yoke.
      State the cue you used for each photo (e.g. "photo 2: center fly visible → FRONT", "photo 3: two patch pockets + elastic gathering, no fly → BACK").
   b. MIRROR RULE (critical): always describe locations in the WEARER'S left/right, not the photo's left/right. In a FRONT view, the wearer's LEFT appears on the VIEWER'S RIGHT (mirrored). In a BACK view, the wearer's left appears on the viewer's left (not mirrored). Apply this conversion explicitly before writing any left/right location.
   c. Then write the map as short labeled lines covering every zone, including "none" for empty zones — asymmetry matters (e.g. a patch on ONE leg only, a hammer loop on the OTHER leg only, elastic on the back waistband only):
      FRONT waistband: (e.g. "flat waistband with center button + zip fly, belt loops, NO elastic visible from front")
      FRONT wearer-left leg: ...
      FRONT wearer-right leg: ...
      BACK waistband: (e.g. "fully elasticated with gathering, no back closure")
      BACK wearer-left leg: (e.g. "hammer loop at outer side seam, no patch")
      BACK wearer-right leg: (e.g. "small woven brand patch near hem on outer side, no loop")
      BACK pockets: (count, shape, placement)
      SIDE seams / other: ...
   d. If a zone is not visible in any provided photo, write "not visible in provided photos — do not invent" for that zone.
   d2. TOPS — the three edge zones ("neckline", "sleeveCuffs", "hem") are MANDATORY and are the most frequently mis-rendered part of a top. For EACH of the three, state (1) the finish type (ribbed band / plain folded hem / bound edge / raw edge / drawcord) and (2) whether a CONTRAST trim or decorative stitch runs along that edge, naming its colors and stitch style. These three edges often differ from each other: a garment can have a contrast whipstitch at the neckline and cuffs but a plain ribbed hem band with NO contrast stitching. Never assume the three match — inspect each separately and, when an edge has no contrast trim, write "NO contrast stitching" explicitly. For bottoms, set these three to "none".
   e. NO DUPLICATION ACROSS ROWS (critical): each physical detail appears in EXACTLY ONE row of the map. A symmetric pair (e.g. the two standard back patch pockets) is described ONCE in its shared row ("backPockets": "two large rectangular patch pockets, one per side") and must NOT be repeated in the per-leg rows. The per-leg rows list ONLY details unique to that one leg. Repeating a detail in multiple rows makes the image generator render extra copies of it.
   f. ASYMMETRY CHECKLIST ("asymmetryChecklist" field): after building the map, list every one-side-only detail as "<detail> — wearer's <LEFT|RIGHT> leg ONLY, the opposite side has NO such detail", joined by "; ". This is the ground truth used to catch mirrored/duplicated details in the generated output, so triple-check each side assignment against the mirror rule (b) before writing it.
7. READ TEXT INSIDE THE IMAGES (critical for Korean 상세페이지). Some provided photos are not clean product shots but long detail-page cuts (상세컷) that contain TEXT baked into the image — fabric composition/혼용률, 소재, care, features/특징, and especially a SIZE CHART (사이즈표: 허리/총장/밑위/허벅지/가슴/어깨/소매 등). You MUST read that embedded Korean/English text and use it: fold material/care/feature text into "material" and "details", and extract every listed size into "sizeOptions". Text printed inside an image is real product data — never skip it because it is "in an image".
8. SIZE OPTIONS ("sizeOptions" field) — list every sale size you can find, from a size chart in the images OR from the accompanying spec text. Each entry: {label, measurements}. label = the size name shown (S/M/L/FREE/1/30 등). measurements = the verbatim numbers for that size if a chart gives them (e.g. "허리 35 총장 62 밑위 30 허벅지 36.5"), else null. Do NOT invent sizes or numbers — empty array if none is shown. These numbers are used only as a FIT reference later, not printed on the garment.
6.5 (structural scan caveat) When you report topstitching/seam lines in "details", report ONLY lines that are actually visible in the photos. Do NOT pad the description with generic seams a garment of this type "usually" has — an invented seam line becomes an invented stitch line in the generated image.

Return ONLY valid JSON, no markdown, no explanation:

{
  "color": "exact color name and fading/washing details (e.g., 'vintage sandwashed medium blue denim with natural fading', 'solid pitch black', 'washed charcoal with light vertical streaking')",
  "material": "fabric composition (e.g., 'heavyweight rigid 100% cotton denim twill', 'linen-rayon blend')",
  "fitType": "ONE of: oversized, boxy, regular, slim, wide-leg, skinny, straight, unknown",
  "category": "ONE of: top, bottom, outer, dress, shoes, bag, accessory, unknown",
  "details": "the full result of the MANDATORY STRUCTURAL SCAN above — every seam/panel line, every pocket (type + exact location), every logo/patch/print (exact location AND exact appearance — patch color, text/graphic color, shape), every closure (type + count + location), stitching, hem style. For denim, also add: vintage washing effects, sandwashed thighs/knees, whiskering at crotch, pocket distressing, hem wear. DO NOT mention brand tags, hangers, or store price cards/strings — those are packaging, not garment construction.",
  "texture": "surface texture description. CRITICAL — state whether the surface is FLAT-and-smooth or has genuine THREE-DIMENSIONAL RELIEF (raised/recessed structure you could feel with a finger), because this is the #1 thing that gets flattened in rendering. Name the specific relief if present: seersucker (자글자글/오돌토돌 puckered crinkled ridges that alternate with flat bands, giving an airy cooling hand), crinkle/wrinkle finish, waffle/honeycomb, corduroy wale, ribbing, slub, boucle, terry loop, cable knit, etc. If it is a striped or checked fabric, EXPLICITLY say whether the lines are FLAT PRINTED/YARN-DYED lines on a smooth surface, OR are formed by the 3D texture itself (e.g. seersucker stripes are puckered raised ridges, NOT printed lines). Describe how pronounced the relief is and how it puckers/ripples. Examples: 'seersucker: vertical yarn-dyed thin stripes where the striped bands pucker into raised crinkled ridges alternating with flatter bands — a lightweight, airy, three-dimensional cotton-blend summer weave, NOT a smooth flat shirting', 'coarse diagonal rigid denim twill weave', 'smooth flat poplin, no relief'.",
  "lightReaction": "how fabric reacts to light (e.g., 'matte finish, no sheen', 'subtle metallic sheen at highlights', 'slight luster, semi-matte'). If the fabric has 3D relief (seersucker/waffle/corduroy/ribbing), note that the raised ridges catch light while the recesses fall into soft self-shadow, giving a dappled, textured light play rather than an even flat sheen.",
  "chestWidth": "estimated chest measurement if visible (e.g., '54cm', '58cm') or null",
  "length": "garment length description (e.g., 'hip length', 'cropped above waist', 'ankle length', '28 inch inseam') or null",
  "sizeOptions": "an ARRAY (per rules 7-8) of {label, measurements} read from size charts/spec text in the images or accompanying text — [] if none. Never invent.",
  "constructionMap": "an OBJECT (per rule 6) with these required string fields — for TOPS the three edge zones neckline/sleeveCuffs/hem are the most important (rule 6d2): photoClassification, neckline, sleeveCuffs, hem, frontWaistband, frontLeftLeg, frontRightLeg, backWaistband, backLeftLeg, backRightLeg, backPockets, sideSeams, asymmetryChecklist — every field filled using WEARER'S left/right with the mirror rule applied, 'none' for empty zones, 'not visible in provided photos — do not invent' for unseen zones, no detail repeated across rows (rule 6e), and the asymmetry checklist per rule 6f. Every field is mandatory, never omit one."
}
`.trim();

export async function analyzeGarment(
  garmentImagesBase64: string[],
  geminiApiKey: string,
  sourceUrl?: string,
  rawSpecs?: string,
  userCategory?: string,
  openaiApiKey?: string,
  /**
   * (2026-07-14) 재질/디테일 전용 클로즈업 사진 — 색상 추출 대상이 아니다.
   * 메인 사진(garmentImagesBase64)은 색상/핏 위주로, 이 사진들은 질감/버튼/스티치 위주로
   * 분석하도록 이미지마다 역할을 명시해서 함께 보낸다 (라벨 없이 여러 장을 섞으면 Gemini가
   * 어느 사진을 색상 기준으로 삼아야 할지 헷갈려 함).
   */
  materialImagesBase64?: string[],
): Promise<GarmentAnalysis> {
  const parts: any[] = [];
  const hasMaterialImages = !!materialImagesBase64?.length;

  // 메인 제품 이미지 — 색상/핏/실루엣 기준
  garmentImagesBase64.forEach((imgBase64, i) => {
    const { data, mimeType } = parseBase64(imgBase64);
    if (hasMaterialImages || garmentImagesBase64.length > 1) {
      parts.push({
        text: `Image ${i + 1} — PRIMARY product photo. Use this for color, fit, silhouette, and category.`,
      });
    }
    parts.push({ inlineData: { data, mimeType } });
  });

  // 재질 참고 이미지 — 텍스처/버튼/스티치 전용, 색상 판단에는 쓰지 않음
  if (hasMaterialImages) {
    materialImagesBase64!.forEach((imgBase64, i) => {
      const { data, mimeType } = parseBase64(imgBase64);
      parts.push({
        text: `Material reference photo ${i + 1} — a close-up of the SAME product's FABRIC. Use this ONLY to describe how the fabric feels and reflects light: the "material" (fiber/weave/knit type, thickness), "texture" (surface weave/knit structure, hand), and "lightReaction" (matte/sheen) fields. Do NOT let this photo influence "color", any pattern/print, the silhouette, the length, or the construction "details" (pockets, seams, logo/patch placement) — those come exclusively from the PRIMARY product photo(s) above. A zoomed-in weave here is the fabric's texture, NOT a decorative pattern.`,
      });
      parts.push({ inlineData: { data, mimeType } });
    });
  }

  parts.push({
    text: ANALYSIS_SYSTEM_PROMPT,
  });

  // 도매처 URL 스크래핑 → Gemini 추가 컨텍스트로 주입
  if (sourceUrl) {
    console.log('[GarmentAgent] 도매처 URL 스크래핑:', sourceUrl);
    const urlText = await fetchUrlText(sourceUrl);
    if (urlText) {
      parts.push({
        text: `\n\nReference product page content scraped from seller URL (use to improve color, fabric, and fit accuracy):\n${urlText}`,
      });
    }
  }

  // 원단 스펙 텍스트가 있으면 추가 컨텍스트로 제공
  if (rawSpecs) {
    parts.push({
      text: `\n\nAdditional product spec from seller (Korean, use to refine your analysis):\n${rawSpecs}`,
    });
  }

  // 사용자가 명시한 카테고리가 있으면 강제 지시 주입
  if (userCategory) {
    parts.push({
      text: `\n\nCRITICAL USER REQUIREMENT: The user has explicitly selected that this sourcing item belongs to the category: "${userCategory.toUpperCase()}". You MUST strictly output "${userCategory.toLowerCase()}" as the value for the "category" field in your JSON response. DO NOT classify it as anything else.`,
    });
  }

  try {
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    // API 호출 시 429 재시도 헬퍼 적용
    const response = await retryOn429(() =>
      ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts }],
        config: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: GARMENT_ANALYSIS_SCHEMA as any,
        },
      })
    );

    const raw = response.text?.trim() || '{}';
    const parsed = JSON.parse(raw);
    return {
      color: parsed.color || 'unknown color',
      material: parsed.material || 'unknown fabric',
      fitType: parsed.fitType || 'regular',
      category: parsed.category || 'top',
      details: parsed.details || 'no additional details',
      texture: parsed.texture || 'standard fabric texture',
      lightReaction: parsed.lightReaction || 'matte finish',
      chestWidth: parsed.chestWidth || undefined,
      length: parsed.length || undefined,
      sizeOptions: normalizeSizeOptions(parsed.sizeOptions),
      constructionMap: normalizeConstructionMap(parsed.constructionMap),
    };
  } catch (geminiError) {
    if (openaiApiKey) {
      console.warn('[GarmentAgent] Gemini API 오류 발생. OpenAI GPT-4o-mini 비전으로 분석을 실행합니다.');
      try {
        const openai = new OpenAI({ apiKey: openaiApiKey });
        const messages: any[] = [
          {
            role: 'system',
            content: `You are an expert e-commerce menswear catalog assistant. Analyze the garment images and return a JSON object describing the garment.
CRITICAL RULES:
1. Describe ONLY the single physical garment itself.
2. Do NOT describe the image layout, photo composition, multiple views, collages, split-screen, or models (e.g., do NOT write "The photo shows a front and back view of a model", "collage", or "diptych").
3. Describe the item as a single individual garment (e.g. "A pair of vintage washed jeans").
4. MANDATORY STRUCTURAL SCAN — before writing "details", look at the garment piece by piece and identify every seam/panel line, every pocket (type: cargo/welt/patch/coin/slit + exact location), every logo/brand patch/embroidery/print (exact location, e.g. "left thigh cargo pocket flap"), every closure (buttons/zippers/drawstrings/toggles/snaps, count + location), topstitching/contrast stitching, and hem style. This applies to EVERY garment type (cargo pants, shorts, jackets, knitwear), not only denim.
5. For jeans/denim specifically, ALSO be extremely detailed about the washing texture, sandwashed fading on thighs/knees, vertical slub lines, whiskering lines at the crotch, and exact denim twill texture grain — in addition to the structural scan, not instead of it.
5.5 ONLY report seam/topstitch lines that are actually visible in the photos — never add generic seams the garment "usually" has, because an invented seam becomes an invented stitch line in the output.
7. READ TEXT INSIDE THE IMAGES: some photos are Korean 상세페이지 detail cuts with TEXT baked in (소재/혼용률, 특징, care, and a SIZE CHART 사이즈표). Read that embedded text and fold it into "material"/"details", and extract every listed size into "sizeOptions" ({label, measurements}); measurements = verbatim numbers if a chart gives them (e.g. "허리 35 총장 62"), else null. Never invent sizes/numbers; [] if none.
6. MANDATORY CONSTRUCTION MAP ("constructionMap" field) — classify each photo as FRONT/BACK/side/close-up using garment anatomy (BOTTOMS: center fly/button+zip = FRONT; patch pockets/yoke/elastic gathering with no fly = BACK. TOPS: placket/graphic/forward collar = FRONT; plain yoke = BACK), stating the cue per photo, then map every zone in the WEARER'S left/right (mirror rule: in a FRONT view the wearer's left appears on the viewer's right; in a BACK view it does not mirror). Write labeled lines: FRONT waistband / FRONT wearer-left leg / FRONT wearer-right leg / BACK waistband / BACK wearer-left leg / BACK wearer-right leg / BACK pockets / SIDE seams. Mark empty zones "none" and unseen zones "not visible in provided photos — do not invent". Asymmetry matters (e.g. patch on one leg only, hammer loop on the other leg only, elastic on the back waistband only). NO DUPLICATION: each physical detail appears in exactly ONE line — symmetric pairs (the two back pockets) go only in the BACK pockets line, never repeated per-leg; per-leg lines list only one-leg-only details. End with an ASYMMETRY CHECKLIST line: every one-side-only detail as "<detail> — wearer's <LEFT|RIGHT> leg ONLY, the opposite side has NO such detail", joined by "; ".

The JSON must follow this exact schema:
{
  "color": "highly specific color description and fading pattern (e.g. vintage sandwashed medium blue denim with natural fading, deep charcoal)",
  "material": "fabric description (e.g. heavyweight rigid 100% cotton denim twill, lightweight cotton blend)",
  "fitType": "slim" | "regular" | "oversized" | "loose" | "wide-leg",
  "category": "top" | "bottom" | "outer" | "dress" | "shoes" | "bag" | "accessory",
  "details": "the full result of the MANDATORY STRUCTURAL SCAN: every seam/panel line, every pocket (type + exact location), every logo/patch/print (exact location AND exact appearance — patch color, text/graphic color, shape), every closure (type + count + location), stitching, hem style. For denim, also add vintage washes/sandwashed thighs/whiskering/pocket distressing/hem wear. DO NOT include hangers, strings, price cards, or store tags.",
  "texture": "fabric texture description (e.g. coarse diagonal rigid denim twill weave, high-contrast wash grain)",
  "lightReaction": "matte" | "subtle sheen" | "glossy",
  "sizeOptions": "array of {label, measurements} read from size charts/spec text in the images (rule 7); [] if none; never invent",
  "constructionMap": "the full result of the MANDATORY CONSTRUCTION MAP (rule 6): photo classification with reasoning, then labeled zone-by-zone lines (FRONT waistband / FRONT wearer-left leg / FRONT wearer-right leg / BACK waistband / BACK wearer-left leg / BACK wearer-right leg / BACK pockets / SIDE seams), in WEARER'S left/right with the mirror rule applied, empty zones marked 'none', unseen zones marked 'not visible in provided photos — do not invent'"
}
Output raw JSON ONLY. No markdown formatting, no \`\`\`json block. Just the raw JSON string.`
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Analyze these garment photos. Category requested by user: ${userCategory || 'unknown'}. Additional specs: ${rawSpecs || ''}.${hasMaterialImages ? ' The additional images after the primary ones are CLOSE-UP FABRIC reference photos of the same product — use them ONLY to describe material/texture/lightReaction (fabric hand, weave/knit, sheen). Do NOT take color, pattern/print, silhouette, length, or construction details from them; those come only from the primary product photos. A zoomed weave is texture, not a pattern.' : ''}`
              },
              ...garmentImagesBase64.map(b64 => {
                const { data, mimeType } = parseBase64(b64);
                return {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimeType};base64,${data}`
                  }
                };
              }),
              ...(materialImagesBase64 || []).map(b64 => {
                const { data, mimeType } = parseBase64(b64);
                return {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimeType};base64,${data}`
                  }
                };
              })
            ]
          }
        ];

        const chatCompletion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages,
          temperature: 0.1,
          response_format: { type: 'json_object' }
        });

        const raw = chatCompletion.choices[0].message.content?.trim() || '{}';
        const parsed = JSON.parse(raw);
        return {
          color: parsed.color || 'unknown color',
          material: parsed.material || 'unknown fabric',
          fitType: parsed.fitType || 'regular',
          category: userCategory || parsed.category || 'top',
          details: parsed.details || 'no additional details',
          texture: parsed.texture || 'standard fabric texture',
          lightReaction: parsed.lightReaction || 'matte finish',
          sizeOptions: normalizeSizeOptions(parsed.sizeOptions),
          constructionMap: normalizeConstructionMap(parsed.constructionMap),
        };
      } catch (openaiError) {
        console.error('[GarmentAgent] OpenAI 비전 대체 분석 실패:', openaiError);
      }
    }

    // 최종 폴백 기본값 (Gemini/OpenAI 둘 다 실패했을 때만 — 데님 단정 대신 일반적인 값으로).
    // analysisFailed로 표시해서 호출부/UI가 "분석 실패 상태로 생성 중"임을 알 수 있게 한다 —
    // 무료 등급 한도(429) 초과 시 조용히 이 값으로 생성돼 품질이 무너지던 문제 대응.
    console.error(
      '[GarmentAgent] 분석 실패 — 일반 폴백값으로 진행합니다. 구조/재질/디테일이 반영되지 않습니다.',
      geminiError,
    );
    return {
      color: 'as shown in image',
      material: 'as shown in image',
      fitType: (userCategory === 'bottom' ? 'wide-leg' : 'regular') as any,
      category: (userCategory as any) || 'top',
      details: rawSpecs || 'as shown in the reference garment photo',
      texture: 'textured fabric',
      lightReaction: 'matte finish',
      analysisFailed: true,
    };
  }
}

// 레퍼런스 포즈 이미지 분석
export async function analyzePose(
  poseImageBase64: string,
  geminiApiKey: string,
  openaiApiKey?: string
): Promise<string> {
  const { data, mimeType } = parseBase64(poseImageBase64);

  const promptText = `
Analyze the human pose, body posture, arm/leg placement, hand positions, and camera framing in this fashion reference image.
Provide a clear, detailed 1-2 sentence description in English of the pose and posture (do not describe the clothes, color, or background).
Examples:
- "Pose: Standing facing camera, arms crossed over chest, confident posture."
- "Pose: Walking forward confidently, left hand in pants pocket, right arm swinging naturally."
  `.trim();

  try {
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    // API 호출 시 429 재시도 헬퍼 적용
    const response = await retryOn429(() =>
      ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { data, mimeType } },
              { text: promptText }
            ]
          }
        ],
        config: {
          temperature: 0.2,
        }
      })
    );

    return response.text?.trim() || "Standing naturally facing camera.";
  } catch (geminiError) {
    if (openaiApiKey) {
      console.warn('[PoseAgent] Gemini API 에러 발생. OpenAI GPT-4o-mini 비전 포즈 분석으로 대체 처리합니다.');
      try {
        const openai = new OpenAI({ apiKey: openaiApiKey });
        const chatCompletion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: promptText },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } }
              ]
            }
          ],
          temperature: 0.2
        });
        return chatCompletion.choices[0].message.content?.trim() || "Standing naturally facing camera.";
      } catch (openaiError) {
        console.error('[PoseAgent] OpenAI 포즈 대체 분석 실패:', openaiError);
      }
    }
    return "Standing naturally facing camera.";
  }
}

// 배경 이미지 분석
export async function analyzeBackground(
  backgroundImageBase64: string,
  geminiApiKey: string,
  openaiApiKey?: string
): Promise<string> {
  const { data, mimeType } = parseBase64(backgroundImageBase64);

  const promptText = `
Analyze this background scene image.
Provide a highly detailed 1-2 sentence description in English of the setting, environment, background elements, lighting style, and overall atmosphere.
Do not describe any people or clothes. Only describe the environment and its lighting.
Examples:
- "A modern minimalist interior with concrete walls, soft natural sunlight streaming from the left, casting realistic shadows."
- "An outdoor urban street sidewalk during golden hour, soft bokeh of city lights in the background, warm natural lighting."
  `.trim();

  try {
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    // API 호출 시 429 재시도 헬퍼 적용
    const response = await retryOn429(() =>
      ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { data, mimeType } },
              { text: promptText }
            ]
          }
        ],
        config: {
          temperature: 0.2,
        }
      })
    );

    return response.text?.trim() || "Clean white studio background.";
  } catch (geminiError) {
    if (openaiApiKey) {
      console.warn('[BackgroundAgent] Gemini API 에러 발생. OpenAI GPT-4o-mini 비전 배경 분석으로 대체 처리합니다.');
      try {
        const openai = new OpenAI({ apiKey: openaiApiKey });
        const chatCompletion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: promptText },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data}` } }
              ]
            }
          ],
          temperature: 0.2
        });
        return chatCompletion.choices[0].message.content?.trim() || "Clean white studio background.";
      } catch (openaiError) {
        console.error('[BackgroundAgent] OpenAI 배경 대체 분석 실패:', openaiError);
      }
    }
    return "Clean white studio background.";
  }
}

const CATEGORY_SLOT_LABELS: Record<SourcedCategory, string> = {
  top: '상의',
  bottom: '하의',
  outer: '아우터',
  shoes: '신발',
  accessory: '액세서리',
};

const STYLING_FALLBACK_DEFAULTS: Record<Exclude<keyof StylingSuggestion, 'background'>, string> = {
  top: 'A simple neutral-tone t-shirt or knit top that complements the outfit.',
  bottom: 'Neutral straight-fit trousers in a complementary tone.',
  shoes: 'Minimal white leather sneakers.',
  accessory: 'A simple canvas tote bag.',
};

export type StyleHintsBySlot = Partial<Record<'top' | 'bottom' | 'shoes' | 'accessory', string>>;

// 보존되지 않는 나머지 슬롯(상의/하의/신발/액세서리/배경)에 대한 코디 스타일링 제안 생성 (텍스트 전용)
export async function generateStylingSuggestion(
  protectedCategory: SourcedCategory,
  garmentAnalysis: GarmentAnalysis,
  poseDescription: string,
  geminiApiKey: string,
  openaiApiKey?: string,
  userPreferenceHints?: StyleHintsBySlot,
): Promise<StylingSuggestion> {
  const slotsToFill = (['top', 'bottom', 'shoes', 'accessory'] as SourcedCategory[]).filter((s) => s !== protectedCategory);

  // 슬롯마다 별도 입력 필드로 받은 사용자 지시를 슬롯 이름을 명시해서 각각 "필수 준수" 문구로 만든다.
  // 예전엔 하의/신발/액세서리 지시를 하나의 자유 텍스트로 합쳐서 보냈더니, AI가 어느 문장이
  // 어느 슬롯 얘기인지 잘못 해석해서(특히 신발) 지시를 놓치는 경우가 반복됐음 — 슬롯을 코드로
  // 확정해서 모호함을 아예 없앤다.
  const mandatoryLines = slotsToFill
    .map((slot) => {
      const hint = userPreferenceHints?.[slot as keyof StyleHintsBySlot];
      if (!hint?.trim()) return null;
      return `- MANDATORY requirement for ${CATEGORY_SLOT_LABELS[slot]}(${slot}): ${hint.trim()} — the "${slot}" field in your JSON output MUST directly and specifically reflect this, do not substitute, soften, or ignore any part of it.`;
    })
    .filter((line): line is string => !!line)
    .join('\n');

  const outerBaseLayerHint = protectedCategory === 'outer'
    ? '\nThe sourced item is an OUTER garment (jacket/cardigan/coat) worn OVER a base layer. The "top" slot in your JSON output represents that BASE LAYER, not another jacket — suggest a slim, simple piece (a plain crew-neck tee, turtleneck, or thin knit) that would peek through at the neckline and cuffs. Do NOT suggest another outer layer, heavy garment, or anything bulky for the "top" slot.'
    : '';

  const promptText = `
You are a professional fashion stylist for a Korean menswear lookbook shoot.
A model is already wearing the confirmed sourced product: a ${garmentAnalysis.category} described as "${garmentAnalysis.color}, ${garmentAnalysis.material}, ${garmentAnalysis.fitType} fit". This item is masked/protected and must NOT be changed or mentioned as something to generate.
Current pose in the photo: ${poseDescription}
${outerBaseLayerHint}
${mandatoryLines ? `MANDATORY USER REQUIREMENTS (NOT soft preferences — follow each exactly):\n${mandatoryLines}\nIMPORTANT: if a requirement contains a negation or exclusion (e.g., "not X", "no X", "X 아님", "(X 제외)", "(X 하지마)", "(X X)" meaning "avoid X"), that exclusion is just as mandatory as the positive part — you must actively avoid producing X in your description, not merely fail to mention it.` : ''}

Suggest a cohesive, stylish outfit for ONLY these remaining slots: ${slotsToFill.map((s) => CATEGORY_SLOT_LABELS[s]).join(', ')}, plus a studio/location background that matches the mood. Any slot not covered by a mandatory requirement above should be styled freely to match it.
NEVER suggest sunglasses, hats, caps, beanies, or anything that covers the model's face or hair — the model's face must stay fully visible (these items are only allowed if a mandatory user requirement explicitly asks for them).
Return ONLY valid JSON with these exact keys (use an empty string "" for any slot NOT in the list above):
{
  "top": "detailed description of top/knitwear, or empty string",
  "bottom": "detailed description of pants/skirt, or empty string",
  "shoes": "detailed description of footwear, or empty string",
  "accessory": "detailed description of bag/watch/jewelry/sunglasses, or empty string",
  "background": "detailed studio or location background description"
}
  `.trim();

  const pickSlots = (parsed: any): StylingSuggestion => ({
    top: slotsToFill.includes('top') ? (parsed.top || undefined) : undefined,
    bottom: slotsToFill.includes('bottom') ? (parsed.bottom || undefined) : undefined,
    shoes: slotsToFill.includes('shoes') ? (parsed.shoes || undefined) : undefined,
    accessory: slotsToFill.includes('accessory') ? (parsed.accessory || undefined) : undefined,
    background: parsed.background || 'Clean minimalist white studio background with soft professional lighting.',
  });

  // 사용자가 명시적으로 스타일을 지시했을 때는 창의성보다 지시 순응이 훨씬 중요하므로 온도를 낮춘다.
  const temperature = mandatoryLines ? 0.3 : 0.8;

  try {
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    const response = await retryOn429(() =>
      ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: promptText }] }],
        config: {
          temperature,
          responseMimeType: 'application/json',
        },
      })
    );
    const parsed = JSON.parse(response.text?.trim() || '{}');
    return pickSlots(parsed);
  } catch (geminiError) {
    if (openaiApiKey) {
      console.warn('[StylingAgent] Gemini API 오류 발생. OpenAI로 코디 스타일링 제안을 대체 생성합니다.');
      try {
        const openai = new OpenAI({ apiKey: openaiApiKey });
        const chatCompletion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: promptText }],
          temperature,
          response_format: { type: 'json_object' },
        });
        const parsed = JSON.parse(chatCompletion.choices[0].message.content?.trim() || '{}');
        return pickSlots(parsed);
      } catch (openaiError) {
        console.error('[StylingAgent] OpenAI 코디 스타일링 제안 대체 실패:', openaiError);
      }
    }

    // 최종 폴백 기본값
    return {
      bottom: slotsToFill.includes('bottom') ? STYLING_FALLBACK_DEFAULTS.bottom : undefined,
      shoes: slotsToFill.includes('shoes') ? STYLING_FALLBACK_DEFAULTS.shoes : undefined,
      accessory: slotsToFill.includes('accessory') ? STYLING_FALLBACK_DEFAULTS.accessory : undefined,
      background: 'Clean minimalist white studio background with soft professional lighting.',
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// 색상 옵션 자동 추출 (AI 제품 피팅용, 2026-07-09)
// 도매처(신상마켓/도매꾹 등) 샘플 시트는 한 장에 여러 색상이 같이 나오는 경우가 많다 —
// 그 한 장에서 실제로 판매되는 색상 옵션들을 추출해 색상별 생성으로 이어준다.
// ─────────────────────────────────────────────────────────────────
export interface ColorVariant {
  /** UI 표시용 한글 색상명 (예: "아이보리") */
  label: string;
  /** 프롬프트용 정밀 영어 색상 설명 (예: "ivory off-white") */
  color: string;
  /** 시트 안에서 이 색상 제품이 차지하는 영역 [ymin, xmin, ymax, xmax] (0~1000 정규화) —
   * 생성 전에 이 영역만 잘라 보내면 "여러 벌 중 어느 옷인지" 혼동 없이 제품 재현이 훨씬 정확해짐 */
  box?: [number, number, number, number];
}

export async function extractColorVariants(
  imageBase64: string,
  geminiApiKey: string,
  openaiApiKey?: string,
): Promise<ColorVariant[]> {
  const { data, mimeType } = parseBase64(imageBase64);
  const promptText = `
This is a wholesale sample sheet photo of ONE clothing product that may show MULTIPLE color options
(the same garment repeated in different colors, often stacked or side by side).
List every distinct color option of the product shown in this image, WITH the bounding box of each colorway.

Rules:
- Only count actual colorways of the product itself — ignore background, props, print graphics' internal colors, and lighting differences.
- If the image shows only ONE color of the product, return exactly one entry.
- Keep the order they appear in the image (top to bottom, left to right).
- "box_2d" is the tight bounding box around that single colorway garment, as [ymin, xmin, ymax, xmax] normalized to 0-1000.

Return ONLY valid JSON, no markdown:
{ "colors": [ { "label": "짧은 한글 색상명 (예: 아이보리)", "color": "precise English color description for image generation (e.g., 'ivory off-white', 'jet black', 'light heather gray melange')", "box_2d": [ymin, xmin, ymax, xmax] } ] }
`.trim();

  const parseColors = (raw: string): ColorVariant[] => {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.colors) ? parsed.colors : [];
    return list
      .filter((c: any) => c && typeof c.color === 'string' && c.color.trim())
      .map((c: any) => {
        const b = c.box_2d;
        const box =
          Array.isArray(b) && b.length === 4 && b.every((n: any) => typeof n === 'number' && n >= 0 && n <= 1000) && b[0] < b[2] && b[1] < b[3]
            ? (b as [number, number, number, number])
            : undefined;
        return { label: String(c.label || c.color).trim(), color: String(c.color).trim(), box };
      })
      .slice(0, 6); // 색상 옵션 과다 방지 (생성 비용)
  };

  try {
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    const response = await retryOn429(() =>
      ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ inlineData: { data, mimeType } }, { text: promptText }] }],
        config: { temperature: 0.1, responseMimeType: 'application/json' },
      }),
    );
    const colors = parseColors(response.text?.trim() || '{}');
    if (colors.length > 0) return colors;
    throw new Error('색상 추출 결과가 비어 있음');
  } catch (geminiError) {
    if (openaiApiKey) {
      console.warn('[ColorAgent] Gemini 오류 — OpenAI 비전으로 색상 추출을 대체 실행합니다.');
      try {
        const openai = new OpenAI({ apiKey: openaiApiKey });
        const chatCompletion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: promptText },
                { type: 'image_url', image_url: { url: imageBase64 } },
              ],
            },
          ],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        });
        const colors = parseColors(chatCompletion.choices[0].message.content?.trim() || '{}');
        if (colors.length > 0) return colors;
      } catch (openaiError) {
        console.error('[ColorAgent] OpenAI 색상 추출 대체 실패:', openaiError);
      }
    }
    // 추출 실패 시 단일 색상으로 폴백 — 기존 동작(이미지 그대로 1장 생성)과 동일해짐
    return [{ label: '기본 색상', color: 'the exact color shown in the product image' }];
  }
}

// ─────────────────────────────────────────────────────────────────
// 생성 결과 자동 검증 (2026-07-19)
// 프롬프트 지시만으로는 비대칭 디테일(한쪽 다리에만 있는 패치/고리)이 양쪽에 복제되거나
// 좌우 턴 방향이 무시되는 실패가 반복 재현됨 — 텍스트 지시의 한계. 생성된 사진을 Gemini가
// 참고사진·구조맵과 대조해 합격/불합격 + 구체 결함 목록을 내고, 불합격이면 라우트에서
// 결함 목록을 교정 지시로 붙여 1회 재생성한다. 검증 호출은 Gemini Flash라 생성비 대비 미미.
// ─────────────────────────────────────────────────────────────────
export interface GarmentRenderVerdict {
  pass: boolean;
  /** 재생성 프롬프트에 그대로 붙일 수 있는 영어 교정 지시 목록 (불합격 시에만 채워짐) */
  defects: string[];
}

const RENDER_VERDICT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    generatedView: { type: Type.STRING, description: 'Which side of the garment the GENERATED photo shows: "front", "back", "left side", "right side", or "three-quarter ..." — decided from garment anatomy (fly visible = front; back pockets/elastic gathering = back), not from a guess' },
    pass: { type: Type.BOOLEAN, description: 'true only if EVERY check passed' },
    defects: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'One entry per failed check, each written as a direct corrective instruction for the image generator (e.g. "The cargo patch pocket must appear ONLY on the wearer\'s RIGHT leg — remove the duplicate cargo pocket rendered on the wearer\'s left leg"). Empty array if pass=true',
    },
  },
  required: ['generatedView', 'pass', 'defects'],
};

export async function verifyGarmentRender(
  generatedImageBase64: string,
  constructionMap: GarmentConstructionMap,
  garmentAnalysis: GarmentAnalysis,
  poseInstruction: string,
  geminiApiKey: string,
  referenceImagesBase64: string[] = [],
  /** (2026-07-19) 스타일링 슬롯 기대값(사용자 원문 우선) — 베이지 샌들이 검정으로, 갈색 가방이
   * 검정으로 나오는 등 색/종류 무시를 기계적으로 잡기 위해 검증에 함께 넘긴다. */
  styleChecklist: Array<{ label: string; text: string }> = [],
  /** 소싱 제품의 핵심 핏 지시(예: "목 꽉 맞음, 크롭, 머슬핏") — 목이 헐렁하게 나오는 등 핏 무시 검사용 */
  keyFit: string = '',
  /**
   * (2026-07-23) 클로즈업 여부. 클로즈업은 소싱 제품 부위만 타이트하게 잘라낸 컷이라
   * 다리/밑단/포켓/하의/신발이 프레임 밖인 게 정상인데, 검증이 그걸 "누락"으로 잡아
   * 불합격 처리하면 (1) 불필요한 재생성으로 시간이 2배가 되고 (2) 프레임에도 없는 걸
   * 고치려다 오히려 결과를 망친다. 'close'면 "프레임에 실제로 보이는 것만 판정"하도록 한다.
   */
  framing: 'full' | 'close' = 'full',
): Promise<GarmentRenderVerdict> {
  const parts: any[] = [];

  referenceImagesBase64.slice(0, 2).forEach((img, i) => {
    const { data, mimeType } = parseBase64(img);
    parts.push({ text: `REFERENCE photo ${i + 1} — the real product being sold (ground truth for construction and fabric).` });
    parts.push({ inlineData: { data, mimeType } });
  });

  {
    const { data, mimeType } = parseBase64(generatedImageBase64);
    parts.push({ text: 'GENERATED photo — an AI-generated model shot of the product. This is the photo you must inspect.' });
    parts.push({ inlineData: { data, mimeType } });
  }

  parts.push({
    text: `
You are a strict QA inspector for AI-generated fashion lookbook photos. Inspect the GENERATED photo against the ground truth below and report every construction/placement defect.

GROUND TRUTH CONSTRUCTION MAP (wearer's left/right):
- NECKLINE (tops): ${constructionMap.neckline}
- SLEEVE CUFFS (tops): ${constructionMap.sleeveCuffs}
- BOTTOM HEM (tops): ${constructionMap.hem}
- CLOSURES / HARDWARE (exact counts): ${constructionMap.closures}
- FRONT waistband: ${constructionMap.frontWaistband}
- FRONT wearer-LEFT leg: ${constructionMap.frontLeftLeg}
- FRONT wearer-RIGHT leg: ${constructionMap.frontRightLeg}
- BACK waistband: ${constructionMap.backWaistband}
- BACK wearer-LEFT leg: ${constructionMap.backLeftLeg}
- BACK wearer-RIGHT leg: ${constructionMap.backRightLeg}
- BACK pockets: ${constructionMap.backPockets}
- Side seams: ${constructionMap.sideSeams}
- ASYMMETRY CHECKLIST (each item exists on EXACTLY ONE side): ${constructionMap.asymmetryChecklist}
- Fabric: ${garmentAnalysis.material}; texture: ${garmentAnalysis.texture}; color: ${garmentAnalysis.color}

POSE INSTRUCTION GIVEN TO THE GENERATOR (may be Korean): "${poseInstruction || '(default frontal standing pose)'}"
${keyFit ? `\nSOURCED PRODUCT KEY FIT (may be Korean): "${keyFit}"` : ''}
${styleChecklist.length ? `\nSTYLING THE MODEL WAS SUPPOSED TO WEAR (each line's COLOR and garment TYPE are mandatory; may be Korean):\n${styleChecklist.map((s) => `- ${s.label}: ${s.text}`).join('\n')}` : ''}

${framing === 'close' ? `THIS IS A CLOSE-UP CROP — the shot is intentionally cropped tight on the sourced product (e.g. only the chest/torso for a top, only the legs for a bottom). Legs, feet, hem, waistband, bottoms, shoes, and any zone outside the crop are EXPECTED to be absent. NEVER report an item as a defect merely because it is out of frame or not visible in this crop — judge ONLY what is actually inside the frame. Do not fail the pose/turn direction, and do not run the styling check (bottoms/shoes are out of frame). Focus your inspection on the fabric texture, the closures/hardware count, and the construction of the visible garment area.\n` : ''}INSPECTION PROCEDURE:
1. Decide which side of the garment the GENERATED photo shows (front/back/side) using garment anatomy (fly = front; back pockets/elastic gathering = back).
2. MIRROR RULE for reading the GENERATED photo: if it shows the FRONT, the wearer's LEFT is on the VIEWER'S RIGHT; if it shows the BACK, the wearer's left is on the viewer's left.
3. For EVERY item in the ASYMMETRY CHECKLIST that should be visible from this view: (a) is it present? (b) is it on the correct wearer's side? (c) is the OPPOSITE side clean — no duplicate, echo, or mirrored copy? A checklist item rendered on BOTH legs is an automatic FAIL.
4. Are there invented details NOT on the real product — extra pockets, extra patches, extra seams/panel lines, or extra topstitch/stitch lines (especially added near the hem, side seam, or chest of an otherwise plain garment)? Compare against the REFERENCE photo(s). Any stitch/seam line the reference does not show is a FAIL — report it as "remove the invented <where> stitch/seam line; the real product has no such line there".
5. Does the garment's fabric/color in the GENERATED photo roughly match the ground truth (obvious mismatches only — e.g. smooth dress fabric instead of sturdy twill, clearly wrong color)? Ignore lighting differences.
6. If the pose instruction specifies a turn/facing direction (e.g. 왼쪽 = model's left turn, 오른쪽 = model's right turn, 뒤 = back view): does the GENERATED body orientation actually match it? "왼쪽으로 돌아" means the model rotates toward the MODEL'S OWN left. If the direction is clearly opposite or ignored (e.g. frontal standing when a turn was required), that is a FAIL.
6.5 EDGE CHECK (tops) — compare the GENERATED garment's three edges against the NECKLINE / SLEEVE CUFFS / BOTTOM HEM lines above. They are finished differently from each other, so check each separately: (a) is the finish type right (ribbed band vs plain hem vs raw edge)? (b) is a contrast trim/stitch present on exactly the edges that name one, and ABSENT on the edges that say no contrast stitching? (c) do the trim's colors/stitch style match? A contrast stitch copied onto the hem when the hem should be plain, a missing ribbed hem band, or a missing neckline/cuff trim are all FAILS — report the specific edge and the required correction.
6.6 CLOSURE COUNT CHECK — read the CLOSURES / HARDWARE line above, then COUNT the buttons/snaps/zippers actually visible in the GENERATED photo and compare the numbers literally. A different count (one extra or one missing), a button placket invented on a garment whose closures line says "none — pullover", a missing zipper, or hardware in the wrong colour/material are all FAILS. Report the exact required count, e.g. "render exactly 5 front buttons, not 6". Only count closures that would be visible in this crop/view — do not fail an item that is simply out of frame.
${styleChecklist.length && framing !== 'close' ? `7. STYLING CHECK — for EACH styling line above, look at the corresponding item in the GENERATED photo and verify BOTH its color and its garment type match the words. This is a common, high-priority failure: if the line says 베이지/beige and the item is black, or 갈색/brown and it is black, or 워싱 데님/washed denim and it is plain black slacks, that is a FAIL. Do NOT accept the outfit being recolored to a black/grey/monochrome look to match the product. Report each mismatch as a correction naming the item, the wrong color/type seen, and the required one.` : ''}
${keyFit ? `8. FIT CHECK — verify the sourced product's fit matches the KEY FIT words. In particular a "tight/꽉 맞음/타이트" neckline must hug the neck high and close; a loose, wide, or dropped neckline that exposes the collarbone/trapezius is a FAIL. Report the required fit correction.` : ''}

Report pass=true ONLY if every applicable check passes. Each defect must be a self-contained corrective instruction the image generator can follow.
`.trim(),
  });

  try {
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    const response = await retryOn429(() =>
      ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts }],
        config: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: RENDER_VERDICT_SCHEMA as any,
        },
      }),
    );
    const parsed = JSON.parse(response.text?.trim() || '{}');
    const defects = Array.isArray(parsed.defects) ? parsed.defects.filter((d: any) => typeof d === 'string' && d.trim()) : [];
    return { pass: parsed.pass === true || defects.length === 0, defects };
  } catch (err) {
    // 검증 실패는 생성 자체를 막지 않는다 — 합격 처리하고 원본 결과를 그대로 쓴다 (fail-open)
    console.warn('[VerifyAgent] 생성 결과 검증 호출 실패 — 검증 생략:', err);
    return { pass: true, defects: [] };
  }
}
