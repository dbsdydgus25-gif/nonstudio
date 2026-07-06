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
  const imgPath = path.join(process.cwd(), 'public', 'models', 'face_reference.png');
  if (!fs.existsSync(imgPath)) {
    console.error('파일이 없습니다:', imgPath);
    return;
  }

  const fileBuffer = fs.readFileSync(imgPath);
  const base64 = fileBuffer.toString('base64');

  const promptText = `
Analyze this Korean male model's face, hairstyle, head shape, and facial features.
Provide a highly detailed 2-3 sentence description in English describing his hair (color, style, length), skin tone, face shape, and facial features (eyes, nose, jawline) so we can instruct DALL-E to generate a matching head/face.
Keep it strictly descriptive and professional.
  `.trim();

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { data: base64, mimeType: 'image/png' } },
          { text: promptText }
        ]
      }
    ]
  });

  console.log('--- FACE ANALYSIS RESULT ---');
  console.log(response.text?.trim());
  console.log('---------------------------');
}

main().catch(console.error);
