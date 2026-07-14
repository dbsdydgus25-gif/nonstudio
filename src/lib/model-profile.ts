/**
 * model-profile.ts
 * 모델 정보(참고 이미지 + 키/몸무게/신발 + 상세 체형 스펙 텍스트)의 단일 저장소.
 * 로그인 계정(uid)별로 Supabase Storage(비공개 버킷) users/{uid}/model/ 아래에 저장한다.
 * AI 피팅 / AI 제품 피팅이 매 생성마다 여기서 읽어가므로, UI(모델 정보 페이지)에서 수정하면
 * 즉시 다음 생성부터 반영된다.
 *
 * 마이그레이션: 로그인 도입 전에 쓰던 전역 경로(model/profile.json, model/identity_reference.png)는
 * 읽기 폴백으로 유지 — nonfitting 계정이 처음 로그인해도 기존 윤용현 정보가 그대로 보이고,
 * 첫 저장부터 계정 경로에 기록된다.
 *
 * 일관성에 대한 솔직한 한계: gpt-image-2는 seed가 없어 텍스트 스펙만으로는 체형이 매번 조금씩
 * 흔들린다. 가장 강한 고정 수단은 "전신이 나온 참고 이미지"다.
 */

import { getSupabaseAdmin, GENERATIONS_BUCKET } from './supabase';
import { PERSONAL_BODY_SPEC } from './fitting-prompts';

/** 로그인 도입 전 전역 경로 (읽기 폴백용) */
const GLOBAL_PROFILE_JSON_PATH = 'model/profile.json';
const GLOBAL_IDENTITY_IMAGE_PATH = 'model/identity_reference.png';
/** 예전부터 쓰던 기본 아이덴티티 사진 (상반신 실사) — 최후 폴백 */
const LEGACY_IDENTITY_PATH = 'restyle/seed_1.png';
/**
 * 전역(구) 경로 폴백은 로그인 도입 전 데이터의 원 소유자인 nonfitting 계정에만 적용한다 —
 * 모든 계정에 폴백을 열면 신규 계정이 윤용현 모델을 물려받아 "모델 먼저 만들기" 관문이
 * 무력화되고 남의 모델로 생성하게 되는 문제가 있음 (2026-07-14 테스트 계정으로 실제 확인).
 */
const LEGACY_OWNER_UID = '2bdbdfee-e3a6-425a-aca8-c8b8826faf08';

function profileFallbackPaths(uid: string): string[] {
  return uid === LEGACY_OWNER_UID
    ? [profileJsonPath(uid), GLOBAL_PROFILE_JSON_PATH]
    : [profileJsonPath(uid)];
}
function identityFallbackPaths(uid: string): string[] {
  return uid === LEGACY_OWNER_UID
    ? [identityImagePath(uid), GLOBAL_IDENTITY_IMAGE_PATH, LEGACY_IDENTITY_PATH]
    : [identityImagePath(uid)];
}

function profileJsonPath(uid: string): string {
  return `users/${uid}/model/profile.json`;
}
function identityImagePath(uid: string): string {
  return `users/${uid}/model/identity_reference.png`;
}
/** 가상 모델 생성 시 저장되는 추가 뷰(뒤/좌/우) 경로 */
export function viewImagePath(uid: string, view: 'back' | 'left' | 'right'): string {
  return `users/${uid}/model/view_${view}.png`;
}

/** 가상 모델 빌더 진행 상태 — 'building'이면 뷰 4컷 생성 중, 'ready'면 사용 가능 */
export type ModelBuilderStatus = 'building' | 'ready' | 'failed';

export interface ModelProfile {
  name: string;
  heightCm: number;
  weightKg: number;
  shoeSizeMm: number;
  /** 체형/피부/디테일 상세 스펙 — 프롬프트에 그대로 들어가는 텍스트 (백엔드 전용, UI엔 요약만 노출) */
  specText: string;
  /** 참고 이미지가 업로드되어 있는지 */
  hasCustomIdentityImage: boolean;
  updatedAt: string | null;
  // ── 가상 모델 빌더 필드 (2026-07-14 추가, 전부 옵셔널 — 레거시 프로필과 호환) ──
  gender?: 'male' | 'female';
  age?: number;
  /** 사용자가 입력한 신체 특징 원문 (피부톤/털/핏줄/상처 등, 한국어) — 요약 표시용 */
  featuresText?: string;
  /** 외모 프리셋 라벨 또는 직접 입력 원문 — 요약 표시용 */
  appearanceText?: string;
  builderStatus?: ModelBuilderStatus;
  builderError?: string | null;
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

export async function getModelProfile(uid: string): Promise<ModelProfile> {
  const supabase = getSupabaseAdmin();
  for (const path of profileFallbackPaths(uid)) {
    try {
      const { data, error } = await supabase.storage.from(GENERATIONS_BUCKET).download(path);
      if (error || !data) continue;
      const parsed = JSON.parse(await data.text());
      return { ...DEFAULT_MODEL_PROFILE, ...parsed };
    } catch {
      continue;
    }
  }
  return DEFAULT_MODEL_PROFILE;
}

export async function saveModelProfile(
  uid: string,
  profile: Omit<ModelProfile, 'updatedAt'>,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const body = JSON.stringify({ ...profile, updatedAt: new Date().toISOString() }, null, 2);
  const { error } = await supabase.storage
    .from(GENERATIONS_BUCKET)
    .upload(profileJsonPath(uid), Buffer.from(body, 'utf-8'), {
      contentType: 'application/json',
      upsert: true,
    });
  if (error) throw error;
}

/** 아이덴티티 참고 이미지 교체 (모델 정보 페이지에서 업로드) */
export async function saveIdentityImage(uid: string, buffer: Buffer, mimeType: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.storage
    .from(GENERATIONS_BUCKET)
    .upload(identityImagePath(uid), buffer, { contentType: mimeType, upsert: true });
  if (error) throw error;
}

/**
 * 생성 파이프라인용 — 계정 이미지 → 전역(구) 이미지 → 레거시 seed 순으로 찾는다.
 */
export async function getModelIdentityImage(
  uid: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const supabase = getSupabaseAdmin();
  for (const path of identityFallbackPaths(uid)) {
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
export async function getIdentityImagePreviewUrl(uid: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  for (const path of identityFallbackPaths(uid)) {
    const { data } = await supabase.storage.from(GENERATIONS_BUCKET).createSignedUrl(path, 3600);
    if (data?.signedUrl) return data.signedUrl;
  }
  return null;
}

/** 가상 모델 빌더가 만든 뷰(뒤/좌/우) 미리보기 URL — 없는 뷰는 null */
export async function getViewImagePreviewUrls(
  uid: string,
): Promise<Record<'back' | 'left' | 'right', string | null>> {
  const supabase = getSupabaseAdmin();
  const result: Record<'back' | 'left' | 'right', string | null> = { back: null, left: null, right: null };
  for (const view of ['back', 'left', 'right'] as const) {
    const { data } = await supabase.storage
      .from(GENERATIONS_BUCKET)
      .createSignedUrl(viewImagePath(uid, view), 3600);
    result[view] = data?.signedUrl ?? null;
  }
  return result;
}

/** 뷰 이미지 저장 (가상 모델 빌더 confirm 단계) */
export async function saveViewImage(
  uid: string,
  view: 'back' | 'left' | 'right',
  buffer: Buffer,
  mimeType: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.storage
    .from(GENERATIONS_BUCKET)
    .upload(viewImagePath(uid, view), buffer, { contentType: mimeType, upsert: true });
  if (error) throw error;
}
