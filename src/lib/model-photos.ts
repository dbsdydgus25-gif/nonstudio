/**
 * model-photos.ts
 * 피팅 베이스 모델 사진(public/models/) 로더.
 * 로컬 개발 환경엔 파일이 실제로 있어서 디스크에서 바로 읽고,
 * 배포 환경(Vercel)엔 이 사진들이 git에 없어서(개인정보 보호를 위해 의도적으로 제외) Supabase Storage에서 받아온다.
 * 로컬/배포 어느 쪽이든 같은 원본 파일을 쓰도록 해서 결과물이 동일하게 나오도록 하는 것이 목적.
 */

import fs from 'fs';
import path from 'path';
import { getSupabaseAdmin } from './supabase';

export const MODEL_PHOTOS_BUCKET = 'nonstudio-models';

function localModelsDir(): string {
  return path.join(process.cwd(), 'public', 'models');
}

function mimeTypeFromName(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
}

/** 파일명 목록만 반환 (기존 코드의 정규식 매칭 로직이 파일명 문자열을 그대로 씀). */
export async function listModelPhotoNames(): Promise<string[]> {
  const dir = localModelsDir();
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.') && /\.(png|jpe?g|webp)$/i.test(f));
    if (files.length > 0) return files;
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.storage.from(MODEL_PHOTOS_BUCKET).list();
  if (error) throw new Error(`Supabase 모델 사진 목록 조회 실패: ${error.message}`);
  return (data || [])
    .filter((f) => !f.name.startsWith('.') && /\.(png|jpe?g|webp)$/i.test(f.name))
    .map((f) => f.name);
}

/** 파일명으로 실제 바이트를 가져온다 — 로컬 우선, 없으면(배포 환경) Supabase에서. */
export async function getModelPhotoBuffer(name: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const localPath = path.join(localModelsDir(), name);
  const mimeType = mimeTypeFromName(name);

  if (fs.existsSync(localPath)) {
    return { buffer: fs.readFileSync(localPath), mimeType };
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.storage.from(MODEL_PHOTOS_BUCKET).download(name);
  if (error) throw new Error(`Supabase 모델 사진 다운로드 실패 (${name}): ${error.message}`);
  const arrayBuffer = await data.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}

/** Replicate IDM-VTON 등 base64 data URL이 필요한 곳에서 사용. */
export async function getModelPhotoBase64(name: string): Promise<string> {
  const { buffer, mimeType } = await getModelPhotoBuffer(name);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}
