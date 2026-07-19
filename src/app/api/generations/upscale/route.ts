/**
 * /api/generations/upscale/route.ts
 * "일괄 고화질" — 히스토리에서 고른 결과물들을 gpt-image-2 high 품질로 리마스터한다.
 *
 * 설계 배경(2026-07-19, 대표님 요청):
 * - 모든 생성을 high로 뽑으면 버려질 컷까지 2~2.5배 비용 → 낭비. 그래서 생성은 지금처럼
 *   medium(싸게)로 탐색하고, 채택한 컷만 이 엔드포인트로 high 리마스터한다(비용을 채택본에만 집중).
 * - gpt-image-2는 seed가 없어 "같은 그림 다시"가 불가능하므로, 저장된 결과 이미지 자체를 입력으로
 *   넣고 "구도/사람/옷/색은 절대 바꾸지 말고 디테일·선명도만 올려라"로 지시하는 리마스터 방식.
 *   출력 해상도는 gpt-image-2 상한(1024x1536)으로 동일하지만, high 티어라 원단 질감/스티치 등
 *   같은 픽셀 안의 렌더 디테일이 크게 올라간다(확대해서 재질 볼 때 목적).
 * - 여러 장 × ~60~100초라 비동기 pending 패턴: pending 행 즉시 반환 → after()에서 생성 → 프론트 폴링.
 */

import { NextResponse } from 'next/server';
import { after } from 'next/server';
import OpenAI, { toFile } from 'openai';
import {
  createPendingGeneration,
  markGenerationCompleted,
  markGenerationFailed,
  getGenerationsByIds,
  downloadOutputImage,
} from '@/lib/generation-store';
import { withImageRetry, runWithConcurrency } from '@/lib/image-utils';

export const runtime = 'nodejs';
export const maxDuration = 280;

/** 리마스터 표식 — pose_label 앞에 붙여 히스토리에서 고화질본을 구분한다. */
export const HD_LABEL_PREFIX = '[HD] ';

const REMASTER_PROMPT = `
=== TASK: HIGH-FIDELITY REMASTER OF AN EXISTING PHOTO (NOT A REDESIGN) ===
The input is a finished fashion lookbook photograph. Re-render it at maximum quality and detail — this is an upscale/remaster pass, purely to increase sharpness and fine detail.

ABSOLUTE RULE — CHANGE NOTHING about the content:
- Keep the EXACT same person (face, body, skin tone, hair), the exact same pose and body orientation, the exact same framing/crop and camera angle.
- Keep the EXACT same garments, their exact colors and shades, and every construction detail (seams, panel lines, pockets, patches, logos, buttons, stitching) in the exact same place — do not add, remove, move, duplicate, or reinterpret any of them.
- Keep the exact same background and lighting.

ONLY improve rendering quality: sharper focus, cleaner edges, and more realistic fine detail — especially visible fabric weave and texture, thread/stitch definition, and natural skin/hair micro-detail — as if the same shot were taken with a higher-resolution camera and a better lens. Do NOT beautify, restyle, smooth, or "improve" the design; do NOT change proportions. The result must be instantly recognizable as the same photograph, just crisper.

Output: a single photorealistic photograph, no text, no watermark, no collage, no multiple views.
`.trim();

async function remasterOne(openai: OpenAI, sourcePath: string): Promise<{ buffer: Buffer; mimeType: string }> {
  // 리마스터는 입력을 다운스케일하지 않는다 — 원본 결과(1024x1536)를 그대로 넣고 high로 재렌더.
  const { buffer, mimeType } = await downloadOutputImage(sourcePath);
  const file = await toFile(buffer, `source.${mimeType.split('/')[1] || 'png'}`, { type: mimeType });

  const res: any = await withImageRetry(() =>
    (openai.images as any).edit({
      model: 'gpt-image-2',
      image: file,
      prompt: REMASTER_PROMPT,
      n: 1,
      size: '1024x1536',
      quality: 'high',
    }),
  );
  const item = res?.data?.[0];
  const imageUrl = item?.url || (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
  if (!imageUrl) throw new Error('빈 이미지 응답 (gpt-image-2 remaster)');

  if (imageUrl.startsWith('data:')) {
    const [header, data] = imageUrl.split(',');
    const outMime = header.match(/data:([^;]+)/)?.[1] || 'image/png';
    return { buffer: Buffer.from(data, 'base64'), mimeType: outMime };
  }
  const r = await fetch(imageUrl);
  const ab = await r.arrayBuffer();
  return { buffer: Buffer.from(ab), mimeType: r.headers.get('content-type') || 'image/png' };
}

export async function POST(req: Request) {
  try {
    const { generationIds, openaiApiKey } = (await req.json()) as {
      generationIds: string[];
      openaiApiKey?: string;
    };
    if (!Array.isArray(generationIds) || generationIds.length === 0) {
      return NextResponse.json({ success: false, error: '고화질로 뽑을 결과를 선택해주세요.' }, { status: 400 });
    }
    const oKey = openaiApiKey || process.env.OPENAI_API_KEY;
    if (!oKey) {
      return NextResponse.json({ success: false, error: 'OpenAI API 키가 필요합니다.' }, { status: 400 });
    }

    const sources = await getGenerationsByIds(generationIds.slice(0, 20)); // 과금 폭주 방지 상한
    if (sources.length === 0) {
      return NextResponse.json({ success: false, error: '완료된 결과만 고화질로 뽑을 수 있습니다.' }, { status: 400 });
    }

    // 각 소스마다 pending 행을 먼저 만들어 즉시 id를 반환한다(같은 탭에 뜨도록 mode 재사용, HD 표식).
    const jobs = await Promise.all(
      sources.map(async (src) => ({
        source: src,
        generationId: await createPendingGeneration({
          pipeline: 'restyle',
          modeOrCategory: src.modeOrCategory || undefined,
          poseLabel: `${HD_LABEL_PREFIX}${(src.poseLabel || '결과').replace(HD_LABEL_PREFIX, '')}`,
          prompt: 'HD 리마스터',
        }),
      })),
    );

    after(async () => {
      const openai = new OpenAI({ apiKey: oKey });
      await runWithConcurrency(jobs, 2, async ({ source, generationId }) => {
        try {
          const { buffer, mimeType } = await remasterOne(openai, source.outputStoragePath);
          await markGenerationCompleted(generationId, { outputBuffer: buffer, outputMimeType: mimeType });
        } catch (err: any) {
          console.error('[api/generations/upscale][after] 리마스터 실패:', err);
          await markGenerationFailed(generationId, err?.message || '고화질 리마스터 중 오류가 발생했습니다.');
        }
      });
    });

    return NextResponse.json({
      success: true,
      jobs: jobs.map((j) => ({ generationId: j.generationId, sourceId: j.source.id })),
    });
  } catch (err: any) {
    console.error('[api/generations/upscale] 처리 실패:', err);
    return NextResponse.json(
      { success: false, error: err?.message || '고화질 처리 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
