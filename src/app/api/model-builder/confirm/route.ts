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

// (2026-07-27) 단일 이미지만 받던 것을 배열로 확장 — 뒤/좌/우 뷰 생성 시 정면 + 이미 확정된
// 다른 뷰(들)까지 함께 참고시켜 세 뷰 사이의 얼굴/헤어/체형 일관성을 높인다(레퍼런스 보드
// 기법의 핵심 아이디어 적용 지점 — 자세한 배경은 model-builder.ts의 buildModelViewPrompt 주석 참고).
async function editImage(
  openai: OpenAI,
  bases: Array<{ buffer: Buffer; mimeType: string }>,
  prompt: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const files = await Promise.all(
    bases.map(async (base, i) => {
      const down = await downscaleImage(base.buffer, base.mimeType);
      return toFile(down.buffer, `base_${i}.${down.mimeType.split('/')[1] || 'png'}`, { type: down.mimeType });
    }),
  );
  const res: any = await withImageRetry(() =>
    (openai.images as any).edit({
      model: 'gpt-image-2',
      image: files,
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
        const front = await editImage(openai, [draft], buildModelFrontFinalPrompt(input));
        await saveIdentityImage(uid, front.buffer, front.mimeType);

        // 2) 뒤→좌→우 순서로 체이닝 — 이전에는 정면 1장만 보고 3컷을 완전히 독립적으로(병렬)
        // 생성해서 서로 얼굴/헤어가 미세하게 달라지는 문제가 있었다. 이제 좌/우를 만들 때
        // 정면 + 이미 확정된 뷰까지 함께 참고시켜 세 뷰 사이의 동일성을 서로 대조하게 한다
        // (레퍼런스 보드 기법 적용 — 자세한 배경은 buildModelViewPrompt 주석 참고). 체이닝이라
        // 병렬(runWithConcurrency)은 못 쓰고 순차 실행이지만, 모델 설정은 1회성 작업이라
        // 늘어난 지연시간보다 일관성 향상이 더 중요하다.
        const back = await editImage(openai, [front], buildModelViewPrompt('back'));
        await saveViewImage(uid, 'back', back.buffer, back.mimeType);

        const left = await editImage(openai, [front, back], buildModelViewPrompt('left', ['back']));
        await saveViewImage(uid, 'left', left.buffer, left.mimeType);

        const right = await editImage(openai, [front, back, left], buildModelViewPrompt('right', ['back', 'left']));
        await saveViewImage(uid, 'right', right.buffer, right.mimeType);

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
