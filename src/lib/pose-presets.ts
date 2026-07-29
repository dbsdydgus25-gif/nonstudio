/**
 * pose-presets.ts
 * AI 룩북의 "포즈 프리셋 라이브러리" 저장소 — 대표님이 한 번 등록해두고 계속 재사용하는
 * 이름 붙은 포즈들. model-profile.ts와 같은 Supabase Storage(비공개 버킷) JSON 패턴을 쓴다.
 *
 * model-profile은 계정당 딱 하나(싱글턴)라 파일 하나면 끝이지만, 프리셋은 여러 개라
 * 목록 파일(index.json) + 프리셋별 참고사진(선택)으로 나눈다. 개수가 수십 개 수준이라
 * 별도 Postgres 테이블까지는 만들지 않는다(마이그레이션은 사용자가 대시보드에서 직접
 * 실행해야 하는 프로젝트라, 테이블을 늘리지 않는 쪽이 실제로 더 싸다).
 */

import { getSupabaseAdmin, GENERATIONS_BUCKET } from './supabase';
import type { SourcedCategory } from './fitting-prompts';

export interface PosePreset {
  id: string;
  /** 대표님이 붙인 이름 (예: "정면 주머니 손", "쿼터턴 뒷모습") */
  name: string;
  /** 실제 프롬프트에 들어가는 포즈 지시문 */
  poseInstruction: string;
  /** 참고 사진(포즈 예시)이 함께 저장되어 있는지 */
  hasRefImage: boolean;
  /**
   * 어느 소싱 카테고리용 포즈인지 — 신발 촬영용 포즈와 상의 촬영용 포즈는 프레이밍도
   * 자세도 완전히 다르므로 섞이면 안 된다. 구버전 프리셋은 'top'으로 폴백.
   */
  slot: SourcedCategory;
  /** 전신샷인지 클로즈업인지 — 구버전 프리셋은 'full'로 폴백 */
  framing: 'full' | 'close';
  createdAt: string;
}

/** 구버전(필드 없던 시절) 프리셋도 안전하게 읽히도록 기본값을 채운다 */
function normalizePreset(p: any): PosePreset {
  return {
    id: p.id,
    name: p.name,
    poseInstruction: p.poseInstruction,
    hasRefImage: !!p.hasRefImage,
    slot: p.slot || 'top',
    framing: p.framing === 'close' ? 'close' : 'full',
    createdAt: p.createdAt || new Date(0).toISOString(),
  };
}

function indexPath(uid: string): string {
  return `users/${uid}/pose-presets/index.json`;
}
function refImagePath(uid: string, presetId: string): string {
  return `users/${uid}/pose-presets/${presetId}.png`;
}

export async function listPosePresets(uid: string): Promise<PosePreset[]> {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase.storage.from(GENERATIONS_BUCKET).download(indexPath(uid));
    if (error || !data) return [];
    const parsed = JSON.parse(await data.text());
    return Array.isArray(parsed?.presets) ? parsed.presets.map(normalizePreset) : [];
  } catch {
    return [];
  }
}

async function writeIndex(uid: string, presets: PosePreset[]): Promise<void> {
  const supabase = getSupabaseAdmin();
  const body = JSON.stringify({ presets }, null, 2);
  const { error } = await supabase.storage
    .from(GENERATIONS_BUCKET)
    .upload(indexPath(uid), Buffer.from(body, 'utf-8'), {
      contentType: 'application/json',
      upsert: true,
    });
  if (error) throw error;
}

export async function addPosePreset(
  uid: string,
  input: {
    name: string;
    poseInstruction: string;
    slot: SourcedCategory;
    framing: 'full' | 'close';
    refImage?: { buffer: Buffer; mimeType: string };
  },
): Promise<PosePreset> {
  const supabase = getSupabaseAdmin();
  const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (input.refImage) {
    const { error } = await supabase.storage
      .from(GENERATIONS_BUCKET)
      .upload(refImagePath(uid, id), input.refImage.buffer, {
        contentType: input.refImage.mimeType,
        upsert: true,
      });
    if (error) throw error;
  }

  const preset: PosePreset = {
    id,
    name: input.name.trim(),
    poseInstruction: input.poseInstruction.trim(),
    hasRefImage: !!input.refImage,
    slot: input.slot,
    framing: input.framing,
    createdAt: new Date().toISOString(),
  };
  const presets = await listPosePresets(uid);
  await writeIndex(uid, [...presets, preset]);
  return preset;
}

export async function deletePosePreset(uid: string, presetId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const presets = await listPosePresets(uid);
  const target = presets.find((p) => p.id === presetId);
  // 참고사진 삭제 실패는 무시 — 목록에서 사라지는 게 사용자에게 보이는 결과이고,
  // 고아 파일이 남아도 기능상 해가 없다(다음 업로드가 upsert로 덮어씀).
  if (target?.hasRefImage) {
    try {
      await supabase.storage.from(GENERATIONS_BUCKET).remove([refImagePath(uid, presetId)]);
    } catch {
      /* 무시 */
    }
  }
  await writeIndex(
    uid,
    presets.filter((p) => p.id !== presetId),
  );
}

/** UI 미리보기용 서명 URL (1시간) — 참고사진이 없으면 null */
export async function getPosePresetRefUrl(uid: string, presetId: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.storage
    .from(GENERATIONS_BUCKET)
    .createSignedUrl(refImagePath(uid, presetId), 3600);
  return data?.signedUrl ?? null;
}

/** 생성 파이프라인용 — 프리셋 참고사진 원본 버퍼 */
export async function getPosePresetRefImage(
  uid: string,
  presetId: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const supabase = getSupabaseAdmin();
  try {
    const { data, error } = await supabase.storage
      .from(GENERATIONS_BUCKET)
      .download(refImagePath(uid, presetId));
    if (error || !data) return null;
    return { buffer: Buffer.from(await data.arrayBuffer()), mimeType: data.type || 'image/png' };
  } catch {
    return null;
  }
}
