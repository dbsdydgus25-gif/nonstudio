/**
 * background-reference.ts
 * AI 피팅 / AI 바리에이션 공통 — 배경 지시가 없을 때 항상 이 실제 사진(스튜디오 배경/조명 기준)을
 * 참고 이미지로 같이 넣는다. 텍스트 설명만으로는 매번 배경/조명이 살짝씩 달라지므로
 * 실제 사진 한 장을 고정 기준으로 삼는다.
 */

import fs from 'fs';
import path from 'path';

const DEFAULT_BACKGROUND_IMAGE_PATH = path.join(process.cwd(), 'public', 'backgrounds', 'default_white_studio.png');

export function getDefaultBackgroundReferenceImage(): { buffer: Buffer; mimeType: string } | null {
  if (!fs.existsSync(DEFAULT_BACKGROUND_IMAGE_PATH)) return null;
  return { buffer: fs.readFileSync(DEFAULT_BACKGROUND_IMAGE_PATH), mimeType: 'image/png' };
}
