/**
 * garment-agent.ts
 * Gemini Vision 또는 OpenAI GPT-4o-mini 비전으로 옷 사진을 분석해 구조화된 GarmentAnalysis 객체 반환
 * 항상 동일한 분석 스키마를 반환해 프롬프트 일관성 보장
 */

import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import type { GarmentAnalysis, StylingSuggestion, SourcedCategory } from './fitting-prompts';

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
   - Any logo, brand patch, embroidery, print, or label — exact placement (e.g. "small woven patch on the left thigh cargo pocket flap", "embroidered logo on upper left chest")
   - Closures: buttons (count + placement), zippers, drawstrings, toggles, snaps, velcro — exact placement and count
   - Any topstitching, contrast stitching color, or decorative stitch lines
   - Hem style (raw hem, cuffed/rolled, elastic, drawcord)
   This structural scan applies to EVERY garment type, not only denim — cargo pants, shorts, jackets, and knitwear all have real construction details that must be found and reported; do not skip this because the item isn't denim.
5. For jeans/denim specifically, ALSO be extremely detailed about the washing texture, sandwashed fading on thighs/knees, vertical slub lines, whiskering lines at the crotch, and exact denim twill texture grain — in addition to the structural scan above, not instead of it.

Return ONLY valid JSON, no markdown, no explanation:

{
  "color": "exact color name and fading/washing details (e.g., 'vintage sandwashed medium blue denim with natural fading', 'solid pitch black', 'washed charcoal with light vertical streaking')",
  "material": "fabric composition (e.g., 'heavyweight rigid 100% cotton denim twill', 'linen-rayon blend')",
  "fitType": "ONE of: oversized, boxy, regular, slim, wide-leg, skinny, straight, unknown",
  "category": "ONE of: top, bottom, outer, dress, shoes, bag, accessory, unknown",
  "details": "the full result of the MANDATORY STRUCTURAL SCAN above — every seam/panel line, every pocket (type + exact location), every logo/patch/print (exact location), every closure (type + count + location), stitching, hem style. For denim, also add: vintage washing effects, sandwashed thighs/knees, whiskering at crotch, pocket distressing, hem wear. DO NOT mention brand tags, hangers, or store price cards/strings — those are packaging, not garment construction.",
  "texture": "surface texture description (e.g., 'coarse diagonal rigid denim twill weave, high-contrast wash grain', 'smooth cotton knit')",
  "lightReaction": "how fabric reacts to light (e.g., 'matte finish, no sheen', 'subtle metallic sheen at highlights', 'slight luster, semi-matte')",
  "chestWidth": "estimated chest measurement if visible (e.g., '54cm', '58cm') or null",
  "length": "garment length description (e.g., 'hip length', 'cropped above waist', 'ankle length', '28 inch inseam') or null"
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
        text: `Material reference photo ${i + 1} — a close-up of the SAME product's fabric/hardware. Use this ONLY to refine "material", "texture", "lightReaction", and "details" (buttons, stitching, weave/knit structure). Do NOT use it to determine "color" — trust the PRIMARY product photo(s) above for color.`,
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

The JSON must follow this exact schema:
{
  "color": "highly specific color description and fading pattern (e.g. vintage sandwashed medium blue denim with natural fading, deep charcoal)",
  "material": "fabric description (e.g. heavyweight rigid 100% cotton denim twill, lightweight cotton blend)",
  "fitType": "slim" | "regular" | "oversized" | "loose" | "wide-leg",
  "category": "top" | "bottom" | "outer" | "dress" | "shoes" | "bag" | "accessory",
  "details": "the full result of the MANDATORY STRUCTURAL SCAN: every seam/panel line, every pocket (type + exact location), every logo/patch/print (exact location), every closure (type + count + location), stitching, hem style. For denim, also add vintage washes/sandwashed thighs/whiskering/pocket distressing/hem wear. DO NOT include hangers, strings, price cards, or store tags.",
  "texture": "fabric texture description (e.g. coarse diagonal rigid denim twill weave, high-contrast wash grain)",
  "lightReaction": "matte" | "subtle sheen" | "glossy"
}
Output raw JSON ONLY. No markdown formatting, no \`\`\`json block. Just the raw JSON string.`
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Analyze these garment photos. Category requested by user: ${userCategory || 'unknown'}. Additional specs: ${rawSpecs || ''}.${hasMaterialImages ? ' The additional images after the primary ones are CLOSE-UP MATERIAL REFERENCE photos of the same product — use them only to refine material/texture/details, NOT color.' : ''}`
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
        };
      } catch (openaiError) {
        console.error('[GarmentAgent] OpenAI 비전 대체 분석 실패:', openaiError);
      }
    }

    // 최종 폴백 기본값 (Gemini/OpenAI 둘 다 실패했을 때만 — 데님 단정 대신 일반적인 값으로)
    return {
      color: 'as shown in image',
      material: 'as shown in image',
      fitType: (userCategory === 'bottom' ? 'wide-leg' : 'regular') as any,
      category: (userCategory as any) || 'top',
      details: rawSpecs || 'as shown in the reference garment photo',
      texture: 'textured fabric',
      lightReaction: 'matte finish',
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

  const promptText = `
You are a professional fashion stylist for a Korean menswear lookbook shoot.
A model is already wearing the confirmed sourced product: a ${garmentAnalysis.category} described as "${garmentAnalysis.color}, ${garmentAnalysis.material}, ${garmentAnalysis.fitType} fit". This item is masked/protected and must NOT be changed or mentioned as something to generate.
Current pose in the photo: ${poseDescription}
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
