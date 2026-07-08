'use client';

import React, { useState, useEffect, useRef } from 'react';
import ReactCrop, { type Crop, type PercentCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';

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
  /** 결과 만족도 피드백 — 지정하면 결과 이미지 위에 👍/👎 버튼이 표시됨 */
  onRate?: (generationId: string, rating: 'good' | 'bad') => void;
  /** 지정하면 "AI 바리에이션으로 보내기" 버튼이 표시됨 (AI 피팅 결과 화면 전용) */
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
  const imgCropRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setRatedAs(null);
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
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || '크롭 저장에 실패했습니다.');
      }
      const blob = await res.blob();
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

  const CROP_RATIOS = ['1:1', '4:5', '3:4', '9:16'];

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="bg-white border border-gray-200 rounded-3xl p-8 relative overflow-hidden shadow-sm">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-xl shadow-lg shadow-emerald-500/20">
              🖼️
            </div>
            <div>
              <h3 className="text-lg font-black text-gray-900 tracking-tight">
                최종 고화질 가상 피팅 결과 (HD Studio Result)
              </h3>
              <p className="text-xs text-gray-400">
                OpenAI DALL-E 3 HD로 옷의 텍스처와 특성을 완벽히 재현한 결과
              </p>
            </div>
          </div>
          {currentResult && (
            <div className="flex items-center gap-2">
              {onRate && currentResult.generationId && (
                <div className="flex items-center gap-1.5 mr-1">
                  <button
                    onClick={() => handleRate('good')}
                    title="이 결과가 좋아요"
                    className={`px-3 py-2 rounded-xl border text-xs font-bold transition flex items-center gap-1 ${
                      ratedAs === 'good'
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                        : 'bg-white border-gray-200 text-gray-500 hover:text-emerald-600 hover:border-emerald-300'
                    }`}
                  >
                    👍 {ratedAs === 'good' ? '저장됨' : '이거다'}
                  </button>
                  <button
                    onClick={() => handleRate('bad')}
                    title="이 결과는 아니에요"
                    className={`px-3 py-2 rounded-xl border text-xs font-bold transition flex items-center gap-1 ${
                      ratedAs === 'bad'
                        ? 'bg-rose-50 border-rose-300 text-rose-700'
                        : 'bg-white border-gray-200 text-gray-500 hover:text-rose-600 hover:border-rose-300'
                    }`}
                  >
                    👎 아니야
                  </button>
                </div>
              )}
              <div className="relative">
                <button
                  onClick={() => setIsCropMenuOpen((v) => !v)}
                  className="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-900 font-bold text-xs flex items-center gap-2 transition border border-gray-200"
                >
                  <span>✂️ 비율 저장</span>
                </button>
                {isCropMenuOpen && (
                  <div className="absolute right-0 top-full mt-1.5 z-20 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden min-w-[140px]">
                    {CROP_RATIOS.map((ratio) => (
                      <button
                        key={ratio}
                        onClick={() => handleCropSave(ratio)}
                        disabled={!!isCropping}
                        className="w-full px-4 py-2.5 text-left text-xs font-bold text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition disabled:opacity-50"
                      >
                        {isCropping === ratio ? '저장 중...' : `${ratio} 로 저장`}
                      </button>
                    ))}
                    <div className="border-t border-gray-100" />
                    <button
                      onClick={() => {
                        setIsCropMenuOpen(false);
                        setFreeCrop({ unit: '%', x: 10, y: 10, width: 80, height: 80 });
                        setFreeCropPercent(null);
                        setIsFreeCropOpen(true);
                      }}
                      disabled={!!isCropping}
                      className="w-full px-4 py-2.5 text-left text-xs font-bold text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition disabled:opacity-50"
                    >
                      ✂️ 자유 비율 직접 지정
                    </button>
                  </div>
                )}
              </div>
              <a
                href={currentResult.imageUrl}
                target="_blank"
                rel="noreferrer"
                download="AI_Fitting_Result.png"
                className="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-900 font-bold text-xs flex items-center gap-2 transition border border-gray-200"
              >
                <span>⬇️ HD 원본 다운로드</span>
              </a>
              {onSendToVariation && (
                <button
                  onClick={() => onSendToVariation(currentResult.imageUrl)}
                  className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-bold text-xs flex items-center gap-2 transition"
                >
                  <span>🧍 AI 바리에이션으로 보내기</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* 렌더링 화면 또는 로딩 영역 */}
        <div className="relative min-h-[500px] rounded-2xl bg-gray-50 border border-gray-200 overflow-hidden flex items-center justify-center">
          {isGenerating ? (
            <div className="text-center p-8 space-y-6 max-w-md mx-auto">
              <div className="relative w-20 h-20 mx-auto">
                <div className="absolute inset-0 rounded-full border-4 border-emerald-200" />
                <div className="absolute inset-0 rounded-full border-4 border-emerald-500 border-t-transparent animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center text-xl">
                  ✨
                </div>
              </div>
              <div className="space-y-2">
                <h4 className="text-base font-black text-gray-900 animate-pulse">
                  {loadingStage || '고화질 렌더링 중...'}
                </h4>
                <p className="text-xs text-gray-400 leading-relaxed">
                  OpenAI의 최첨단 DALL-E 3 모델이 프롬프트를 분석하여 니트의 원사 디테일과 카라 라인, 핏을 실감나게 입혀내고 있습니다. (약 15~25초 소요)
                </p>
              </div>
            </div>
          ) : currentResult ? (
            <div className="w-full flex flex-col items-center p-4">
              <div className="relative group cursor-zoom-in" onClick={() => setIsZoomed(true)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={currentResult.imageUrl}
                  alt="AI Fitting Result"
                  className="max-h-[700px] w-auto rounded-xl shadow-2xl object-contain transition duration-500 group-hover:scale-[1.01]"
                />
                <div className="absolute bottom-4 right-4 px-3 py-1.5 rounded-full bg-black/70 backdrop-blur-md border border-white/20 text-white text-xs font-bold opacity-0 group-hover:opacity-100 transition flex items-center gap-1.5">
                  <span>🔍 클릭해서 확대</span>
                </div>
              </div>

              {currentResult.prompt && (
                <div className="mt-6 w-full max-w-2xl bg-gray-50 border border-gray-200 rounded-2xl p-4 text-xs text-gray-500 space-y-1">
                  <div className="font-bold text-emerald-600">
                    ✨ OpenAI에 실제로 전달된 프롬프트 전문 {currentResult.revisedPrompt ? `(${currentResult.revisedPrompt})` : ''}:
                  </div>
                  <p className="font-mono leading-relaxed text-[11px] text-gray-600 whitespace-pre-wrap line-clamp-6 hover:line-clamp-none transition">
                    {currentResult.prompt}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center p-12 space-y-3">
              <div className="w-16 h-16 rounded-3xl bg-white border border-gray-200 flex items-center justify-center mx-auto text-3xl">
                🎨
              </div>
              <p className="text-sm font-bold text-gray-400">
                아직 생성된 피팅 이미지가 없습니다.
              </p>
              <p className="text-xs text-gray-300">
                위 단계에서 프롬프트를 확인한 뒤 &apos;생성하기&apos; 버튼을 클릭해주세요.
              </p>
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
            className="absolute top-6 right-6 px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white font-bold text-sm transition"
          >
            ✕ 닫기
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={currentResult.imageUrl}
            alt="Zoomed Result"
            className="max-w-full max-h-[90vh] object-contain rounded-xl shadow-2xl"
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
            className="bg-white rounded-3xl p-6 max-w-3xl w-full max-h-[90vh] overflow-auto space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h4 className="text-base font-black text-gray-900">✂️ 자유 비율로 영역 지정</h4>
              <button
                onClick={() => setIsFreeCropOpen(false)}
                className="text-gray-400 hover:text-gray-700 text-sm font-bold"
              >
                ✕ 닫기
              </button>
            </div>
            <p className="text-xs text-gray-400">
              모서리를 드래그해서 원하는 영역을 지정한 뒤 저장하세요.
            </p>
            <div className="flex justify-center bg-gray-50 rounded-2xl p-2">
              <ReactCrop
                crop={freeCrop}
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
                className="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold text-xs transition"
              >
                취소
              </button>
              <button
                onClick={handleFreeCropSave}
                disabled={!freeCropPercent || isCropping === 'custom'}
                className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-white font-bold text-xs transition disabled:opacity-50"
              >
                {isCropping === 'custom' ? '저장 중...' : '이 영역으로 저장'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 생성 갤러리 히스토리 */}
      {history.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-3xl p-6 space-y-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-black text-gray-900 flex items-center gap-2">
              <span>📚 이번 세션 피팅 히스토리 ({history.length})</span>
            </h4>
            <span className="text-xs text-gray-400">클릭하면 상단에서 다시 확인 가능</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-3">
            {history.map((item) => (
              <div
                key={item.id}
                onClick={() => onSelectHistory(item)}
                className={`aspect-[3/4] rounded-xl overflow-hidden border-2 cursor-pointer transition group relative ${
                  currentResult?.imageUrl === item.imageUrl
                    ? 'border-emerald-500 scale-105 shadow-lg shadow-emerald-500/20'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.imageUrl}
                  alt={item.timestamp}
                  className="w-full h-full object-cover group-hover:scale-105 transition duration-300"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition flex items-end p-2">
                  <span className="text-[10px] font-bold text-white truncate">
                    {item.timestamp}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
