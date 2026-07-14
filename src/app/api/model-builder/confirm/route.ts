/**
 * /api/model-builder/confirm — 초안 확정 → 고품질 4컷(정면/뒤/좌/우) 백엔드 저장 (비동기)
 *
 * 즉시 profile.json을 builderStatus='building'으로 저장하고 응답한 뒤,
 * after()에서: 초안 이미지를 베이스로 고품질 정면 재생성 → identity_reference.png 저장 →
 * 그 정면을 베이스로 뒤/좌/우 3컷 생성 → 완료 시 builderStatus='ready'.
 * 클라이언트는 GET /api/model-profile을 폴링해서 ready를 감지한다.
 *
 * 상세 영문 스펙(specText)은 여기서 확정 저장 — 이후 AI 피팅/제품 피팅의 bodySpec으로 그대로 쓰임.
 */

import { NextResponse } from 'next/server';
import { after } from 'next/server';
import OpenAI, { toFile } from 'openai';
import {
  buildModelSpecText,
  buildModelFrontFinalPrompt,
  buildModelViewPrompt,
  SKIN_TONE_LABEL,
  APPEARANCE_PRESETS,
  type ModelBuilderInput,
} from '@/lib/model-builder';
import { saveModelProfile, saveIdentityImage, saveViewImage, getModelProfile } from '@/lib/model-profile';
import { withImageRetry, runWithConcurrency, downscaleImage } from '@/lib/image-utils';
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

async function editImage(
  openai: OpenAI,
  base: { buffer: Buffer; mimeType: string },
  prompt: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const down = await downscaleImage(base.buffer, base.mimeType);
  const file = await toFile(down.buffer, `base.${down.mimeType.split('/')[1] || 'png'}`, { type: down.mimeType });
  const res: any = await withImageRetry(() =>
    (openai.images as any).edit({
      model: 'gpt-image-2',
      image: file,
      prompt: prompt.slice(0, 12000),
      n: 1,
      size: '1024x1536',
      quality: 'medium', // 확정본 — 서비스 전반이 계속 참조하는 기준 이미지라 품질을 올린다
    }),
  );
  const item = res?.data?.[0];
  if (item?.b64_json) return { buffer: Buffer.from(item.b64_json, 'base64'), mimeType: 'image/png' };
  if (item?.url) {
    const r = await fetch(item.url);
    return { buffer: Buffer.from(await r.arrayBuffer()), mimeType: r.headers.get('content-type') || 'image/png' };
  }
  throw new Error('빈 이미지 응답 (모델 확정 생성)');
}

/** 사용자에게 보여줄 요약용 외모 라벨 */
function appearanceLabel(input: ModelBuilderInput): string {
  if (input.appearancePreset === 'custom') return input.appearanceCustomText?.trim() || '직접 입력';
  return APPEARANCE_PRESETS.find((p) => p.key === input.appearancePreset)?.label || '';
}

export async function POST(req: Request) {
  try {
    const uid = await getSessionUserId();
    if (!uid) return NextResponse.json({ success: false, error: '로그인이 필요합니다.' }, { status: 401 });

    const {
      input,
      draftImageBase64,
      openaiApiKey,
    }: { input: ModelBuilderInput; draftImageBase64: string; openaiApiKey: string } = await req.json();

    if (!openaiApiKey) {
      return NextResponse.json({ success: false, error: 'OpenAI API 키가 필요합니다.' }, { status: 400 });
    }
    if (!draftImageBase64) {
      return NextResponse.json({ success: false, error: '확정할 초안 이미지가 없습니다.' }, { status: 400 });
    }

    const specText = buildModelSpecText(input);
    const featuresSummary = [
      `피부톤: ${SKIN_TONE_LABEL[input.skinTone]}`,
      input.featuresText.trim(),
    ]
      .filter(Boolean)
      .join(' · ');

    // 즉시 "생성 중" 상태로 저장 — UI가 이 상태를 보고 진행 화면을 띄운다
    await saveModelProfile(uid, {
      name: input.name?.trim() || '내 모델',
      heightCm: input.heightCm,
      weightKg: input.weightKg,
      shoeSizeMm: input.shoeSizeMm,
      specText,
      hasCustomIdentityImage: false,
      gender: input.gender,
      age: input.age,
      featuresText: featuresSummary,
      appearanceText: appearanceLabel(input),
      builderStatus: 'building',
      builderError: null,
    });

    after(async () => {
      const openai = new OpenAI({ apiKey: openaiApiKey });
      try {
        const draft = parseBase64Image(draftImageBase64);

        // 1) 고품질 정면 — 초안을 베이스로 같은 인물을 재생성
        const front = await editImage(openai, draft, buildModelFrontFinalPrompt(input));
        await saveIdentityImage(uid, front.buffer, front.mimeType);

        // 2) 뒤/좌/우 3컷 — 확정 정면을 베이스로 (동시 3개, 429 재시도 포함)
        await runWithConcurrency(['back', 'left', 'right'] as const, 3, async (view) => {
          const img = await editImage(openai, front, buildModelViewPrompt(view));
          await saveViewImage(uid, view, img.buffer, img.mimeType);
        });

        const current = await getModelProfile(uid);
        await saveModelProfile(uid, {
          ...current,
          hasCustomIdentityImage: true,
          builderStatus: 'ready',
          builderError: null,
        });
      } catch (err: any) {
        console.error('[model-builder/confirm][after] 실패:', err);
        try {
          const current = await getModelProfile(uid);
          await saveModelProfile(uid, {
            ...current,
            builderStatus: 'failed',
            builderError: err?.error?.message || err?.message || '모델 확정 생성 중 오류가 발생했습니다.',
          });
        } catch {
          // 상태 저장마저 실패하면 폴링 타임아웃으로 처리됨
        }
      }
    });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[model-builder/confirm] 실패:', err);
    return NextResponse.json(
      { success: false, error: err?.message || '모델 확정 요청에 실패했습니다.' },
      { status: 500 },
    );
  }
}
