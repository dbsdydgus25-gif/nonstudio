import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const envPath = path.join(process.cwd(), '.env.local');
const envText = fs.readFileSync(envPath, 'utf-8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const BUCKET = 'nonstudio-generations';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// 피팅 모델 정보 폴더 — 1~4.png(원본 정체성 사진) + AI_Fitting_Result(5~7).png(사용자가 직접 고른 좋은 결과물)
const sourceDir = path.join(process.cwd(), '피팅 모델', '피팅 모델 정보');
const files = [
  { name: '1.png', label: '정체성 기준 사진 #1' },
  { name: '2.png', label: '정체성 기준 사진 #2' },
  { name: '3.png', label: '정체성 기준 사진 #3' },
  { name: '4.png', label: '정체성 기준 사진 #4' },
  { name: 'AI_Fitting_Result (5).png', label: 'AI 피팅 승인 결과 #5' },
  { name: 'AI_Fitting_Result (6).png', label: 'AI 피팅 승인 결과 #6' },
  { name: 'AI_Fitting_Result (7).png', label: 'AI 피팅 승인 결과 #7 (최신 — 기준으로 활성화)' },
];

// 기존에 활성화된 기준 이미지가 있으면 전부 비활성화 (단일 기준 이미지 원칙 유지)
await supabase.from('reference_images').update({ is_active: false }).eq('pipeline', 'restyle').eq('is_active', true);

for (const [i, file] of files.entries()) {
  const localPath = path.join(sourceDir, file.name);
  if (!fs.existsSync(localPath)) {
    console.warn(`건너뜀 (파일 없음): ${file.name}`);
    continue;
  }
  const buffer = fs.readFileSync(localPath);
  const storagePath = `restyle/seed_${i + 1}.png`;

  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: 'image/png',
    upsert: true,
  });
  if (uploadError) {
    console.error(`업로드 실패: ${file.name} —`, uploadError.message);
    continue;
  }

  const isLast = i === files.length - 1;
  const { error: insertError } = await supabase.from('reference_images').insert({
    pipeline: 'restyle',
    label: file.label,
    storage_path: storagePath,
    is_active: isLast,
  });
  if (insertError) {
    console.error(`DB 기록 실패: ${file.name} —`, insertError.message);
    continue;
  }
  console.log(`시드 완료: ${file.name} -> ${storagePath}${isLast ? ' (활성 기준 이미지)' : ''}`);
}
