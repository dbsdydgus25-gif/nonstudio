/**
 * collections-store.ts
 * 히스토리 결과물을 사용자가 폴더(컬렉션)로 묶어 저장/정리할 수 있게 하는 저장소.
 *
 * DDL 없이 Supabase Storage의 JSON 한 파일(collections/index.json)로 관리한다 — 이유:
 * - 논피팅 Supabase는 현재 MCP/직접 PG 접속이 없어 ALTER TABLE을 코드로 못 돌린다(수기 적용
 *   대기 중인 마이그레이션도 있음). 폴더는 단일 계정(단일 모델) 기준 전역 데이터라 파일 하나로
 *   충분하고, 모델 프로필을 Storage JSON으로 두는 기존 패턴과도 일치한다.
 * - 폴더 멤버십은 generation_id 배열로만 들고, 이미지 실체는 generations 테이블/버킷 그대로 참조.
 */

import { getSupabaseAdmin, GENERATIONS_BUCKET } from './supabase';

const INDEX_PATH = 'collections/index.json';

export interface Collection {
  id: string;
  name: string;
  createdAt: string;
  /** 이 폴더에 담긴 generations.id 목록 (담은 순서 유지) */
  generationIds: string[];
}

interface CollectionsIndex {
  collections: Collection[];
}

function newId(): string {
  return `col_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function readIndex(): Promise<CollectionsIndex> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.from(GENERATIONS_BUCKET).download(INDEX_PATH);
    if (error || !data) return { collections: [] };
    const parsed = JSON.parse(await data.text());
    if (!parsed || !Array.isArray(parsed.collections)) return { collections: [] };
    return parsed as CollectionsIndex;
  } catch {
    return { collections: [] };
  }
}

async function writeIndex(index: CollectionsIndex): Promise<void> {
  const supabase = getSupabaseAdmin();
  const body = Buffer.from(JSON.stringify(index, null, 2), 'utf-8');
  const { error } = await supabase.storage
    .from(GENERATIONS_BUCKET)
    .upload(INDEX_PATH, body, { contentType: 'application/json', upsert: true });
  if (error) throw error;
}

export async function listCollections(): Promise<Collection[]> {
  const index = await readIndex();
  // 최근 생성 폴더가 위로
  return [...index.collections].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createCollection(name: string): Promise<Collection> {
  const trimmed = (name || '').trim() || '새 폴더';
  const index = await readIndex();
  const collection: Collection = {
    id: newId(),
    name: trimmed,
    createdAt: new Date().toISOString(),
    generationIds: [],
  };
  index.collections.push(collection);
  await writeIndex(index);
  return collection;
}

export async function renameCollection(id: string, name: string): Promise<void> {
  const index = await readIndex();
  const col = index.collections.find((c) => c.id === id);
  if (!col) throw new Error('폴더를 찾을 수 없습니다.');
  col.name = (name || '').trim() || col.name;
  await writeIndex(index);
}

export async function deleteCollection(id: string): Promise<void> {
  const index = await readIndex();
  index.collections = index.collections.filter((c) => c.id !== id);
  await writeIndex(index);
}

/** 폴더에 generation을 담거나(add) 뺀다(remove). 중복 없이 유지. */
export async function updateCollectionItems(
  id: string,
  generationIds: string[],
  action: 'add' | 'remove',
): Promise<Collection> {
  const index = await readIndex();
  const col = index.collections.find((c) => c.id === id);
  if (!col) throw new Error('폴더를 찾을 수 없습니다.');
  if (action === 'add') {
    // 담은 순서를 최대한 보존: 기존 순서 + 새로 추가된 것(중복 제외)
    col.generationIds = [...col.generationIds, ...generationIds.filter((g) => !col.generationIds.includes(g))];
  } else {
    const removeSet = new Set(generationIds);
    col.generationIds = col.generationIds.filter((g) => !removeSet.has(g));
  }
  await writeIndex(index);
  return col;
}
