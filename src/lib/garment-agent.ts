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
4. For jeans/denim: Be extremely detailed about the washing texture, sandwashed fading on thighs/knees, vertical slub lines, whiskering lines at the crotch, and exact denim twill texture grain.

Return ONLY valid JSON, no markdown, no explanation:

{
  "color": "exact color name and fading/washing details (e.g., 'vintage sandwashed medium blue denim with natural fading', 'solid pitch black', 'washed charcoal with light vertical streaking')",
  "material": "fabric composition (e.g., 'heavyweight rigid 100% cotton denim twill', 'linen-rayon blend')",
  "fitType": "ONE of: oversized, boxy, regular, slim, wide-leg, skinny, straight, unknown",
  "category": "ONE of: top, bottom, outer, dress, shoes, bag, accessory, unknown",
  "details": "list all design details and texture marks. Emphasize: vintage washing effects, sandwashed thighs/knees, whiskering at crotch, pocket distressing, hem wear. DO NOT mention brand tags, hangers, or store price cards/strings.",
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
  openaiApiKey?: string
): Promise<GarmentAnalysis> {
  const parts: any[] = [];

  // 모든 의류 이미지 추가
  garmentImagesBase64.forEach((imgBase64) => {
    const { data, mimeType } = parseBase64(imgBase64);
    parts.push({
      inlineData: {
        data,
        mimeType,
      },
    });
  });

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
4. For jeans/denim: Be extremely detailed about the washing texture, sandwashed fading on thighs/knees, vertical slub lines, whiskering lines at the crotch, and exact denim twill texture grain.

The JSON must follow this exact schema:
{
  "color": "highly specific color description and fading pattern (e.g. vintage sandwashed medium blue denim with natural fading, deep charcoal)",
  "material": "fabric description (e.g. heavyweight rigid 100% cotton denim twill, lightweight cotton blend)",
  "fitType": "slim" | "regular" | "oversized" | "loose" | "wide-leg",
  "category": "top" | "bottom" | "outer" | "dress" | "shoes" | "bag" | "accessory",
  "details": "detailed list of design highlights: pocket locations, vintage washes, sandwashed thighs/knees, whiskering at crotch, pocket distressing, hem wear. DO NOT include hangers, strings, price cards, or store tags.",
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
                text: `Analyze these garment photos. Category requested by user: ${userCategory || 'unknown'}. Additional specs: ${rawSpecs || ''}.`
              },
              ...garmentImagesBase64.map(b64 => {
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

    // 최종 폴백 기본값
    return {
      color: 'as shown in image',
      material: 'rigid cotton denim fabric',
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
