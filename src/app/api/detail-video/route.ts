/**
 * /api/detail-video/route.ts
 * "AI 영상" — 제품 착용 컷을 짧은 세로형 영상으로 만들어 GIF로 저장한다.
 * 원단 촉감/신축성 같은 디테일 모션과, 실제로 걷는 듯한 전신 모션 두 갈래를 지원한다.
 * gpt-image-2 기반 바리에이션과 달리 영상 생성은 수십 초~수 분이 걸려서, 여기서도 동일하게
 * "pending 행 즉시 반환 → after()에서 폴링하며 백그라운드 완료 → 프론트가
 * /api/generations/status로 폴링" 구조를 그대로 따른다.
 *
 * 가장 중요한 제약: 원본 사진의 얼굴/체형/원단 재질은 절대 바뀌면 안 된다 — 프롬프트
 * 설계는 detail-video-prompts.ts에서 담당.
 *
 * (2026-07-22) Veo 3.1 마이그레이션. 실측으로 확인한 것들:
 * - 기존 `veo-2.0-generate-001`은 **완전히 퇴역(404)** 해서 이 기능은 그동안 무조건 실패 상태였다.
 * - `negativePrompt` 파라미터는 veo-3.1-lite에서 **미지원(400)** — 부정 제약은 프롬프트 본문에 둔다.
 * - `durationSeconds`는 4/6/8만 허용 (기존 코드의 3은 무효값이었다).
 * - Veo는 입력 이미지 비율을 따라가지 않고 자기 캔버스에 검은 여백을 채운다 →
 *   보내기 전에 9:16으로 크롭해야 한다 (cropToAspectRatio).
 * - 오디오는 항상 켜져 있어 끌 수 없다. GIF 변환 시 어차피 버려진다.
 */

import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { buildDetailVideoPrompt, type MotionKind } from '@/lib/detail-video-prompts';
import { createPendingGeneration, markGenerationCompleted, markGenerationFailed } from '@/lib/generation-store';
import { resultImageToBuffer } from '@/lib/image-source';
import { cropToAspectRatio } from '@/lib/image-utils';
import { convertMp4ToGif } from '@/lib/video-to-gif';

export const runtime = 'nodejs';
export const maxDuration = 280;

// 비용: Lite 720p $0.05/초, Fast 720p $0.10/초 → 4초 기준 각각 약 $0.20 / $0.40.
// 기본은 Lite, 사용자가 화질 토글을 켜면 Fast.
const VIDEO_MODELS = {
  lite: 'veo-3.1-lite-generate-preview',
  fast: 'veo-3.1-fast-generate-preview',
} as const;
type VideoQuality = keyof typeof VIDEO_MODELS;

const DURATION_SECONDS = 4; // Veo 3.1은 4/6/8만 허용 — 최소값이 가장 저렴
const PORTRAIT_RATIO = 9 / 16;
const POLL_INTERVAL_MS = 8000;
const MAX_POLL_ATTEMPTS = 30; // 8s * 30 = 240s, maxDuration(280s) 안에 여유있게 마무리

export async function POST(req: Request) {
  try {
    const { sourceImageBase64, detailInstruction, geminiApiKey, motionKind, quality } = await req.json();

    if (!sourceImageBase64) {
      return NextResponse.json({ success: false, error: '영상으로 만들 기준 사진이 필요합니다.' }, { status: 400 });
    }
    if (!detailInstruction || typeof detailInstruction !== 'string' || !detailInstruction.trim()) {
      return NextResponse.json({ success: false, error: '어떤 움직임을 보여줄지 설명이 필요합니다.' }, { status: 400 });
    }
    const apiKey = geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ success: false, error: 'Gemini API 키가 필요합니다.' }, { status: 400 });
    }

    const kind: MotionKind = motionKind === 'motion' ? 'motion' : 'detail';
    const videoQuality: VideoQuality = quality === 'fast' ? 'fast' : 'lite';
    const prompt = buildDetailVideoPrompt(detailInstruction.trim(), kind);

    const generationId = await createPendingGeneration({
      pipeline: 'detail-video',
      modeOrCategory: 'detail-video',
      // 히스토리에서 어떤 종류의 영상인지 한눈에 보이도록 라벨을 남긴다
      poseLabel: `${kind === 'motion' ? '모션' : '디테일'} · ${videoQuality === 'fast' ? '고화질' : '기본'}`,
      prompt: detailInstruction.trim(),
    });

    after(async () => {
      try {
        const raw = await resultImageToBuffer(sourceImageBase64);
        // Veo가 검은 여백을 채우지 않도록 9:16으로 미리 맞춰서 보낸다 (위 주석 참고)
        const { buffer: sourceBuf, mimeType: sourceMime } = await cropToAspectRatio(
          raw.buffer,
          raw.mimeType,
          PORTRAIT_RATIO,
        );
        const ai = new GoogleGenAI({ apiKey });

        let operation = await ai.models.generateVideos({
          model: VIDEO_MODELS[videoQuality],
          prompt,
          image: { imageBytes: sourceBuf.toString('base64'), mimeType: sourceMime },
          config: {
            numberOfVideos: 1,
            durationSeconds: DURATION_SECONDS,
            resolution: '720p',
            aspectRatio: '9:16',
            personGeneration: 'allow_adult',
          },
        });

        let attempts = 0;
        while (!operation.done && attempts < MAX_POLL_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          operation = await ai.operations.getVideosOperation({ operation });
          attempts += 1;
        }

        if (!operation.done) {
          throw new Error('영상 생성이 시간 내에 끝나지 않았습니다 (타임아웃).');
        }
        if (operation.error) {
          throw new Error(typeof operation.error === 'string' ? operation.error : JSON.stringify(operation.error));
        }

        const generated = operation.response?.generatedVideos?.[0]?.video;
        if (!generated) throw new Error('빈 영상 응답 (Gemini video generation)');

        let videoBuffer: Buffer;
        if (generated.videoBytes) {
          videoBuffer = Buffer.from(generated.videoBytes, 'base64');
        } else if (generated.uri) {
          const sep = generated.uri.includes('?') ? '&' : '?';
          const res = await fetch(`${generated.uri}${sep}key=${apiKey}`);
          if (!res.ok) throw new Error(`영상 다운로드 실패 (${res.status})`);
          videoBuffer = Buffer.from(await res.arrayBuffer());
        } else {
          throw new Error('영상 응답에 videoBytes와 uri가 둘 다 없습니다.');
        }

        // (2026-07-17) 대표님이 캡컷 등으로 따로 변환할 필요 없이 바로 GIF로 받을 수 있도록,
        // 원본 mp4를 서버에서 바로 GIF로 변환해서 저장한다.
        const gifBuffer = await convertMp4ToGif(videoBuffer, { fps: 10, width: 480 });

        await markGenerationCompleted(generationId, {
          outputBuffer: gifBuffer,
          outputMimeType: 'image/gif',
          prompt: detailInstruction.trim(),
        });
      } catch (err: any) {
        console.error('[api/detail-video][after] 영상 생성 실패:', err);
        await markGenerationFailed(generationId, err?.message || '디테일컷 영상 생성 중 오류가 발생했습니다.');
      }
    });

    return NextResponse.json({ success: true, generationId, prompt: detailInstruction.trim() });
  } catch (err: any) {
    console.error('[api/detail-video] 처리 실패:', err);
    return NextResponse.json(
      { success: false, error: err.message || '디테일컷 영상 처리 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
