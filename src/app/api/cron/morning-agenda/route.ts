/**
 * /api/cron/morning-agenda
 * 맥이 꺼져 있어도 매일 아침 도는 Vercel Cron 버전 — 기존 로컬 SKILL
 * (nonstudio-morning-agenda)의 "오늘 할 일 정리" 원칙은 사실 대부분 고정 규칙(사업기획팀
 * 소싱 1개, 마케팅팀 콘텐츠 1개, 어제 미완료 항목 이월)이라 AI 판단이 필요 없다 — 그대로
 * 템플릿 코드로 옮겨서 Claude API 호출/비용 없이 결정론적으로 처리한다(ponytail: 안 쓰는
 * 복잡도는 추가하지 않음).
 */
import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { getFreshCafe24AccessToken } from '@/lib/cafe24-token-store';
import { getYesterdayIssues, writeMorningReport } from '@/lib/notion-report';

export const runtime = 'nodejs';
export const maxDuration = 60;

function todayKST(): { today: string; yesterday: string } {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const today = kst.toISOString().slice(0, 10);
  const y = new Date(kst.getTime() - 24 * 60 * 60 * 1000);
  return { today, yesterday: y.toISOString().slice(0, 10) };
}

async function countCafe24OrdersToday(): Promise<number | null> {
  try {
    const accessToken = await getFreshCafe24AccessToken({
      mallId: process.env.CAFE24_MALL_ID!,
      clientId: process.env.CAFE24_CLIENT_ID!,
      clientSecret: process.env.CAFE24_CLIENT_SECRET!,
    });
    const { today } = todayKST();
    const res = await fetch(
      `https://${process.env.CAFE24_MALL_ID}.cafe24api.com/api/v2/admin/orders?start_date=${today}&end_date=${today}&limit=50`,
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data.orders || []).length;
  } catch (err) {
    console.error('[cron/morning-agenda] 카페24 주문 확인 실패:', err);
    return null;
  }
}

async function countNaverOrdersToday(): Promise<number | null> {
  try {
    const clientId = process.env.NAVER_CLIENT_ID!;
    const clientSecret = process.env.NAVER_CLIENT_SECRET!;
    const timestamp = Date.now().toString();
    const signature = Buffer.from(bcrypt.hashSync(`${clientId}_${timestamp}`, clientSecret), 'utf-8').toString(
      'base64',
    );
    const tokenRes = await fetch('https://api.commerce.naver.com/external/v1/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        timestamp,
        client_secret_sign: signature,
        grant_type: 'client_credentials',
        type: 'SELF',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) return null;

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const url = new URL(
      'https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/last-changed-statuses',
    );
    url.searchParams.set('lastChangedFrom', `${from.toISOString().slice(0, 19)}.000+09:00`);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.data?.lastChangeStatuses || data.lastChangeStatuses || []).length;
  } catch (err) {
    console.error('[cron/morning-agenda] 네이버 주문 확인 실패:', err);
    return null;
  }
}

export async function GET(req: Request) {
  const auth = req.headers.get('authorization');
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: '인증 실패' }, { status: 401 });
  }

  const { today, yesterday } = todayKST();

  const [cafe24Count, naverCount, yesterdayIssues] = await Promise.all([
    countCafe24OrdersToday(),
    countNaverOrdersToday(),
    getYesterdayIssues(process.env.NOTION_TOKEN!, process.env.NOTION_DB_ID!, yesterday),
  ]);

  const totalOrders = (cafe24Count ?? 0) + (naverCount ?? 0);
  const issues: string[] = [...yesterdayIssues];
  if (cafe24Count == null) issues.push('카페24 주문 확인 자동화 오류 — 확인 필요');
  if (naverCount == null) issues.push('네이버 주문 확인 자동화 오류 — 확인 필요');

  const bizGoal =
    totalOrders > 0
      ? `오늘 소싱 1개 이상 리서치 목표 (오늘 주문 ${totalOrders}건 발주/올빗풀필먼트 전달 확인 필요)`
      : '오늘 소싱 1개 이상 리서치 목표';

  const teams = {
    개발팀: ['논피팅 앱 미해결 이슈/사용자 피드백 반영, 없으면 안정화·모니터링'],
    사업기획팀: [bizGoal],
    마케팅팀: ['오늘 콘텐츠 1개 이상 제작 목표'],
  };

  const url = await writeMorningReport(process.env.NOTION_TOKEN!, process.env.NOTION_DB_ID!, {
    date: today,
    teams,
    issues,
  });

  return NextResponse.json({ success: true, date: today, notionUrl: url, cafe24Count, naverCount });
}
