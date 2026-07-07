/**
 * generation-store.ts
 * Supabase에 생성 결과를 기록하고, 승격된 "기준" 참고 이미지를 다음 생성 호출에 재사용하기 위한 헬퍼.
 * gpt-image-2는 seed가 없어 텍스트 프롬프트만으로는 결과가 흔들린다 — 사람이 고른 좋은 결과물을
 * 다음 이미지 입력(레퍼런스)으로 같이 넣어주는 방식으로 일관성을 보강한다.
 */

import { getSupabaseAdmin, GENERATIONS_BUCKET } from './supabase';

export type Pipeline = 'fitting' | 'restyle';

interface SaveGenerationInput {
  pipeline: Pipeline;
  modeOrCategory?: string;
  prompt: string;
  poseLabel?: string;
  referenceImageIds?: string[];
  outputBuffer: Buffer;
  outputMimeType: string;
}

function extFromMime(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  return 'jpg';
}

/** 생성된 이미지를 Storage에 올리고 generations 테이블에 기록. 실패해도 메인 파이프라인은 막지 않는다. */
export async function saveGeneration(input: SaveGenerationInput): Promise<string | null> {
  try {
    const supabase = getSupabaseAdmin();
    const path = `${input.pipeline}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extFromMime(input.outputMimeType)}`;

    const { error: uploadError } = await supabase.storage
      .from(GENERATIONS_BUCKET)
      .upload(path, input.outputBuffer, { contentType: input.outputMimeType, upsert: false });
    if (uploadError) throw uploadError;

    const { data, error: insertError } = await supabase
      .from('generations')
      .insert({
        pipeline: input.pipeline,
        mode_or_category: input.modeOrCategory,
        prompt: input.prompt,
        pose_label: input.poseLabel,
        reference_image_ids: input.referenceImageIds ?? [],
        output_storage_path: path,
      })
      .select('id')
      .single();
    if (insertError) throw insertError;

    return data.id as string;
  } catch (err) {
    console.warn('[generation-store] saveGeneration 실패 (기록만 실패, 생성 자체는 정상 진행):', err);
    return null;
  }
}

interface CreatePendingGenerationInput {
  pipeline: Pipeline;
  modeOrCategory?: string;
  poseLabel?: string;
  /** 생성 시점에 이미 알고 있는 프롬프트(문자열). 아직 모르면 빈 문자열로 두고 완료 시 채운다. */
  prompt: string;
}

/**
 * 실제 이미지 생성 전에 "처리 중" 상태로 행을 먼저 만든다 — 비동기 작업 아키텍처의 핵심.
 * gpt-image-2 호출이 90~100초 걸려서 클라이언트가 응답을 기다리는 동안 연결이 끊기거나
 * Vercel 함수가 죽으면 원인을 알 수 없는 에러만 남았는데, 이제 요청을 받자마자 이 pending
 * 행의 id를 즉시 반환하고, 실제 생성은 `after()`로 응답 이후 백그라운드에서 진행한다.
 * 프론트는 이 id로 /api/generations/status를 폴링해서 완료 여부를 확인한다.
 */
export async function createPendingGeneration(input: CreatePendingGenerationInput): Promise<string> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('generations')
    .insert({
      pipeline: input.pipeline,
      mode_or_category: input.modeOrCategory,
      prompt: input.prompt,
      pose_label: input.poseLabel,
      reference_image_ids: [],
      output_storage_path: '',
      status: 'pending',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

/** 백그라운드 생성이 끝나면 결과 이미지를 업로드하고 상태를 completed로 갱신. */
export async function markGenerationCompleted(
  generationId: string,
  input: { outputBuffer: Buffer; outputMimeType: string; prompt?: string },
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const path = `restyle/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extFromMime(input.outputMimeType)}`;

  const { error: uploadError } = await supabase.storage
    .from(GENERATIONS_BUCKET)
    .upload(path, input.outputBuffer, { contentType: input.outputMimeType, upsert: false });
  if (uploadError) throw uploadError;

  const update: { output_storage_path: string; status: 'completed'; prompt?: string } = {
    output_storage_path: path,
    status: 'completed',
  };
  if (input.prompt) update.prompt = input.prompt;

  const { error: updateError } = await supabase.from('generations').update(update).eq('id', generationId);
  if (updateError) throw updateError;
}

/** 백그라운드 생성이 실패하면 상태를 failed로 남겨서 프론트가 폴링 중 에러를 알 수 있게 한다. */
export async function markGenerationFailed(generationId: string, errorMessage: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  await supabase
    .from('generations')
    .update({ status: 'failed', error_message: errorMessage.slice(0, 500) })
    .eq('id', generationId);
}

export interface GenerationStatusItem {
  id: string;
  status: 'pending' | 'completed' | 'failed';
  imageUrl: string | null;
  prompt: string;
  poseLabel: string | null;
  errorMessage: string | null;
}

/** 폴링용 — 여러 generationId의 현재 상태를 한 번에 조회 (완료된 것만 서명된 URL 발급). */
export async function getGenerationStatuses(ids: string[]): Promise<GenerationStatusItem[]> {
  if (ids.length === 0) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('generations')
    .select('id, status, output_storage_path, prompt, pose_label, error_message')
    .in('id', ids);
  if (error) throw error;

  const results: GenerationStatusItem[] = [];
  for (const row of data || []) {
    const r = row as any;
    let imageUrl: string | null = null;
    if (r.status === 'completed' && r.output_storage_path) {
      const { data: signed } = await supabase.storage
        .from(GENERATIONS_BUCKET)
        .createSignedUrl(r.output_storage_path, 3600);
      imageUrl = signed?.signedUrl ?? null;
    }
    results.push({
      id: r.id,
      status: r.status ?? 'pending',
      imageUrl,
      prompt: r.prompt ?? '',
      poseLabel: r.pose_label ?? null,
      errorMessage: r.error_message ?? null,
    });
  }
  return results;
}

/** 좋아요/싫어요 평가 저장. */
export async function rateGeneration(generationId: string, rating: 'good' | 'bad', note?: string) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('generations')
    .update({ rating, rating_note: note ?? null })
    .eq('id', generationId);
  if (error) throw error;
}

export interface GenerationHistoryItem {
  id: string;
  imageUrl: string;
  prompt: string;
  poseLabel: string | null;
  createdAt: string;
}

/**
 * 최근 생성 기록 조회 (히스토리 화면용) — 페이지를 나갔다 들어와도 이전 결과를 볼 수 있도록
 * React state 대신 Supabase에서 직접 불러온다. 이미지는 비공개 버킷이라 서명된 URL로 반환.
 */
export async function listRecentGenerations(source: 'fitting' | 'variation', limit = 24): Promise<GenerationHistoryItem[]> {
  try {
    const supabase = getSupabaseAdmin();
    let query = supabase
      .from('generations')
      .select('id, output_storage_path, prompt, pose_label, mode_or_category, created_at')
      .eq('pipeline', 'restyle')
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(limit);
    query = source === 'variation' ? query.eq('mode_or_category', 'variation') : query.neq('mode_or_category', 'variation');

    const { data, error } = await query;
    if (error) throw error;

    const results: GenerationHistoryItem[] = [];
    for (const row of data || []) {
      const { data: signed, error: signErr } = await supabase.storage
        .from(GENERATIONS_BUCKET)
        .createSignedUrl((row as any).output_storage_path, 3600);
      if (signErr || !signed) continue;
      results.push({
        id: (row as any).id,
        imageUrl: signed.signedUrl,
        prompt: (row as any).prompt,
        poseLabel: (row as any).pose_label,
        createdAt: (row as any).created_at,
      });
    }
    return results;
  } catch (err) {
    console.warn('[generation-store] listRecentGenerations 실패 (히스토리 없이 진행):', err);
    return [];
  }
}

