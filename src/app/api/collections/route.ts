/**
 * /api/collections/route.ts
 * 히스토리 결과물을 폴더(컬렉션)로 정리하는 CRUD 엔드포인트.
 * - GET: 폴더 목록
 * - POST { name }: 폴더 생성
 * - PATCH { action, id, ... }: rename / delete / addItems / removeItems
 * 저장은 Storage JSON(collections-store) — DDL 불필요.
 */

import { NextResponse } from 'next/server';
import {
  listCollections,
  createCollection,
  renameCollection,
  deleteCollection,
  updateCollectionItems,
} from '@/lib/collections-store';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const collections = await listCollections();
    return NextResponse.json({ success: true, collections });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || '폴더 조회 실패' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { name } = await req.json();
    const collection = await createCollection(name);
    return NextResponse.json({ success: true, collection });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || '폴더 생성 실패' }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { action, id } = body as {
      action: 'rename' | 'delete' | 'addItems' | 'removeItems';
      id: string;
    };
    if (!id) return NextResponse.json({ success: false, error: '폴더 id가 필요합니다.' }, { status: 400 });

    switch (action) {
      case 'rename':
        await renameCollection(id, body.name);
        break;
      case 'delete':
        await deleteCollection(id);
        break;
      case 'addItems':
        await updateCollectionItems(id, body.generationIds || [], 'add');
        break;
      case 'removeItems':
        await updateCollectionItems(id, body.generationIds || [], 'remove');
        break;
      default:
        return NextResponse.json({ success: false, error: '알 수 없는 action' }, { status: 400 });
    }
    const collections = await listCollections();
    return NextResponse.json({ success: true, collections });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || '폴더 수정 실패' }, { status: 500 });
  }
}
