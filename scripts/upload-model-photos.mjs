import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const envPath = path.join(process.cwd(), '.env.local');
const envText = fs.readFileSync(envPath, 'utf-8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const BUCKET = 'nonstudio-models';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: buckets } = await supabase.storage.listBuckets();
if (!buckets.some((b) => b.name === BUCKET)) {
  const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
  if (error) throw error;
  console.log(`버킷 생성됨: ${BUCKET}`);
} else {
  console.log(`버킷 이미 존재: ${BUCKET}`);
}

const modelsDir = path.join(process.cwd(), 'public', 'models');
const files = fs.readdirSync(modelsDir).filter((f) => !f.startsWith('.') && /\.(png|jpe?g|webp)$/i.test(f));

for (const name of files) {
  const buffer = fs.readFileSync(path.join(modelsDir, name));
  const ext = path.extname(name).toLowerCase();
  const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const { error } = await supabase.storage.from(BUCKET).upload(name, buffer, { contentType, upsert: true });
  if (error) {
    console.error(`실패: ${name} —`, error.message);
  } else {
    console.log(`업로드됨: ${name} (${(buffer.length / 1024).toFixed(0)}KB)`);
  }
}
