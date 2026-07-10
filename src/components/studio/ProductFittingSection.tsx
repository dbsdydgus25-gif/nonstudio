'use client';

import React, { useState, useEffect, useRef } from 'react';
import { FittingResultViewer, type HistoryItem } from './FittingResultViewer';
import type { SourcedCategory } from '@/lib/fitting-prompts';
import { pollGenerationStatuses } from '@/lib/poll-generations';
import { downloadResultImage } from '@/lib/download-image';

interface ProductFittingSectionProps {
  geminiKey: string;
  openaiKey: string;
  onNeedKeys: () => void;
  /** 확정된 결과를 AI 바리에이션 쪽으로 넘길 때 호출 */
  onSendToVariation?: (imageUrl: string) => void;
}

const CATEGORY_OPTIONS: { id: SourcedCategory; label: string; desc: string }[] = [
  { id: 'top', label: '상의', desc: '제품이 상의' },
  { id: 'bottom', label: '하의', desc: '제품이 하의' },
  { id: 'shoes', label: '신발', desc: '제품이 신발' },
  { id: 'accessory', label: '액세서리', desc: '가방 · 시계 · 주얼리 등' },
];

const STYLE_SLOT_META: Record<SourcedCategory, { label: string; placeholder: string }> = {
  top: { label: '상의 스타일', placeholder: '예: 미니멀한 톤의 니트' },
  bottom: { label: '하의 스타일', placeholder: '예: 생지 와이드 데님, 기장감 긴 걸로 (배바지 아님)' },
  shoes: { label: '신발 스타일', placeholder: '예: 베이지 계열 샌들' },
  accessory: { label: '액세서리 스타일', placeholder: '예: 토트백 하나' },
};

interface ColorJobItem {
  generationId: string;
  label: string;
  status: 'pending' | 'completed' | 'failed';
  imageUrl?: string;
  errorMessage?: string | null;
}

/** 파일을 base64 data URL로 읽는다 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function ProductFittingSection({ geminiKey, openaiKey, onNeedKeys, onSendToVariation }: ProductFittingSectionProps) {
  // 색상 옵션별 제품 이미지 (1장 이상) — 첫 장이 대표, 나머지가 색상 옵션
  const [productImages, setProductImages] = useState<string[]>([]);
  // 한 장에 여러 색상이 나온 도매 샘플 시트에서 색상을 자동 추출해 색상별로 생성
  const [extractColors, setExtractColors] = useState(false);
  const [category, setCategory] = useState<SourcedCategory>('top');
  const [poseHint, setPoseHint] = useState('');
  const [styleHints, setStyleHints] = useState<Partial<Record<SourcedCategory, string>>>({});
  const otherSlots = CATEGORY_OPTIONS.map((c) => c.id).filter((id) => id !== category);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [isRunning, setIsRunning] = useState(false);
  const [stageMsg, setStageMsg] = useState('');
  const [colorJobs, setColorJobs] = useState<ColorJobItem[]>([]);
  const [isBatchDownloading, setIsBatchDownloading] = useState(false);

  const [currentResult, setCurrentResult] = useState<{ imageUrl: string; prompt: string; revisedPrompt?: string; generationId?: string | null } | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  useEffect(() => {
    fetch('/api/generations/history?source=product')
      .then((res) => res.json())
      .then((data) => {
        if (!data.success) return;
        setHistory(
          data.items.map((item: any) => ({
            id: item.id,
            imageUrl: item.imageUrl,
            prompt: item.prompt,
            revisedPrompt: item.poseLabel,
            timestamp: new Date(item.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
          })),
        );
      })
      .catch(() => {});
  }, []);

  const handleRate = async (generationId: string, rating: 'good' | 'bad') => {
    try {
      const res = await fetch('/api/generations/rate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generationId, rating }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '평가 저장 실패');
    } catch (err: any) {
      alert(err.message || '평가 저장 중 오류가 발생했습니다.');
    }
  };

  const handleAddFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const dataUrls = await Promise.all(Array.from(files).map(fileToDataUrl));
    setProductImages((prev) => [...prev, ...dataUrls].slice(0, 6));
  };

  const handleRun = async () => {
    if (productImages.length === 0) {
      alert('제품 이미지를 먼저 업로드해주세요.');
      return;
    }
    if (!geminiKey || !openaiKey) {
      onNeedKeys();
      return;
    }

    setIsRunning(true);
    setStageMsg(extractColors ? '색상 옵션 추출 및 렌더링 중 (색상별 병렬 생성, 최대 2분)' : '제품 분석 및 렌더링 중 (색상별 병렬 생성, 최대 2분)');
    setCurrentResult(null);
    setColorJobs([]);

    const userAdditions = poseHint.trim() ? `자세 지시: ${poseHint.trim()}` : '';

    try {
      const res = await fetch('/api/product-fitting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productImagesBase64: productImages,
          category,
          geminiApiKey: geminiKey,
          openaiApiKey: openaiKey,
          userAdditions,
          extractColors,
          userPreferenceHints: otherSlots.reduce<Record<string, string>>((acc, slot) => {
            const v = styleHints[slot]?.trim();
            if (v) acc[slot] = v;
            return acc;
          }, {}),
        }),
      });

      let startData: any;
      try {
        startData = await res.json();
      } catch {
        throw new Error('서버 응답을 읽을 수 없습니다. 잠시 후 다시 시도해주세요.');
      }
      if (!res.ok || !startData.success) {
        throw new Error(startData.error || 'AI 제품 피팅 시작에 실패했습니다.');
      }

      const jobs: ColorJobItem[] = startData.jobs.map((j: any) => ({
        generationId: j.generationId,
        label: j.label,
        status: 'pending' as const,
      }));
      setColorJobs(jobs);

      const finalItems = await pollGenerationStatuses(
        jobs.map((j) => j.generationId),
        (items) => {
          setColorJobs((prev) =>
            prev.map((job) => {
              const update = items.find((it) => it.id === job.generationId);
              if (!update) return job;
              return { ...job, status: update.status, imageUrl: update.imageUrl ?? undefined, errorMessage: update.errorMessage };
            }),
          );
          // 첫 번째로 완료된 결과를 상단 뷰어에 표시
          const firstDone = items.find((it) => it.status === 'completed' && it.imageUrl);
          if (firstDone) {
            setCurrentResult((prev) => prev ?? { imageUrl: firstDone.imageUrl!, prompt: firstDone.prompt || '', generationId: firstDone.id });
          }
        },
      );

      const succeeded = finalItems.filter((i) => i.status === 'completed' && i.imageUrl);
      if (succeeded.length === 0) {
        const reasons = Array.from(new Set(finalItems.map((i) => i.errorMessage).filter(Boolean)));
        const detail = reasons.length > 0 ? `\n\n상세: ${reasons.join(' / ')}` : '';
        throw new Error(`모든 색상 옵션 생성에 실패했습니다.${detail}`);
      }

      const timestamp = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      setHistory((prev) => [
        ...succeeded.map((item) => ({
          id: item.id,
          imageUrl: item.imageUrl!,
          prompt: item.prompt || '',
          revisedPrompt: item.poseLabel ?? undefined,
          timestamp,
        })),
        ...prev,
      ]);
    } catch (err: any) {
      alert(err.message || '오류가 발생했습니다.');
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-8 py-10 space-y-10">
      {/* 제품 이미지 업로드 (색상 옵션 포함 다중) */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-semibold text-gray-300 tabular-nums">01</span>
          <h2 className="text-sm font-semibold text-gray-900 tracking-tight">제품 이미지 업로드</h2>
          <span className="text-[11px] text-gray-400">색상 옵션별 여러 장 가능</span>
        </div>
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
          <p className="text-xs text-gray-400 leading-relaxed">
            제품 단독 컷(누끼 · 행거 · 상세페이지)이나 타사 착용샷 모두 가능합니다. 색상 옵션 이미지를 전부 올리면 색상별로 1장씩 생성됩니다 (최대 6장).
          </p>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
            {productImages.map((img, i) => (
              <div key={i} className="relative aspect-[3/4] rounded-lg overflow-hidden border border-gray-200 group bg-gray-50">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img} alt={`제품 ${i + 1}`} className="w-full h-full object-contain" />
                <button
                  type="button"
                  onClick={() => setProductImages((prev) => prev.filter((_, idx) => idx !== i))}
                  className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/60 text-white text-[11px] opacity-0 group-hover:opacity-100 transition"
                >
                  ✕
                </button>
                <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/60 text-white text-[9px] font-medium tracking-wide">
                  {productImages.length > 1 ? `색상 ${i + 1}` : '대표'}
                </span>
              </div>
            ))}
            {productImages.length < 6 && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="aspect-[3/4] rounded-lg border border-dashed border-gray-300 hover:border-gray-400 transition flex flex-col items-center justify-center gap-1.5 text-gray-400 hover:text-gray-600"
              >
                <span className="text-xl font-light leading-none">+</span>
                <span className="text-[10px] font-medium tracking-wide">이미지 추가</span>
              </button>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              handleAddFiles(e.target.files);
              e.target.value = '';
            }}
          />

          {/* 색상 자동 추출 토글 — 한 장에 여러 색상이 나온 도매 샘플 시트용 */}
          <button
            type="button"
            onClick={() => setExtractColors((v) => !v)}
            className={`w-full flex items-center justify-between px-4 py-3.5 rounded-xl border transition text-left ${
              extractColors ? 'border-gray-900 bg-gray-900' : 'border-gray-200 bg-white hover:border-gray-300'
            }`}
          >
            <span>
              <span className={`block text-[13px] font-semibold tracking-tight ${extractColors ? 'text-white' : 'text-gray-900'}`}>
                색상 옵션 자동 추출
              </span>
              <span className={`block text-[11px] mt-0.5 ${extractColors ? 'text-gray-300' : 'text-gray-400'}`}>
                한 장에 여러 색상이 함께 나온 샘플 사진(신상마켓 · 도매꾹 등)이면 켜세요 — 색상을 인식해 색상별로 1장씩 생성합니다
              </span>
            </span>
            <span
              className={`relative w-10 h-[22px] rounded-full transition flex-shrink-0 ml-4 ${
                extractColors ? 'bg-white/30' : 'bg-gray-200'
              }`}
            >
              <span
                className={`absolute top-[3px] w-4 h-4 rounded-full transition-all ${
                  extractColors ? 'right-[3px] bg-white' : 'left-[3px] bg-white shadow-sm'
                }`}
              />
            </span>
          </button>
        </div>
      </section>

      {/* 카테고리 */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-semibold text-gray-300 tabular-nums">02</span>
          <h2 className="text-sm font-semibold text-gray-900 tracking-tight">제품 카테고리</h2>
        </div>
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
          <p className="text-xs text-gray-400 leading-relaxed">
            저장된 모델 정보가 이 제품을 실제로 착용한 룩북 화보를 생성합니다. 배경은 화이트 스튜디오로 고정됩니다.
          </p>
          <div className="grid grid-cols-4 gap-2">
            {CATEGORY_OPTIONS.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setCategory(cat.id)}
                className={`py-3.5 px-2 rounded-xl border text-center transition-all ${
                  category === cat.id
                    ? 'border-gray-900 bg-gray-900 text-white'
                    : 'border-gray-200 bg-white text-gray-500 hover:text-gray-900 hover:border-gray-300'
                }`}
              >
                <div className="text-[13px] font-semibold tracking-tight">{cat.label}</div>
                <div className={`text-[10px] mt-0.5 ${category === cat.id ? 'text-gray-300' : 'text-gray-400'}`}>
                  {cat.desc}
                </div>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* 추가 스타일링 지시 */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-semibold text-gray-300 tabular-nums">03</span>
          <h2 className="text-sm font-semibold text-gray-900 tracking-tight">추가 스타일링 지시</h2>
          <span className="text-[11px] text-gray-400">선택</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="bg-white border border-gray-200 rounded-2xl p-5 space-y-2.5">
            <div className="text-[11px] font-semibold text-gray-900 tracking-wide">자세</div>
            <textarea
              value={poseHint}
              onChange={(e) => setPoseHint(e.target.value)}
              placeholder="예: 손 주머니에 넣고 살짝 옆으로 돌아선 포즈"
              rows={3}
              className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3.5 py-3 text-[13px] text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-900 resize-none leading-relaxed transition"
            />
          </div>

          {otherSlots.map((slot) => {
            const meta = STYLE_SLOT_META[slot];
            return (
              <div key={slot} className="bg-white border border-gray-200 rounded-2xl p-5 space-y-2.5">
                <div className="text-[11px] font-semibold text-gray-900 tracking-wide">{meta.label}</div>
                <textarea
                  value={styleHints[slot] || ''}
                  onChange={(e) => setStyleHints((prev) => ({ ...prev, [slot]: e.target.value }))}
                  placeholder={meta.placeholder}
                  rows={3}
                  className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3.5 py-3 text-[13px] text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-900 resize-none leading-relaxed transition"
                />
              </div>
            );
          })}
        </div>
      </section>

      {/* 실행 버튼 */}
      <section>
        <button
          onClick={handleRun}
          disabled={isRunning || productImages.length === 0}
          className={`w-full py-5 rounded-xl font-semibold text-[15px] tracking-tight transition-all ${
            isRunning
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : productImages.length === 0
              ? 'bg-gray-50 text-gray-300 cursor-not-allowed border border-gray-200'
              : 'bg-gray-900 text-white hover:bg-black'
          }`}
        >
          {isRunning ? (
            <span className="flex items-center justify-center gap-3">
              <span className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
              {stageMsg}
            </span>
          ) : extractColors ? (
            'AI 제품 피팅 생성 — 색상 자동 추출'
          ) : (
            `AI 제품 피팅 생성${productImages.length > 1 ? ` — 색상 ${productImages.length}종` : ' — 전신 1장'}`
          )}
        </button>
      </section>

      {/* 결과 */}
      {(currentResult || isRunning || history.length > 0) && (
        <section className="space-y-4">
          <FittingResultViewer
            currentResult={currentResult}
            history={history}
            onSelectHistory={(item) => setCurrentResult({ imageUrl: item.imageUrl, prompt: item.prompt, revisedPrompt: item.revisedPrompt })}
            isGenerating={isRunning && !currentResult}
            loadingStage={stageMsg}
            onRate={handleRate}
            onSendToVariation={onSendToVariation}
          />

          {colorJobs.length > 1 && (
            <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-400 mb-1">Colorways</div>
                  <h4 className="text-sm font-semibold text-gray-900 tracking-tight">색상 옵션별 결과 {colorJobs.length}종</h4>
                </div>
                <button
                  disabled={isBatchDownloading}
                  onClick={async () => {
                    setIsBatchDownloading(true);
                    try {
                      const completed = colorJobs.filter((j) => j.status === 'completed' && j.imageUrl);
                      for (const [i, job] of completed.entries()) {
                        await downloadResultImage(job.imageUrl!, `product_color_${i + 1}_${Date.now()}.png`);
                      }
                    } catch (err: any) {
                      alert(err?.message || '전체 다운로드 중 오류가 발생했습니다.');
                    } finally {
                      setIsBatchDownloading(false);
                    }
                  }}
                  className="px-3.5 py-2 rounded-lg border border-gray-200 hover:border-gray-400 text-gray-600 hover:text-gray-900 text-xs font-medium tracking-wide transition disabled:opacity-40"
                >
                  {isBatchDownloading ? '저장 중...' : '전체 다운로드'}
                </button>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
                {colorJobs.map((job) => (
                  <div
                    key={job.generationId}
                    className={`group relative aspect-[3/4] rounded-lg overflow-hidden border border-gray-200 bg-gray-50 ${
                      job.status === 'completed' ? 'hover:border-gray-400 transition cursor-pointer' : ''
                    }`}
                    onClick={() => {
                      if (job.status === 'completed' && job.imageUrl) {
                        setCurrentResult({ imageUrl: job.imageUrl, prompt: '', revisedPrompt: job.label, generationId: job.generationId });
                      }
                    }}
                  >
                    {job.status === 'completed' && job.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={job.imageUrl} alt={job.label} className="w-full h-full object-cover" />
                    ) : job.status === 'failed' ? (
                      <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-gray-400 p-2">
                        <span className="text-[10px] font-medium text-center leading-snug">{job.errorMessage || '생성 실패'}</span>
                      </div>
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <span className="w-5 h-5 border-2 border-gray-200 border-t-gray-900 rounded-full animate-spin" />
                      </div>
                    )}
                    <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/60 text-white text-[9px] font-medium tracking-wide">
                      {job.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
