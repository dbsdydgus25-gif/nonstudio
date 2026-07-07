/**
 * /api/restyle/route.ts
 * 실사 기반 AI 리스타일링: 사용자가 소싱 제품을 실제로 입고/착용해 찍은 사진 1장을 받아,
 * 선택한 카테고리(상의/하의/신발/액세서리)의 색상/질감/핏은 충실히 재현하면서,
 * 몸은 177/74 마른 근육형으로 리셰이프하고 포즈·배경·나머지 착장은 새로 생성한다.
 * (실사 원본을 픽셀 단위로 고정하지 않음 — 원본 체형을 그대로 두면 자유도가 떨어지고
 * 실제 몸매가 그대로 드러나 상품성이 떨어지는 문제가 있어 마스크 방식에서 전환함)
 * ① 사진 분석(의류 분석 + 포즈 분석) → ② 프롬프트 작성 → ③ OpenAI 이미지 생성(전용)
 */

import { NextResponse } from 'next/server';
import OpenAI, { toFile } from 'openai';
import fs from 'fs';
import path from 'path';
import { analyzeGarment, analyzePose, generateStylingSuggestion } from '@/lib/garment-agent';
import { buildRestylePrompt, DEFAULT_STUDIO_BACKGROUND, type SourcedCategory } from '@/lib/fitting-prompts';
import { getActiveReferenceImage, saveGeneration } from '@/lib/generation-store';

export const runtime = 'nodejs';
export const maxDuration = 120;

// 배경 지시가 없을 때 항상 이 실제 사진(스튜디오 배경/조명 기준)을 참고 이미지로 같이 넣는다.
// 텍스트 설명만으로는 매번 배경/조명이 살짝씩 달라져서, 실제 사진 한 장을 고정 기준으로 삼는다.
const DEFAULT_BACKGROUND_IMAGE_PATH = path.join(process.cwd(), 'public', 'backgrounds', 'default_white_studio.png');

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

  // 승격된 체형 기준 이미지 / 고정 배경 기준 이미지가 있으면 추가 입력 이미지로 같이 넣어 일관성을 강화한다
  // (텍스트 설명만으로 몸/배경을 재형성하는 것보다 실제 참고 사진이 훨씬 강하게 먹힘 — 모델 피팅 파이프라인과 동일한 방식)
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
      variationCount,
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
    const count = Math.min(4, Math.max(1, Number(variationCount) || 2));

    // ① 사진 분석 (의류 분석 · 포즈 분석, 병렬)
    const [garmentAnalysis, poseDescription] = await Promise.all([
      analyzeGarment([photoBase64], geminiApiKey, undefined, undefined, sourcedCategory, openaiApiKey),
      analyzePose(photoBase64, geminiApiKey, openaiApiKey),
    ]);

    const { buffer: photoBuf, mimeType: photoMime } = parseBase64Image(photoBase64);

    const openai = new OpenAI({ apiKey: openaiApiKey });

    // 승격된 기준 참고 이미지 조회 (없으면 null — Supabase 미설정/미승격 상태에서도 정상 동작)
    const savedReferenceImage = await getActiveReferenceImage('restyle');

    // 코디 제안(배경·하의·신발·액세서리)은 요청당 딱 한 번만 생성해서 모든 변형이 공유한다.
    // 예전엔 변형마다 따로 호출해서 매번 배경/하의/가방이 다르게 지어졌음 —
    // 그러면 같은 배치의 사진들이 서로 다른 화보처럼 보여서 "같은 사람 아닌 것 같다"는 문제가 생김.
    // 변형 간 차이는 이제 gpt-image-2 자체의 렌더링 편차 정도로만 남는다.
    const stylingSuggestion = await generateStylingSuggestion(
      sourcedCategory,
      garmentAnalysis,
      poseDescription,
      geminiApiKey,
      openaiApiKey,
      userPreferenceHint,
    );

    // 배경은 사용자가 명시적으로 지시했을 때만 그 내용을 쓰고, 없으면 모델 피팅과 동일한
    // 고정 흰색 스튜디오 배경으로 강제 통일한다 — AI가 매번 다른 장소를 지어내지 않도록.
    const hasCustomBackground = !!backgroundHint?.trim();
    stylingSuggestion.background = hasCustomBackground ? backgroundHint.trim() : DEFAULT_STUDIO_BACKGROUND;

    // 배경 지시가 없으면 실제 흰색 스튜디오 사진을 참고 이미지로 같이 넣는다 — 텍스트보다
    // 실제 사진 한 장이 배경/조명 방향을 훨씬 정확하게 고정시켜준다.
    let backgroundReferenceImage: { buffer: Buffer; mimeType: string } | null = null;
    if (!hasCustomBackground && fs.existsSync(DEFAULT_BACKGROUND_IMAGE_PATH)) {
      backgroundReferenceImage = { buffer: fs.readFileSync(DEFAULT_BACKGROUND_IMAGE_PATH), mimeType: 'image/png' };
    }

    type VariationResult = { imageUrl: string; engineUsed: string; prompt: string; variationLabel: string; generationId: string | null };

    async function generateVariation(
      i: number,
      bodyReferenceImage: { buffer: Buffer; mimeType: string } | null,
    ): Promise<VariationResult> {
      const prompt = buildRestylePrompt(
        sourcedCategory,
        garmentAnalysis,
        poseDescription,
        stylingSuggestion,
        userAdditions || '',
        !!backgroundReferenceImage,
      );
      const variationLabel = `스타일 변형 #${i + 1}`;
      try {
        const referenceImages = [bodyReferenceImage, backgroundReferenceImage].filter(
          (r): r is { buffer: Buffer; mimeType: string } => !!r,
        );
        const { imageUrl, engineUsed } = await runSingleRestyle(openai, photoBuf, photoMime, prompt, referenceImages);

        // 생성 기록 저장 (실패해도 결과 반환에는 영향 없음 — saveGeneration 내부에서 흡수)
        let generationId: string | null = null;
        try {
          const { buffer: outBuf, mimeType: outMime } = await resultImageToBuffer(imageUrl);
          generationId = await saveGeneration({
            pipeline: 'restyle',
            modeOrCategory: sourcedCategory,
            prompt,
            poseLabel: variationLabel,
            outputBuffer: outBuf,
            outputMimeType: outMime,
          });
        } catch (logErr) {
          console.warn('[api/restyle] 생성 기록 저장 실패 (결과 반환은 정상 진행):', logErr);
        }

        return { imageUrl, engineUsed, prompt, variationLabel, generationId };
      } catch (taskErr: any) {
        console.error(
          `[api/restyle] 변형 #${i + 1} 생성 실패 — status: ${taskErr?.status}, message: ${taskErr?.message}, detail:`,
          taskErr?.error || taskErr,
        );
        throw taskErr;
      }
    }

    // 변형끼리 앵커로 체이닝(순차 생성)하면 Vercel 서버리스 함수 시간 제한(504)을 넘기기 쉬워서
    // 다시 전체 병렬 생성으로 되돌림. 배치 내 일관성은 Supabase에 승격해둔 기준 이미지(savedReferenceImage)로
    // 확보한다 — 처음 한 번 마음에 드는 결과에 👍를 눌러 기준으로 저장해두면, 그 다음부터는
    // 같은 배치 안의 모든 변형이 그 기준 이미지를 함께 참고해서 서로도 일관되게 나온다.
    const settled = await Promise.allSettled(
      Array.from({ length: count }).map((_, i) => generateVariation(i, savedReferenceImage)),
    );

    const images = settled
      .filter((r): r is PromiseFulfilledResult<VariationResult> => r.status === 'fulfilled')
      .map((r) => r.value);
    const errors = settled
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => {
        const reason = r.reason;
        const status = reason?.status ? ` (status ${reason.status})` : '';
        return `${reason?.message || String(reason)}${status}`;
      });

    if (images.length === 0) {
      return NextResponse.json({ success: false, error: '모든 변형 생성에 실패했습니다.', errors }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      images,
      garmentAnalysis,
      totalGenerated: images.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: any) {
    console.error('[api/restyle] 처리 실패:', err);
    return NextResponse.json(
      { success: false, error: err.message || '리스타일링 처리 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
