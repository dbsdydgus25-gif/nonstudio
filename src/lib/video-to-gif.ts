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
 * (2026-07-22) 팔레트 최적화 도입.
 * 이전엔 `-vf fps,scale`만 걸고 GIF로 뽑았는데, 그러면 ffmpeg가 고정 기본 팔레트를 써서
 * 화면 전체에 모래알 같은 디더링 노이즈가 끼고 색이 뜬다 — 실제 결과물에서 벽면이 사포처럼
 * 보이고 네이비가 회색빛으로 바랬다. AI 영상의 목적 자체가 "원단 질감을 보여주는 것"이라
 * 이건 치명적이라, 영상에서 팔레트를 뽑아 적용하는 2-pass 방식(palettegen/paletteuse)으로
 * 바꿨다. 용량은 약 2.4MB → 4.3MB로 늘지만 질감/색 정확도가 확연히 좋아진다.
 *
 * @param mp4Buffer 원본 영상
 * @param opts.fps 프레임레이트 (기본 10 — GIF는 fps를 낮춰야 파일 용량이 감당할 만해짐)
 * @param opts.width 가로 픽셀 (기본 480 — 숏폼 미리보기/GIF 용도로 충분, 고화질 불필요)
 * @param opts.maxColors 팔레트 색 수 (기본 128 — 256색 대비 용량 20% 절감, 육안 차이 거의 없음)
 */
export async function convertMp4ToGif(
  mp4Buffer: Buffer,
  opts: { fps?: number; width?: number; maxColors?: number } = {},
): Promise<Buffer> {
  if (!ffmpegPath) throw new Error('ffmpeg-static 바이너리를 찾을 수 없습니다.');

  const { fps = 10, width = 480, maxColors = 128 } = opts;
  const tmpInputPath = path.join(os.tmpdir(), `detail-video-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`);
  await writeFile(tmpInputPath, mp4Buffer);

  try {
    return await new Promise<Buffer>((resolve, reject) => {
      // split으로 스트림을 둘로 나눠, 한쪽에서 팔레트를 만들고 다른 쪽에 적용한다(2-pass를
      // 한 번의 호출로 처리). bayer 디더링은 그라데이션에서 밴딩이 덜하고 용량도 안정적이다.
      const filter =
        `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];` +
        `[s0]palettegen=max_colors=${maxColors}[p];` +
        `[s1][p]paletteuse=dither=bayer:bayer_scale=4`;
      const args = [
        '-i', tmpInputPath,
        '-filter_complex', filter,
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
