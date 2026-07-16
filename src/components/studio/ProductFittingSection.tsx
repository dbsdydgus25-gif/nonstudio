'use client';

import React, { useState, useEffect, useRef } from 'react';
import { FittingResultViewer, type HistoryItem } from './FittingResultViewer';
import type { SourcedCategory } from '@/lib/fitting-prompts';
import { pollGenerationStatuses } from '@/lib/poll-generations';
import { downloadResultImage } from '@/lib/download-image';
import { fileToCompressedDataUrl } from '@/lib/client-image';

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

export function ProductFittingSection({ geminiKey, openaiKey, onNeedKeys, onSendToVariation }: ProductFittingSectionProps) {
  // 제품 이미지 (1장 이상) — extractColors를 안 쓰면 전부 "같은 제품의 다른 각도" 참고 사진으로 함께 쓰인다
  const [productImages, setProductImages] = useState<string[]>([]);
  // 재질/텍스처 클로즈업 참고 사진 — 색상 아닌 원단/버튼/스티치 디테일 전용 (별도 슬롯)
  const [materialImages, setMaterialImages] = useState<string[]>([]);
  const materialFileInputRef = useRef<HTMLInputElement>(null);
  // 한 장에 여러 색상이 나온 도매 샘플 시트에서 색상을 자동 추출해 색상별로 생성
  const [extractColors, setExtractColors] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  // 추출된 색상별 계획 — 색상마다 코디 지시를 따로 입력할 수 있다 (비운 슬롯은 공통 지시 사용)
  const [colorPlans, setColorPlans] = useState<Array<{ label: string; color: string; box?: [number, number, number, number]; styleHints: Partial<Record<SourcedCategory, string>> }> | null>(null);
  const [category, setCategory] = useState<SourcedCategory>('top');
  const [poseHint, setPoseHint] = useState('');
  // (2026-07-17) 여러 포즈 컷을 한 번에 뽑을 때 — 컷별로 자세를 따로 지정, 비워두면 랜덤 프리셋 포즈
  const [poseCount, setPoseCount] = useState(1);
  const [customPoseTexts, setCustomPoseTexts] = useState<string[]>(['', '', '', '']);
  const [styleHints, setStyleHints] = useState<Partial<Record<SourcedCategory, string>>>({});
  // (2026-07-17) 소싱 제품이 아닌 슬롯(예: 상의)을 말로 설명하기 어려울 때 첨부하는 "이렇게
  // 입혀줘" 참고 사진 — 슬롯당 최대 3장, 화면엔 "첨부됨 N장"으로만 간단히 표시
  const [styleReferenceImages, setStyleReferenceImages] = useState<Partial<Record<SourcedCategory, string[]>>>({});
  const styleRefFileInputRef = useRef<HTMLInputElement>(null);
  const [styleRefTargetSlot, setStyleRefTargetSlot] = useState<SourcedCategory | null>(null);
  // 제품 자체의 핏/디테일 지시 (예: 머슬핏, 크롭 기장감) — 사진만으로 안 보이는 정보 보강
  const [productNotes, setProductNotes] = useState('');
  // 초안 품질(low) — medium 대비 약 1/4 비용, 코디/색상 확인용
  const [draftMode, setDraftMode] = useState(false);
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
    const dataUrls = await Promise.all(Array.from(files).map(fileToCompressedDataUrl));
    setProductImages((prev) => [...prev, ...dataUrls].slice(0, 6));
    setColorPlans(null); // 이미지가 바뀌면 이전 추출 결과는 무효
  };

  const handleAddMaterialFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const dataUrls = await Promise.all(Array.from(files).map(fileToCompressedDataUrl));
    setMaterialImages((prev) => [...prev, ...dataUrls].slice(0, 4));
  };

  // (2026-07-17) 슬롯별 "이렇게 입혀줘" 참고 사진 첨부 — 최대 3장, 초과분은 버림
  const handleAddStyleRefFiles = async (slot: SourcedCategory, files: FileList | null) => {
    if (!files?.length) return;
    const dataUrls = await Promise.all(Array.from(files).map(fileToCompressedDataUrl));
    setStyleReferenceImages((prev) => ({ ...prev, [slot]: [...(prev[slot] || []), ...dataUrls].slice(0, 3) }));
  };

  // 색상 샘플 시트에서 색상 옵션 추출 (생성 전 미리보기) — 추출 후 색상별 코디 입력 가능
  const handleExtractColors = async () => {
    if (productImages.length === 0) {
      alert('색상 샘플 사진을 먼저 업로드해주세요.');
      return;
    }
    if (!geminiKey || !openaiKey) {
      onNeedKeys();
      return;
    }
    setIsExtracting(true);
    try {
      const res = await fetch('/api/product-fitting/extract-colors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: productImages[0], geminiApiKey: geminiKey, openaiApiKey: openaiKey }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '색상 추출에 실패했습니다.');
      setColorPlans(data.colors.map((c: any) => ({ label: c.label, color: c.color, box: c.box, styleHints: {} })));
    } catch (err: any) {
      alert(err?.message || '색상 추출 중 오류가 발생했습니다.');
    } finally {
      setIsExtracting(false);
    }
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
    setStageMsg(extractColors ? '색상 옵션 추출 및 렌더링 중 (색상별 병렬 생성, 최대 2분)' : '제품 분석 및 렌더링 중 (최대 2분)');
    setCurrentResult(null);
    setColorJobs([]);

    // 포즈 1장이면 기존과 동일하게 "자세" 텍스트 하나만, 여러 장이면 컷별 지시 배열을 그대로 전달
    // (비운 컷은 서버에서 프리셋 포즈 중 랜덤으로 채움)
    const effectiveCustomPoseTexts =
      poseCount === 1 ? [poseHint.trim()] : customPoseTexts.slice(0, poseCount).map((t) => t.trim());

    try {
      const res = await fetch('/api/product-fitting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productImagesBase64: productImages,
          materialImagesBase64: materialImages.length ? materialImages : undefined,
          category,
          geminiApiKey: geminiKey,
          openaiApiKey: openaiKey,
          poseCount,
          customPoseTexts: effectiveCustomPoseTexts,
          productNotes: productNotes.trim() || undefined,
          draftMode,
          extractColors,
          // (2026-07-17) 색상 옵션 모드여도 공통으로 적용 — 참고 이미지는 색상과 무관하게
          // "이 슬롯은 이 옷으로 입혀줘"이므로 색상별로 다를 이유가 없다.
          styleReferenceImagesBySlot: Object.fromEntries(
            Object.entries(styleReferenceImages).filter(([, imgs]) => imgs && imgs.length),
          ),
          // 추출 미리보기를 거쳤으면 색상별 계획(색상별 코디 덮어쓰기 포함)을 그대로 전달
          colorPlans: extractColors && colorPlans?.length
            ? colorPlans.map((p) => ({
                label: p.label,
                color: p.color,
                box: p.box,
                styleHints: Object.fromEntries(
                  Object.entries(p.styleHints).filter(([, v]) => typeof v === 'string' && v.trim()),
                ),
              }))
            : undefined,
          // 색상별 계획이 있으면 공통 코디 지시는 숨겨져 있으므로 보내지 않는다 (색상 카드가 대체)
          userPreferenceHints:
            extractColors && colorPlans?.length
              ? {}
              : otherSlots.reduce<Record<string, string>>((acc, slot) => {
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
        if (res.status === 413) {
          throw new Error('업로드한 이미지 용량이 너무 큽니다. 사진 수를 줄이거나 다시 시도해주세요.');
        }
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
          <span className="text-[11px] text-gray-400">같은 제품 여러 각도 · 색상 옵션 모두 가능</span>
        </div>
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
          <p className="text-xs text-gray-400 leading-relaxed">
            제품 단독 컷(누끼 · 행거 · 상세페이지)이나 타사 착용샷 모두 가능합니다. 아래 <b className="text-gray-600">색상 옵션 자동 추출</b>을 켜지 않으면,
            여러 장을 올려도 전부 <b className="text-gray-600">같은 제품의 다른 각도/디테일</b> 참고 사진으로 함께 분석해 1장을 생성합니다 (색상이 실제로 다르면 추출 기능을 켜세요).
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
                  {i === 0 ? '대표' : extractColors ? `색상 ${i + 1}` : `각도 ${i + 1}`}
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
            onClick={() => {
              setExtractColors((v) => !v);
              setColorPlans(null);
            }}
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

          {/* 색상 추출 미리보기 + 색상별 코디 지시 */}
          {extractColors && (
            <div className="space-y-3">
              <button
                type="button"
                onClick={handleExtractColors}
                disabled={isExtracting || productImages.length === 0}
                className="w-full py-3 rounded-xl border border-gray-200 hover:border-gray-400 text-gray-700 hover:text-gray-900 font-medium text-[13px] tracking-tight transition disabled:opacity-40"
              >
                {isExtracting ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-3.5 h-3.5 border-2 border-gray-300 border-t-gray-700 rounded-full animate-spin" />
                    색상 인식 중
                  </span>
                ) : colorPlans ? (
                  '색상 다시 추출'
                ) : (
                  '색상 추출하기 — 색상별로 코디를 따로 지정할 수 있습니다'
                )}
              </button>

              {colorPlans && (
                <div className="space-y-2">
                  <p className="text-[11px] text-gray-400 leading-relaxed">
                    {colorPlans.length}개 색상이 인식됐습니다. 저장된 모델 정보(체형 · 피부 · 기준 사진)가 모든 색상에 동일하게 적용되고, 코디는 색상 칸에 입력한 내용이 우선합니다 — 비워두면 아래 자세 지시 외에는 AI가 그 색상에 어울리게 자동 코디합니다.
                  </p>
                  {colorPlans.map((plan, i) => (
                    <div key={i} className="border border-gray-200 rounded-xl p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="px-2.5 py-1 rounded-md bg-gray-900 text-white text-[11px] font-semibold tracking-tight">
                            {plan.label}
                          </span>
                          <span className="text-[10px] text-gray-400">{plan.color}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setColorPlans((prev) => prev!.filter((_, idx) => idx !== i))}
                          className="text-[11px] font-medium text-gray-400 hover:text-gray-900 transition"
                        >
                          이 색상 제외
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        {otherSlots.map((slot) => {
                          const meta = STYLE_SLOT_META[slot];
                          return (
                            <input
                              key={slot}
                              type="text"
                              value={plan.styleHints[slot] || ''}
                              onChange={(e) =>
                                setColorPlans((prev) =>
                                  prev!.map((p, idx) =>
                                    idx === i ? { ...p, styleHints: { ...p.styleHints, [slot]: e.target.value } } : p,
                                  ),
                                )
                              }
                              placeholder={`${meta.label} (공통 사용 시 비움)`}
                              className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-[12px] text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-900 transition"
                            />
                          );
                        })}
                      </div>
                    </div>
                  ))}

                  {/* (2026-07-17) 색상별 코디 텍스트 바로 아래 — 말로 설명하기 어려운 슬롯은
                      참고 이미지로 대신 첨부. 색상과 무관하게 공통 적용(styleReferenceImages 공유). */}
                  <div className="border border-gray-200 rounded-xl p-4 space-y-2">
                    <div className="text-[11px] font-semibold text-gray-900 tracking-wide">참고 이미지 (모든 색상 공통)</div>
                    <p className="text-[11px] text-gray-400 leading-relaxed">
                      말로 설명하기 어려운 슬롯은 사진으로 첨부하세요 — 색상과 무관하게 모든 색상에 동일하게 적용됩니다.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {otherSlots.map((slot) => {
                        const meta = STYLE_SLOT_META[slot];
                        const refCount = styleReferenceImages[slot]?.length || 0;
                        return (
                          <div
                            key={slot}
                            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 bg-gray-50"
                          >
                            <span className="text-[11px] font-medium text-gray-700">{meta.label}</span>
                            {refCount > 0 && (
                              <>
                                <span className="text-[11px] text-gray-500">첨부됨 {refCount}장</span>
                                <button
                                  type="button"
                                  onClick={() => setStyleReferenceImages((prev) => ({ ...prev, [slot]: [] }))}
                                  className="text-[11px] font-medium text-gray-400 hover:text-gray-900 transition"
                                >
                                  지우기
                                </button>
                              </>
                            )}
                            {refCount < 3 && (
                              <button
                                type="button"
                                onClick={() => {
                                  setStyleRefTargetSlot(slot);
                                  styleRefFileInputRef.current?.click();
                                }}
                                className="text-[11px] font-medium text-gray-500 hover:text-gray-900 transition"
                              >
                                + 참고 이미지
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 재질 참고 사진 — 색상 아닌 원단/버튼/스티치 클로즈업 전용, 위 제품 사진과 분리 분석 */}
          <div className="pt-2 border-t border-gray-100 space-y-2.5">
            <div>
              <div className="text-[13px] font-semibold text-gray-900 tracking-tight">재질 참고 사진</div>
              <p className="text-[11px] text-gray-400 mt-0.5 leading-relaxed">
                원단 결 · 단추 · 스티치 같은 디테일 클로즈업이 있으면 추가하세요. 위 제품 사진은 색상 · 핏 위주로,
                여기 사진은 재질 · 디테일 위주로 따로 분석해서 결과에 함께 반영합니다 (선택, 최대 4장).
              </p>
            </div>
            <div className="grid grid-cols-4 sm:grid-cols-6 gap-2.5">
              {materialImages.map((img, i) => (
                <div key={i} className="relative aspect-square rounded-lg overflow-hidden border border-gray-200 group bg-gray-50">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img} alt={`재질 참고 ${i + 1}`} className="w-full h-full object-cover" />
                  <button
                    type="button"
                    onClick={() => setMaterialImages((prev) => prev.filter((_, idx) => idx !== i))}
                    className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-[10px] opacity-0 group-hover:opacity-100 transition"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {materialImages.length < 4 && (
                <button
                  type="button"
                  onClick={() => materialFileInputRef.current?.click()}
                  className="aspect-square rounded-lg border border-dashed border-gray-300 hover:border-gray-400 transition flex items-center justify-center text-gray-400 hover:text-gray-600"
                >
                  <span className="text-lg font-light leading-none">+</span>
                </button>
              )}
            </div>
            <input
              ref={materialFileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                handleAddMaterialFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </section>

      {/* 제품 핏 · 디테일 지시 — 사진만으로 안 보이는 실착 정보 (머슬핏, 크롭 기장 등) */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-semibold text-gray-300 tabular-nums">02</span>
          <h2 className="text-sm font-semibold text-gray-900 tracking-tight">제품 핏 · 디테일 지시</h2>
          <span className="text-[11px] text-gray-400">선택 — 모든 색상에 공통 적용</span>
        </div>
        <div className="bg-white border border-gray-200 rounded-2xl p-5 space-y-2.5">
          <textarea
            value={productNotes}
            onChange={(e) => setProductNotes(e.target.value)}
            placeholder="예: 머슬핏, 크롭 기장감, 어깨 딱 떨어지는 세미오버핏"
            rows={2}
            className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3.5 py-3 text-[13px] text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-900 resize-none leading-relaxed transition"
          />
          <p className="text-[11px] text-gray-400 leading-relaxed">
            사진만으로는 판단이 어려운 실착 핏 · 기장 · 원단 정보를 적어주세요. 사진에서 보이는 것보다 이 지시가 우선합니다.
          </p>
        </div>
      </section>

      {/* 카테고리 */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-semibold text-gray-300 tabular-nums">03</span>
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

      {/* 추가 스타일링 지시 — 색상 추출을 완료했으면 코디는 색상별 카드가 대체하므로 자세만 남긴다 */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-semibold text-gray-300 tabular-nums">04</span>
          <h2 className="text-sm font-semibold text-gray-900 tracking-tight">
            {extractColors && colorPlans ? '자세 지시' : '추가 스타일링 지시'}
          </h2>
          <span className="text-[11px] text-gray-400">
            {extractColors && colorPlans ? '선택 — 코디는 위 색상별 칸에서 지정' : '선택'}
          </span>
        </div>

        {/* 포즈 컷 수 — 재질/코디 분석 정보를 유지한 채 포즈만 바꿔 여러 장 생성 */}
        <div className="bg-white border border-gray-200 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <div className="text-[13px] font-semibold text-gray-900 tracking-tight">포즈 컷 수</div>
            <div className="text-[11px] text-gray-400 mt-0.5">
              {poseCount > 1 ? '컷마다 아래에서 자세를 지정할 수 있습니다' : '1장 이상이면 컷마다 다른 포즈로 생성됩니다'}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setPoseCount((c) => Math.max(1, c - 1))}
              className="w-9 h-9 rounded-lg border border-gray-200 hover:border-gray-400 text-gray-600 hover:text-gray-900 font-medium flex items-center justify-center text-sm transition"
            >
              −
            </button>
            <span className="text-[15px] font-semibold text-gray-900 w-10 text-center tabular-nums">{poseCount}장</span>
            <button
              type="button"
              onClick={() => setPoseCount((c) => Math.min(4, c + 1))}
              className="w-9 h-9 rounded-lg border border-gray-200 hover:border-gray-400 text-gray-600 hover:text-gray-900 font-medium flex items-center justify-center text-sm transition"
            >
              +
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {poseCount === 1 ? (
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
          ) : (
            Array.from({ length: poseCount }, (_, i) => (
              <div key={i} className="bg-white border border-gray-200 rounded-2xl p-5 space-y-2.5">
                <div className="text-[11px] font-semibold text-gray-900 tracking-wide">자세 지시 {i + 1}</div>
                <textarea
                  value={customPoseTexts[i] ?? ''}
                  onChange={(e) => {
                    const next = [...customPoseTexts];
                    next[i] = e.target.value;
                    setCustomPoseTexts(next);
                  }}
                  placeholder="예: 오른쪽을 바라보며 몸을 살짝 돌린 자세 (비워두면 랜덤 포즈)"
                  rows={3}
                  className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3.5 py-3 text-[13px] text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-900 resize-none leading-relaxed transition"
                />
              </div>
            ))
          )}

          {/* 색상 옵션 모드에선 이 카드 대신 위(섹션 01, 색상별 코디 칸 바로 아래)의
              "참고 이미지 (모든 색상 공통)"를 사용한다 — 중복 노출 방지. */}
          {!(extractColors && colorPlans) &&
            otherSlots.map((slot) => {
              const meta = STYLE_SLOT_META[slot];
              const refCount = styleReferenceImages[slot]?.length || 0;
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
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-[11px] text-gray-400">
                      말로 설명하기 어려우면 참고 사진으로 대신 첨부하세요 (최대 3장)
                    </span>
                    <div className="flex items-center gap-2">
                      {refCount > 0 && (
                        <>
                          <span className="text-[11px] font-medium text-gray-700">첨부됨 {refCount}장</span>
                          <button
                            type="button"
                            onClick={() => setStyleReferenceImages((prev) => ({ ...prev, [slot]: [] }))}
                            className="text-[11px] font-medium text-gray-400 hover:text-gray-900 transition"
                          >
                            지우기
                          </button>
                        </>
                      )}
                      {refCount < 3 && (
                        <button
                          type="button"
                          onClick={() => {
                            setStyleRefTargetSlot(slot);
                            styleRefFileInputRef.current?.click();
                          }}
                          className="text-[11px] font-medium text-gray-500 hover:text-gray-900 transition"
                        >
                          + 참고 이미지
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
        </div>
      </section>

      <input
        ref={styleRefFileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (styleRefTargetSlot) handleAddStyleRefFiles(styleRefTargetSlot, e.target.files);
          e.target.value = '';
        }}
      />

      {/* 실행 버튼 */}
      <section className="space-y-3">
        <label className="flex items-center gap-2.5 cursor-pointer select-none px-1">
          <input
            type="checkbox"
            checked={draftMode}
            onChange={(e) => setDraftMode(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 accent-gray-900"
          />
          <span className="text-[12px] text-gray-500">
            <b className="text-gray-700 font-semibold">초안 품질로 생성</b> — 비용 약 1/4. 코디 · 색상 확인용으로 쓰고, 최종 컷은 끄고 생성하세요
          </span>
        </label>
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
            `AI 제품 피팅 생성 — 색상 자동 추출${poseCount > 1 ? ` × 포즈 ${poseCount}장` : ''}`
          ) : (
            `AI 제품 피팅 생성 — 전신 ${poseCount}장${productImages.length > 1 ? ` (참고 사진 ${productImages.length}장 종합)` : ''}`
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
