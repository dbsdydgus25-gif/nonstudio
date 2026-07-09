/**
 * pose-reference.ts
 * AI 바리에이션 — 텍스트 포즈 지시만으로는 매번 각도/프레이밍이 미묘하게 흔들려서, 사용자가
 * 직접 고른 포즈 참고 사진이 있으면 같이 참고 이미지로 넣어 포즈를 훨씬 일관되게 고정한다.
 * `public/reference_poses/pose_1.png`, `pose_2.png` ... 파일명 숫자가 fitting-prompts.ts의
 * FULLBODY_POSES 배열 순서(1부터 시작)와 그대로 대응한다. 파일이 없으면 조용히 건너뛰고
 * 텍스트 포즈 지시만으로 진행한다 — 아직 아무 사진도 없어도 기존 동작 그대로 동작함.
 * (기존에 있던 `public/reference_poses/` 폴더 — 구 파이프라인이 쓰던 상의/전신/하의
 * 하위폴더가 이미 있던 자리 — 를 그대로 재사용한다. 새 `public/poses/`를 따로 만들지 않음.)
 */

import fs from 'fs';
import path from 'path';

const POSE_REFERENCE_DIR = path.join(process.cwd(), 'public', 'reference_poses');

export function getPoseReferenceImage(poseNumber: number): { buffer: Buffer; mimeType: string } | null {
  const filePath = path.join(POSE_REFERENCE_DIR, `pose_${poseNumber}.png`);
  if (!fs.existsSync(filePath)) return null;
  return { buffer: fs.readFileSync(filePath), mimeType: 'image/png' };
}
