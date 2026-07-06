import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import { toFile } from 'openai';

export const runtime = 'nodejs';
export const maxDuration = 120;

// base64(혹은 dataURL) → Buffer + mimeType 추출
function parseBase64Image(dataUrlOrBase64: string): { buffer: Buffer; mimeType: string } {
  if (dataUrlOrBase64.startsWith('data:')) {
    const [header, data] = dataUrlOrBase64.split(',');
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/png';
    return { buffer: Buffer.from(data, 'base64'), mimeType };
  }
  return { buffer: Buffer.from(dataUrlOrBase64, 'base64'), mimeType: 'image/png' };
}

// OpenAI가 요구하는 PNG RGBA 형식으로 변환 (Sharp 없이 간단 처리)
// JPEG → PNG 변환은 직접 재인코딩이 필요하므로, 여기서는 raw buffer를 그대로 전달
// gpt-image-2 /edits는 image/png, image/webp, image/jpeg 등 지원
async function bufferToOpenAIFile(buffer: Buffer, mimeType: string, filename: string) {
  return await toFile(buffer, filename, { type: mimeType });
}

export async function POST(req: Request) {
  try {
    const {
      personImage,   // base64: 모델 원본 사진
      garmentImage,  // base64: 소싱한 옷 사진
      openaiApiKey,
      geminiApiKey,
      prompt,        // Gemini가 분석한 영어 프롬프트
      modelSpecs = '177cm 74kg athletic build Korean male model',
    } = await req.json();

    if (!personImage || !garmentImage) {
      return NextResponse.json({ error: '모델 사진과 의류 사진이 모두 필요합니다.' }, { status: 400 });
    }

    const apiKey = openaiApiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'OpenAI API 키가 없습니다.' }, { status: 400 });
    }

    const openai = new OpenAI({ apiKey });

    // ── 사람 이미지 파싱 ──────────────────────────────────────────
    const { buffer: personBuf, mimeType: personMime } = parseBase64Image(personImage);
    const { buffer: garmentBuf, mimeType: garmentMime } = parseBase64Image(garmentImage);

    // ── 옷 설명 프롬프트 구성 ─────────────────────────────────────
    const editPrompt = prompt
      ? // Gemini 분석 결과가 있으면 그것을 최우선 활용
        `Keep this exact person's face, body, pose, and background completely unchanged. 
Only replace the clothing: dress this person in the exact garment shown in the reference image.
Garment details: ${prompt}
Critical: The person's face identity, hair, skin tone, pose, and background must remain 100% identical to the original photo. Only the clothing changes.`
      : // 없으면 기본 피팅 지시
        `Keep this exact person's face, body, pose, and background completely unchanged.
Only replace/add the clothing shown in the garment reference.
The person is ${modelSpecs}.
Critical: Face identity, hair, skin tone, pose, and background must remain 100% identical. Only change the clothing.`;

    let imageUrl = '';
    let revisedPrompt = '';
    let engineUsed = '';

    // ── 1차 시도: gpt-image-2 edit (두 이미지 참조 방식) ──────────
    try {
      console.log('[Engine] gpt-image-2 /edits (with garment reference)...');

      const personFile = await bufferToOpenAIFile(personBuf, personMime, `model.${personMime.split('/')[1] || 'jpg'}`);
      const garmentFile = await bufferToOpenAIFile(garmentBuf, garmentMime, `garment.${garmentMime.split('/')[1] || 'jpg'}`);

      const response = await (openai.images as any).edit({
        model: 'gpt-image-2',
        image: [personFile, garmentFile],
        prompt: editPrompt,
        n: 1,
        size: '1024x1536',
      });

      const item = response?.data?.[0];
      imageUrl = item?.url || (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
      revisedPrompt = item?.revised_prompt || editPrompt;
      engineUsed = 'OpenAI GPT-Image-2 Virtual Fitting (Multi-Image Edit)';

    } catch (editMultiErr: any) {
      console.warn('[Fallback 1] gpt-image-2 multi-image edit 실패:', editMultiErr?.message);

      // ── 2차 시도: gpt-image-2 edit (모델 사진 단독 + 옷 프롬프트) ──
      try {
        console.log('[Engine] gpt-image-2 /edits (single image + garment prompt)...');

        const personFile2 = await bufferToOpenAIFile(personBuf, personMime, `model.${personMime.split('/')[1] || 'jpg'}`);

        const response2 = await (openai.images as any).edit({
          model: 'gpt-image-2',
          image: personFile2,
          prompt: editPrompt,
          n: 1,
          size: '1024x1536',
        });

        const item2 = response2?.data?.[0];
        imageUrl = item2?.url || (item2?.b64_json ? `data:image/png;base64,${item2.b64_json}` : '');
        revisedPrompt = item2?.revised_prompt || editPrompt;
        engineUsed = 'OpenAI GPT-Image-2 Virtual Fitting (Single-Image Edit)';

      } catch (editSingleErr: any) {
        console.warn('[Fallback 2] gpt-image-2 single edit 실패:', editSingleErr?.message);

        // ── 3차 시도: dall-e-2 edit (클래식 inpainting, 마스크 없이) ──
        try {
          console.log('[Engine] dall-e-2 /edits fallback...');

          // DALL-E 2는 정사각형 PNG 필요
          const personFile3 = await bufferToOpenAIFile(personBuf, 'image/png', 'model.png');

          const response3 = await openai.images.edit({
            model: 'dall-e-2',
            image: personFile3,
            prompt: editPrompt.slice(0, 950),
            n: 1,
            size: '1024x1024',
          });

          const item3 = response3?.data?.[0];
          imageUrl = item3?.url || (item3?.b64_json ? `data:image/png;base64,${item3.b64_json}` : '');
          revisedPrompt = item3?.revised_prompt || editPrompt;
          engineUsed = 'OpenAI DALL-E 2 Inpainting';

        } catch (dalle2Err: any) {
          console.error('[All OpenAI edit engines failed]:', dalle2Err?.message);
          throw new Error(`OpenAI 이미지 편집(가상 피팅) 실패: ${dalle2Err?.message}`);
        }
      }
    }

    if (!imageUrl) {
      throw new Error('이미지 생성을 완료하지 못했습니다.');
    }

    return NextResponse.json({
      success: true,
      imageUrl,
      revisedPrompt,
      engineUsed,
    });

  } catch (error: any) {
    console.error('Virtual Fitting Pipeline Error:', error);
    return NextResponse.json(
      { error: error?.error?.message || error.message || '가상 피팅 생성 중 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}
