/**
 * /api/product-fitting/from-link/route.ts
 * "링크로 가져오기(보조)" — 경쟁사/자사몰 상세페이지 URL에서 제품 이미지·재질(상세)컷·색상/사이즈
 * 옵션을 best-effort로 추출해 기존 파이프라인의 각 파트(제품 이미지/재질 참고 사진/색상/사이즈)에
 * 그대로 꽂는다.
 *
 * 정직한 한계(이번 세션 실측): 네이버 스마트스토어(HTTP 429, nfront)·신상마켓(Cloudflare)은
 * 서버에서 못 연다. 그런 사이트는 blocked=true로 돌려주고 프론트가 "이미지를 저장해 올려주세요"로
 * 안내한다. 카페24 등 열리는 자사몰/일부 경쟁사는 아래처럼 이미지를 두 종류로 나눠 내려받는다.
 *
 * (2026-07-21 2차) 카페24 상세설명(에디봇) 영역은 이 제품과 무관한 브랜드 무드컷/타 상품 사진이
 * 섞여 나올 수 있음이 실측 확인됨(예: 상품과 다른 색·다른 사람이 나온 거리 스냅). geminiApiKey가
 * 있으면 다운로드한 후보들을 Gemini Flash로 한 번에 "이 상품을 실제로 보여주는가"만 검사해 걸러낸다.
 */

import { NextResponse } from 'next/server';
import { GoogleGenAI, Type } from '@google/genai';

export const runtime = 'nodejs';
export const maxDuration = 90;

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

function resolveUrl(u: string, origin: string): string {
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('/') && origin) return origin + u;
  return u;
}

const isJunkUrl = (u: string) => /\.svg(\?|$)|sprite|icon|logo|favicon|blank|placeholder|1x1|pixel|badge|btn_/i.test(u);

/**
 * 이미지 후보를 두 갈래로 분리한다:
 * - official: 쇼핑몰 "상품 목록/대표 이미지" 규약 경로(예: 카페24 /web/product/(big|extra/big)/,
 *   cloudfront/cdn goods 경로) — 제품 자체를 보여주는 공식 컷일 확률이 높다 → "제품 이미지"로.
 * - detail: 본문(상세설명·에디봇) 안에 자유 삽입된 이미지(카페24 ec-data-src 등) — 사이즈표·재질
 *   클로즈업·상세 텍스트가 섞여 있지만, 브랜드 무드컷 등 무관한 사진도 섞일 수 있다 → "재질 참고
 *   사진"으로 보내고, 실제 옷과 무관한지는 아래 비전 필터로 다시 거른다.
 */
function collectImageUrls(html: string, pageUrl: string): { official: string[]; detail: string[] } {
  const origin = (() => {
    try {
      return new URL(pageUrl).origin;
    } catch {
      return '';
    }
  })();

  const officialSet = new Set<string>();
  const detailSet = new Set<string>();

  const og = extractMeta(html, 'image');
  if (og) officialSet.add(og);

  // 카페24 상품 목록/대표 이미지 규약: /web/product/big/, /web/product/extra/big/
  for (const m of html.matchAll(/https?:\/\/[^"'\\ )]*\/web\/product\/(?:big|extra\/big)\/[^"'\\ )]+\.(?:jpe?g|png|webp)/gi))
    officialSet.add(m[0]);
  // 일반 <img src>/data-src — 카테고리 불명확하니 공식 후보로 취급(og:image류와 유사 위치가 많음)
  for (const m of html.matchAll(/<img[^>]+(?:src|data-src)=["']([^"']+)["']/gi)) officialSet.add(m[1]);
  // 그 외 cloudfront/cdn/goods 이미지 URL(경쟁사 자체 CDN)
  for (const m of html.matchAll(/https?:\/\/[^"'\\ )]*(?:cloudfront|cdn)[^"'\\ )]*\.(?:jpe?g|png|webp)(?:\?[^"'\\ )]*)?/gi))
    officialSet.add(m[0]);

  // 카페24 상세설명(에디봇) 지연로딩 — 사이즈표·재질 클로즈업이 여기 있다
  for (const m of html.matchAll(/ec-data-src=["']([^"']+)["']/gi)) detailSet.add(m[1]);

  const clean = (set: Set<string>, cap: number) =>
    Array.from(set)
      .map((u) => resolveUrl(u, origin))
      .filter((u) => /^https?:\/\//.test(u) && !isJunkUrl(u))
      .filter((u, i, arr) => arr.indexOf(u) === i)
      .slice(0, cap);

  const official = clean(officialSet, 14);
  const detailOnly = clean(detailSet, 20).filter((u) => !official.includes(u));
  return { official, detail: detailOnly };
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

/**
 * (2026-07-21) 상세페이지 본문에는 이 상품과 무관한 브랜드 무드컷/타 상품 사진이 섞여 나올 수
 * 있음이 실측 확인됨. Gemini Flash로 한 번에 "이 제품(제목/색상 기준)을 실제로 보여주는가"만
 * 검사해 무관한 이미지를 제거한다. geminiApiKey가 없으면 필터 없이 전부 통과(fail-open).
 */
async function filterRelevantImages(
  images: string[],
  title: string,
  colorOptions: string[],
  geminiApiKey?: string,
): Promise<boolean[]> {
  if (!geminiApiKey || images.length === 0) return images.map(() => true);
  try {
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    const parts: any[] = [
      {
        text: `These ${images.length} numbered photos (index 0 to ${images.length - 1}, in order) were scraped from a single product's detail page titled "${title || 'unknown'}"${colorOptions.length ? `, sold in these colorways: ${colorOptions.join(', ')}` : ''}. Some may be UNRELATED brand mood shots, a different product, banners/promos, or street photography that does not actually show this garment. For EACH image, decide if it should be KEPT (it clearly shows THIS garment — worn, laid flat, a construction/fabric close-up, or a size chart) or DROPPED (unrelated scenery/person, a clearly different garment/color-family, or a banner/promo graphic with no real garment view). Return keep=true/false per index, in the same order.`,
      },
    ];
    images.forEach((img, i) => {
      const [, data] = img.split(',');
      const mimeType = img.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
      parts.push({ text: `Image index ${i}:` });
      parts.push({ inlineData: { data, mimeType } });
    });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts }],
      config: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            decisions: {
              type: Type.ARRAY,
              items: { type: Type.OBJECT, properties: { index: { type: Type.NUMBER }, keep: { type: Type.BOOLEAN } }, required: ['index', 'keep'] },
            },
          },
          required: ['decisions'],
        } as any,
      },
    });
    const parsed = JSON.parse(response.text?.trim() || '{}');
    const decisions: Array<{ index: number; keep: boolean }> = Array.isArray(parsed.decisions) ? parsed.decisions : [];
    const keepMap = new Map(decisions.map((d) => [d.index, d.keep]));
    // 판정이 없는 이미지는 안전하게 통과(fail-open) — 필터가 실수로 다 지우는 것보다 낫다
    return images.map((_, i) => keepMap.get(i) ?? true);
  } catch (err) {
    console.warn('[from-link] 이미지 관련성 필터 호출 실패 — 필터 생략:', err);
    return images.map(() => true);
  }
}

export async function POST(req: Request) {
  try {
    const { url, geminiApiKey } = (await req.json()) as { url: string; geminiApiKey?: string };
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
    const { official, detail } = collectImageUrls(html, pageUrl);
    const options = extractOptions(html);

    const referer = (() => {
      try {
        return new URL(pageUrl).origin + '/';
      } catch {
        return pageUrl;
      }
    })();

    const downloadBucket = async (urls: string[], cap: number) => {
      const out: string[] = [];
      for (const u of urls) {
        if (out.length >= cap) break;
        const data = await downloadImage(u, referer);
        if (data) out.push(data);
      }
      return out;
    };

    const productImagesRaw = await downloadBucket(official, 8);
    const materialImagesRaw = await downloadBucket(detail, 6);

    // 무관 이미지 필터 — 두 버킷을 합쳐 한 번에 검사(호출 절약), keep[]을 원래 길이 기준으로 되나눈다.
    const combined = [...productImagesRaw, ...materialImagesRaw];
    const keep = await filterRelevantImages(combined, title, options.colors, geminiApiKey);
    const productImages = productImagesRaw.filter((_, i) => keep[i]);
    const materialImages = materialImagesRaw.filter((_, i) => keep[productImagesRaw.length + i]);

    if (productImages.length === 0 && materialImages.length === 0) {
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
      productImages,
      materialImages,
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
