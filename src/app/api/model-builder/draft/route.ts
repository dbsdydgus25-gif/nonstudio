/**
 * /api/model-builder/draft — 가상 모델 초안 1장 생성 (동기)
 * 초안 품질(low) · 흰 스튜디오 · 전신 정면 · 검은 반팔+반바지.
 * appearanceReferenceImageBase64가 있으면 그 얼굴/헤어스타일/분위기를 참고해 생성한다(옷·배경·포즈는 무시).
 * 마음에 들 때까지 "다시 만들기"로 반복 → 확정 시 /confirm으로 이 이미지를 넘긴다.
 */

import { NextResponse } from 'next/server';
import OpenAI, { toFile } from 'openai';
import {
  buildModelDraftPrompt,
  buildModelDraftFromReferencePrompt,
  type ModelBuilderInput,
} from '@/lib/model-builder';
import { withImageRetry, downscaleImage } from '@/lib/image-utils';
import { getSessionUserId } from '@/lib/auth';

export const runtime = 'nodejs';
export const maxDuration = 280;

function parseBase64Image(dataUrl: string): { buffer: Buffer; mimeType: string } {
  if (dataUrl.startsWith('data:')) {
    const [header, data] = dataUrl.split(',');
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/png';
    return { buffer: Buffer.from(data, 'base64'), mimeType };
  }
  return { buffer: Buffer.from(dataUrl, 'base64'), mimeType: 'image/png' };
}

export async function POST(req: Request) {
  try {
    const uid = await getSessionUserId();
    if (!uid) return NextResponse.json({ success: false, error: '로그인이 필요합니다.' }, { status: 401 });

    const {
      input,
      openaiApiKey,
      appearanceReferenceImageBase64,
    }: {
      input: ModelBuilderInput;
      openaiApiKey: string;
      appearanceReferenceImageBase64?: string | null;
    } = await req.json();
    if (!openaiApiKey) {
      return NextResponse.json({ success: false, error: 'OpenAI API 키가 필요합니다.' }, { status: 400 });
    }
    if (!input?.gender || !input?.heightCm || !input?.weightKg) {
      return NextResponse.json({ success: false, error: '모델 기본 정보를 입력해 주세요.' }, { status: 400 });
    }

    const openai = new OpenAI({ apiKey: openaiApiKey });

    let res: any;
    if (appearanceReferenceImageBase64) {
      // 참고 이미지 있음 — edit로 얼굴/헤어스타일만 참고해 생성
      const ref = parseBase64Image(appearanceReferenceImageBase64);
      const down = await downscaleImage(ref.buffer, ref.mimeType);
      const refFile = await toFile(down.buffer, `reference.${down.mimeType.split('/')[1] || 'jpg'}`, {
        type: down.mimeType,
      });
      const prompt = buildModelDraftFromReferencePrompt(input);
      res = await withImageRetry(() =>
        (openai.images as any).edit({
          model: 'gpt-image-2',
          image: refFile,
          prompt: prompt.slice(0, 12000),
          n: 1,
          size: '1024x1536',
          quality: 'low',
        }),
      );
    } else {
      const prompt = buildModelDraftPrompt(input);
      res = await withImageRetry(() =>
        (openai.images as any).generate({
          model: 'gpt-image-2',
          prompt: prompt.slice(0, 12000),
          n: 1,
          size: '1024x1536',
          quality: 'low', // 초안 — 마음에 들 때까지 저비용으로 반복
        }),
      );
    }

    const item = res?.data?.[0];
    const imageDataUrl = item?.b64_json
      ? `data:image/png;base64,${item.b64_json}`
      : item?.url || '';
    if (!imageDataUrl) throw new Error('빈 이미지 응답 (모델 초안 생성)');

    return NextResponse.json({ success: true, imageDataUrl });
  } catch (err: any) {
    console.error('[model-builder/draft] 실패:', err);
    return NextResponse.json(
      { success: false, error: err?.error?.message || err?.message || '모델 초안 생성에 실패했습니다.' },
      { status: 500 },
    );
  }
}
