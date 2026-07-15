/**
 * /api/model-builder/from-photo — 트랙 2: 실제 사진 업로드로 모델 만들기 (비동기)
 *
 * 사진 1장: 그대로 정면 기준 이미지(identity_reference)로 저장 (재생성 없음 = 실물 그대로).
 * 사진 2장 이상: images.edit 다중 이미지 입력으로 하나의 정면 기준 사진으로 종합
 *   (Image 1 = 포즈/구도/착장 기준, 나머지 = 얼굴·피부·체형 정확도 보강용).
 * 이후 공통: 정면 기준 이미지에서 뒤/좌/우 3컷만 파생 생성.
 */

import { NextResponse } from 'next/server';
import { after } from 'next/server';
import OpenAI, { toFile } from 'openai';
import {
  buildPhotoModelSpecText,
  buildPhotoSynthesisPrompt,
  buildPhotoViewPrompt,
  type PhotoModelInput,
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

async function editView(
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
      quality: 'medium',
    }),
  );
  const item = res?.data?.[0];
  if (item?.b64_json) return { buffer: Buffer.from(item.b64_json, 'base64'), mimeType: 'image/png' };
  if (item?.url) {
    const r = await fetch(item.url);
    return { buffer: Buffer.from(await r.arrayBuffer()), mimeType: r.headers.get('content-type') || 'image/png' };
  }
  throw new Error('빈 이미지 응답 (사진 모델 뷰 생성)');
}

/** 여러 장을 하나의 정면 기준 사진으로 종합 (images.edit 다중 이미지 입력) */
async function synthesizeFront(
  openai: OpenAI,
  photos: Array<{ buffer: Buffer; mimeType: string }>,
  input: PhotoModelInput,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const downs = await Promise.all(photos.map((p) => downscaleImage(p.buffer, p.mimeType)));
  const files = await Promise.all(
    downs.map((d, i) => toFile(d.buffer, `ref-${i}.${d.mimeType.split('/')[1] || 'jpg'}`, { type: d.mimeType })),
  );
  const prompt = buildPhotoSynthesisPrompt(input, files.length);
  const res: any = await withImageRetry(() =>
    (openai.images as any).edit({
      model: 'gpt-image-2',
      image: files,
      prompt: prompt.slice(0, 12000),
      n: 1,
      size: '1024x1536',
      quality: 'medium',
    }),
  );
  const item = res?.data?.[0];
  if (item?.b64_json) return { buffer: Buffer.from(item.b64_json, 'base64'), mimeType: 'image/png' };
  if (item?.url) {
    const r = await fetch(item.url);
    return { buffer: Buffer.from(await r.arrayBuffer()), mimeType: r.headers.get('content-type') || 'image/png' };
  }
  throw new Error('빈 이미지 응답 (사진 종합)');
}

export async function POST(req: Request) {
  try {
    const uid = await getSessionUserId();
    if (!uid) return NextResponse.json({ success: false, error: '로그인이 필요합니다.' }, { status: 401 });

    const {
      input,
      photosBase64,
      openaiApiKey,
    }: { input: PhotoModelInput; photosBase64: string[]; openaiApiKey: string } = await req.json();

    if (!openaiApiKey) {
      return NextResponse.json({ success: false, error: 'OpenAI API 키가 필요합니다.' }, { status: 400 });
    }
    if (!photosBase64?.length) {
      return NextResponse.json({ success: false, error: '모델 사진을 업로드해 주세요.' }, { status: 400 });
    }
    if (!input?.heightCm || !input?.weightKg) {
      return NextResponse.json({ success: false, error: '키·몸무게를 입력해 주세요.' }, { status: 400 });
    }

    const photos = photosBase64.slice(0, 6).map(parseBase64Image);
    const specText = buildPhotoModelSpecText(input);

    // 사진 1장이면 그대로 정면으로 저장 (재생성 없음 = 실물 그대로).
    // 2장 이상이면 종합은 after()에서 진행하고, 여기서는 첫 장을 임시 정면으로 즉시 보여준다.
    const firstDown = await downscaleImage(photos[0].buffer, photos[0].mimeType);
    await saveIdentityImage(uid, firstDown.buffer, firstDown.mimeType);

    await saveModelProfile(uid, {
      name: input.name?.trim() || '내 모델',
      heightCm: input.heightCm,
      weightKg: input.weightKg,
      shoeSizeMm: input.shoeSizeMm,
      specText,
      hasCustomIdentityImage: true,
      gender: input.gender,
      age: input.age,
      featuresText: photos.length > 1 ? `업로드한 실제 사진 ${photos.length}장 종합` : '업로드한 실제 사진 기반',
      appearanceText: '사진 기반',
      builderStatus: 'building',
      builderError: null,
      builderTrack: 'photo',
    });

    after(async () => {
      const openai = new OpenAI({ apiKey: openaiApiKey });
      try {
        let front = firstDown;
        if (photos.length > 1) {
          front = await synthesizeFront(openai, photos, input);
          await saveIdentityImage(uid, front.buffer, front.mimeType);
        }

        await runWithConcurrency(['back', 'left', 'right'] as const, 3, async (view) => {
          const img = await editView(openai, front, buildPhotoViewPrompt(view));
          await saveViewImage(uid, view, img.buffer, img.mimeType);
        });

        const current = await getModelProfile(uid);
        await saveModelProfile(uid, { ...current, builderStatus: 'ready', builderError: null });
      } catch (err: any) {
        console.error('[model-builder/from-photo][after] 실패:', err);
        try {
          const current = await getModelProfile(uid);
          // 정면은 이미 저장돼 있으니, 뷰/종합 생성만 실패해도 모델 자체는 사용 가능하게 ready 처리
          await saveModelProfile(uid, {
            ...current,
            builderStatus: 'ready',
            builderError: '일부 뷰 생성에 실패했지만 정면 사진으로 사용 가능합니다.',
          });
        } catch {
          // 무시 — 폴링 타임아웃으로 처리
        }
      }
    });

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[model-builder/from-photo] 실패:', err);
    return NextResponse.json(
      { success: false, error: err?.message || '사진 모델 저장에 실패했습니다.' },
      { status: 500 },
    );
  }
}
