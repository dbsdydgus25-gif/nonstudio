'use client';

import React from 'react';

interface AnalysisPanelProps {
  analyzedResult: {
    koreanSummary: string;
    garmentAnalysis?: string;
    personAnalysis?: string;
    keyFeatures?: string[];
    englishPrompt: string;
  } | null;
  promptText: string;
  onPromptChange: (text: string) => void;
  onAutoPipeline: () => void;
  isAutoRunning: boolean;
  autoPipelineStage: number; // 0: 대기, 1: Gemini 분석, 2: DALL-E 3 화보, 3: 상세페이지 카피, 4: 완료
  canRun: boolean;
  dalleQuality: string;
  setDalleQuality: (q: string) => void;
  dalleSize: string;
  setDalleSize: (s: string) => void;
  dalleStyle: string;
  setDalleStyle: (st: string) => void;
}

export function AnalysisPanel({
  analyzedResult,
  promptText,
  onPromptChange,
  onAutoPipeline,
  isAutoRunning,
  autoPipelineStage,
  canRun,
  dalleQuality,
  setDalleQuality,
  dalleSize,
  setDalleSize,
  dalleStyle,
  setDalleStyle,
}: AnalysisPanelProps) {
  return (
    <div className="bg-zinc-900/90 border border-amber-500/30 rounded-3xl p-8 backdrop-blur-2xl relative overflow-hidden space-y-8 shadow-2xl">
      <div className="absolute top-0 right-0 w-96 h-96 bg-gradient-to-bl from-amber-500/10 via-purple-600/10 to-transparent rounded-full blur-3xl pointer-events-none" />

      {/* 헤더 */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-white/10 pb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="px-3 py-0.5 rounded-full bg-amber-500 text-zinc-950 font-black text-xs uppercase tracking-wider shadow">
              🔥 ONE-CLICK AUTO PIPELINE
            </span>
            <span className="text-xs text-slate-400">클릭 한 번으로 3단계 AI 파이프라인 논스톱 자동 진행</span>
          </div>
          <h2 className="text-xl md:text-2xl font-black text-white tracking-tight">
            원클릭 룩북 화보 &amp; 13섹션 상세페이지 자동 제작 엔진
          </h2>
        </div>
      </div>

      {/* 옵션 간단 선택부 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-black/40 p-4 rounded-2xl border border-white/10">
        <div className="space-y-1">
          <label className="text-xs font-bold text-slate-400">화질 설정 (Quality)</label>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'hd', label: 'HD 최고화질' },
              { id: 'standard', label: 'Standard' },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setDalleQuality(item.id)}
                className={`py-2 px-3 rounded-xl border text-center transition text-xs font-bold ${
                  dalleQuality === item.id
                    ? 'border-amber-400 bg-amber-500/20 text-white'
                    : 'border-white/10 bg-zinc-900 text-slate-400 hover:border-white/20'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-bold text-slate-400">화면 비율 (Size)</label>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: '1024x1792', label: '9:16 세로 룩북' },
              { id: '1024x1024', label: '1:1 정방형' },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setDalleSize(item.id)}
                className={`py-2 px-3 rounded-xl border text-center transition text-xs font-bold ${
                  dalleSize === item.id
                    ? 'border-amber-400 bg-amber-500/20 text-white'
                    : 'border-white/10 bg-zinc-900 text-slate-400 hover:border-white/20'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-bold text-slate-400">렌더링 톤 (Style)</label>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'natural', label: 'Natural 실사' },
              { id: 'vivid', label: 'Vivid 대비' },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setDalleStyle(item.id)}
                className={`py-2 px-3 rounded-xl border text-center transition text-xs font-bold ${
                  dalleStyle === item.id
                    ? 'border-amber-400 bg-amber-500/20 text-white'
                    : 'border-white/10 bg-zinc-900 text-slate-400 hover:border-white/20'
                  }`}
                >
                  {item.label}
                </button>
            ))}
          </div>
        </div>
      </div>

      {/* 초대형 원클릭 풀오토메이션 실행 버튼 */}
      <div className="pt-2">
        <button
          onClick={onAutoPipeline}
          disabled={!canRun || isAutoRunning}
          className={`w-full py-6 rounded-3xl font-black text-lg md:text-xl flex flex-col sm:flex-row items-center justify-center gap-3 transition shadow-2xl relative overflow-hidden group ${
            !canRun || isAutoRunning
              ? 'bg-white/5 text-slate-500 cursor-not-allowed border border-white/10'
              : 'bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 hover:opacity-95 text-zinc-950 shadow-amber-500/30 hover:scale-[1.01]'
          }`}
        >
          {isAutoRunning ? (
            <div className="flex items-center gap-3">
              <span className="w-6 h-6 rounded-full border-3 border-zinc-950 border-t-transparent animate-spin" />
              <span>자동 파이프라인 가동 중... 잠시만 기다려주세요!</span>
            </div>
          ) : (
            <>
              <span className="text-2xl animate-bounce">⚡</span>
              <span>원클릭 AI 화보 제작 시작 (분석 → DALL-E 3 렌더링 → 13섹션 카피 자동 진행)</span>
            </>
          )}
        </button>
      </div>

      {/* 파이프라인 실시간 진행 상황 바 */}
      {isAutoRunning && (
        <div className="bg-black/80 border border-white/15 rounded-2xl p-6 space-y-4 animate-fade-in">
          <div className="flex items-center justify-between text-xs font-bold text-amber-400">
            <span>🚀 FULL AUTO PIPELINE TRACKER</span>
            <span>{autoPipelineStage === 1 ? '33%' : autoPipelineStage === 2 ? '66%' : '90%'}</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Stage 1 */}
            <div
              className={`p-4 rounded-xl border flex items-center gap-3 transition ${
                autoPipelineStage >= 1
                  ? autoPipelineStage === 1
                    ? 'border-cyan-400 bg-cyan-500/20 text-white animate-pulse'
                    : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-white/5 bg-white/5 text-slate-500'
              }`}
            >
              <div className="text-xl">{autoPipelineStage > 1 ? '✅' : '⚡'}</div>
              <div>
                <div className="text-xs font-bold">1단계: Gemini Vision 렌더 분석</div>
                <div className="text-[11px] opacity-80">177/74 실측 &amp; 원단 빛 반응 계산</div>
              </div>
            </div>

            {/* Stage 2 */}
            <div
              className={`p-4 rounded-xl border flex items-center gap-3 transition ${
                autoPipelineStage >= 2
                  ? autoPipelineStage === 2
                    ? 'border-amber-400 bg-amber-500/20 text-white animate-pulse'
                    : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-white/5 bg-white/5 text-slate-500'
              }`}
            >
              <div className="text-xl">{autoPipelineStage > 2 ? '✅' : '🎨'}</div>
              <div>
                <div className="text-xs font-bold">2단계: DALL-E 3 HD 화보 생성</div>
                <div className="text-[11px] opacity-80">스튜디오 조명 아래 옷 핏 렌더링</div>
              </div>
            </div>

            {/* Stage 3 */}
            <div
              className={`p-4 rounded-xl border flex items-center gap-3 transition ${
                autoPipelineStage >= 3
                  ? autoPipelineStage === 3
                    ? 'border-purple-400 bg-purple-500/20 text-white animate-pulse'
                    : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-white/5 bg-white/5 text-slate-500'
              }`}
            >
              <div className="text-xl">{autoPipelineStage > 3 ? '✅' : '📝'}</div>
              <div>
                <div className="text-xs font-bold">3단계: 13섹션 상세페이지 생성</div>
                <div className="text-[11px] opacity-80">구매 전환율 극대화 실전 카피</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 분석 완료 후 프롬프트 확인 및 자유 수정 (자동으로 넘어갔어도 나중에 확인 가능) */}
      {analyzedResult && (
        <div className="bg-black/40 border border-white/10 rounded-2xl p-6 space-y-4 animate-fade-in">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-cyan-400">📋 Gemini 177/74 실측 &amp; 원단 분석 리포트 요약</span>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed font-medium">{analyzedResult.koreanSummary}</p>
          {analyzedResult.keyFeatures && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {analyzedResult.keyFeatures.map((tag, i) => (
                <span key={i} className="px-2.5 py-1 rounded-full bg-white/10 text-white text-[11px] font-bold">
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
