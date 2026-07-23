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
import { downscaleImage } from '@/lib/image-utils';

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

/**
 * (2026-07-21) 상세페이지의 "제품 특징 텍스트"를 뽑는다 — 제품명(예: "스티치 머슬 니트티"의 머슬)과
 * 설명 불릿(골지 텍스처/니트 소재 등)에 핏·재질·특징이 그대로 적혀 있는데 지금까지 버리고 있었다.
 * 이 텍스트를 analyzeGarment의 rawSpecs로 넘겨야 "머슬핏·크롭" 같은 특징이 결과에 반영된다.
 * 네비게이션/약관 같은 잡텍스트를 피하려고 불릿과 키워드 주변만 좁게 긁는다.
 */
function extractProductText(html: string, title: string): string {
  const plain = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();

  // 네비게이션·리뷰·다른 상품(가격 붙은 추천 상품) 등 오염원을 걸러낸다.
  // 특히 "트윌 커브드 와이드 카고 팬츠 62,900원" 같은 추천 상품명이 섞이면 분석이 딴 옷을 본다.
  const isJunkText = (s: string) =>
    /\d{1,3},\d{3}\s*원/.test(s) || // 가격 → 추천 상품/가격 영역
    /조회|추천\s*\d|리뷰|REVIEW|Q&A|배송|교환|반품|적립|쿠폰|장바구니|LOGIN|REGISTER|MY PAGE|검색어|검색기록|공지/i.test(s);

  const picked: string[] = [];
  if (title) picked.push(title);

  // 설명 불릿(• …) — 대부분의 자사몰이 제품 특징을 이 형태로 적어둔다(가장 깨끗한 소스)
  const bullets: string[] = [];
  for (const m of plain.matchAll(/[•·]\s*([^•·]{4,90})/g)) {
    const s = m[1].trim();
    if (s && !isJunkText(s)) bullets.push(s);
    if (bullets.length >= 8) break;
  }
  picked.push(...bullets);

  // 불릿이 충분하면 그것만 쓴다 — 키워드 스캔은 리뷰/추천상품까지 긁어와 오염되기 쉽다.
  if (bullets.length < 2) {
    const KEY = /(소재|혼용률|안감|신축|스판|두께감|비침|촉감|골지|기모|머슬|크롭|슬림|오버핏|루즈핏|기장)/g;
    const seenWin = new Set<string>();
    for (const m of plain.matchAll(KEY)) {
      const win = plain.slice(Math.max(0, m.index! - 45), Math.min(plain.length, m.index! + 60)).trim();
      if (win && !seenWin.has(win) && !isJunkText(win)) {
        seenWin.add(win);
        picked.push(win);
      }
      if (seenWin.size >= 5) break;
    }
  }

  // 부분 문자열 중복 제거(같은 문장이 잘린 형태로 여러 번 들어오는 것 방지)
  const out: string[] = [];
  for (const raw of picked.map((s) => s.trim()).filter((s) => s.length >= 2)) {
    if (out.some((k) => k.includes(raw) || raw.includes(k))) continue;
    out.push(raw);
  }
  return out.join(' / ').slice(0, 800);
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
    const rawBuf = Buffer.from(await res.arrayBuffer());
    if (rawBuf.length < 4000) return null; // 아이콘/1x1 등 너무 작은 건 제외
    // (2026-07-21) 링크 이미지는 원본(최대 1MB+)이라 8~14장 합치면 Vercel 요청 한도(413)를 넘는다.
    // 직접 업로드는 클라이언트에서 압축되는데 링크는 그 과정이 없어 서버에서 다운스케일해준다.
    const { buffer, mimeType } = await downscaleImage(rawBuf, ct);
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
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
): Promise<Array<{ keep: boolean; role: 'garment' | 'fabric' | 'info'; colorway: string }>> {
  // 분석 실패/키 없음 시 폴백 — 판단을 못 하면 전부 garment로 통과(기존 동작 보존)
  const passAll = () =>
    images.map(() => ({ keep: true, role: 'garment' as const, colorway: '' }));
  if (!geminiApiKey || images.length === 0) return passAll();
  try {
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });
    const parts: any[] = [
      {
        text: `These ${images.length} numbered photos (index 0 to ${images.length - 1}, in order) were scraped from a single product's detail page titled "${title || 'unknown'}"${colorOptions.length ? `, sold in these colorways: ${colorOptions.join(', ')}` : ''}. Some may be UNRELATED brand mood shots, a different product, banners/promos, or street photography that does not actually show this garment.

For EACH image return three things:
1. keep — true if it is at all related to THIS product (a photo of the garment worn/flat, a fabric close-up, a size chart, a colorway/spec info card, etc.); false ONLY if it is unrelated scenery/person, a clearly DIFFERENT garment, or a generic banner/promo with no info about this product.
2. role — classify HOW the image can be used, because some images must never be used as a rendering reference:
   - "garment" = a clean photo showing THIS SINGLE garment clearly (worn on one model, or laid flat/on a hanger), with NO heavy text overlay and NOT a multi-garment layout. These are the only images safe to recreate the product from.
   - "fabric" = a close-up of the fabric surface / a construction detail (stitching, button, weave) — one garment, zoomed in.
   - "info" = anything that is NOT a clean single-garment shot even though it relates to the product: a size chart, a text-heavy spec/marketing card, a "컬러뷰/color view" swatch sheet, a grid/collage showing SEVERAL garments or SEVERAL colors together, an "overview" card with feature bullets. These carry useful text but must NEVER be used to redraw the garment.
   Be strict: if an image shows more than one garment, or is mostly text, or is a color-swatch lineup, it is "info", not "garment" — even if a garment is visible in it.
3. colorway — WHICH single colorway of this product the garment in that photo actually is. Judge by the garment's real color${colorOptions.length ? ` and answer with EXACTLY one of these option names: ${colorOptions.join(', ')}` : ''}. If the image is "info" (size chart, text card, or a multi-color swatch/grid showing several colors at once), answer "unknown" — never pick one color off a multi-color sheet.`,
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
              items: {
                type: Type.OBJECT,
                properties: {
                  index: { type: Type.NUMBER },
                  keep: { type: Type.BOOLEAN },
                  role: { type: Type.STRING, enum: ['garment', 'fabric', 'info'] },
                  colorway: { type: Type.STRING, description: 'One of the listed colorway names, or "unknown"' },
                },
                required: ['index', 'keep', 'role', 'colorway'],
              },
            },
          },
          required: ['decisions'],
        } as any,
      },
    });
    const parsed = JSON.parse(response.text?.trim() || '{}');
    const decisions: Array<{ index: number; keep: boolean; role?: string; colorway?: string }> = Array.isArray(
      parsed.decisions,
    )
      ? parsed.decisions
      : [];
    const map = new Map(decisions.map((d) => [d.index, d]));
    // 판정이 없는 이미지는 안전하게 통과(fail-open) — 필터가 실수로 다 지우는 것보다 낫다
    return images.map((_, i) => {
      const d = map.get(i);
      const raw = (d?.colorway || '').trim();
      const matched = colorOptions.find((c) => c.toLowerCase() === raw.toLowerCase()) || '';
      const role: 'garment' | 'fabric' | 'info' =
        d?.role === 'fabric' || d?.role === 'info' ? d.role : 'garment';
      // info(스와치/텍스트/그리드)는 색상을 특정할 수 없으므로 항상 unknown 취급 — 색상 필터 오염 방지
      return { keep: d?.keep ?? true, role, colorway: role === 'info' ? '' : matched };
    });
  } catch (err) {
    console.warn('[from-link] 이미지 관련성 필터 호출 실패 — 필터 생략:', err);
    return passAll();
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
    const productText = extractProductText(html, title);
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

    // 무관 이미지 필터 + 이미지별 역할(garment/fabric/info)·컬러웨이 판별 — 두 버킷을 합쳐
    // 한 번에 검사(호출 절약)한다. (2026-07-23) 예전엔 URL 출처(official/detail)로만 버킷을
    // 나눠서, 상세페이지의 "컬러뷰 스와치 시트/텍스트 카드"가 그대로 productImages(=생성 편집
    // 원본)로 들어가 완전히 다른 옷이 나오는 사고가 있었다. 이제 출처가 아니라 판별된 역할로
    // 다시 버킷을 나눈다: garment=생성 가능한 단독 착용/누끼 컷, fabric=원단 클로즈업,
    // info=사이즈표/스와치/그리드/텍스트 카드(분석 텍스트로만 쓰고 생성기엔 절대 안 넣음).
    const combined = [...productImagesRaw, ...materialImagesRaw];
    const verdicts = await filterRelevantImages(combined, title, options.colors, geminiApiKey);
    const kept = combined.map((img, i) => ({ img, v: verdicts[i] })).filter((x) => x.v.keep);

    const garmentKept = kept.filter((x) => x.v.role === 'garment');
    const fabricKept = kept.filter((x) => x.v.role === 'fabric');
    const infoKept = kept.filter((x) => x.v.role === 'info');

    // 생성 편집 원본으로 쓰는 productImages는 반드시 garment 컷만. garment가 하나도 없으면
    // (드문 경우) fabric이라도 대표로 승격 — 그래도 info(스와치/텍스트)는 절대 안 올린다.
    const productKept = garmentKept.length > 0 ? garmentKept : fabricKept;
    const materialKept = garmentKept.length > 0 ? fabricKept : [];

    const productImages = productKept.map((x) => x.img);
    const materialImages = materialKept.map((x) => x.img);
    const productImageColors = productKept.map((x) => x.v.colorway);
    const materialImageColors = materialKept.map((x) => x.v.colorway);
    // 분석 전용 — 사이즈표/소재 텍스트("Cotton 75% Rayon 25%" 등)를 읽는 데만 쓰고 생성기엔 안 넣는다
    const infoImages = infoKept.map((x) => x.img);

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
      // 분석 전용 이미지(사이즈표/스와치/텍스트 카드) — 소재/사이즈 텍스트를 읽는 데만 쓰고
      // 생성기(gpt-image-2)엔 절대 안 넣는다. 프론트가 생성 요청에 infoImagesBase64로 전달.
      infoImages,
      // 이미지별 판별된 컬러웨이(빈 문자열 = 판별 불가) — 프론트가 선택 색상에 맞는 컷만 쓰도록
      productImageColors,
      materialImageColors,
      title,
      description,
      // 제품명·설명 불릿에서 뽑은 특징 텍스트(머슬핏/골지/니트 소재 등) — 분석의 rawSpecs로 쓰인다
      productText,
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
