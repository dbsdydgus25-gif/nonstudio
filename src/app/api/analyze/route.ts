import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';

export const runtime = 'nodejs';
export const maxDuration = 60;

function parseBase64Image(dataUrlOrBase64: string) {
  if (dataUrlOrBase64.startsWith('data:')) {
    const matches = dataUrlOrBase64.match(/^data:([a-zA-Z0-9/+-]+);base64,(.+)$/);
    if (matches && matches.length === 3) {
      return {
        mimeType: matches[1],
        data: matches[2],
      };
    }
  }
  return {
    mimeType: 'image/jpeg',
    data: dataUrlOrBase64,
  };
}

async function fetchScrapedText(url: string): Promise<string> {
  if (!url || !url.startsWith('http')) return '';
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return '';
    const html = await res.text();
    const cleanText = html
      .replace(/<script[^>]*>([\S\s]*?)<\/script>/gi, '')
      .replace(/<style[^>]*>([\S\s]*?)<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleanText.slice(0, 4500);
  } catch (e) {
    console.warn('URL Scraping failed or timed out:', e);
    return '';
  }
}

export async function POST(req: Request) {
  try {
    const {
      personImage,
      garmentImage,
      geminiApiKey,
      customInstructions,
      fittingStyle,
      sourceUrl,
      rawSpecs,
      modelSpecs,
    } = await req.json();

    const apiKey = geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Gemini API 키가 입력되지 않았습니다. 상단 설정에서 API 키를 등록해주세요.' },
        { status: 400 }
      );
    }

    if (!personImage || !garmentImage) {
      return NextResponse.json(
        { error: '착장(인물) 사진과 의류 사진 모두 업로드해야 합니다.' },
        { status: 400 }
      );
    }

    const personImgParsed = parseBase64Image(personImage);
    const garmentImgParsed = parseBase64Image(garmentImage);

    // URL 스크래핑 시도
    const scrapedText = sourceUrl ? await fetchScrapedText(sourceUrl) : '';

    const ai = new GoogleGenAI({ apiKey });

    const currentModelSpecs = modelSpecs || '키 177cm / 몸무게 74kg (어깨가 넓은 슬림 탄탄 머슬핏 남성 체형)';

    const systemPrompt = `You are a world-class AI fashion technical director, wholesale apparel sizing expert (동대문/보세 소싱), and elite DALL-E 3 lookbook prompt engineer.
Your goal is to analyze the sourced garment and the dedicated store fitting model to create an ultra-realistic commercial lookbook photo for an e-commerce product detail page.

### [Target Fitting Model Physical Specs]
- Physical Measurements: ${currentModelSpecs}
- Ensure that the garment's fit physically reflects how a 177cm / 74kg athletic build fills out the clothing (e.g., tight chest/shoulder lines, clean collar sit, structured arm cuffs).

### [External Wholesale / Sourced Product Data]
- Sourced Product URL / Title: ${sourceUrl || 'None provided'}
- Scraped Web Content / Detail Page Text: "${scrapedText ? scrapedText.slice(0, 2000) : 'None extracted'}"
- Raw Fabric & Size Specs provided by Store Owner: "${rawSpecs || 'None provided'}"

### [Analysis & Prompt Engineering Requirements]
1. Deeply analyze the garment in Image 2 AND combine it with any extracted external specs (${rawSpecs || scrapedText || 'visual deduction'}).
2. Specifically analyze Fabric Physics & Light Interaction: Note exact knit gauge, ribbing depth, how the fabric reacts under professional studio lighting (subtle sheen on collar trim, matte softness of ribbed cotton/acrylic blend, shadow depth in vertical ridges).
3. Analyze 177cm/74kg Body Fit Interaction: Explain in physical detail how this garment fits a 177cm/74kg model (e.g., shoulder seams sitting precisely on broad shoulders, muscle fit hugging the upper chest while draping cleanly at the waist).
4. Generate a master DALL-E 3 prompt in English that explicitly encodes:
   - The exact subject build (177cm, 74kg athletic Korean male).
   - The exact physical garment features (open collar knit, brown trim, vertical ribbing).
   - Realistic fabric lighting (soft diffuse studio softbox reflecting off the fabric texture).
   - Commercial e-commerce lookbook aesthetic (8K raw photography, neutral studio backdrop).

Return ONLY valid JSON matching this schema:
{
  "koreanSummary": "원단 혼용률/질감, 조명 아래 빛 반응성, 177/74 스펙 체형과의 실측 핏 매치에 대한 종합 분석 (한국어 4~5문장)",
  "garmentAnalysis": "원단의 물리적 특성, 게이지, 빛 반응성 및 디테일 분석 (한국어)",
  "personAnalysis": "177cm / 74kg 체형 기준 실질적 핏 연출 분석 (한국어)",
  "keyFeatures": ["177/74 머슬핏", "세로 골지 텍스처", "조명 반사 디테일", "오픈카라 배색", "사입 상세스펙 연동"],
  "englishPrompt": "The full, professional English prompt optimized for DALL-E 3 HD generator."
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: personImgParsed.mimeType, data: personImgParsed.data } },
            { inlineData: { mimeType: garmentImgParsed.mimeType, data: garmentImgParsed.data } },
            { text: systemPrompt },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        temperature: 0.4,
      },
    });

    const textResult = response.text || '{}';
    let jsonResult;
    try {
      jsonResult = JSON.parse(textResult);
    } catch (e) {
      jsonResult = {
        koreanSummary: '의류 및 177/74 신체 스펙 분석이 완료되었습니다. 고화질 피팅 프롬프트를 확인하세요.',
        garmentAnalysis: '업로드된 의류 원단 및 빛 반응성 분석 완료',
        personAnalysis: '177cm / 74kg 피팅 모델 실측 핏 분석 완료',
        keyFeatures: ['177/74 맞춤핏', '고화질 렌더링', '원단 디테일 반영'],
        englishPrompt: textResult,
      };
    }

    return NextResponse.json({ success: true, result: jsonResult });
  } catch (error: any) {
    console.error('Gemini Analysis Error:', error);
    return NextResponse.json(
      { error: error.message || '제미나이 이미지 분석 중 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}
