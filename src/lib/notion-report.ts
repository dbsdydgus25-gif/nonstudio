/**
 * notion-report.ts
 * 사업운영/scripts/notion-daily-report.mjs의 요청 형태를 그대로 포팅 — 아침/저녁이
 * 같은 날 페이지를 공유하는 로직(날짜로 오늘 페이지 먼저 조회) 포함. Vercel Cron이
 * 로컬 스크립트 대신 이 함수들을 직접 호출한다.
 */
const NOTION_VERSION = '2022-06-28';

interface TeamItems {
  [team: string]: string[];
}

async function notion(token: string, path: string, method: string, body?: unknown) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function heading(text: string, level: 2 | 3 = 2) {
  const key = level === 2 ? 'heading_2' : 'heading_3';
  return { object: 'block', type: key, [key]: { rich_text: [{ type: 'text', text: { content: text } }] } };
}

function richTextWithLinks(text: string) {
  const urlPattern = /https?:\/\/[^\s)]+/g;
  const parts: any[] = [];
  let lastIndex = 0;
  let match;
  while ((match = urlPattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push({ type: 'text', text: { content: text.slice(lastIndex, match.index) } });
    parts.push({ type: 'text', text: { content: match[0], link: { url: match[0] } } });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push({ type: 'text', text: { content: text.slice(lastIndex) } });
  return parts.length ? parts : [{ type: 'text', text: { content: text } }];
}

function bullet(text: string) {
  return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: richTextWithLinks(text) } };
}

function teamBlocks(teams: TeamItems) {
  const blocks: any[] = [];
  for (const [team, items] of Object.entries(teams || {})) {
    blocks.push(heading(team, 3));
    if (!items || items.length === 0) blocks.push(bullet('(기록 없음)'));
    else for (const item of items) blocks.push(bullet(item));
  }
  return blocks;
}

async function findTodayPage(token: string, dbId: string, date: string) {
  const result = await notion(token, `/databases/${dbId}/query`, 'POST', {
    filter: { property: '날짜', date: { equals: date } },
  });
  return result.results[0] || null;
}

export interface MorningReport {
  date: string;
  teams: TeamItems;
  issues: string[];
}

export interface EveningReport extends MorningReport {
  budgetSpent?: number;
  budgetRemaining?: number;
  sourcingCount?: number;
  contentCount?: number;
}

/** 어제 회의록 페이지의 이슈 항목을 읽어온다 — 아침 리포트가 "미완료 항목"을 참고하는 용도 */
export async function getYesterdayIssues(token: string, dbId: string, yesterdayDate: string): Promise<string[]> {
  const page = await findTodayPage(token, dbId, yesterdayDate);
  if (!page) return [];
  try {
    const blocks = await notion(token, `/blocks/${page.id}/children?page_size=100`, 'GET');
    const results: any[] = blocks.results || [];
    const idx = results.findIndex(
      (b) => b.type === 'heading_2' && b.heading_2?.rich_text?.[0]?.text?.content?.includes('이슈'),
    );
    if (idx < 0) return [];
    const issues: string[] = [];
    for (let i = idx + 1; i < results.length && results[i].type === 'bulleted_list_item'; i++) {
      const text = results[i].bulleted_list_item?.rich_text?.map((t: any) => t.text?.content || '').join('') || '';
      if (text && text !== '(기록 없음)') issues.push(text);
    }
    return issues;
  } catch {
    return [];
  }
}

export async function writeMorningReport(token: string, dbId: string, report: MorningReport): Promise<string> {
  const existing = await findTodayPage(token, dbId, report.date);
  const children = [
    heading('🌅 오늘 할 일'),
    ...teamBlocks(report.teams),
    heading('⚠️ 이슈/확인 필요'),
    ...(report.issues || []).map(bullet),
  ];
  if (existing) {
    await notion(token, `/blocks/${existing.id}/children`, 'PATCH', { children });
    return existing.url;
  }
  const page = await notion(token, '/pages', 'POST', {
    parent: { database_id: dbId },
    properties: {
      제목: { title: [{ text: { content: report.date } }] },
      날짜: { date: { start: report.date } },
      상태: { select: { name: '🌅 계획' } },
    },
    children,
  });
  return page.url;
}

export async function writeEveningReport(token: string, dbId: string, report: EveningReport): Promise<string> {
  const existing = await findTodayPage(token, dbId, report.date);
  const props: Record<string, unknown> = { 상태: { select: { name: '🌙 완료' } } };
  if (report.budgetSpent != null) props['예산 소진(원)'] = { number: report.budgetSpent };
  if (report.budgetRemaining != null) props['잔여 예산(원)'] = { number: report.budgetRemaining };
  if (report.sourcingCount != null) props['소싱 누적(개)'] = { number: report.sourcingCount };
  if (report.contentCount != null) props['콘텐츠 누적(개)'] = { number: report.contentCount };

  const eveningBlocks = [heading('🌙 오늘 한 일'), ...teamBlocks(report.teams)];
  if (report.issues?.length) eveningBlocks.push(heading('⚠️ 이슈/확인 필요'), ...report.issues.map(bullet));

  if (existing) {
    await notion(token, `/pages/${existing.id}`, 'PATCH', { properties: props });
    await notion(token, `/blocks/${existing.id}/children`, 'PATCH', { children: eveningBlocks });
    return existing.url;
  }
  const page = await notion(token, '/pages', 'POST', {
    parent: { database_id: dbId },
    properties: {
      제목: { title: [{ text: { content: report.date } }] },
      날짜: { date: { start: report.date } },
      ...props,
    },
    children: eveningBlocks,
  });
  return page.url;
}

/** "작업기록" DB에서 오늘 날짜의 행을 팀별로 그룹핑해서 읽어온다 */
export async function getTodayWorklog(
  token: string,
  worklogDbId: string,
  date: string,
): Promise<{ teams: TeamItems; budget: { cost: number; margin: number | null; remaining: number | null } }> {
  const result = await notion(token, `/databases/${worklogDbId}/query`, 'POST', {
    filter: { property: '날짜', date: { equals: date } },
  });
  const teams: TeamItems = { 개발팀: [], 사업기획팀: [], 마케팅팀: [] };
  let cost = 0;
  let margin: number | null = null;
  let remaining: number | null = null;
  for (const row of result.results || []) {
    const p = row.properties;
    const team = p['팀']?.select?.name as string | undefined;
    const content = p['내용']?.title?.[0]?.text?.content as string | undefined;
    if (team && content && teams[team]) teams[team].push(content);
    if (p['원가(원)']?.number != null) cost += p['원가(원)'].number;
    if (p['마진율']?.number != null) margin = p['마진율'].number;
    if (p['잔여예산(원)']?.number != null) remaining = p['잔여예산(원)'].number;
  }
  return { teams, budget: { cost, margin, remaining } };
}
