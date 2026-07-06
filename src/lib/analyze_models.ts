import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY가 없습니다.');
    return;
  }

  const ai = new GoogleGenAI({ apiKey });
  const modelsDir = path.join(process.cwd(), 'public', 'models');
  if (!fs.existsSync(modelsDir)) {
    console.error('models 디렉토리가 없습니다.');
    return;
  }

  const files = fs.readdirSync(modelsDir).filter(f => !f.startsWith('.') && /\.(png|jpe?g|webp)$/i.test(f));
  
  console.log(`--- 분석 시작 (총 ${files.length}개 모델) ---`);

  for (const file of files) {
    const filePath = path.join(modelsDir, file);
    const fileBuffer = fs.readFileSync(filePath);
    const base64 = fileBuffer.toString('base64');
    const ext = path.extname(file).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';

    const promptText = `
Analyze this model image and describe it in 1 sentence.
Specify:
1. Framing (Full body, Upper body, or Lower body waist-down)
2. What the model is wearing (shirt color, pants color/type, shoes)
3. Background (white studio, or indoor/outdoor location)
    `.trim();

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { data: base64, mimeType } },
              { text: promptText }
            ]
          }
        ]
      });
      console.log(`[${file}]: ${response.text?.trim()}`);
    } catch (e: any) {
      console.error(`[${file}] 에러:`, e.message || e);
    }
    // Rate limit 방지용 대기
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.log('--- 분석 완료 ---');
}

main().catch(console.error);
