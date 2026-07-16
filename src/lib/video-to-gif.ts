/**
 * video-to-gif.ts
 * 디테일컷 영상(mp4)을 서버에서 바로 GIF로 변환한다 — 대표님이 캡컷 등으로 따로
 * 변환할 필요 없이 생성 즉시 GIF로 저장/다운로드할 수 있게 하기 위함.
 *
 * mp4는 컨테이너 구조상(moov atom 위치) stdin 파이프로 안전하게 스트리밍 디코딩되지
 * 않는 경우가 많아, 입력은 /tmp에 임시 파일로 써서 ffmpeg가 seek 가능하게 하고,
 * 출력(GIF)은 stdout 파이프로 바로 받는다 — 임시 출력 파일을 따로 안 만들어도 됨.
 */

import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ffmpegPath from 'ffmpeg-static';

/**
 * @param mp4Buffer 원본 영상
 * @param opts.fps 프레임레이트 (기본 10 — GIF는 fps를 낮춰야 파일 용량이 감당할 만해짐)
 * @param opts.width 가로 픽셀 (기본 480 — 숏폼 미리보기/GIF 용도로 충분, 고화질 불필요)
 */
export async function convertMp4ToGif(
  mp4Buffer: Buffer,
  opts: { fps?: number; width?: number } = {},
): Promise<Buffer> {
  if (!ffmpegPath) throw new Error('ffmpeg-static 바이너리를 찾을 수 없습니다.');

  const { fps = 10, width = 480 } = opts;
  const tmpInputPath = path.join(os.tmpdir(), `detail-video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);
  await writeFile(tmpInputPath, mp4Buffer);

  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const args = [
        '-i', tmpInputPath,
        '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos`,
        '-f', 'gif',
        'pipe:1',
      ];
      const proc = spawn(ffmpegPath as string, args);

      const chunks: Buffer[] = [];
      let stderr = '';
      proc.stdout.on('data', (chunk) => chunks.push(chunk));
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg 종료 코드 ${code}: ${stderr.slice(-500)}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
  } finally {
    await unlink(tmpInputPath).catch(() => {});
  }
}
