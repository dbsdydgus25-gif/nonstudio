'use client';

/**
 * AI 룩북 — 두 단계 구조.
 *  1단계: 링크 임포트 → 색상 선택 → "사람 없는" 깨끗한 앞/뒤/옆(좌)/옆(우) 기준컷 4장 확보
 *  2단계: 등록해둔 포즈 프리셋을 골라, 그 기준컷 기준으로 모델 착용 컷을 배치 생성
 *
 * AI 제품 피팅을 확장하지 않고 새로 만든 이유: 매 생성마다 지저분한 스크래핑 사진 더미를
 * 다시 참고하는 구조가 정체성 오염(타사 모델 얼굴 유입)의 근본 원인이었다. 여기서는
 * 1단계에서 사람 없는 깨끗한 기준컷을 한 번 만들어두고 이후 그것만 재사용한다.
 */

import React, { useState, useEffect, useRef } from 'react';
import { pollGenerationStatuses, type PolledGenerationStatus } from '@/lib/poll-generations';
import type { SourcedCategory } from '@/lib/fitting-prompts';

type CleanAngle = 'front' | 'back' | 'left' | 'right';

const ANGLES: Array<{ id: CleanAngle; label: string }> = [
  { id: 'front', label: '앞' },
  { id: 'back', label: '뒤' },
  { id: 'left', label: '옆 (왼쪽)' },
  { id: 'right', label: '옆 (오른쪽)' },
];

const CATEGORY_OPTIONS: Array<{ id: SourcedCategory; label: string }> = [
  { id: 'top', label: '상의' },
  { id: 'bottom', label: '하의' },
  { id: 'outer', label: '아우터' },
  { id: 'shoes', label: '신발' },
  { id: 'accessory', label: '액세서리' },
];

interface PosePresetItem {
  id: string;
  name: string;
  poseInstruction: string;
  hasRefImage: boolean;
  refImageUrl: string | null;
}

interface LookbookSectionProps {
  geminiKey: string;
  openaiKey: string;
  onNeedKeys: () => void;
}

export function LookbookSection({ geminiKey, openaiKey, onNeedKeys }: LookbookSectionProps) {
  // ── 1단계: 제품 소스 ──
  const [productLink, setProductLink] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<{ kind: 'ok' | 'blocked'; text: string } | null>(null);
  const [category, setCategory] = useState<SourcedCategory>('top');
  const [productImages, setProductImages] = useState<string[]>([]);
  const [productImageColors, setProductImageColors] = useState<string[]>([]);
  const [productImageHasPerson, setProductImageHasPerson] = useState<boolean[]>([]);
  const [colorOptions, setColorOptions] = useState<string[]>([]);
  const [selectedColor, setSelectedColor] = useState<string | null>(null);
  const [excludedIdx, setExcludedIdx] = useState<Set<number>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── 1단계: 기준컷 ──
  const [refShots, setRefShots] = useState<Partial<Record<CleanAngle, string>>>({});
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [garmentAnalysis, setGarmentAnalysis] = useState<any>(null);
  // 소싱 제품이 아닌 나머지 슬롯(하의/신발 등) 코디 — 비워두면 서버가 중립 기본값으로 고정
  const [styleHints, setStyleHints] = useState<Partial<Record<SourcedCategory, string>>>({});
  const [refBusy, setRefBusy] = useState<CleanAngle | 'all' | null>(null);
  const [refError, setRefError] = useState('');

  // ── 2단계: 포즈 프리셋 ──
  const [presets, setPresets] = useState<PosePresetItem[]>([]);
  const [selectedPresetIds, setSelectedPresetIds] = useState<Set<string>>(new Set());
  const [newPresetName, setNewPresetName] = useState('');
  const [newPresetText, setNewPresetText] = useState('');
  const [newPresetRef, setNewPresetRef] = useState<string | null>(null);
  const [isSavingPreset, setIsSavingPreset] = useState(false);
  const [presetError, setPresetError] = useState('');
  const presetFileRef = useRef<HTMLInputElement>(null);

  // ── 2단계: 배치 생성 ──
  const [draftMode, setDraftMode] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [runMsg, setRunMsg] = useState('');
  const [results, setResults] = useState<
    Array<{
      generationId: string;
      label: string;
      status: PolledGenerationStatus['status'];
      imageUrl: string | null;
      errorMessage: string | null;
    }>
  >([]);

  const keysSet = geminiKey && openaiKey;

  useEffect(() => {
    void loadPresets();
  }, []);

  const loadPresets = async () => {
    try {
      const res = await fetch('/api/pose-presets');
      const data = await res.json();
      if (data.success) setPresets(data.presets || []);
    } catch {
      /* 목록 조회 실패는 조용히 — 아래 등록/삭제에서 다시 시도된다 */
    }
  };

  // ── 1단계 로직 ──
  const colorKeyOf = (i: number) => (productImageColors[i] || '').toLowerCase();
  const activeColorKey = selectedColor ? selectedColor.toLowerCase() : null;
  const visibleIdxs = productImages
    .map((_, i) => i)
    .filter((i) => !activeColorKey || colorKeyOf(i) === activeColorKey || colorKeyOf(i) === '');
  const isIncluded = (i: number) => !excludedIdx.has(i);

  /** 기준컷 생성에 실제로 넘기는 사진: 선택 색상 + 포함된 것 + 인물 없는 컷 우선 */
  const curatedImages = (): string[] => {
    const idxs = visibleIdxs.filter(isIncluded);
    const sorted = [...idxs].sort(
      (a, b) => Number(!!productImageHasPerson[a]) - Number(!!productImageHasPerson[b]),
    );
    return sorted.slice(0, 6).map((i) => productImages[i]);
  };

  const handleImportLink = async () => {
    const url = productLink.trim();
    if (!url) return;
    setIsImporting(true);
    setImportMsg(null);
    try {
      const res = await fetch('/api/product-fitting/from-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, geminiApiKey: geminiKey }),
      });
      const data = await res.json();
      if (data.blocked) {
        setImportMsg({
          kind: 'blocked',
          text: data.reason || '이 링크는 자동으로 못 읽어요. 이미지를 직접 올려주세요.',
        });
        return;
      }
      if (!res.ok || !data.success) throw new Error(data.error || '링크에서 가져오지 못했습니다.');

      setProductImages((data.productImages || []).slice(0, 20));
      setProductImageColors((data.productImageColors || []).slice(0, 20));
      setProductImageHasPerson((data.productImageHasPerson || []).slice(0, 20));
      setColorOptions(data.colorOptions || []);
      setSelectedColor(null);
      setExcludedIdx(new Set());
      setRefShots({});
      setSheetId(null);
      setGarmentAnalysis(null);
      setImportMsg({
        kind: 'ok',
        text: `제품컷 ${(data.productImages || []).length}장${
          (data.colorOptions || []).length ? `, 색상 ${data.colorOptions.length}개` : ''
        } 가져왔습니다.`,
      });
    } catch (err: any) {
      setImportMsg({ kind: 'blocked', text: err?.message || '링크 처리 중 오류가 발생했습니다.' });
    } finally {
      setIsImporting(false);
    }
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    const dataUrls = await Promise.all(
      Array.from(files).map(
        (f) =>
          new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(f);
          }),
      ),
    );
    setProductImages((prev) => [...prev, ...dataUrls].slice(0, 20));
    setProductImageColors((prev) => [...prev, ...dataUrls.map(() => '')].slice(0, 20));
    setProductImageHasPerson((prev) => [...prev, ...dataUrls.map(() => false)].slice(0, 20));
  };

  const generateRefShots = async (angles?: CleanAngle[]) => {
    if (!keysSet) return onNeedKeys();
    const images = curatedImages();
    if (images.length === 0) {
      setRefError('기준컷을 만들 제품 사진이 없습니다. 링크를 가져오거나 사진을 올려주세요.');
      return;
    }
    setRefError('');
    setRefBusy(angles?.length === 1 ? angles[0] : 'all');
    try {
      const res = await fetch('/api/lookbook/reference-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productImagesBase64: images,
          category,
          geminiApiKey: geminiKey,
          openaiApiKey: openaiKey,
          colorOverride: selectedColor || undefined,
          angles,
          // 개별 재생성이면 기존 시트에 덮어써서 앞면을 기준 앵커로 재사용한다
          sheetId: angles?.length ? sheetId || undefined : undefined,
          // 재분석은 첫 생성 때 한 번만 — 개별 재생성에선 기존 분석을 재사용해 비용을 아낀다
          garmentAnalysis: angles?.length && garmentAnalysis ? garmentAnalysis : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '기준컷 생성에 실패했습니다.');
      setGarmentAnalysis(data.garmentAnalysis);
      setSheetId(data.sheetId);
      setRefShots((prev) => ({ ...prev, ...data.images }));
    } catch (err: any) {
      setRefError(err?.message || '기준컷 생성 중 오류가 발생했습니다.');
    } finally {
      setRefBusy(null);
    }
  };

  // ── 2단계 로직 ──
  const handleAddPreset = async () => {
    if (!newPresetName.trim() || !newPresetText.trim()) {
      setPresetError('이름과 포즈 설명을 모두 입력해주세요.');
      return;
    }
    setPresetError('');
    setIsSavingPreset(true);
    try {
      const res = await fetch('/api/pose-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newPresetName,
          poseInstruction: newPresetText,
          refImageBase64: newPresetRef || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '프리셋 저장에 실패했습니다.');
      setNewPresetName('');
      setNewPresetText('');
      setNewPresetRef(null);
      await loadPresets();
    } catch (err: any) {
      setPresetError(err?.message || '프리셋 저장 중 오류가 발생했습니다.');
    } finally {
      setIsSavingPreset(false);
    }
  };

  const handleDeletePreset = async (id: string) => {
    try {
      await fetch(`/api/pose-presets?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      setSelectedPresetIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await loadPresets();
    } catch (err: any) {
      setPresetError(err?.message || '프리셋 삭제 중 오류가 발생했습니다.');
    }
  };

  const togglePreset = (id: string) =>
    setSelectedPresetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleRunBatch = async () => {
    if (!keysSet) return onNeedKeys();
    if (!sheetId) {
      setRunMsg('먼저 1단계에서 기준컷을 만들어주세요.');
      return;
    }
    if (selectedPresetIds.size === 0) {
      setRunMsg('포즈 프리셋을 하나 이상 선택해주세요.');
      return;
    }

    setIsRunning(true);
    setRunMsg('생성 요청 중…');
    setResults([]);
    try {
      const res = await fetch('/api/lookbook/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // 기준컷 이미지 자체는 서버 Storage에 있다 — id만 보낸다(예전엔 base64 4장을
          // 그대로 실어 보내다가 413 Request Entity Too Large가 났다).
          sheetId,
          garmentAnalysis,
          category,
          presetIds: Array.from(selectedPresetIds),
          openaiApiKey: openaiKey,
          colorOverride: selectedColor || undefined,
          draftMode,
          styleHints,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '배치 생성에 실패했습니다.');

      const jobs: Array<{ generationId: string; label: string }> = data.jobs;
      setResults(jobs.map((j) => ({ ...j, status: 'pending' as const, imageUrl: null, errorMessage: null })));
      setRunMsg(`${jobs.length}장 생성 중… (완료되는 대로 아래에 채워집니다)`);

      await pollGenerationStatuses(
        jobs.map((j) => j.generationId),
        (items) => {
          setResults((prev) =>
            prev.map((r) => {
              const it = items.find((i) => i.id === r.generationId);
              return it ? { ...r, status: it.status, imageUrl: it.imageUrl, errorMessage: it.errorMessage } : r;
            }),
          );
        },
      );
      setRunMsg('완료되었습니다.');
    } catch (err: any) {
      setRunMsg(err?.message || '생성 중 오류가 발생했습니다.');
    } finally {
      setIsRunning(false);
    }
  };

  const downloadImage = (url: string, name: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.target = '_blank';
    a.rel = 'noopener';
    a.click();
  };

  // ── 렌더 ──
  return (
    <div className="max-w-5xl mx-auto px-8 py-10 space-y-12">
      {/* ───── 01. 제품 가져오기 ───── */}
      <section>
        <div className="flex items-baseline gap-2 mb-4">
          <span className="text-[10px] font-semibold tracking-[0.2em] text-gray-300">01</span>
          <h2 className="text-sm font-semibold text-gray-900">제품 가져오기</h2>
        </div>

        <div className="flex gap-2">
          <input
            value={productLink}
            onChange={(e) => setProductLink(e.target.value)}
            placeholder="제품 상세페이지 링크 (도매/브랜드몰 등)"
            className="flex-1 px-3.5 py-2.5 rounded-lg border border-gray-200 focus:border-gray-400 outline-none text-xs"
          />
          <button
            onClick={handleImportLink}
            disabled={isImporting || !productLink.trim()}
            className="px-4 py-2.5 rounded-lg bg-gray-900 text-white text-xs font-medium disabled:opacity-40 transition"
          >
            {isImporting ? '가져오는 중…' : '가져오기'}
          </button>
        </div>
        {importMsg && (
          <p className={`mt-2 text-[11px] ${importMsg.kind === 'ok' ? 'text-emerald-600' : 'text-amber-600'}`}>
            {importMsg.text}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-1.5">
          {CATEGORY_OPTIONS.map((c) => (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              className={`px-3 py-1.5 rounded-full text-[11px] font-medium transition ${
                category === c.id ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {colorOptions.length > 0 && (
          <div className="mt-3">
            <p className="text-[10px] text-gray-400 mb-1.5">색상 선택 — 고른 색의 컷만 기준컷 생성에 쓰입니다</p>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setSelectedColor(null)}
                className={`px-3 py-1.5 rounded-full text-[11px] font-medium transition ${
                  !selectedColor ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}
              >
                전체
              </button>
              {colorOptions.map((c) => (
                <button
                  key={c}
                  onClick={() => setSelectedColor(c)}
                  className={`px-3 py-1.5 rounded-full text-[11px] font-medium transition ${
                    selectedColor === c ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 grid grid-cols-5 gap-2">
          {visibleIdxs.map((i) => (
            <div key={i} className="relative group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={productImages[i]}
                alt=""
                className={`w-full aspect-[3/4] object-cover rounded-lg border border-gray-200 transition ${
                  isIncluded(i) ? '' : 'opacity-40 grayscale'
                }`}
              />
              <button
                onClick={() =>
                  setExcludedIdx((prev) => {
                    const next = new Set(prev);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    return next;
                  })
                }
                className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-black/50 text-white text-[10px] flex items-center justify-center"
              >
                {isIncluded(i) ? '✓' : '○'}
              </button>
              {productImageHasPerson[i] && (
                <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-amber-500/90 text-white text-[9px] font-semibold">
                  인물
                </span>
              )}
              {productImageColors[i] && (
                <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-white/85 text-gray-700 text-[9px] font-semibold">
                  {productImageColors[i]}
                </span>
              )}
            </div>
          ))}
          {productImages.length < 20 && (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="aspect-[3/4] rounded-lg border border-dashed border-gray-300 hover:border-gray-400 text-gray-400 hover:text-gray-600 text-[10px] font-medium transition"
            >
              + 사진 추가
            </button>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void handleUpload(e.target.files);
            e.target.value = '';
          }}
        />
      </section>

      {/* ───── 02. 기준컷 4장 ───── */}
      <section>
        <div className="flex items-baseline justify-between mb-4">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] font-semibold tracking-[0.2em] text-gray-300">02</span>
            <h2 className="text-sm font-semibold text-gray-900">기준컷 (앞 / 뒤 / 옆·옆)</h2>
          </div>
          <button
            onClick={() => generateRefShots()}
            disabled={!!refBusy || productImages.length === 0}
            className="px-4 py-2 rounded-lg bg-gray-900 text-white text-xs font-medium disabled:opacity-40 transition"
          >
            {refBusy === 'all' ? '만드는 중…' : '4컷 만들기'}
          </button>
        </div>
        <p className="text-[11px] text-gray-400 mb-3">
          사람 없이 제품만 담긴 깨끗한 컷을 만듭니다. 이 4장이 이후 모든 포즈 생성의 기준이 되므로, 여기서 확인하고
          마음에 안 드는 각도만 다시 만들면 됩니다.
        </p>
        {refError && <p className="text-[11px] text-red-500 mb-2">{refError}</p>}

        <div className="grid grid-cols-4 gap-3">
          {ANGLES.map((a) => (
            <div key={a.id}>
              <div className="relative aspect-[3/4] rounded-lg border border-gray-200 overflow-hidden bg-gray-50">
                {refShots[a.id] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={refShots[a.id]} alt={a.label} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-300">
                    {refBusy === 'all' || refBusy === a.id ? '생성 중…' : '비어 있음'}
                  </div>
                )}
              </div>
              <div className="mt-1.5 flex items-center justify-between">
                <span className="text-[10px] font-medium text-gray-500">{a.label}</span>
                <button
                  onClick={() => generateRefShots([a.id])}
                  disabled={!!refBusy || productImages.length === 0}
                  className="text-[10px] text-gray-400 hover:text-gray-900 disabled:opacity-40 transition"
                >
                  다시
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ───── 03. 나머지 코디 ───── */}
      <section>
        <div className="flex items-baseline gap-2 mb-4">
          <span className="text-[10px] font-semibold tracking-[0.2em] text-gray-300">03</span>
          <h2 className="text-sm font-semibold text-gray-900">나머지 코디</h2>
        </div>
        <p className="text-[11px] text-gray-400 mb-3">
          소싱 제품 외에 모델이 뭘 입을지 정합니다. 비워두면 제품이 돋보이도록 중립 기본값(흰 티 · 검정 슬랙스 ·
          흰 스니커즈 · 액세서리 없음)으로 <b>모든 컷에 동일하게</b> 고정됩니다.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {CATEGORY_OPTIONS.filter((c) => c.id !== category).map((c) => (
            <div key={c.id}>
              <label className="block text-[10px] font-medium text-gray-500 mb-1">{c.label}</label>
              <input
                value={styleHints[c.id] || ''}
                onChange={(e) => setStyleHints((prev) => ({ ...prev, [c.id]: e.target.value }))}
                placeholder={
                  c.id === 'bottom'
                    ? '예: 와이드 생지 데님 (배바지 아님)'
                    : c.id === 'shoes'
                      ? '예: 검정 로퍼'
                      : c.id === 'outer'
                        ? '예: 착용 안 함'
                        : c.id === 'accessory'
                          ? '예: 없음'
                          : '예: 흰색 반팔 티셔츠'
                }
                className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-gray-400 outline-none text-xs"
              />
            </div>
          ))}
        </div>
      </section>

      {/* ───── 04. 포즈 프리셋 ───── */}
      <section>
        <div className="flex items-baseline gap-2 mb-4">
          <span className="text-[10px] font-semibold tracking-[0.2em] text-gray-300">04</span>
          <h2 className="text-sm font-semibold text-gray-900">포즈 프리셋</h2>
        </div>
        <p className="text-[11px] text-gray-400 mb-3">
          한 번 등록해두면 계속 재사용됩니다. 참고 사진을 같이 올리면 그 자세를 더 정확히 따라갑니다.
        </p>

        <div className="grid grid-cols-3 gap-2 mb-4">
          {presets.map((p) => {
            const on = selectedPresetIds.has(p.id);
            return (
              <div
                key={p.id}
                className={`relative rounded-lg border px-3 py-2.5 cursor-pointer transition ${
                  on ? 'border-gray-900 bg-gray-50' : 'border-gray-200 hover:border-gray-300'
                }`}
                onClick={() => togglePreset(p.id)}
              >
                <div className="flex items-center gap-2">
                  {p.refImageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.refImageUrl} alt="" className="w-8 h-10 object-cover rounded" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-medium text-gray-900 truncate">{p.name}</p>
                    <p className="text-[10px] text-gray-400 truncate">{p.poseInstruction}</p>
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDeletePreset(p.id);
                  }}
                  className="absolute top-1 right-1.5 text-[11px] text-gray-300 hover:text-red-500 transition"
                >
                  ✕
                </button>
              </div>
            );
          })}
          {presets.length === 0 && (
            <p className="col-span-3 text-[11px] text-gray-300 py-4 text-center">
              등록된 포즈가 없습니다. 아래에서 추가해주세요.
            </p>
          )}
        </div>

        <div className="rounded-lg border border-gray-200 p-3 space-y-2">
          <input
            value={newPresetName}
            onChange={(e) => setNewPresetName(e.target.value)}
            placeholder="포즈 이름 (예: 정면 주머니 손)"
            className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-gray-400 outline-none text-xs"
          />
          <textarea
            value={newPresetText}
            onChange={(e) => setNewPresetText(e.target.value)}
            placeholder="포즈 설명 — 자세, 손 위치, 시선, 카메라 각도를 구체적으로 (영어로 쓰면 더 정확합니다)"
            rows={3}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-gray-400 outline-none text-xs resize-none"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => presetFileRef.current?.click()}
              className="px-3 py-1.5 rounded-lg border border-gray-200 hover:border-gray-400 text-[11px] text-gray-500 transition"
            >
              {newPresetRef ? '참고 사진 변경' : '참고 사진 (선택)'}
            </button>
            {newPresetRef && (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={newPresetRef} alt="" className="w-8 h-10 object-cover rounded" />
                <button onClick={() => setNewPresetRef(null)} className="text-[11px] text-gray-400 hover:text-red-500">
                  제거
                </button>
              </>
            )}
            <div className="flex-1" />
            <button
              onClick={handleAddPreset}
              disabled={isSavingPreset}
              className="px-4 py-2 rounded-lg bg-gray-900 text-white text-xs font-medium disabled:opacity-40 transition"
            >
              {isSavingPreset ? '저장 중…' : '포즈 추가'}
            </button>
          </div>
          {presetError && <p className="text-[11px] text-red-500">{presetError}</p>}
        </div>
        <input
          ref={presetFileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              const reader = new FileReader();
              reader.onload = () => setNewPresetRef(reader.result as string);
              reader.readAsDataURL(f);
            }
            e.target.value = '';
          }}
        />
      </section>

      {/* ───── 04. 배치 생성 ───── */}
      <section>
        <div className="flex items-baseline justify-between mb-4">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] font-semibold tracking-[0.2em] text-gray-300">05</span>
            <h2 className="text-sm font-semibold text-gray-900">배치 생성</h2>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] text-gray-500 cursor-pointer">
              <input type="checkbox" checked={draftMode} onChange={(e) => setDraftMode(e.target.checked)} />
              초안 품질 (비용 약 1/4)
            </label>
            <button
              onClick={handleRunBatch}
              disabled={isRunning}
              className="px-4 py-2 rounded-lg bg-gray-900 text-white text-xs font-medium disabled:opacity-40 transition"
            >
              {isRunning ? '생성 중…' : `${selectedPresetIds.size || ''}장 생성`}
            </button>
          </div>
        </div>
        {runMsg && <p className="text-[11px] text-gray-500 mb-3">{runMsg}</p>}

        {results.length > 0 && (
          <div className="grid grid-cols-4 gap-3">
            {results.map((r) => (
              <div key={r.generationId}>
                <div className="relative aspect-[2/3] rounded-lg border border-gray-200 overflow-hidden bg-gray-50">
                  {r.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.imageUrl} alt={r.label} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-300 px-2 text-center">
                      {r.status === 'failed' ? r.errorMessage || '실패' : '생성 중…'}
                    </div>
                  )}
                </div>
                <div className="mt-1.5 flex items-center justify-between">
                  <span className="text-[10px] text-gray-500 truncate">{r.label}</span>
                  {r.imageUrl && (
                    <button
                      onClick={() => downloadImage(r.imageUrl!, `lookbook_${r.label}.png`)}
                      className="text-[10px] text-gray-400 hover:text-gray-900 transition"
                    >
                      저장
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
