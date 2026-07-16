/**
 * /api/detail-video/route.ts
 * "디테일컷" 짧은 영상(3초 안팎) — 원단 촉감/신축성/핏 특성을 동작으로 보여주는 세로형 숏폼
 * 영상을 Gemini(Veo)로 생성한다. gpt-image-2 기반 바리에이션과 달리 영상 생성은 보통 수십 초~
 * 수 분이 걸려서, 여기서도 동일하게 "pending 행 즉시 반환 → after()에서 폴링하며 백그라운드
 * 완료 → 프론트가 /api/generations/status로 폴링" 구조를 그대로 따른다.
 *
 * 가장 중요한 제약: 원본 사진의 얼굴/체형/원단 재질은 절대 바뀌면 안 된다 — 프롬프트
 * 설계는 detail-video-prompts.ts에서 담당.
 */

import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { buildDetailVideoPrompt } from '@/lib/detail-video-prompts';
import { createPendingGeneration, markGenerationCompleted, markGenerationFailed } from '@/lib/generation-store';
import { resultImageToBuffer } from '@/lib/image-source';
import { convertMp4ToGif } from '@/lib/video-to-gif';

export const runtime = 'nodejs';
export const maxDuration = 280;

// 저화질/저비용 우선 — 3초 안팎, 720p, 오디오 없음, 1개만 생성
const VIDEO_MODEL = 'veo-2.0-generate-001';
const POLL_INTERVAL_MS = 8000;
const MAX_POLL_ATTEMPTS = 30; // 8s * 30 = 240s, maxDuration(280s) 안에 여유있게 마무리

export async function POST(req: Request) {
  try {
    const { sourceImageBase64, detailInstruction, geminiApiKey } = await req.json();

    if (!sourceImageBase64) {
      return NextResponse.json({ success: false, error: '원단/디테일을 보여줄 기준 사진이 필요합니다.' }, { status: 400 });
    }
    if (!detailInstruction || typeof detailInstruction !== 'string' || !detailInstruction.trim()) {
      return NextResponse.json({ success: false, error: '어떤 디테일을 보여줄지 설명이 필요합니다.' }, { status: 400 });
    }
    const apiKey = geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ success: false, error: 'Gemini API 키가 필요합니다.' }, { status: 400 });
    }

    const prompt = buildDetailVideoPrompt(detailInstruction.trim());

    const generationId = await createPendingGeneration({
      pipeline: 'detail-video',
      modeOrCategory: 'detail-video',
      prompt: detailInstruction.trim(),
    });

    after(async () => {
      try {
        const { buffer: sourceBuf, mimeType: sourceMime } = await resultImageToBuffer(sourceImageBase64);
        const ai = new GoogleGenAI({ apiKey });

        let operation = await ai.models.generateVideos({
          model: VIDEO_MODEL,
          prompt,
          image: { imageBytes: sourceBuf.toString('base64'), mimeType: sourceMime },
          config: {
            numberOfVideos: 1,
            durationSeconds: 3,
            resolution: '720p',
            generateAudio: false,
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
