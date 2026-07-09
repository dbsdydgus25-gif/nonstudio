'use client';

import React, { useState, useEffect, useRef } from 'react';
import ReactCrop, { type Crop, type PercentCrop, centerCrop, makeAspectCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { downloadResultImage } from '@/lib/download-image';

export interface HistoryItem {
  id: string;
  imageUrl: string;
  prompt: string;
  revisedPrompt?: string;
  timestamp: string;
}

interface FittingResultViewerProps {
  currentResult: { imageUrl: string; prompt: string; revisedPrompt?: string; generationId?: string | null } | null;
  history: HistoryItem[];
  onSelectHistory: (item: HistoryItem) => void;
  isGenerating: boolean;
  loadingStage: string;
  /** 결과 만족도 피드백 — 지정하면 결과 이미지 위에 평가 버튼이 표시됨 */
  onRate?: (generationId: string, rating: 'good' | 'bad') => void;
  /** 지정하면 "바리에이션으로 보내기" 버튼이 표시됨 */
  onSendToVariation?: (imageUrl: string) => void;
}

export function FittingResultViewer({
  currentResult,
  history,
  onSelectHistory,
  isGenerating,
  loadingStage,
  onRate,
  onSendToVariation,
}: FittingResultViewerProps) {
  const [isZoomed, setIsZoomed] = useState(false);
  const [ratedAs, setRatedAs] = useState<'good' | 'bad' | null>(null);
  const [isCropMenuOpen, setIsCropMenuOpen] = useState(false);
  const [isCropping, setIsCropping] = useState<string | null>(null);
  const [isFreeCropOpen, setIsFreeCropOpen] = useState(false);
  const [freeCrop, setFreeCrop] = useState<Crop>({ unit: '%', x: 10, y: 10, width: 80, height: 80 });
  const [freeCropPercent, setFreeCropPercent] = useState<PercentCrop | null>(null);
  const [freeCropAspect, setFreeCropAspect] = useState<number | undefined>(undefined);
  const [isDownloadingOriginal, setIsDownloadingOriginal] = useState(false);
  const [isPromptExpanded, setIsPromptExpanded] = useState(false);
  const imgCropRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setRatedAs(null);
    setIsPromptExpanded(false);
  }, [currentResult?.generationId, currentResult?.imageUrl]);

  const handleRate = (rating: 'good' | 'bad') => {
    if (!currentResult?.generationId || !onRate) return;
    setRatedAs(rating);
    onRate(currentResult.generationId, rating);
  };

  const downloadCrop = async (
    body: { imageUrl: string; ratio?: string; region?: { x: number; y: number; width: number; height: number } },
    filenameTag: string,
    busyKey: string
  ) => {
    setIsCropping(busyKey);
    try {
      const res = await fetch('/api/crop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success || !data?.dataUrl) {
        throw new Error(data?.error || '크롭 저장에 실패했습니다.');
      }
      // base64 data URL을 그대로 다운로드하면 브라우저가 파일명을 못 붙이므로 blob으로 변환
      const blobRes = await fetch(data.dataUrl);
      const blob = await blobRes.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fitting_${filenameTag}_${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(err.message || '크롭 저장 중 오류가 발생했습니다.');
    } finally {
      setIsCropping(null);
    }
  };

  const handleCropSave = async (ratio: string) => {
    if (!currentResult) return;
    await downloadCrop({ imageUrl: currentResult.imageUrl, ratio }, ratio.replace(':', 'x'), ratio);
    setIsCropMenuOpen(false);
  };

  const handleFreeCropSave = async () => {
    if (!currentResult || !freeCropPercent) return;
    const region = {
      x: freeCropPercent.x / 100,
      y: freeCropPercent.y / 100,
      width: freeCropPercent.width / 100,
      height: freeCropPercent.height / 100,
    };
    await downloadCrop({ imageUrl: currentResult.imageUrl, region }, 'custom', 'custom');
    setIsFreeCropOpen(false);
  };

  // Supabase 서명 URL은 cross-origin + 1시간 만료라 클라이언트 직접 fetch가 실패할 수 있음
  // (페이지를 오래 열어두면 만료된 URL로 400) — 서버 프록시(/api/download)로 항상 신선하게 받는다.
  const handleDownloadOriginal = async (imageUrl: string) => {
    setIsDownloadingOriginal(true);
    try {
      await downloadResultImage(imageUrl, `AI_Fitting_Result_${Date.now()}.png`);
    } catch (err: any) {
      alert(err?.message || '다운로드에 실패했습니다. 잠시 후 다시 시도해주세요.');
    } finally {
      setIsDownloadingOriginal(false);
    }
  };

  const CROP_RATIOS = ['1:1', '4:5', '3:4', '9:16'];

  const toolButtonClass =
    'px-3.5 py-2 rounded-lg border border-gray-200 hover:border-gray-400 bg-white text-gray-600 hover:text-gray-900 font-medium text-xs tracking-wide transition disabled:opacity-40';

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="bg-white border border-gray-200 rounded-2xl p-7 relative overflow-hidden">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-400 mb-1">Result</div>
            <h3 className="text-base font-semibold text-gray-900 tracking-tight">생성 결과</h3>
          </div>
          {currentResult && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {onRate && currentResult.generationId && (
                <div className="flex items-center gap-1.5 mr-2">
                  <button
                    onClick={() => handleRate('good')}
                    title="이 결과가 좋아요"
                    className={`px-3.5 py-2 rounded-lg border text-xs font-medium tracking-wide transition ${
                      ratedAs === 'good'
                        ? 'bg-gray-900 border-gray-900 text-white'
                        : 'bg-white border-gray-200 text-gray-500 hover:border-gray-400 hover:text-gray-900'
                    }`}
                  >
                    {ratedAs === 'good' ? '저장됨' : '좋음'}
                  </button>
                  <button
                    onClick={() => handleRate('bad')}
                    title="이 결과는 아니에요"
                    className={`px-3.5 py-2 rounded-lg border text-xs font-medium tracking-wide transition ${
                      ratedAs === 'bad'
                        ? 'bg-gray-100 border-gray-300 text-gray-500'
                        : 'bg-white border-gray-200 text-gray-500 hover:border-gray-400 hover:text-gray-900'
                    }`}
                  >
                    아쉬움
                  </button>
                </div>
              )}
              <div className="relative">
                <button onClick={() => setIsCropMenuOpen((v) => !v)} className={toolButtonClass}>
                  비율 저장
                </button>
                {isCropMenuOpen && (
                  <div className="absolute right-0 top-full mt-1.5 z-20 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden min-w-[150px]">
                    {CROP_RATIOS.map((ratio) => (
                      <button
                        key={ratio}
                        onClick={() => handleCropSave(ratio)}
                        disabled={!!isCropping}
                        className="w-full px-4 py-2.5 text-left text-xs font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition disabled:opacity-50"
                      >
                        {isCropping === ratio ? '저장 중...' : `${ratio} 비율로 저장`}
                      </button>
                    ))}
                    <div className="border-t border-gray-100" />
                    <button
                      onClick={() => {
                        setIsCropMenuOpen(false);
                        setFreeCrop({ unit: '%', x: 10, y: 10, width: 80, height: 80 });
                        setFreeCropPercent(null);
                        setFreeCropAspect(undefined);
                        setIsFreeCropOpen(true);
                      }}
                      disabled={!!isCropping}
                      className="w-full px-4 py-2.5 text-left text-xs font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition disabled:opacity-50"
                    >
                      영역 직접 지정
                    </button>
                  </div>
                )}
              </div>
              <button
                onClick={() => handleDownloadOriginal(currentResult.imageUrl)}
                disabled={isDownloadingOriginal}
                className={toolButtonClass}
              >
                {isDownloadingOriginal ? '다운로드 중...' : '원본 다운로드'}
              </button>
              {onSendToVariation && (
                <button
                  onClick={() => onSendToVariation(currentResult.imageUrl)}
                  className="px-3.5 py-2 rounded-lg bg-gray-900 hover:bg-black text-white font-medium text-xs tracking-wide transition"
                >
                  바리에이션으로 보내기
                </button>
              )}
            </div>
          )}
        </div>

        {/* 렌더링 화면 또는 로딩 영역 */}
        <div className="relative min-h-[500px] rounded-xl bg-gray-50 border border-gray-100 overflow-hidden flex items-center justify-center">
          {isGenerating ? (
            <div className="text-center p-8 space-y-6 max-w-md mx-auto">
              <div className="relative w-16 h-16 mx-auto">
                <div className="absolute inset-0 rounded-full border-2 border-gray-200" />
                <div className="absolute inset-0 rounded-full border-2 border-gray-900 border-t-transparent animate-spin" />
              </div>
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-gray-900">{loadingStage || '렌더링 중입니다'}</h4>
                <p className="text-xs text-gray-400 leading-relaxed">
                  모델 정보와 제품 디테일을 반영해 고해상도 컷을 만드는 중입니다. 약 60~90초 정도 걸립니다.
                </p>
              </div>
            </div>
          ) : currentResult ? (
            <div className="w-full flex flex-col items-center p-4">
              <div className="relative group cursor-zoom-in" onClick={() => setIsZoomed(true)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={currentResult.imageUrl}
                  alt="생성 결과"
                  className="max-h-[700px] w-auto rounded-lg object-contain transition duration-500 group-hover:opacity-95"
                />
                <div className="absolute bottom-4 right-4 px-3 py-1.5 rounded-md bg-black/60 backdrop-blur-sm text-white text-[11px] font-medium tracking-wide opacity-0 group-hover:opacity-100 transition">
                  클릭해서 확대
                </div>
              </div>

              {currentResult.prompt && (
                <div className="mt-6 w-full max-w-2xl bg-gray-50 border border-gray-200 rounded-xl p-4 text-xs text-gray-500 space-y-1">
                  <button
                    type="button"
                    onClick={() => setIsPromptExpanded((v) => !v)}
                    className="w-full flex items-center justify-between font-medium text-gray-700 text-left"
                  >
                    <span>
                      전달된 프롬프트 전문 {currentResult.revisedPrompt ? `(${currentResult.revisedPrompt})` : ''}
                    </span>
                    <span className="text-[10px] text-gray-400 shrink-0 ml-2">
                      {isPromptExpanded ? '접기' : '펼치기'}
                    </span>
                  </button>
                  <p
                    className={`font-mono leading-relaxed text-[11px] text-gray-500 whitespace-pre-wrap transition ${
                      isPromptExpanded ? '' : 'line-clamp-6'
                    }`}
                  >
                    {currentResult.prompt}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center p-12 space-y-3">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                className="w-10 h-10 mx-auto text-gray-300"
              >
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="9" cy="9" r="2" />
                <path d="m21 15-3.5-3.5L6 23" />
              </svg>
              <p className="text-[13px] font-medium text-gray-400">아직 생성된 결과가 없습니다</p>
              <p className="text-[11px] text-gray-300">위 단계를 채운 뒤 생성 버튼을 눌러주세요</p>
            </div>
          )}
        </div>
      </div>

      {/* 라이트박스 줌 모달 */}
      {isZoomed && currentResult && (
        <div
          className="fixed inset-0 z-50 bg-black/95 backdrop-blur-xl flex items-center justify-center p-4 animate-fade-in"
          onClick={() => setIsZoomed(false)}
        >
          <button
            onClick={() => setIsZoomed(false)}
            className="absolute top-6 right-6 px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 text-white font-medium text-sm transition"
          >
            닫기
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={currentResult.imageUrl}
            alt="확대 보기"
            className="max-w-full max-h-[90vh] object-contain rounded-lg"
          />
        </div>
      )}

      {/* 자유 비율 크롭 모달 */}
      {isFreeCropOpen && currentResult && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in"
          onClick={() => setIsFreeCropOpen(false)}
        >
          <div
            className="bg-white rounded-2xl p-6 max-w-3xl w-full max-h-[90vh] overflow-auto space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h4 className="text-[15px] font-semibold text-gray-900 tracking-tight">영역 직접 지정</h4>
              <button
                onClick={() => setIsFreeCropOpen(false)}
                className="text-gray-400 hover:text-gray-900 text-sm font-medium"
              >
                닫기
              </button>
            </div>
            <p className="text-xs text-gray-400">
              모서리를 드래그해 원하는 영역을 지정하세요. 비율을 고정하면 그 비율을 유지한 채 위치와 크기만 조절됩니다.
            </p>
            <div className="flex items-center gap-1.5 flex-wrap">
              {([
                { label: '자유', value: undefined },
                { label: '1:1', value: 1 },
                { label: '4:5', value: 4 / 5 },
                { label: '3:4', value: 3 / 4 },
                { label: '9:16', value: 9 / 16 },
              ] as const).map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => {
                    setFreeCropAspect(opt.value);
                    const img = imgCropRef.current;
                    if (opt.value && img && img.naturalWidth && img.naturalHeight) {
                      const nextCrop = centerCrop(
                        makeAspectCrop({ unit: '%', width: 80 }, opt.value, img.naturalWidth, img.naturalHeight),
                        img.naturalWidth,
                        img.naturalHeight,
                      );
                      setFreeCrop(nextCrop);
                      setFreeCropPercent(nextCrop);
                    }
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                    freeCropAspect === opt.value
                      ? 'bg-gray-900 border-gray-900 text-white'
                      : 'bg-white border-gray-200 text-gray-500 hover:border-gray-400'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div className="flex justify-center bg-gray-50 rounded-xl p-2">
              <ReactCrop
                crop={freeCrop}
                aspect={freeCropAspect}
                onChange={(_, percentCrop) => setFreeCrop(percentCrop)}
                onComplete={(_, percentCrop) => setFreeCropPercent(percentCrop)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imgCropRef}
                  src={currentResult.imageUrl}
                  alt="크롭할 이미지"
                  className="max-h-[65vh]"
                />
              </ReactCrop>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setIsFreeCropOpen(false)}
                className="px-4 py-2 rounded-lg border border-gray-200 hover:border-gray-400 text-gray-600 font-medium text-xs transition"
              >
                취소
              </button>
              <button
                onClick={handleFreeCropSave}
                disabled={!freeCropPercent || isCropping === 'custom'}
                className="px-4 py-2 rounded-lg bg-gray-900 hover:bg-black text-white font-medium text-xs transition disabled:opacity-40"
              >
                {isCropping === 'custom' ? '저장 중...' : '이 영역으로 저장'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 생성 갤러리 히스토리 */}
      {history.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-400 mb-1">Archive</div>
              <h4 className="text-sm font-semibold text-gray-900 tracking-tight">최근 결과 {history.length}건</h4>
            </div>
            <span className="text-[11px] text-gray-400">클릭하면 상단에서 다시 확인할 수 있습니다</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3">
            {history.map((item) => (
              <div
                key={item.id}
                onClick={() => onSelectHistory(item)}
                className={`aspect-[3/4] rounded-lg overflow-hidden border cursor-pointer transition group relative ${
                  currentResult?.imageUrl === item.imageUrl
                    ? 'border-gray-900'
                    : 'border-gray-200 hover:border-gray-400'
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.imageUrl}
                  alt={item.timestamp}
                  className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition flex items-end p-2">
                  <span className="text-[10px] font-medium text-white truncate">{item.timestamp}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
