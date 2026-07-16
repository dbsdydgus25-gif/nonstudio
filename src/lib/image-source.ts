/**
 * image-source.ts
 * 여러 파이프라인(바리에이션/디테일컷 영상 등)이 공통으로 쓰는 "입력 이미지를 Buffer로
 * 통일" 헬퍼. base64 data URL과 Supabase 서명 URL(https://...) 둘 다 처리한다.
 */

export function parseBase64Image(dataUrl: string): { buffer: Buffer; mimeType: string } {
  if (dataUrl.startsWith('data:')) {
    const [header, data] = dataUrl.split(',');
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
    return { buffer: Buffer.from(data, 'base64'), mimeType };
  }
  return { buffer: Buffer.from(dataUrl, 'base64'), mimeType: 'image/jpeg' };
}

/** OpenAI 응답 이미지(URL 또는 base64 data URL)를 Buffer로 통일 — Supabase 업로드용 */
export async function resultImageToBuffer(imageUrl: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (imageUrl.startsWith('data:')) {
    return parseBase64Image(imageUrl);
  }
  const res = await fetch(imageUrl);
  const arrayBuffer = await res.arrayBuffer();
  const mimeType = res.headers.get('content-type') || 'image/png';
  return { buffer: Buffer.from(arrayBuffer), mimeType };
}
