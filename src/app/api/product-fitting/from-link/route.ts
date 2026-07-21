/**
 * /api/product-fitting/from-link/route.ts
 * "링크로 가져오기(보조)" — 경쟁사 상세페이지 URL에서 제품 이미지 + 텍스트를 best-effort로 추출.
 *
 * 정직한 한계(이번 세션 실측): 네이버 스마트스토어(HTTP 429, nfront)·신상마켓(Cloudflare)은
 * 서버에서 못 연다. 그런 사이트는 blocked=true로 돌려주고 프론트가 "이미지를 저장해 올려주세요"로
 * 안내한다. 열리는 사이트(예: 4910)만 og:image/갤러리 이미지를 내려받아 data URL로 반환한다.
 * 반환된 이미지는 그대로 productImagesBase64로 써서 기존 분석/생성 파이프라인에 태운다.
 */

import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function browserHeaders(referer?: string): Record<string, string> {
  return {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    ...(referer ? { Referer: referer } : {}),
  };
}

/** 봇/차단/에러 셸을 감지한다 — 네이버(nfront 429), Cloudflare("Just a moment"/challenge), 에러페이지 등. */
function detectBlock(status: number, html: string): string | null {
  if (status === 429) return '이 사이트는 서버 접근을 차단합니다(429). 네이버·일부 도매 사이트가 그렇습니다.';
  if (status === 403) return '이 사이트는 서버 접근을 거부합니다(403).';
  if (/Just a moment|challenge-platform|cf-browser-verification/i.test(html))
    return 'Cloudflare 봇 방어에 막혔습니다(신상마켓 등).';
  if (/에러페이지|시스템오류/.test(html) && html.length < 30000)
    return '사이트가 봇 요청에 에러 페이지를 반환합니다(네이버 등).';
  if (html.length < 1500) return '페이지 내용을 충분히 받지 못했습니다(차단 가능성).';
  return null;
}

function extractMeta(html: string, prop: string): string {
  const m =
    html.match(new RegExp(`<meta[^>]*property=["']og:${prop}["'][^>]*content=["']([^"']+)["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:${prop}["']`, 'i'));
  return m?.[1]?.trim() || '';
}

/** HTML에서 제품 이미지로 보이는 URL 후보들을 모은다(og:image + img src + JSON 안 이미지 URL). */
function collectImageUrls(html: string, pageUrl: string): string[] {
  const urls = new Set<string>();
  const og = extractMeta(html, 'image');
  if (og) urls.add(og);

  // <img src>, data-src, srcset 첫 URL
  for (const m of html.matchAll(/<img[^>]+(?:src|data-src)=["']([^"']+)["']/gi)) urls.add(m[1]);
  // (2026-07-21) 카페24 등은 상세 설명 이미지(사이즈표·재질 텍스트가 박힌 긴 상세컷)를
  // ec-data-src로 지연 로딩한다 — 이걸 빼면 정작 중요한 상세컷을 놓친다.
  for (const m of html.matchAll(/ec-data-src=["']([^"']+)["']/gi)) urls.add(m[1]);
  // __NEXT_DATA__/JSON 등에 박힌 이미지 URL
  for (const m of html.matchAll(/https?:\/\/[^"'\\ )]+\.(?:jpe?g|png|webp)(?:\?[^"'\\ )]*)?/gi)) urls.add(m[0]);

  const origin = (() => {
    try {
      return new URL(pageUrl).origin;
    } catch {
      return '';
    }
  })();

  const isJunk = (u: string) => /\.svg(\?|$)|sprite|icon|logo|favicon|blank|placeholder|1x1|pixel|badge|btn_/i.test(u);

  return Array.from(urls)
    .map((u) => (u.startsWith('//') ? `https:${u}` : u.startsWith('/') && origin ? origin + u : u))
    .filter((u) => /^https?:\/\//.test(u) && !isJunk(u))
    // 제품 이미지일 가능성이 큰 것 우선(cloudfront/cdn/goods/product), 그다음 나머지
    .sort((a, b) => {
      const score = (u: string) => (/cloudfront|cdn|goods|product|detail|image/i.test(u) ? 0 : 1);
      return score(a) - score(b);
    })
    .slice(0, 12);
}

/** 상품 옵션 <select>(색상/사이즈)에서 실제 옵션 값을 뽑는다. 카페24 등 대부분 자사몰에 통함. */
function extractOptions(html: string): { colors: string[]; sizes: Array<{ label: string }> } {
  const groups: string[][] = [];
  for (const sel of html.matchAll(/<select[^>]*>([\s\S]*?)<\/select>/gi)) {
    const body = sel[1];
    const values = Array.from(body.matchAll(/<option[^>]*>([^<]+)<\/option>/gi))
      .map((m) => m[1].trim())
      .filter(
        (v) =>
          v &&
          !/^-+$/.test(v) &&
          !/선택|필수|옵션을|please|choose|^\s*$/i.test(v) &&
          v.length <= 24,
      );
    if (values.length >= 1 && values.length <= 15) groups.push(values);
  }

  const SIZE_RE = /^(XXS|XS|S|M|L|XL|XXL|XXXL|F|FREE|\d{1,3}(?:호|inch|"|cm)?)$/i;
  const colors = new Set<string>();
  const sizes = new Set<string>();
  for (const g of groups) {
    const sizeLike = g.filter((v) => SIZE_RE.test(v)).length;
    if (sizeLike >= Math.ceil(g.length * 0.6)) g.forEach((v) => sizes.add(v));
    else g.forEach((v) => colors.add(v));
  }
  return {
    colors: Array.from(colors).slice(0, 12),
    sizes: Array.from(sizes)
      .slice(0, 12)
      .map((label) => ({ label })),
  };
}

async function downloadImage(url: string, referer: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: browserHeaders(referer), signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return null; // 핫링크 차단 시 HTML이 돌아옴 → 버림
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 4000) return null; // 아이콘/1x1 등 너무 작은 건 제외
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  try {
    const { url } = (await req.json()) as { url: string };
    if (!url || !/^https?:\/\//i.test(url.trim())) {
      return NextResponse.json({ success: false, error: '올바른 상품 링크(http/https)를 입력해주세요.' }, { status: 400 });
    }
    const pageUrl = url.trim();

    let res: Response;
    try {
      res = await fetch(pageUrl, { headers: browserHeaders(), redirect: 'follow', signal: AbortSignal.timeout(15000) });
    } catch {
      return NextResponse.json({
        success: false,
        blocked: true,
        reason: '링크를 여는 데 실패했습니다(차단 또는 시간 초과). 상세 이미지를 저장해 직접 올려주세요.',
      });
    }
    const html = await res.text();

    const block = detectBlock(res.status, html);
    if (block) {
      return NextResponse.json({
        success: false,
        blocked: true,
        reason: `${block} 상세페이지 이미지를 저장해 직접 올려주세요 — 이미지 속 사이즈표·소재 텍스트까지 분석에 반영됩니다.`,
      });
    }

    const title = extractMeta(html, 'title');
    const description = extractMeta(html, 'description');
    const candidates = collectImageUrls(html, pageUrl);

    // 상위 후보 몇 장만 실제 다운로드(핫링크 차단은 자동 제외). 최대 6장.
    const referer = (() => {
      try {
        return new URL(pageUrl).origin + '/';
      } catch {
        return pageUrl;
      }
    })();
    const downloaded: string[] = [];
    for (const c of candidates) {
      if (downloaded.length >= 8) break;
      const data = await downloadImage(c, referer);
      if (data) downloaded.push(data);
    }

    const options = extractOptions(html);

    if (downloaded.length === 0) {
      return NextResponse.json({
        success: false,
        blocked: true,
        reason: '링크는 열렸지만 제품 이미지를 내려받지 못했습니다(핫링크 차단 등). 상세 이미지를 저장해 직접 올려주세요.',
        title,
        description,
      });
    }

    return NextResponse.json({
      success: true,
      images: downloaded,
      title,
      description,
      sourceUrl: pageUrl,
      colorOptions: options.colors, // <select>에서 뽑은 정확한 색상 옵션 (있으면)
      sizeOptions: options.sizes, // <select>에서 뽑은 사이즈 옵션 (없으면 상세컷에서 비전이 읽음)
    });
  } catch (err: any) {
    console.error('[api/product-fitting/from-link] 처리 실패:', err);
    return NextResponse.json(
      { success: false, error: err?.message || '링크 처리 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
