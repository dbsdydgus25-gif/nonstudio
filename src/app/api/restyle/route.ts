/**
 * /api/restyle/route.ts
 * "AI 피팅" — 사용자가 소싱 제품을 실제로 입고/착용해 찍은 사진 1장을 받아,
 * 선택한 카테고리(상의/하의/신발/액세서리)의 색상/질감/핏은 충실히 재현하면서,
 * 몸은 177/74 마른 근육형으로 리셰이프하고 포즈·배경·나머지 착장은 새로 생성한다.
 * 항상 전신 샷 1장만 생성 — 이 1장이 확정된 "완성된 룩"이 되고, 이후 AI 바리에이션(포즈 다양화)의
 * 입력으로 이어진다 (구 이름: AI 리스타일링).
 * (실사 원본을 픽셀 단위로 고정하지 않음 — 원본 체형을 그대로 두면 자유도가 떨어지고
 * 실제 몸매가 그대로 드러나 상품성이 떨어지는 문제가 있어 마스크 방식에서 전환함)
 *
 * (2026-07-08) 비동기 아키텍처로 전환 — gpt-image-2 호출이 90~100초 걸리는데 클라이언트가
 * 그 응답을 한 요청으로 계속 기다리면 네트워크/프록시 문제로 죽어서 원인 불명의 JSON 파싱
 * 에러만 남는 경우가 있었다. 이제 요청을 받자마자 "처리 중" 행을 만들어 id를 즉시 반환하고,
 * 실제 분석+생성은 `after()`로 응답 이후 백그라운드에서 진행한다. 프론트는 이 id로
 * /api/generations/status를 폴링해서 완료 여부를 확인한다.
 */

import { NextResponse } from 'next/server';
import { after } from 'next/server';
import OpenAI, { toFile } from 'openai';
import { analyzeGarment, analyzePose, generateStylingSuggestion } from '@/lib/garment-agent';
import { buildRestylePrompt, DEFAULT_STUDIO_BACKGROUND, type SourcedCategory } from '@/lib/fitting-prompts';
import { createPendingGeneration, markGenerationCompleted, markGenerationFailed } from '@/lib/generation-store';
import { getDefaultBackgroundReferenceImage } from '@/lib/background-reference';

export const runtime = 'nodejs';
// Vercel Hobby+Fluid Compute는 함수당 최대 300초까지 허용한다 — 분석(Gemini 2회) + 코디 제안
// + gpt-image-2 생성(90~100초) + 업로드를 전부 합치면 120초를 넘길 수 있어 여유있게 잡는다.
export const maxDuration = 280;

function parseBase64Image(dataUrl: string): { buffer: Buffer; mimeType: string } {
  if (dataUrl.startsWith('data:')) {
    const [header, data] = dataUrl.split(',');
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
    return { buffer: Buffer.from(data, 'base64'), mimeType };
  }
  return { buffer: Buffer.from(dataUrl, 'base64'), mimeType: 'image/jpeg' };
}

async function toOpenAIFile(buffer: Buffer, mimeType: string, name: string) {
  return await toFile(buffer, name, { type: mimeType });
}

/** OpenAI 응답 이미지(URL 또는 base64 data URL)를 Buffer로 통일 — Supabase 업로드용 */
async function resultImageToBuffer(imageUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (imageUrl.startsWith('data:')) {
    return parseBase64Image(imageUrl);
  }
  const res = await fetch(imageUrl);
  const arrayBuffer = await res.arrayBuffer();
  const mimeType = res.headers.get('content-type') || 'image/png';
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}

async function runSingleRestyle(
  openai: OpenAI,
  photoBuf: Buffer,
  photoMime: string,
  prompt: string,
  referenceImages: Array<{ buffer: Buffer; mimeType: string }> = [],
): Promise<{ imageUrl: string; engineUsed: string }> {
  const photoFile = await toOpenAIFile(photoBuf, photoMime, `photo.${photoMime.split('/')[1] || 'jpg'}`);

  // 고정 배경 기준 이미지가 있으면 추가 입력 이미지로 같이 넣어 일관성을 강화한다
  const refFiles = await Promise.all(
    referenceImages.map((ref, i) =>
      toOpenAIFile(ref.buffer, ref.mimeType, `reference-${i}.${ref.mimeType.split('/')[1] || 'jpg'}`),
    ),
  );
  const imageInput = refFiles.length > 0 ? [photoFile, ...refFiles] : photoFile;

  const res = await (openai.images as any).edit({
    model: 'gpt-image-2',
    image: imageInput,
    prompt: prompt.slice(0, 4000),
    n: 1,
    size: '1024x1536',
    quality: 'medium', // 'auto'(기본값)는 비용/시간이 크게 늘어남 — 커머셜 컷 용도로는 medium이면 충분
    // input_fidelity는 gpt-image-2가 지원하지 않는 파라미터라 400 에러 유발 — 제거함 (SDK 타입엔 있었지만 이 모델은 거부)
  });

  const item = res?.data?.[0];
  const imageUrl = item?.url || (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
  if (!imageUrl) throw new Error('빈 이미지 응답 (gpt-image-2 restyle edit)');
  return { imageUrl, engineUsed: refFiles.length > 0 ? 'gpt-image-2 (restyle + reference)' : 'gpt-image-2 (restyle)' };
}

export async function POST(req: Request) {
  try {
    const {
      photoBase64,
      category,
      geminiApiKey,
      openaiApiKey,
      userAdditions,
      backgroundHint,
      userPreferenceHint,
    } = await req.json();

    if (!photoBase64) {
      return NextResponse.json({ success: false, error: '실사 사진을 등록해주세요.' }, { status: 400 });
    }
    const validCategories: SourcedCategory[] = ['top', 'bottom', 'shoes', 'accessory'];
    if (!validCategories.includes(category)) {
      return NextResponse.json({ success: false, error: '소싱 제품 카테고리를 선택해주세요.' }, { status: 400 });
    }
    if (!geminiApiKey || !openaiApiKey) {
      return NextResponse.json({ success: false, error: 'Gemini/OpenAI API 키가 필요합니다.' }, { status: 400 });
    }

    const sourcedCategory = category as SourcedCategory;

    // "처리 중" 행을 즉시 만들어 id를 반환 — 실제 분석/생성은 아래 after()에서 진행된다.
    const generationId = await createPendingGeneration({
      pipeline: 'restyle',
      modeOrCategory: sourcedCategory,
      poseLabel: 'AI 피팅 결과',
      prompt: '',
    });

    after(async () => {
      try {
        const [garmentAnalysis, poseDescription] = await Promise.all([
          analyzeGarment([photoBase64], geminiApiKey, undefined, undefined, sourcedCategory, openaiApiKey),
          analyzePose(photoBase64, geminiApiKey, openaiApiKey),
        ]);

        const { buffer: photoBuf, mimeType: photoMime } = parseBase64Image(photoBase64);
        const openai = new OpenAI({ apiKey: openaiApiKey });

        const stylingSuggestion = await generateStylingSuggestion(
          sourcedCategory,
          garmentAnalysis,
          poseDescription,
          geminiApiKey,
          openaiApiKey,
          userPreferenceHint,
        );

        // 배경은 사용자가 명시적으로 지시했을 때만 그 내용을 쓰고, 없으면 AI 바리에이션과 동일한
        // 고정 흰색 스튜디오 배경으로 강제 통일한다 — AI가 매번 다른 장소를 지어내지 않도록.
        const hasCustomBackground = !!backgroundHint?.trim();
        stylingSuggestion.background = hasCustomBackground ? backgroundHint.trim() : DEFAULT_STUDIO_BACKGROUND;

        // 배경 지시가 없으면 실제 흰색 스튜디오 사진을 참고 이미지로 같이 넣는다 — 텍스트보다
        // 실제 사진 한 장이 배경/조명 방향을 훨씬 정확하게 고정시켜준다.
        const backgroundReferenceImage = hasCustomBackground ? null : getDefaultBackgroundReferenceImage();

        const prompt = buildRestylePrompt(
          sourcedCategory,
          garmentAnalysis,
          poseDescription,
          stylingSuggestion,
          userAdditions || '',
          !!backgroundReferenceImage,
        );

        const referenceImages = [backgroundReferenceImage].filter(
          (r): r is { buffer: Buffer; mimeType: string } => !!r,
        );

        // AI 피팅은 항상 전신 샷 1장만 생성한다 — 이 1장이 "확정된 룩"이 되고, AI 바리에이션(포즈 다양화)의
        // 입력으로 이어진다.
        const { imageUrl } = await runSingleRestyle(openai, photoBuf, photoMime, prompt, referenceImages);
        const { buffer: outBuf, mimeType: outMime } = await resultImageToBuffer(imageUrl);

        await markGenerationCompleted(generationId, { outputBuffer: outBuf, outputMimeType: outMime, prompt });
      } catch (err: any) {
        console.error('[api/restyle][after] 처리 실패:', err);
        await markGenerationFailed(generationId, err?.message || 'AI 피팅 처리 중 오류가 발생했습니다.');
      }
    });

    return NextResponse.json({ success: true, generationId });
  } catch (err: any) {
    console.error('[api/restyle] 처리 실패:', err);
    return NextResponse.json(
      { success: false, error: err.message || '리스타일링 처리 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
