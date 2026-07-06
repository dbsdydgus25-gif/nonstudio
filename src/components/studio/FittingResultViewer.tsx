'use client';

import React, { useState } from 'react';

export interface HistoryItem {
  id: string;
  imageUrl: string;
  prompt: string;
  revisedPrompt?: string;
  timestamp: string;
}

interface FittingResultViewerProps {
  currentResult: { imageUrl: string; prompt: string; revisedPrompt?: string } | null;
  history: HistoryItem[];
  onSelectHistory: (item: HistoryItem) => void;
  isGenerating: boolean;
  loadingStage: string;
}

export function FittingResultViewer({
  currentResult,
  history,
  onSelectHistory,
  isGenerating,
  loadingStage,
}: FittingResultViewerProps) {
  const [isZoomed, setIsZoomed] = useState(false);

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
            <a
              href={currentResult.imageUrl}
              target="_blank"
              rel="noreferrer"
              download="AI_Fitting_Result.png"
              className="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-900 font-bold text-xs flex items-center gap-2 transition border border-gray-200"
            >
              <span>⬇️ HD 원본 다운로드</span>
            </a>
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

              {currentResult.revisedPrompt && (
                <div className="mt-6 w-full max-w-2xl bg-gray-50 border border-gray-200 rounded-2xl p-4 text-xs text-gray-500 space-y-1">
                  <div className="font-bold text-emerald-600">✨ OpenAI DALL-E 3 최종 적용 프롬프트:</div>
                  <p className="font-mono leading-relaxed text-[11px] text-gray-600 line-clamp-3 hover:line-clamp-none transition">
                    {currentResult.revisedPrompt}
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
