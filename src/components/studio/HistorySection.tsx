'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { downloadResultImage } from '@/lib/download-image';

interface HistoryEntry {
  id: string;
  imageUrl: string;
  prompt: string;
  poseLabel: string | null;
  createdAt: string;
  pipeline: 'fitting' | 'product' | 'variation';
}

type FilterTab = 'all' | 'fitting' | 'product' | 'variation';

const PIPELINE_LABEL: Record<HistoryEntry['pipeline'], string> = {
  fitting: 'AI 피팅',
  product: 'AI 제품 피팅',
  variation: 'AI 바리에이션',
};

async function fetchSource(source: 'fitting' | 'product' | 'variation'): Promise<HistoryEntry[]> {
  try {
    const res = await fetch(`/api/generations/history?source=${source}`);
    const data = await res.json();
    if (!data.success) return [];
    return (data.items || []).map((item: any) => ({
      id: item.id,
      imageUrl: item.imageUrl,
      prompt: item.prompt,
      poseLabel: item.poseLabel,
      createdAt: item.createdAt,
      pipeline: source,
    }));
  } catch {
    return [];
  }
}

export function HistorySection() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  useEffect(() => {
    (async () => {
      setIsLoading(true);
      const [fitting, product, variation] = await Promise.all([
        fetchSource('fitting'),
        fetchSource('product'),
        fetchSource('variation'),
      ]);
      const merged = [...fitting, ...product, ...variation].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      setEntries(merged);
      setIsLoading(false);
    })();
  }, []);

  const filtered = useMemo(
    () => (filter === 'all' ? entries : entries.filter((e) => e.pipeline === filter)),
    [entries, filter],
  );

  const counts = useMemo(
    () => ({
      all: entries.length,
      fitting: entries.filter((e) => e.pipeline === 'fitting').length,
      product: entries.filter((e) => e.pipeline === 'product').length,
      variation: entries.filter((e) => e.pipeline === 'variation').length,
    }),
    [entries],
  );

  const TABS: Array<{ id: FilterTab; label: string }> = [
    { id: 'all', label: `전체 ${counts.all}` },
    { id: 'fitting', label: `AI 피팅 ${counts.fitting}` },
    { id: 'product', label: `AI 제품 피팅 ${counts.product}` },
    { id: 'variation', label: `AI 바리에이션 ${counts.variation}` },
  ];

  return (
    <div className="max-w-6xl mx-auto px-8 py-10 space-y-8">
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-400">Library</div>
        <h2 className="text-lg font-semibold text-gray-900 tracking-tight">전체 히스토리</h2>
        <p className="text-xs text-gray-400">모든 파이프라인의 생성 기록을 한곳에서 확인합니다.</p>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setFilter(tab.id)}
            className={`px-4 py-2 rounded-lg text-xs font-medium tracking-wide transition border ${
              filter === tab.id
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center py-24 text-sm text-gray-400">불러오는 중</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-24 space-y-2">
          <p className="text-sm font-medium text-gray-400">아직 생성 기록이 없습니다</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3">
          {filtered.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setSelected(entry)}
              className="text-left rounded-lg overflow-hidden border border-gray-200 hover:border-gray-400 transition group relative"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={entry.imageUrl}
                alt={entry.poseLabel || entry.pipeline}
                className="w-full aspect-[3/4] object-cover group-hover:scale-105 transition duration-300"
              />
              <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/60 backdrop-blur-sm text-[9px] font-medium tracking-wide text-white">
                {PIPELINE_LABEL[entry.pipeline]}
              </div>
              <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent px-2.5 py-2.5">
                <div className="text-[10px] font-medium text-white truncate">{entry.poseLabel || '결과'}</div>
                <div className="text-[9px] text-white/70">
                  {new Date(entry.createdAt).toLocaleString('ko-KR', {
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 상세 보기 모달 */}
      {selected && (
        <div
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur-xl flex items-center justify-center p-4 animate-fade-in"
          onClick={() => setSelected(null)}
        >
          <div
            className="bg-white rounded-2xl p-6 max-w-3xl w-full max-h-[90vh] overflow-auto space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 rounded-md bg-gray-900 text-white text-[10px] font-medium tracking-wide">
                  {PIPELINE_LABEL[selected.pipeline]}
                </span>
                <span className="text-xs text-gray-400">
                  {new Date(selected.createdAt).toLocaleString('ko-KR')}
                </span>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="text-gray-400 hover:text-gray-900 text-sm font-medium"
              >
                닫기
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={selected.imageUrl} alt={selected.poseLabel || ''} className="w-full rounded-xl max-h-[60vh] object-contain bg-gray-50" />
            {selected.poseLabel && (
              <div className="text-xs font-semibold text-gray-900">{selected.poseLabel}</div>
            )}
            {selected.prompt && (
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-[11px] text-gray-500 font-mono leading-relaxed max-h-40 overflow-auto">
                {selected.prompt}
              </div>
            )}
            <button
              disabled={isDownloading}
              onClick={async () => {
                // cross-origin <a download>는 무시되고, 서명 URL은 1시간 만료라 프록시로 받는다
                setIsDownloading(true);
                try {
                  await downloadResultImage(selected.imageUrl, `history_${selected.id}.png`);
                } catch (err: any) {
                  alert(err?.message || '다운로드에 실패했습니다.');
                } finally {
                  setIsDownloading(false);
                }
              }}
              className="inline-flex px-4 py-2 rounded-lg border border-gray-200 hover:border-gray-400 text-gray-700 font-medium text-xs tracking-wide transition disabled:opacity-40"
            >
              {isDownloading ? '다운로드 중...' : '다운로드'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
