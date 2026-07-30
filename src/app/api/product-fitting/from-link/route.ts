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

// (2026-07-27) classsup.com 실측: 헤더 로고/SNS 아이콘/카카오 배너/푸터 배너/퀵메뉴 이미지가
// 이 필터를 다 통과해서 officialSet의 14장 캡을 먼저 채워버리고, 정작 페이지 훨씬 아래
// 본문(에디터로 삽입된 진짜 원단·카라·소매 클로즈업)이 캡 밖으로 밀려나 "디테일 참고 사진"이
// 텅 비는 사고가 실측 확인됨. 사이트 UI 크롬(배너/퀵메뉴/카카오/SNS/공지)을 넓게 걸러낸다.
const isJunkUrl = (u: string) =>
  /\.svg(\?|$)|sprite|icon|logo|favicon|blank|placeholder|1x1|pixel|badge|btn_|banner|footer|quick_(top|down)|join_kakao|top_sns|_bn_\d|kakaotalk|\/board\/images\/|notice|popup|close\.(png|gif|jpe?g)|facebook\.com\/tr\?|google-analytics|googletagmanager|doubleclick\.net/i.test(
    u,
  ) ||
  // (2026-07-27) 캡 상향으로 <img> 캐치올이 사이트 스킨 UI 이미지까지 대량으로 긁어옴
  // (classsup 실측: PC_TOP·all_cate·market98/layout 등). 카페24류 스킨에서 제품 이미지는
  // /design/·/layout/ 아래 절대 안 들어가고 스킨 폴더가 거기다 — 안전하게 사이트 크롬으로 제외.
  /\/design\/|\/layout\/|market98|all_cate|pc_top|gnb|_top\.(jpe?g|png|gif)/i.test(u);

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
  // (2026-07-27) classsup.com 실측: ec-data-src를 안 쓰는 몰은 본문 에디터(NNEditor/스마트에디터
  // 등, 업로드 경로에 "editor"가 들어감)로 삽입한 이미지가 그냥 평범한 <img src>라서, 위의
  // 일반 <img> 캐치올(아래)에 officialSet과 뒤섞여 헤더/배너류에 밀려 캡 밖으로 밀려났다.
  // "업로드 경로에 editor가 포함"이라는 신호를 detail 전용 버킷으로 직접 분리해 우선 확보한다.
  for (const m of html.matchAll(/https?:\/\/[^"'\\ )]*\/(?:web|design)\/upload\/[^"'\\ )]*editor[^"'\\ )]*\.(?:jpe?g|png|webp|gif)/gi))
    detailSet.add(m[0]);

  const clean = (set: Set<string>, cap: number) =>
    Array.from(set)
      .map((u) => resolveUrl(u, origin))
      .filter((u) => /^https?:\/\//.test(u) && !isJunkUrl(u))
      .filter((u, i, arr) => arr.indexOf(u) === i)
      .slice(0, cap);

  // (2026-07-27) 캡 상향 — "제품 이미지를 전부 가져와 대표님이 직접 고르는" 구조로 전환.
  // 예전엔 임의로 몇 장만 잘라와 AI가 자동 선택했는데, gpt-image-2는 글보다 실제 픽셀을
  // 잘 베끼므로 좋은 참고컷을 많이·정확히 사람이 큐레이션해 넣는 게 정확도의 최대 지렛대다.
  // (2026-07-29) 캡 재상향 — ar-es.co.kr(8색상) 실측: 상세설명에 ec-data-src 이미지가 128장
  // 있는데 30장에서 잘려, 문서 순서상 앞쪽에 몰려 있던 버건디 컷만 들어오고 화이트/남색 룩북샷은
  // 통째로 사라졌다(대표님 신고: "버건디색상만 가져왔어"). 색상별 큐레이션이 가능하려면 모든
  // 색상 구간이 후보에 들어와야 하므로, URL 수집 단계에서는 잘라내지 않는다.
  const official = clean(officialSet, 120);
  const detailOnly = clean(detailSet, 220).filter((u) => !official.includes(u));
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

// (2026-07-23) 페이지의 <select>를 이름/id/class 힌트 없이 무차별로 다 긁으면, 언어선택
// (한국어/English), 통화, 정렬순서, 수량선택(1,2,3...) 같은 상품과 무관한 드롭다운까지
// 색상/사이즈로 잘못 분류되는 게 실측 확인됨 — 사이트마다 재현되는 흔한 버그였다.
// select 태그 자체의 속성으로 걸러내는 게 1차 방어, 값 내용으로 걸러내는 게 2차 방어.
// 단어 경계(\b)가 꼭 필요하다 — 카페24 상품 옵션 select 자체의 속성에 "option_sort_no"
// 처럼 "sort"가 언더스코어로 붙어 들어있어서, 경계 없이 부분 문자열로만 보면 진짜 상품
// 옵션 select까지 걸러져버리는 걸 실측으로 확인했다(언더스코어는 정규식 \w라 경계가 안 생김).
const NON_PRODUCT_SELECT_ATTR_RE =
  /\b(lang|locale|currency|money|sort|order|display|per_?page|qty|quantity|amount|count|page|country|shipping)\b/i;
// (2026-07-23 수정) 그런데 실제 bymono.com(카페24) HTML을 직접 떠서 보니, 언어선택 select의
// class가 "xans-layout-multishopshippinglanguagelist"처럼 다른 단어와 공백 없이 붙어있어서
// 위의 \b 기반 정규식이 "language"를 못 잡고 그대로 통과시켜버렸다. 반대로 이건 카페24가
// 언어/배송국가 선택 위젯에 항상 쓰는 매우 특정적인 클래스 접두어라 오탐 위험이 없으므로,
// 이 조합만 예외적으로 경계 없이 부분 문자열로 별도 검사한다.
const NON_PRODUCT_SELECT_SUBSTR_RE = /language|multishopshipping/i;
const JUNK_VALUE_RE =
  /^(한국어|한글|영어|english|日本語|일본어|中文|중국어|krw|usd|jpy|eur|cny|인기순|최신순|등록순|낮은가격순?|높은가격순?|리뷰순|추천순|판매량순|낮은가격|높은가격|language\s*[:：].*|lang\s*[:：].*|언어\s*[:：].*|shipping\s*to\s*[:：].*)$/i;

// 카페24는 상품 옵션 select에 option_title="Color"/"Size" 같은 명시적 속성을 이미 심어둔다
// (실측: <select ... option_title="Color" name="option1" ...>, option_title="Size" ...>).
// 이건 텍스트 패턴으로 색상/사이즈를 추측하는 것보다 훨씬 확실한 신호이므로, 있으면 최우선
// 신뢰한다 — "FREE[30-34]"처럼 괄호/대괄호 형태를 다 나열해도 못 맞히는 정규식 추측이 필요 없다.
const COLOR_TITLE_RE = /^(color|colour|색상|칼라|컬러)$/i;
const SIZE_TITLE_RE = /^(size|사이즈|치수)$/i;

/** 상품 옵션 <select>(색상/사이즈)에서 실제 옵션 값을 뽑는다. 카페24 등 대부분 자사몰에 통함. */
function extractOptions(html: string): { colors: string[]; sizes: Array<{ label: string }> } {
  const groups: Array<{ values: string[]; forcedRole: 'color' | 'size' | null }> = [];
  for (const sel of html.matchAll(/<select([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const attrs = sel[1] || '';

    const titleMatch = attrs.match(/option_title\s*=\s*"([^"]*)"/i);
    const title = titleMatch?.[1] || '';
    const forcedRole: 'color' | 'size' | null = COLOR_TITLE_RE.test(title)
      ? 'color'
      : SIZE_TITLE_RE.test(title)
        ? 'size'
        : null;

    // option_title로 카페24가 색상/사이즈라고 명시한 select는 언어/통화 등 오탐 필터를
    // 건너뛴다 — 카페24 자체 태그가 확실한 신호이므로 이후의 추측성 제외 규칙보다 우선한다.
    if (!forcedRole && (NON_PRODUCT_SELECT_ATTR_RE.test(attrs) || NON_PRODUCT_SELECT_SUBSTR_RE.test(attrs))) {
      continue; // 언어/통화/정렬/수량 select는 애초에 제외
    }

    const body = sel[2];
    const values = Array.from(body.matchAll(/<option[^>]*>([^<]+)<\/option>/gi))
      .map((m) => m[1].trim())
      .filter(
        (v) =>
          v &&
          !/^-+$/.test(v) &&
          !/선택|필수|옵션을|please|choose|^\s*$/i.test(v) &&
          v.length <= 24,
      );
    if (values.length >= 1 && values.length <= 15 && !values.some((v) => JUNK_VALUE_RE.test(v))) {
      groups.push({ values, forcedRole });
    }
  }

  const SIZE_RE = /^(XXS|XS|S|M|L|XL|XXL|XXXL|F|FREE|\d{1,3}(?:호|inch|"|cm)?)$/i;
  // "S(어깨42 가슴52 총장65)"처럼 사이즈 뒤에 실측 치수를 괄호/대괄호로 병기하는 카페24류
  // 표기 — SIZE_RE는 완전일치만 보므로 이 형태를 사이즈로 인식 못 하고 통째로 색상 버킷에
  // 떨어져 "판매 색상에 치수가 섞여 들어간다"는 실제 신고와 정확히 일치했다. 사이즈 라벨 +
  // 괄호/대괄호로 시작하는 값도 사이즈로 인정한다.
  const SIZE_WITH_MEASUREMENTS_RE =
    /^(XXS|XS|S|M|L|XL|XXL|XXXL|F|FREE|\d{1,3}(?:호|inch|"|cm)?)\s*[(（[]/i;
  const colors = new Set<string>();
  const sizes = new Set<string>();
  for (const { values: g, forcedRole } of groups) {
    if (forcedRole === 'color') {
      g.forEach((v) => colors.add(v));
      continue;
    }
    if (forcedRole === 'size') {
      g.forEach((v) => sizes.add(v));
      continue;
    }

    // 수량선택("1","2","3"...) 방지 — 단위 없는 순수 숫자가 1부터 연속으로 이어지면
    // 사이즈표가 아니라 수량 드롭다운일 확률이 매우 높다(28/30/32/34처럼 실제 사이즈는
    // 보통 1씩 증가하지 않는다). 이런 그룹은 색상도 사이즈도 아니므로 통째로 버린다.
    const bareNums = g.map((v) => (/^\d{1,2}$/.test(v) ? Number(v) : null));
    const isQuantitySelect =
      bareNums.every((n) => n !== null) &&
      bareNums[0] === 1 &&
      bareNums.every((n, i) => i === 0 || n === (bareNums[i - 1] as number) + 1);
    if (isQuantitySelect) continue;

    const sizeLike = g.filter((v) => SIZE_RE.test(v) || SIZE_WITH_MEASUREMENTS_RE.test(v)).length;
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

// (2026-07-27) 브라우저의 fetch()가 아니라 서버 쪽 fetch(Fetch 표준)의 res.text()는 실제
// 페이지 인코딩과 무관하게 항상 UTF-8로 디코딩한다 — classssup.com처럼 아직 EUC-KR로
// 서빙하는(주로 오래된/구형 카페24·독립몰) 사이트에서 상품명·옵션이 전부 깨진 문자로
// 나오는 문제가 실측 확인됨. 응답 헤더의 charset, 없으면 <meta charset> 태그를 직접 읽어
// 실제 인코딩으로 디코딩한다.
function decodeHtmlBody(res: Response, buf: ArrayBuffer): string {
  const headerCharset = res.headers.get('content-type')?.match(/charset=([^;]+)/i)?.[1]?.trim().toLowerCase();
  // charset 선언은 항상 ASCII 범위 안에 있으므로, 태그를 찾을 땐 안전하게 latin1로 미리 읽는다.
  const sniffText = Buffer.from(buf.slice(0, 4096)).toString('latin1');
  const metaCharset =
    sniffText.match(/<meta[^>]+charset=["']?([a-zA-Z0-9_-]+)/i)?.[1]?.trim().toLowerCase();
  const raw = headerCharset || metaCharset || 'utf-8';
  // 흔한 표기 편차 정규화 — TextDecoder가 인식하는 라벨로 맞춘다.
  const normalized = /^(euc-?kr|ks_?c_?5601[-_]?1987?|ksc5601|cp949|x-windows-949|windows-949)$/i.test(raw)
    ? 'euc-kr'
    : raw;
  try {
    return new TextDecoder(normalized).decode(buf);
  } catch {
    // 인식 못 하는 인코딩이면 UTF-8로 폴백 (기존 동작 유지, 최소한 크래시는 안 남)
    return new TextDecoder('utf-8').decode(buf);
  }
}

async function downloadImage(url: string, referer: string, maxDim?: number): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: browserHeaders(referer), signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return null; // 핫링크 차단 시 HTML이 돌아옴 → 버림
    const rawBuf = Buffer.from(await res.arrayBuffer());
    if (rawBuf.length < 4000) return null; // 아이콘/1x1 등 너무 작은 건 제외
    // (2026-07-21) 링크 이미지는 원본(최대 1MB+)이라 8~14장 합치면 Vercel 요청 한도(413)를 넘는다.
    // 직접 업로드는 클라이언트에서 압축되는데 링크는 그 과정이 없어 서버에서 다운스케일해준다.
    // (2026-07-29) maxDim을 작게 주면 갤러리 썸네일 모드 — 수십 장을 한 응답에 담을 수 있다.
    const { buffer, mimeType } = await downscaleImage(rawBuf, ct, maxDim);
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
type ImageVerdict = { keep: boolean; role: 'garment' | 'fabric' | 'info'; colorway: string; hasPerson: boolean };

async function filterRelevantImages(
  images: string[],
  title: string,
  colorOptions: string[],
  geminiApiKey?: string,
): Promise<ImageVerdict[]> {
  // 분석 실패/키 없음 시 폴백 — 판단을 못 하면 전부 garment로 통과(기존 동작 보존)
  const passChunk = (chunk: string[]): ImageVerdict[] =>
    chunk.map(() => ({ keep: true, role: 'garment' as const, colorway: '', hasPerson: false }));
  if (!geminiApiKey || images.length === 0) return passChunk(images);
  const ai = new GoogleGenAI({ apiKey: geminiApiKey });

  // (2026-07-27) 캡 상향(제품컷 전부 수집)으로 한 번에 35장까지 올 수 있어, 한 번의 비전 호출에
  // 다 밀어넣으면 느려지고 인덱스 정렬이 흔들릴 위험이 있다. 12장씩 청크로 나눠 병렬 분류하고
  // 순서대로 이어붙인다(청크 실패는 그 청크만 fail-open).
  const CHUNK = 12;
  const classifyChunk = async (chunk: string[]): Promise<ImageVerdict[]> => {
    try {
      const parts: any[] = [
        {
          text: `These ${chunk.length} numbered photos (index 0 to ${chunk.length - 1}, in order) were scraped from a single product's detail page titled "${title || 'unknown'}"${colorOptions.length ? `, sold in these colorways: ${colorOptions.join(', ')}` : ''}. Some may be UNRELATED brand mood shots, a different product, banners/promos, or street photography that does not actually show this garment.

For EACH image return three things:
1. keep — true if it is at all related to THIS product (a photo of the garment worn/flat, a fabric close-up, a size chart, a colorway/spec info card, etc.); false ONLY if it is unrelated scenery/person, a clearly DIFFERENT garment, or a generic banner/promo with no info about this product.
   IMPORTANT — this product is sold in MULTIPLE COLORWAYS${colorOptions.length ? ` (${colorOptions.length}: ${colorOptions.join(', ')})` : ''}. A photo showing this SAME garment design in a different COLOR is still this product — keep it. Only a genuinely different garment (different silhouette, different category, different construction) counts as a different product. Never set keep=false merely because the color differs from the other photos.
2. role — classify HOW the image can be used, because some images must never be used as a rendering reference:
   - "garment" = a clean photo showing THIS SINGLE garment clearly (worn on one model, or laid flat/on a hanger), with NO heavy text overlay and NOT a multi-garment layout. These are the only images safe to recreate the product from.
   - "fabric" = a close-up of the fabric surface / a construction detail (stitching, button, weave) — one garment, zoomed in.
   - "info" = anything that is NOT a clean single-garment shot even though it relates to the product: a size chart, a text-heavy spec/marketing card, a "컬러뷰/color view" swatch sheet, a grid/collage showing SEVERAL garments or SEVERAL colors together, an "overview" card with feature bullets. These carry useful text but must NEVER be used to redraw the garment.
   Be strict: if an image shows more than one garment, or is mostly text, or is a color-swatch lineup, it is "info", not "garment" — even if a garment is visible in it.
3. colorway — WHICH single colorway of this product the garment in that photo actually is. Judge by the garment's real color${colorOptions.length ? ` and prefer EXACTLY one of these option names: ${colorOptions.join(', ')}. If the garment's real color clearly matches none of them, answer with a short plain Korean color word for what you actually see (예: 화이트, 블랙, 네이비, 그레이, 베이지) rather than forcing a wrong option` : ' — answer with a short plain Korean color word (예: 화이트, 블랙, 네이비, 그레이, 베이지)'}. If the image is "info" (size chart, text card, or a multi-color swatch/grid showing several colors at once), answer "unknown" — never pick one color off a multi-color sheet.
4. hasPerson — true if any part of a real human (face, or a body wearing the garment) is visible in the photo; false for flat-lay, ghost-mannequin, or pure fabric/hardware close-ups with no person at all.`,
      },
    ];
    chunk.forEach((img, i) => {
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
                  hasPerson: { type: Type.BOOLEAN },
                },
                required: ['index', 'keep', 'role', 'colorway', 'hasPerson'],
              },
            },
          },
          required: ['decisions'],
        } as any,
      },
    });
    const parsed = JSON.parse(response.text?.trim() || '{}');
    const decisions: Array<{ index: number; keep: boolean; role?: string; colorway?: string; hasPerson?: boolean }> =
      Array.isArray(parsed.decisions) ? parsed.decisions : [];
    const map = new Map(decisions.map((d) => [d.index, d]));
    // 판정이 없는 이미지는 안전하게 통과(fail-open) — 필터가 실수로 다 지우는 것보다 낫다
    return chunk.map((_, i) => {
      const d = map.get(i);
      const raw = (d?.colorway || '').trim();
      // (2026-07-29 2차) 예전엔 <select> 옵션명과 정확히 일치하지 않으면 색상을 통째로 버려서('')
      // 그 컷들이 전부 "색상 미판별"로 뭉쳐 색상 탭에서 구분이 안 됐다(대표님: "두 가지 색상밖에
      // 없어"). 옵션명과 맞으면 옵션명으로 정규화하고, 아니면 비전이 실제로 본 색 이름을 그대로
      // 살린다 — 이름이 조금 달라도 색끼리는 묶이는 게 버리는 것보다 훨씬 낫다.
      const matched = colorOptions.find((c) => c.toLowerCase() === raw.toLowerCase());
      const colorway = /^(unknown|알\s*수\s*없음|)$/i.test(raw) ? '' : matched || raw;
      const role: 'garment' | 'fabric' | 'info' =
        d?.role === 'fabric' || d?.role === 'info' ? d.role : 'garment';
      // info(스와치/텍스트/그리드)는 색상을 특정할 수 없으므로 항상 unknown 취급 — 색상 필터 오염 방지
      return { keep: d?.keep ?? true, role, colorway: role === 'info' ? '' : colorway, hasPerson: d?.hasPerson ?? false };
    });
  } catch (err) {
    console.warn('[from-link] 이미지 관련성 필터 청크 실패 — 이 청크는 생략(전부 통과):', err);
    return passChunk(chunk);
  }
  };

  // 12장씩 청크로 나눠 병렬 분류 후 순서대로 이어붙인다.
  const chunks: string[][] = [];
  for (let i = 0; i < images.length; i += CHUNK) chunks.push(images.slice(i, i + CHUNK));
  const chunkResults = await Promise.all(chunks.map((c) => classifyChunk(c)));
  return chunkResults.flat();
}

export async function POST(req: Request) {
  try {
    const { url, geminiApiKey, thumbnails } = (await req.json()) as {
      url: string;
      geminiApiKey?: string;
      /** true면 갤러리용 저용량 썸네일 + 원본 URL 반환(수십 장 수집 가능). AI 룩북이 사용. */
      thumbnails?: boolean;
    };
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
    const html = decodeHtmlBody(res, await res.arrayBuffer());

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

    // (2026-07-29) 썸네일 모드 — 갤러리에 수십 장을 보여주려면 장당 용량을 줄여야 한다.
    // 이미지 원본 URL을 같이 반환해, 실제 생성 단계에서 선택된 것만 서버가 고해상도로
    // 다시 받아 쓰도록 한다(브라우저를 왕복하며 수 MB를 나르지 않는다).
    // (2026-07-29 2차) 갤러리 썸네일은 화면에서 150px 정도로만 보이므로 256px면 충분하다.
    // 512px일 때 100장이면 응답이 10MB 가까이 되어 전송만으로도 느렸다(대표님: "왜이렇게 더뎌").
    // 256px이면 장당 ~15KB라 130장도 3MB 안쪽에서 처리된다.
    const thumbDim = thumbnails ? 256 : undefined;
    const downloadBucket = async (urls: string[], cap: number) => {
      const out: Array<{ data: string; url: string }> = [];
      // 16장씩 병렬 — 6장씩으로는 100장 받는 데 라운드가 17번이라 체감이 느렸다.
      const CONC = 16;
      for (let i = 0; i < urls.length && out.length < cap; i += CONC) {
        const batch = urls.slice(i, i + CONC);
        const results = await Promise.all(
          batch.map(async (u) => ({ url: u, data: await downloadImage(u, referer, thumbDim) })),
        );
        for (const r of results) {
          if (r.data && out.length < cap) out.push({ data: r.data, url: r.url });
        }
      }
      return out;
    };

    // 썸네일 모드에서는 색상별 큐레이션이 목적이므로 사실상 자르지 않는다 — 색상 구간이
    // 하나라도 빠지면 그 색은 아예 고를 수 없다(대표님 신고의 근본 원인).
    const productImagesRaw = await downloadBucket(official, thumbnails ? 120 : 20);
    const materialImagesRaw = await downloadBucket(detail, thumbnails ? 120 : 15);

    // 무관 이미지 필터 + 이미지별 역할(garment/fabric/info)·컬러웨이 판별 — 두 버킷을 합쳐
    // 한 번에 검사(호출 절약)한다. (2026-07-23) 예전엔 URL 출처(official/detail)로만 버킷을
    // 나눠서, 상세페이지의 "컬러뷰 스와치 시트/텍스트 카드"가 그대로 productImages(=생성 편집
    // 원본)로 들어가 완전히 다른 옷이 나오는 사고가 있었다. 이제 출처가 아니라 판별된 역할로
    // 다시 버킷을 나눈다: garment=생성 가능한 단독 착용/누끼 컷, fabric=원단 클로즈업,
    // info=사이즈표/스와치/그리드/텍스트 카드(분석 텍스트로만 쓰고 생성기엔 절대 안 넣음).
    const combined = [...productImagesRaw, ...materialImagesRaw];
    const verdicts = await filterRelevantImages(
      combined.map((x) => x.data),
      title,
      options.colors,
      geminiApiKey,
    );
    const kept = combined.map((x, i) => ({ img: x.data, srcUrl: x.url, v: verdicts[i] })).filter((x) => x.v.keep);

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
    // 썸네일 모드에서 실제 생성 시 고해상도로 다시 받기 위한 원본 URL (인덱스 정렬 유지)
    const productImageUrls = productKept.map((x) => x.srcUrl);
    const materialImageUrls = materialKept.map((x) => x.srcUrl);
    // 사진에서 실제로 판별된 색상들(등장 횟수 많은 순) — <select>에 없는 색도 탭에 띄운다
    const colorCounts = new Map<string, number>();
    for (const c of productImageColors) {
      if (c) colorCounts.set(c, (colorCounts.get(c) || 0) + 1);
    }
    const detectedColors = Array.from(colorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([c]) => c);
    // (2026-07-28) 이 컷에 실제 사람(다른 판매처 모델 등)이 찍혀 있는지 — 프론트가 생성 입력으로
    // 쓸 보조컷을 고를 때 인물 없는 컷을 우선하도록. 대표컷 1장이 사람 착용샷인 건 정상(항상 그래왔음).
    const productImageHasPerson = productKept.map((x) => x.v.hasPerson);
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
      // 썸네일 모드용 원본 URL — 생성 단계에서 선택된 것만 서버가 고해상도로 다시 받는다
      productImageUrls,
      materialImageUrls,
      // 실제로 사진에서 판별된 색상 목록 — <select> 옵션에 없는 색도 탭으로 노출하기 위함
      detectedColors,
      // 대표컷 외 보조(otherAngles) 후보 선택 시 인물 사진을 뒤로 미루기 위한 플래그
      productImageHasPerson,
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
