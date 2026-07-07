'use client';

import React, { useEffect, useMemo, useState } from 'react';

interface HistoryEntry {
  id: string;
  imageUrl: string;
  prompt: string;
  poseLabel: string | null;
  createdAt: string;
  pipeline: 'fitting' | 'variation';
}

type FilterTab = 'all' | 'fitting' | 'variation';

async function fetchSource(source: 'fitting' | 'variation'): Promise<HistoryEntry[]> {
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

  useEffect(() => {
    (async () => {
      setIsLoading(true);
      const [fitting, variation] = await Promise.all([fetchSource('fitting'), fetchSource('variation')]);
      const merged = [...fitting, ...variation].sort(
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
      variation: entries.filter((e) => e.pipeline === 'variation').length,
    }),
    [entries],
  );

  const TABS: Array<{ id: FilterTab; label: string }> = [
    { id: 'all', label: `전체 (${counts.all})` },
    { id: 'fitting', label: `✨ AI 피팅 (${counts.fitting})` },
    { id: 'variation', label: `🧍 AI 바리에이션 (${counts.variation})` },
  ];

  return (
    <div className="max-w-6xl mx-auto px-8 py-8 space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-black text-gray-900 tracking-tight">📚 전체 히스토리</h2>
        <p className="text-xs text-gray-400">언제 어떤 파이프라인에서 어떤 결과가 나왔는지 한눈에 확인하세요.</p>
      </div>

      <div className="flex items-center gap-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setFilter(tab.id)}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition border ${
              filter === tab.id
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center py-24 text-sm text-gray-400">불러오는 중...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-24 space-y-2">
          <div className="text-3xl">📭</div>
          <p className="text-sm font-bold text-gray-400">아직 생성 기록이 없습니다.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-4">
          {filtered.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setSelected(entry)}
              className="text-left rounded-2xl overflow-hidden border border-gray-200 hover:border-gray-400 transition group relative shadow-sm"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={entry.imageUrl}
                alt={entry.poseLabel || entry.pipeline}
                className="w-full aspect-[3/4] object-cover group-hover:scale-105 transition duration-300"
              />
              <div className="absolute top-2 left-2 px-2 py-1 rounded-full bg-black/70 backdrop-blur-sm text-[9px] font-bold text-white">
                {entry.pipeline === 'fitting' ? '✨ AI 피팅' : '🧍 AI 바리에이션'}
              </div>
              <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-2.5 py-2.5">
                <div className="text-[10px] font-bold text-white truncate">{entry.poseLabel || '결과'}</div>
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
            className="bg-white rounded-3xl p-6 max-w-3xl w-full max-h-[90vh] overflow-auto space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 rounded-full bg-gray-900 text-white text-[10px] font-bold">
                  {selected.pipeline === 'fitting' ? '✨ AI 피팅' : '🧍 AI 바리에이션'}
                </span>
                <span className="text-xs text-gray-400">
                  {new Date(selected.createdAt).toLocaleString('ko-KR')}
                </span>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="text-gray-400 hover:text-gray-700 text-sm font-bold"
              >
                ✕ 닫기
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={selected.imageUrl} alt={selected.poseLabel || ''} className="w-full rounded-2xl max-h-[60vh] object-contain bg-gray-50" />
            {selected.poseLabel && (
              <div className="text-xs font-bold text-gray-900">{selected.poseLabel}</div>
            )}
            {selected.prompt && (
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-[11px] text-gray-500 font-mono leading-relaxed max-h-40 overflow-auto">
                {selected.prompt}
              </div>
            )}
            <a
              href={selected.imageUrl}
              download={`history_${selected.id}.png`}
              className="inline-flex px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-900 font-bold text-xs transition border border-gray-200"
            >
              ⬇️ 다운로드
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
