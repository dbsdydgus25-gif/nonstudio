/**
 * identity-reference.ts
 * AI 피팅 — 사용자의 실제 몸/피부톤/얼굴 기준 사진(피팅 모델/피팅 모델 정보/1.png, Supabase에
 * restyle/seed_1.png로 시드되어 있음)을 매 생성마다 참고 이미지로 같이 넣는다.
 * 텍스트 스펙만으로는 매번 피부톤/체형이 미묘하게 흔들리므로, background-reference.ts와
 * 동일한 방식으로 실제 사진 한 장을 고정 기준으로 삼는다.
 * (실제 인물 사진이라 로컬 `피팅 모델/`은 .gitignore 처리되어 있고, Supabase 비공개 버킷에서 로드함)
 */

import { getSupabaseAdmin, GENERATIONS_BUCKET } from './supabase';

const IDENTITY_STORAGE_PATH = 'restyle/seed_1.png';

export async function getIdentityReferenceImage(): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.from(GENERATIONS_BUCKET).download(IDENTITY_STORAGE_PATH);
    if (error || !data) throw error;
    const arrayBuffer = await data.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), mimeType: 'image/png' };
  } catch (err) {
    console.warn('[identity-reference] 로드 실패 (참고 이미지 없이 진행):', err);
    return null;
  }
}
