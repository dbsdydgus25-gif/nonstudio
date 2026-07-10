/**
 * model-profile.ts
 * "윤용현 모델 정보"의 단일 저장소 — 참고 이미지 + 키/몸무게/신발 + 상세 체형 스펙 텍스트를
 * Supabase Storage(비공개 버킷)에 JSON + 이미지 파일로 저장한다.
 * AI 피팅 / AI 제품 피팅이 매 생성마다 여기서 읽어가므로, UI(모델 정보 페이지)에서 수정하면
 * 즉시 다음 생성부터 반영된다. (DB 테이블 대신 Storage JSON을 쓰는 이유: DDL 마이그레이션 없이
 * service role 키만으로 관리 가능 — 이 프로젝트 Supabase에는 MCP가 연결 안 되어 있어 DDL은
 * 항상 사용자가 대시보드에서 직접 실행해야 하는 마찰이 있음)
 *
 * 일관성에 대한 솔직한 한계: gpt-image-2는 seed가 없어 텍스트 스펙만으로는 체형이 매번 조금씩
 * 흔들린다. 가장 강한 고정 수단은 "전신이 나온 참고 이미지"다 — 상반신만 나온 사진은 다리
 * 길이/전체 비율 정보가 없어서 하체 체형이 흔들린다.
 */

import { getSupabaseAdmin, GENERATIONS_BUCKET } from './supabase';
import { PERSONAL_BODY_SPEC } from './fitting-prompts';

const PROFILE_JSON_PATH = 'model/profile.json';
const IDENTITY_IMAGE_PATH = 'model/identity_reference.png';
/** 예전부터 쓰던 기본 아이덴티티 사진 (상반신 실사) — 프로필에 이미지가 없을 때 폴백 */
const LEGACY_IDENTITY_PATH = 'restyle/seed_1.png';

export interface ModelProfile {
  name: string;
  heightCm: number;
  weightKg: number;
  shoeSizeMm: number;
  /** 체형/피부/디테일 상세 스펙 — 프롬프트에 그대로 들어가는 영어 텍스트 */
  specText: string;
  /** 참고 이미지가 업로드되어 있는지 (model/identity_reference.png 존재 여부) */
  hasCustomIdentityImage: boolean;
  updatedAt: string | null;
}

/** 코드에 박혀 있던 기존 스펙을 기본값으로 사용 — 프로필 저장 전에도 동작이 바뀌지 않도록 */
export const DEFAULT_MODEL_PROFILE: ModelProfile = {
  name: '윤용현',
  heightCm: 177,
  weightKg: 74,
  shoeSizeMm: 270,
  specText: PERSONAL_BODY_SPEC,
  hasCustomIdentityImage: false,
  updatedAt: null,
};

export async function getModelProfile(): Promise<ModelProfile> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.from(GENERATIONS_BUCKET).download(PROFILE_JSON_PATH);
    if (error || !data) return DEFAULT_MODEL_PROFILE;
    const parsed = JSON.parse(await data.text());
    return { ...DEFAULT_MODEL_PROFILE, ...parsed };
  } catch {
    return DEFAULT_MODEL_PROFILE;
  }
}

export async function saveModelProfile(profile: Omit<ModelProfile, 'updatedAt'>): Promise<void> {
  const supabase = getSupabaseAdmin();
  const body = JSON.stringify({ ...profile, updatedAt: new Date().toISOString() }, null, 2);
  const { error } = await supabase.storage
    .from(GENERATIONS_BUCKET)
    .upload(PROFILE_JSON_PATH, Buffer.from(body, 'utf-8'), { contentType: 'application/json', upsert: true });
  if (error) throw error;
}

/** 아이덴티티 참고 이미지 교체 (모델 정보 페이지에서 업로드) */
export async function saveIdentityImage(buffer: Buffer, mimeType: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.storage
    .from(GENERATIONS_BUCKET)
    .upload(IDENTITY_IMAGE_PATH, buffer, { contentType: mimeType, upsert: true });
  if (error) throw error;
}

/**
 * 생성 파이프라인용 — 프로필에 업로드된 참고 이미지가 있으면 그걸, 없으면 기존 seed_1을 쓴다.
 * (identity-reference.ts의 getIdentityReferenceImage를 대체)
 */
export async function getModelIdentityImage(): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const supabase = getSupabaseAdmin();
  for (const path of [IDENTITY_IMAGE_PATH, LEGACY_IDENTITY_PATH]) {
    try {
      const { data, error } = await supabase.storage.from(GENERATIONS_BUCKET).download(path);
      if (error || !data) continue;
      const arrayBuffer = await data.arrayBuffer();
      return { buffer: Buffer.from(arrayBuffer), mimeType: data.type || 'image/png' };
    } catch {
      continue;
    }
  }
  console.warn('[model-profile] 아이덴티티 참고 이미지 없음 — 텍스트 스펙만으로 진행');
  return null;
}

/** 프로필 스펙 텍스트 + 키/몸무게를 프롬프트용 블록으로 조립 */
export function buildBodySpecFromProfile(profile: ModelProfile): string {
  const header = `- Height ${profile.heightCm}cm, Weight ${profile.weightKg}kg, Shoe/foot size ${profile.shoeSizeMm}mm (Korean ${profile.shoeSizeMm} size).`;
  // specText에 이미 키/몸무게 라인이 들어있으면 중복 삽입하지 않는다
  const hasOwnHeader = /Height\s+\d+\s*cm/i.test(profile.specText);
  return hasOwnHeader ? profile.specText : `${header}\n${profile.specText}`;
}

/** 모델 정보 페이지 미리보기용 — 현재 참고 이미지의 서명 URL (1시간) */
export async function getIdentityImagePreviewUrl(): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  for (const path of [IDENTITY_IMAGE_PATH, LEGACY_IDENTITY_PATH]) {
    const { data } = await supabase.storage.from(GENERATIONS_BUCKET).createSignedUrl(path, 3600);
    if (data?.signedUrl) return data.signedUrl;
  }
  return null;
}
