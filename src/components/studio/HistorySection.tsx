'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { downloadResultImage } from '@/lib/download-image';

interface HistoryEntry {
  id: string;
  imageUrl: string;
  prompt: string;
  poseLabel: string | null;
  createdAt: string;
  pipeline: 'fitting' | 'product' | 'variation';
  isHd: boolean;
}

interface Collection {
  id: string;
  name: string;
  createdAt: string;
  generationIds: string[];
}

type FilterTab = 'all' | 'fitting' | 'product' | 'variation';

const HD_PREFIX = '[HD] ';

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
    return (data.items || []).map((item: any) => {
      const poseLabel: string | null = item.poseLabel ?? null;
      const isHd = !!poseLabel && poseLabel.startsWith(HD_PREFIX);
      return {
        id: item.id,
        imageUrl: item.imageUrl,
        prompt: item.prompt,
        poseLabel: isHd ? poseLabel.slice(HD_PREFIX.length) : poseLabel,
        createdAt: item.createdAt,
        pipeline: source,
        isHd,
      };
    });
  } catch {
    return [];
  }
}

export function HistorySection() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<HistoryEntry | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [hdPendingIds, setHdPendingIds] = useState<string[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refetchHistory = useCallback(async () => {
    const [fitting, product, variation] = await Promise.all([
      fetchSource('fitting'),
      fetchSource('product'),
      fetchSource('variation'),
    ]);
    const merged = [...fitting, ...product, ...variation].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    setEntries(merged);
  }, []);

  const refetchCollections = useCallback(async () => {
    try {
      const res = await fetch('/api/collections');
      const data = await res.json();
      if (data.success) setCollections(data.collections || []);
    } catch {
      /* 폴더 조회 실패는 조용히 무시 */
    }
  }, []);

  useEffect(() => {
    (async () => {
      setIsLoading(true);
      await Promise.all([refetchHistory(), refetchCollections()]);
      setIsLoading(false);
    })();
  }, [refetchHistory, refetchCollections]);

  // 고화질 리마스터 진행 폴링 — 모두 끝나면 히스토리 새로고침
  useEffect(() => {
    if (hdPendingIds.length === 0) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/generations/status?ids=${hdPendingIds.join(',')}`);
        const data = await res.json();
        if (!data.success) return;
        const done = (data.items || []).filter((i: any) => i.status === 'completed' || i.status === 'failed');
        if (done.length >= hdPendingIds.length) {
          setHdPendingIds([]);
          setBusyMsg(null);
          await refetchHistory();
        }
      } catch {
        /* 폴링 실패는 다음 tick에서 재시도 */
      }
    }, 3000);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [hdPendingIds, refetchHistory]);

  const folderMemberIds = useMemo(() => {
    if (!activeFolderId) return null;
    const col = collections.find((c) => c.id === activeFolderId);
    return col ? new Set(col.generationIds) : new Set<string>();
  }, [activeFolderId, collections]);

  const filtered = useMemo(() => {
    let list = filter === 'all' ? entries : entries.filter((e) => e.pipeline === filter);
    if (folderMemberIds) list = list.filter((e) => folderMemberIds.has(e.id));
    return list;
  }, [entries, filter, folderMemberIds]);

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

  const selectedCount = selectedIds.size;

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const selectAllVisible = () => setSelectedIds(new Set(filtered.map((e) => e.id)));

  // 선택한 결과들을 고화질로 일괄 리마스터
  const handleBulkUpscale = async () => {
    if (selectedCount === 0) return;
    const ids = Array.from(selectedIds);
    setBusyMsg(`${ids.length}장 고화질 생성 요청 중...`);
    try {
      const res = await fetch('/api/generations/upscale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generationIds: ids }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || '고화질 요청 실패');
      const jobIds: string[] = (data.jobs || []).map((j: any) => j.generationId);
      setHdPendingIds(jobIds);
      setBusyMsg(`${jobIds.length}장 고화질 생성 중... (완료되면 자동으로 목록에 추가됩니다)`);
      clearSelection();
      setSelectionMode(false);
    } catch (err: any) {
      setBusyMsg(null);
      alert(err?.message || '고화질 처리에 실패했습니다.');
    }
  };

  // 선택한 결과들을 폴더에 담기
  const handleAddToFolder = async (folderId: string) => {
    if (selectedCount === 0) return;
    setFolderMenuOpen(false);
    try {
      const res = await fetch('/api/collections', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'addItems', id: folderId, generationIds: Array.from(selectedIds) }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setCollections(data.collections || []);
      const folder = (data.collections || []).find((c: Collection) => c.id === folderId);
      setBusyMsg(`${selectedCount}장을 "${folder?.name || '폴더'}"에 담았습니다.`);
      setTimeout(() => setBusyMsg(null), 2500);
      clearSelection();
    } catch (err: any) {
      alert(err?.message || '폴더에 담지 못했습니다.');
    }
  };

  const handleCreateFolderAndAdd = async () => {
    const name = prompt('새 폴더 이름을 입력하세요');
    if (name === null) return;
    try {
      const res = await fetch('/api/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      await refetchCollections();
      if (selectedCount > 0) await handleAddToFolder(data.collection.id);
    } catch (err: any) {
      alert(err?.message || '폴더 생성 실패');
    }
  };

  const handleRenameFolder = async (col: Collection) => {
    const name = prompt('폴더 이름 변경', col.name);
    if (name === null) return;
    try {
      const res = await fetch('/api/collections', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rename', id: col.id, name }),
      });
      const data = await res.json();
      if (data.success) setCollections(data.collections || []);
    } catch {
      /* 무시 */
    }
  };

  const handleDeleteFolder = async (col: Collection) => {
    if (!confirm(`"${col.name}" 폴더를 삭제할까요? (안의 이미지는 지워지지 않고 폴더 분류만 사라집니다)`)) return;
    try {
      const res = await fetch('/api/collections', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id: col.id }),
      });
      const data = await res.json();
      if (data.success) {
        setCollections(data.collections || []);
        if (activeFolderId === col.id) setActiveFolderId(null);
      }
    } catch {
      /* 무시 */
    }
  };

  const handleRemoveFromFolder = async (folderId: string, ids: string[]) => {
    try {
      const res = await fetch('/api/collections', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'removeItems', id: folderId, generationIds: ids }),
      });
      const data = await res.json();
      if (data.success) setCollections(data.collections || []);
    } catch {
      /* 무시 */
    }
  };

  // 선택한 결과들 순차 다운로드
  const handleBulkDownload = async () => {
    const targets = filtered.filter((e) => selectedIds.has(e.id));
    if (targets.length === 0) return;
    setIsDownloading(true);
    setBusyMsg(`${targets.length}장 다운로드 중...`);
    try {
      for (let i = 0; i < targets.length; i++) {
        const e = targets[i];
        const tag = e.isHd ? 'HD_' : '';
        await downloadResultImage(e.imageUrl, `${tag}${e.pipeline}_${e.id}.png`);
        await new Promise((r) => setTimeout(r, 400)); // 연속 다운로드 브라우저 차단 완화
      }
      setBusyMsg(`${targets.length}장 다운로드 완료`);
      setTimeout(() => setBusyMsg(null), 2000);
    } catch (err: any) {
      alert(err?.message || '다운로드에 실패했습니다.');
      setBusyMsg(null);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-8 py-10 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-400">Library</div>
          <h2 className="text-lg font-semibold text-gray-900 tracking-tight">전체 히스토리</h2>
          <p className="text-xs text-gray-400">
            생성 결과를 폴더로 정리하고, 마음에 드는 컷만 골라 고화질로 다시 뽑을 수 있습니다.
          </p>
        </div>
        <button
          onClick={() => {
            setSelectionMode((v) => !v);
            clearSelection();
            setFolderMenuOpen(false);
          }}
          className={`shrink-0 px-4 py-2 rounded-lg text-xs font-medium tracking-wide transition border ${
            selectionMode
              ? 'bg-gray-900 text-white border-gray-900'
              : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
          }`}
        >
          {selectionMode ? '선택 종료' : '선택'}
        </button>
      </div>

      {/* 파이프라인 필터 */}
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

      {/* 폴더 레일 */}
      <div className="flex items-center gap-1.5 flex-wrap border-t border-gray-100 pt-4">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-300 mr-1">폴더</span>
        <button
          onClick={() => setActiveFolderId(null)}
          className={`px-3 py-1.5 rounded-full text-xs font-medium transition border ${
            activeFolderId === null
              ? 'bg-gray-900 text-white border-gray-900'
              : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
          }`}
        >
          전체 보기
        </button>
        {collections.map((col) => (
          <span
            key={col.id}
            className={`group inline-flex items-center gap-1 pl-3 pr-1.5 py-1.5 rounded-full text-xs font-medium transition border ${
              activeFolderId === col.id
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
            }`}
          >
            <button onClick={() => setActiveFolderId(col.id)}>
              {col.name} <span className="opacity-60">{col.generationIds.length}</span>
            </button>
            <button
              onClick={() => handleRenameFolder(col)}
              className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-[10px] px-0.5"
              title="이름 변경"
            >
              ✎
            </button>
            <button
              onClick={() => handleDeleteFolder(col)}
              className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-[10px] px-0.5"
              title="폴더 삭제"
            >
              ✕
            </button>
          </span>
        ))}
        <button
          onClick={handleCreateFolderAndAdd}
          className="px-3 py-1.5 rounded-full text-xs font-medium text-gray-400 border border-dashed border-gray-300 hover:border-gray-500 hover:text-gray-600 transition"
        >
          + 새 폴더
        </button>
      </div>

      {busyMsg && (
        <div className="rounded-lg bg-gray-900 text-white text-xs px-4 py-2.5 flex items-center gap-2">
          {hdPendingIds.length > 0 && (
            <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
          )}
          {busyMsg}
        </div>
      )}

      {isLoading ? (
        <div className="text-center py-24 text-sm text-gray-400">불러오는 중</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-24 space-y-2">
          <p className="text-sm font-medium text-gray-400">
            {activeFolderId ? '이 폴더에 담긴 결과가 없습니다' : '아직 생성 기록이 없습니다'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3">
          {filtered.map((entry) => {
            const isSel = selectedIds.has(entry.id);
            return (
              <div
                key={entry.id}
                onClick={() => (selectionMode ? toggleSelect(entry.id) : setSelected(entry))}
                className={`text-left rounded-lg overflow-hidden border transition group relative cursor-pointer ${
                  isSel ? 'border-gray-900 ring-2 ring-gray-900' : 'border-gray-200 hover:border-gray-400'
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={entry.imageUrl}
                  alt={entry.poseLabel || entry.pipeline}
                  className="w-full aspect-[3/4] object-cover group-hover:scale-105 transition duration-300"
                />
                {selectionMode && (
                  <div
                    className={`absolute top-2 right-2 w-5 h-5 rounded-md border-2 flex items-center justify-center text-[11px] ${
                      isSel ? 'bg-gray-900 border-gray-900 text-white' : 'bg-white/80 border-white'
                    }`}
                  >
                    {isSel ? '✓' : ''}
                  </div>
                )}
                <div className="absolute top-2 left-2 flex items-center gap-1">
                  <span className="px-2 py-0.5 rounded bg-black/60 backdrop-blur-sm text-[9px] font-medium tracking-wide text-white">
                    {PIPELINE_LABEL[entry.pipeline]}
                  </span>
                  {entry.isHd && (
                    <span className="px-1.5 py-0.5 rounded bg-emerald-500 text-[9px] font-bold tracking-wide text-white">
                      HD
                    </span>
                  )}
                </div>
                <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent px-2.5 py-2.5 pointer-events-none">
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
              </div>
            );
          })}
        </div>
      )}

      {/* 선택 모드 하단 액션바 */}
      {selectionMode && selectedCount > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-gray-900 text-white rounded-2xl shadow-2xl px-4 py-3 flex items-center gap-2 flex-wrap max-w-[95vw]">
          <span className="text-xs font-semibold px-2">{selectedCount}장 선택됨</span>
          <button
            onClick={selectAllVisible}
            className="text-[11px] text-white/60 hover:text-white px-2 py-1.5"
          >
            전체 선택
          </button>
          <div className="w-px h-5 bg-white/20" />
          <button
            onClick={handleBulkUpscale}
            disabled={hdPendingIds.length > 0}
            className="text-xs font-medium bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 rounded-lg px-3 py-1.5"
          >
            ✨ 고화질로 뽑기
          </button>
          <div className="relative">
            <button
              onClick={() => setFolderMenuOpen((v) => !v)}
              className="text-xs font-medium bg-white/10 hover:bg-white/20 rounded-lg px-3 py-1.5"
            >
              📁 폴더에 담기 ▾
            </button>
            {folderMenuOpen && (
              <div className="absolute bottom-full mb-2 left-0 bg-white text-gray-800 rounded-xl shadow-xl border border-gray-100 py-1.5 min-w-[180px] max-h-64 overflow-auto">
                {collections.length === 0 && (
                  <div className="px-3 py-2 text-[11px] text-gray-400">폴더가 없습니다</div>
                )}
                {collections.map((col) => (
                  <button
                    key={col.id}
                    onClick={() => handleAddToFolder(col.id)}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 flex items-center justify-between"
                  >
                    <span>{col.name}</span>
                    <span className="text-gray-300">{col.generationIds.length}</span>
                  </button>
                ))}
                <div className="border-t border-gray-100 mt-1 pt-1">
                  <button
                    onClick={handleCreateFolderAndAdd}
                    className="w-full text-left px-3 py-2 text-xs text-gray-500 hover:bg-gray-50"
                  >
                    + 새 폴더 만들어 담기
                  </button>
                </div>
              </div>
            )}
          </div>
          <button
            onClick={handleBulkDownload}
            disabled={isDownloading}
            className="text-xs font-medium bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-lg px-3 py-1.5"
          >
            ⬇ 다운로드
          </button>
          <button onClick={clearSelection} className="text-[11px] text-white/50 hover:text-white px-2 py-1.5">
            해제
          </button>
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
                {selected.isHd && (
                  <span className="px-2 py-1 rounded-md bg-emerald-500 text-white text-[10px] font-bold tracking-wide">
                    HD
                  </span>
                )}
                <span className="text-xs text-gray-400">{new Date(selected.createdAt).toLocaleString('ko-KR')}</span>
              </div>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-900 text-sm font-medium">
                닫기
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={selected.imageUrl}
              alt={selected.poseLabel || ''}
              className="w-full rounded-xl max-h-[60vh] object-contain bg-gray-50"
            />
            {selected.poseLabel && <div className="text-xs font-semibold text-gray-900">{selected.poseLabel}</div>}

            {/* 이 이미지가 담긴 폴더 표시 + 빼기 */}
            {collections.some((c) => c.generationIds.includes(selected.id)) && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] text-gray-400">담긴 폴더:</span>
                {collections
                  .filter((c) => c.generationIds.includes(selected.id))
                  .map((c) => (
                    <span
                      key={c.id}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-[10px] text-gray-600"
                    >
                      {c.name}
                      <button
                        onClick={() => handleRemoveFromFolder(c.id, [selected.id])}
                        className="text-gray-400 hover:text-gray-700"
                        title="이 폴더에서 빼기"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              <button
                disabled={isDownloading}
                onClick={async () => {
                  setIsDownloading(true);
                  try {
                    await downloadResultImage(selected.imageUrl, `${selected.isHd ? 'HD_' : ''}history_${selected.id}.png`);
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
              {!selected.isHd && (
                <button
                  disabled={hdPendingIds.length > 0}
                  onClick={async () => {
                    setBusyMsg('고화질 생성 요청 중...');
                    try {
                      const res = await fetch('/api/generations/upscale', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ generationIds: [selected.id] }),
                      });
                      const data = await res.json();
                      if (!data.success) throw new Error(data.error);
                      setHdPendingIds((data.jobs || []).map((j: any) => j.generationId));
                      setBusyMsg('고화질 생성 중... (완료되면 목록에 추가됩니다)');
                      setSelected(null);
                    } catch (err: any) {
                      setBusyMsg(null);
                      alert(err?.message || '고화질 처리에 실패했습니다.');
                    }
                  }}
                  className="inline-flex px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-white font-medium text-xs tracking-wide transition disabled:opacity-40"
                >
                  ✨ 고화질로 뽑기
                </button>
              )}
            </div>

            {selected.prompt && (
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-[11px] text-gray-500 font-mono leading-relaxed max-h-40 overflow-auto">
                {selected.prompt}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
