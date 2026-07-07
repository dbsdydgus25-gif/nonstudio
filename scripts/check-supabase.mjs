import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const envPath = path.join(process.cwd(), '.env.local');
const envText = fs.readFileSync(envPath, 'utf-8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: gen, error: genErr } = await supabase.from('generations').select('id').limit(1);
console.log('generations table:', genErr ? `ERROR: ${genErr.message}` : `OK (${gen.length} rows sampled)`);

const { data: ref, error: refErr } = await supabase.from('reference_images').select('id').limit(1);
console.log('reference_images table:', refErr ? `ERROR: ${refErr.message}` : `OK (${ref.length} rows sampled)`);

const { data: buckets, error: bucketErr } = await supabase.storage.listBuckets();
console.log('buckets:', bucketErr ? `ERROR: ${bucketErr.message}` : buckets.map((b) => b.name).join(', ') || '(none)');
