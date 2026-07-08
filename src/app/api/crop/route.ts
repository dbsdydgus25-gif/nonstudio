/**
 * /api/crop/route.ts
 * 생성된 결과 이미지를 정해진 비율(정사각형/세로 등) 또는 사용자가 직접 지정한 영역으로
 * 크롭해서 다운로드용으로 반환. OpenAI 호스팅 URL은 브라우저 canvas에서 CORS 문제가 날 수
 * 있어 서버에서 직접 크롭한다.
 */

import { NextResponse } from 'next/server';
import sharp from 'sharp';

export const runtime = 'nodejs';

const RATIOS: Record<string, number> = {
  '1:1': 1 / 1,
  '4:5': 4 / 5,
  '3:4': 3 / 4,
  '9:16': 9 / 16,
};

async function loadImageBuffer(imageUrl: string): Promise<Buffer> {
  if (imageUrl.startsWith('data:')) {
    const base64 = imageUrl.split(',')[1] || '';
    return Buffer.from(base64, 'base64');
  }
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`이미지 다운로드 실패 (status ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function POST(req: Request) {
  try {
    const { imageUrl, ratio, region } = await req.json();

    if (!imageUrl) {
      return NextResponse.json({ error: 'imageUrl이 필요합니다.' }, { status: 400 });
    }

    const inputBuffer = await loadImageBuffer(imageUrl);
    const image = sharp(inputBuffer);
    const meta = await image.metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    if (!width || !height) {
      return NextResponse.json({ error: '이미지 크기를 읽을 수 없습니다.' }, { status: 500 });
    }

    let left: number;
    let top: number;
    let cropWidth: number;
    let cropHeight: number;
    let filenameTag: string;

    if (region && typeof region.x === 'number') {
      // 사용자가 직접 지정한 영역 (0~1 비율 좌표, 프론트의 크롭 도구에서 전달)
      left = Math.round(region.x * width);
      top = Math.round(region.y * height);
      cropWidth = Math.round(region.width * width);
      cropHeight = Math.round(region.height * height);
      // 경계 보정
      left = Math.max(0, Math.min(left, width - 1));
      top = Math.max(0, Math.min(top, height - 1));
      cropWidth = Math.max(1, Math.min(cropWidth, width - left));
      cropHeight = Math.max(1, Math.min(cropHeight, height - top));
      filenameTag = 'custom';
    } else {
      const targetRatio = RATIOS[ratio];
      if (!targetRatio) {
        return NextResponse.json({ error: `지원하지 않는 비율입니다: ${ratio}` }, { status: 400 });
      }
      // 원본 안에서 목표 비율에 맞는 가장 큰 영역을 가운데 기준으로 잘라낸다 (해상도 손실 최소화)
      cropWidth = width;
      cropHeight = Math.round(width / targetRatio);
      if (cropHeight > height) {
        cropHeight = height;
        cropWidth = Math.round(height * targetRatio);
      }
      left = Math.round((width - cropWidth) / 2);
      top = Math.round((height - cropHeight) / 2);
      filenameTag = ratio.replace(':', 'x');
    }

    const outputBuffer = await image
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .png()
      .toBuffer();

    // (2026-07-09) raw binary Response로 반환했더니 프로덕션에서 간헐적으로 "손상된 파일"
    // 다운로드가 발생했다 — 원인은 정확히 특정 못했지만(로컬 재현 실패), 프록시/스트리밍 경로에서
    // 바이너리 응답이 깨질 여지가 있는 것으로 보고 base64 JSON 응답으로 바꿔 근본적으로 우회한다.
    const dataUrl = `data:image/png;base64,${outputBuffer.toString('base64')}`;
    return NextResponse.json({ success: true, dataUrl, filenameTag });
  } catch (err: any) {
    console.error('[api/crop] 처리 실패:', err);
    return NextResponse.json({ error: err.message || '크롭 처리 중 오류가 발생했습니다.' }, { status: 500 });
  }
}
