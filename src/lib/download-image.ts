/**
 * download-image.ts (클라이언트 헬퍼)
 * 결과 이미지를 /api/download 프록시로 받아서 파일로 저장한다.
 * - Supabase 서명 URL은 cross-origin이라 <a download>가 브라우저에서 조용히 무시됨
 * - 서명 URL은 1시간 만료라 페이지를 오래 열어두면 직접 fetch도 400으로 실패함
 * 두 문제 모두 서버 프록시(스토리지 경로로 재다운로드)로 해결된다.
 */

export async function downloadResultImage(imageUrl: string, filename: string): Promise<void> {
  const res = await fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageUrl }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success || !data?.dataUrl) {
    throw new Error(data?.error || '이미지 다운로드에 실패했습니다.');
  }
  const blobRes = await fetch(data.dataUrl);
  const blob = await blobRes.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
