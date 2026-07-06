import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CACHE_FILE = path.join(process.cwd(), 'src', 'lib', 'analysis-cache.json');

interface CacheSchema {
  [fileHash: string]: string;
}

function getFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(content).digest('hex');
}

export function getCachedAnalysis(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const hash = getFileHash(filePath);

    if (fs.existsSync(CACHE_FILE)) {
      const cache: CacheSchema = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      return cache[hash] || null;
    }
  } catch (e) {
    console.error('[Cache] Read error:', e);
  }
  return null;
}

export function saveAnalysisToCache(filePath: string, analysisText: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const hash = getFileHash(filePath);

    let cache: CacheSchema = {};
    if (fs.existsSync(CACHE_FILE)) {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }

    cache[hash] = analysisText;
    
    // Ensure parent dir exists
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
    console.log(`[Cache] Saved analysis for: ${path.basename(filePath)} (Hash: ${hash})`);
  } catch (e) {
    console.error('[Cache] Save error:', e);
  }
}
