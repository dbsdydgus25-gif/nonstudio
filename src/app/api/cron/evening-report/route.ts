/**
 * /api/cron/evening-report
 * 저녁 리포트 — "작업기록" Notion DB(팀별 오늘 행) + GitHub 공개 API(오늘 커밋, 로컬
 * git log 대체) + 예산 숫자를 모아 회의록 페이지를 갱신하고 이메일을 보낸다.
 * 여기도 요약은 고정 템플릿이라 Claude API 없이 결정론적으로 처리한다(비용/실패 지점 최소화).
 */
import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { getTodayWorklog, writeEveningReport } from '@/lib/notion-report';

export const runtime = 'nodejs';
export const maxDuration = 60;

function todayKST(): string {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

async function getTodayCommits(): Promise<string[]> {
  try {
    const since = `${todayKST()}T00:00:00+09:00`;
    const res = await fetch(
      `https://api.github.com/repos/dbsdydgus25-gif/nonstudio/commits?since=${encodeURIComponent(since)}`,
      { headers: { Accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data as any[]).map((c) => c.commit?.message?.split('\n')[0]).filter(Boolean);
  } catch {
    return [];
  }
}

function buildEmailBody(date: string, teams: Record<string, string[]>, budget: any, notionUrl: string): string {
  const section = (name: string) =>
    teams[name]?.length ? teams[name].map((s) => `- ${s}`).join('\n') : '- 기록 없음';
  return `[논스튜디오/논피팅] ${date} 일일 보고

■ 오늘 한 일
개발팀:
${section('개발팀')}

사업기획팀:
${section('사업기획팀')}

마케팅팀:
${section('마케팅팀')}

■ 목표 대비 진행
- 오늘 소싱 원가: ${budget.cost.toLocaleString()}원
- 잔여 예산: ${budget.remaining != null ? budget.remaining.toLocaleString() + '원' : '(기록 없음)'}

■ 내일 할 일
- 매일 필수: 소싱 1개 + 콘텐츠 1개

노션 회의록: ${notionUrl}
`;
}

export async function GET(req: Request) {
  const auth = req.headers.get('authorization');
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: '인증 실패' }, { status: 401 });
  }

  const date = todayKST();
  const [{ teams, budget }, commits] = await Promise.all([
    getTodayWorklog(process.env.NOTION_TOKEN!, process.env.WORKLOG_DB_ID!, date),
    getTodayCommits(),
  ]);
  teams['개발팀'] = commits.length ? commits : teams['개발팀'];

  const sourcingCount = teams['사업기획팀']?.length || 0;
  const contentCount = teams['마케팅팀']?.length || 0;

  const notionUrl = await writeEveningReport(process.env.NOTION_TOKEN!, process.env.NOTION_DB_ID!, {
    date,
    teams,
    issues: [],
    budgetSpent: budget.cost || undefined,
    budgetRemaining: budget.remaining ?? undefined,
    sourcingCount,
    contentCount,
  });

  let emailSent = false;
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.REPORT_TO || process.env.GMAIL_USER,
      subject: `[논스튜디오/논피팅] ${date} 일일 보고`,
      text: buildEmailBody(date, teams, budget, notionUrl),
    });
    emailSent = true;
  }

  return NextResponse.json({ success: true, date, notionUrl, emailSent });
}
