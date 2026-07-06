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
import { analyzeGarment, analyzePose, generateStylingSuggestion } from '@/lib/garment-agent';
import { buildRestylePrompt, type SourcedCategory } from '@/lib/fitting-prompts';

export const runtime = 'nodejs';
export const maxDuration = 120;

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

async function runSingleRestyle(
  openai: OpenAI,
  photoBuf: Buffer,
  photoMime: string,
  prompt: string,
): Promise<{ imageUrl: string; engineUsed: string }> {
  const photoFile = await toOpenAIFile(photoBuf, photoMime, `photo.${photoMime.split('/')[1] || 'jpg'}`);

  const res = await (openai.images as any).edit({
    model: 'gpt-image-2',
    image: photoFile,
    prompt: prompt.slice(0, 4000),
    n: 1,
    size: '1024x1536',
    quality: 'medium', // 'auto'(기본값)는 비용/시간이 크게 늘어남 — 커머셜 컷 용도로는 medium이면 충분
    // input_fidelity는 gpt-image-2가 지원하지 않는 파라미터라 400 에러 유발 — 제거함 (SDK 타입엔 있었지만 이 모델은 거부)
  });

  const item = res?.data?.[0];
  const imageUrl = item?.url || (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
  if (!imageUrl) throw new Error('빈 이미지 응답 (gpt-image-2 restyle edit)');
  return { imageUrl, engineUsed: 'gpt-image-2 (restyle)' };
}

export async function POST(req: Request) {
  try {
    const {
      photoBase64,
      category,
      geminiApiKey,
      openaiApiKey,
      userAdditions,
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

    // ② 프롬프트 작성 + ③ 이미지 생성 (variationCount만큼 병렬, OpenAI 전용)
    const tasks = Array.from({ length: count }).map(async (_, i) => {
      const stylingSuggestion = await generateStylingSuggestion(
        sourcedCategory,
        garmentAnalysis,
        poseDescription,
        geminiApiKey,
        openaiApiKey,
        userPreferenceHint,
      );
      const prompt = buildRestylePrompt(
        sourcedCategory,
        garmentAnalysis,
        poseDescription,
        stylingSuggestion,
        userAdditions || '',
      );
      try {
        const { imageUrl, engineUsed } = await runSingleRestyle(openai, photoBuf, photoMime, prompt);
        return {
          imageUrl,
          engineUsed,
          prompt,
          variationLabel: `스타일 변형 #${i + 1}`,
        };
      } catch (taskErr: any) {
        console.error(
          `[api/restyle] 변형 #${i + 1} 생성 실패 — status: ${taskErr?.status}, message: ${taskErr?.message}, detail:`,
          taskErr?.error || taskErr,
        );
        throw taskErr;
      }
    });

    const settled = await Promise.allSettled(tasks);
    const images = settled
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof runSingleRestyle>> & { prompt: string; variationLabel: string }> => r.status === 'fulfilled')
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
