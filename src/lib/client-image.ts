'use client';

/**
 * client-image.ts — 업로드 파일을 브라우저에서 미리 축소해서 data URL로 변환 (2026-07-15)
 *
 * 원인: 휴대폰 원본 사진(장당 5~10MB+)을 그대로 base64로 감싸 /api/*로 보내면,
 * 서버(sharp)가 1024px로 다운스케일하기도 전에 Vercel의 요청 본문 한도(약 4.5MB)에
 * 걸려 413이 남. 제품 피팅에 재질 참고 사진(최대 4장)까지 추가되면서 실제로 재현됨.
 * 서버 다운스케일은 "받은 다음"에만 작동하므로, 애초에 보내기 전에 브라우저에서
 * 캔버스로 축소해야 근본 해결됨.
 *
 * (2026-07-15, 2차) 1차 수정 배포 후에도 413이 재발함 — 원인은 "file.type이 PNG면 무조건
 * PNG로 유지"하던 판단. 실제로는 투명 배경 누끼 이미지가 아니라 스크린샷/캡처(재질 참고
 * 사진 등)가 PNG로 저장되어 올라오는 경우가 흔한데, PNG는 무손실이라 사진처럼 디테일이 많은
 * 콘텐츠에서는 1280px로 줄여도 용량이 잘 안 줄어든다(장당 수백KB~1MB+, 여러 장이면 금방 누적).
 * 실제로 투명도가 있는지(알파 채널에 완전 불투명이 아닌 픽셀이 있는지) 캔버스에서 직접 검사해서,
 * 진짜 투명 배경일 때만 PNG를 유지하고 나머지는 전부 JPEG로 재인코딩한다.
 */

const MAX_DIMENSION = 1280;
const JPEG_QUALITY = 0.82;

/** 리사이즈된 캔버스에 실제 불투명이 아닌(alpha < 255) 픽셀이 하나라도 있는지 검사 */
function hasRealTransparency(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  try {
    const { data } = ctx.getImageData(0, 0, w, h);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return true;
    }
    return false;
  } catch {
    // getImageData가 막히는 환경(예: CORS)이면 원래 판단(파일 타입)으로 안전하게 폴백
    return true;
  }
}

/**
 * 파일을 최대 1280px로 축소한 base64 data URL로 읽는다. 실제로 투명 배경(알파 채널)이 있는
 * 이미지만 PNG로 유지하고, 나머지는 원래 확장자와 무관하게 전부 JPEG로 재인코딩한다 — 스크린샷/
 * 캡처처럼 PNG로 저장된 일반 사진(투명도 없음)에서 용량이 안 줄어드는 문제를 막기 위함. 서버가
 * 어차피 1024px로 다시 다운스케일하므로 1280px는 화질 손실 없이 여유만 남긴 값 — 제품 피팅은
 * 색상 최대 6장 + 재질 최대 4장까지 한 요청에 같이 들어갈 수 있어(최악 10장) 장당 용량을 최대한
 * 눌러둬야 Vercel 요청 본문 한도(약 4.5MB)에 안전하다.
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
        try {
          const mightHaveAlpha = file.type === 'image/png' || file.type === 'image/webp';
          const keepPng = mightHaveAlpha && hasRealTransparency(ctx, targetW, targetH);
          const dataUrl = keepPng
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
