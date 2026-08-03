#!/usr/bin/env node
/**
 * 1회성 스크립트 — 사업운영/.env의 현재 CAFE24_ACCESS_TOKEN/REFRESH_TOKEN을
 * 논피팅 앱의 Supabase Storage(system/cafe24-token.json)로 옮긴다.
 * 이후로는 Vercel Cron(morning-agenda)이 이 저장소를 읽고/갱신한다.
 * 값은 로컬 파일 → 로컬 네트워크 호출로만 이동하며 콘솔에 출력하지 않는다.
 *
 * 실행: node scripts/seed-cafe24-token.mjs
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function parseEnv(path) {
  return Object.fromEntries(
    readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );
}

const appEnv = parseEnv(new URL('../.env.local', import.meta.url));
const bizEnv = parseEnv('/Users/daniel/Desktop/논 스튜디오/논 스튜디오/사업운영/.env');

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = appEnv;
const { CAFE24_ACCESS_TOKEN, CAFE24_REFRESH_TOKEN } = bizEnv;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('논피팅 앱 .env.local에 SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY가 없습니다.');
  process.exit(1);
}
if (!CAFE24_REFRESH_TOKEN) {
  console.error('사업운영/.env에 CAFE24_REFRESH_TOKEN이 없습니다.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const BUCKET = 'nonstudio-generations';
const PATH = 'system/cafe24-token.json';

const body = JSON.stringify(
  {
    access_token: CAFE24_ACCESS_TOKEN || '',
    refresh_token: CAFE24_REFRESH_TOKEN,
    // 즉시 만료 취급 → morning-agenda 첫 실행 때 바로 갱신부터 하고 시작
    expires_at: new Date(0).toISOString(),
  },
  null,
  2,
);

const { error } = await supabase.storage
  .from(BUCKET)
  .upload(PATH, Buffer.from(body, 'utf-8'), { contentType: 'application/json', upsert: true, cacheControl: '0' });

if (error) {
  console.error('시딩 실패:', error.message);
  process.exit(1);
}
console.log(`✅ 시딩 완료 — ${BUCKET}/${PATH} (값은 출력하지 않음)`);
