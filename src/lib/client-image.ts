'use client';

/**
 * client-image.ts — 업로드 파일을 브라우저에서 미리 축소해서 data URL로 변환 (2026-07-15)
 *
 * 원인: 휴대폰 원본 사진(장당 5~10MB+)을 그대로 base64로 감싸 /api/*로 보내면,
 * 서버(sharp)가 1024px로 다운스케일하기도 전에 Vercel의 요청 본문 한도(약 4.5MB)에
 * 걸려 413이 남. 제품 피팅에 재질 참고 사진(최대 4장)까지 추가되면서 실제로 재현됨.
 * 서버 다운스케일은 "받은 다음"에만 작동하므로, 애초에 보내기 전에 브라우저에서
 * 캔버스로 축소해야 근본 해결됨.
 */

const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 0.82;

/**
 * 파일을 최대 1280px로 축소한 base64 data URL로 읽는다. PNG는 투명도 보존을 위해 PNG 유지, 나머지는
 * JPEG로 재인코딩. 서버가 어차피 1024px로 다시 다운스케일하므로 1280px는 화질 손실 없이 여유만
 * 남긴 값 — 제품 피팅은 색상 최대 6장 + 재질 최대 4장까지 한 요청에 같이 들어갈 수 있어(최악 10장)
 * 장당 용량을 최대한 눌러둬야 Vercel 요청 본문 한도(약 4.5MB)에 안전하다.
 */
export function fileToCompressedDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const rawDataUrl = reader.result as string;
      const img = new Image();
      img.onerror = () => resolve(rawDataUrl); // 디코딩 실패 시 원본으로 폴백
      img.onload = () => {
        const { width, height } = img;
        const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
        const targetW = Math.max(1, Math.round(width * scale));
        const targetH = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(rawDataUrl);
          return;
        }
        ctx.drawImage(img, 0, 0, targetW, targetH);
        const isPng = file.type === 'image/png';
        try {
          const dataUrl = isPng
            ? canvas.toDataURL('image/png')
            : canvas.toDataURL('image/jpeg', JPEG_QUALITY);
          resolve(dataUrl);
        } catch {
          resolve(rawDataUrl);
        }
      };
      img.src = rawDataUrl;
    };
    reader.readAsDataURL(file);
  });
}
