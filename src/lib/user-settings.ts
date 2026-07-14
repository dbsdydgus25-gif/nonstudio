/**
 * user-settings.ts — 계정별 API 키 저장소.
 * localStorage 대신 Supabase Storage(비공개 버킷)의 users/{uid}/settings.json에 보관한다.
 * → 어떤 브라우저에서 로그인해도 같은 키가 따라오고, 브라우저 데이터를 지워도 유지된다.
 * (버킷은 비공개 + service_role로만 접근하므로 클라이언트에 직접 노출되지 않는다)
 */

import { getSupabaseAdmin, GENERATIONS_BUCKET } from './supabase';

export interface UserSettings {
  geminiKey: string;
  openaiKey: string;
  updatedAt: string | null;
}

const EMPTY_SETTINGS: UserSettings = { geminiKey: '', openaiKey: '', updatedAt: null };

function settingsPath(uid: string): string {
  return `users/${uid}/settings.json`;
}

export async function getUserSettings(uid: string): Promise<UserSettings> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage
      .from(GENERATIONS_BUCKET)
      .download(settingsPath(uid));
    if (error || !data) return EMPTY_SETTINGS;
    const parsed = JSON.parse(await data.text());
    return { ...EMPTY_SETTINGS, ...parsed };
  } catch {
    return EMPTY_SETTINGS;
  }
}

export async function saveUserSettings(
  uid: string,
  settings: Pick<UserSettings, 'geminiKey' | 'openaiKey'>,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const body = JSON.stringify(
    { geminiKey: settings.geminiKey, openaiKey: settings.openaiKey, updatedAt: new Date().toISOString() },
    null,
    2,
  );
  const { error } = await supabase.storage
    .from(GENERATIONS_BUCKET)
    .upload(settingsPath(uid), Buffer.from(body, 'utf-8'), {
      contentType: 'application/json',
      upsert: true,
    });
  if (error) throw error;
}
