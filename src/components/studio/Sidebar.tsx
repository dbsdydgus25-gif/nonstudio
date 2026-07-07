'use client';

import React from 'react';

interface SidebarProps {
  activePage: 'fitting' | 'restyle' | 'history';
  onPageChange: (page: 'fitting' | 'restyle' | 'history') => void;
  onOpenApiKeys: () => void;
  geminiKey: string;
  openaiKey: string;
}

export function Sidebar({ activePage, onPageChange, onOpenApiKeys, geminiKey, openaiKey }: SidebarProps) {
  const keysSet = geminiKey && openaiKey;

  return (
    <aside className="w-64 min-h-screen bg-white border-r border-gray-200 flex flex-col">
      {/* 로고 */}
      <div className="px-5 py-6 border-b border-gray-200">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="NON STUDIO" className="w-full h-auto" />
      </div>

      {/* API 상태 표시 */}
      <div className="px-4 py-3 border-b border-gray-200">
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold ${
          keysSet
            ? 'bg-emerald-50 border border-emerald-200 text-emerald-700'
            : 'bg-red-50 border border-red-200 text-red-600'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${keysSet ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
          {keysSet ? 'API 연결됨' : 'API 키 설정 필요'}
        </div>
      </div>

      {/* 메뉴 */}
      <nav className="flex-1 p-3 space-y-1">
        {/* 피팅 메뉴 그룹 */}
        <div className="mb-2">
          <div className="px-3 py-1.5 text-[10px] font-black text-gray-400 uppercase tracking-widest">
            피팅 모드
          </div>

          <button
            onClick={() => { onPageChange('restyle'); }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all group ${
              activePage === 'restyle'
                ? 'bg-amber-50 border border-amber-300 text-amber-700'
                : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900 border border-transparent'
            }`}
          >
            <span className="text-lg">✨</span>
            <div className="overflow-hidden">
              <div className="text-sm font-bold truncate">AI 피팅</div>
              <div className="text-[10px] text-gray-400 truncate">실사 사진 → 전신 1장 확정 룩</div>
            </div>
            {activePage === 'restyle' && (
              <span className="ml-auto w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" />
            )}
          </button>

          <button
            onClick={() => { onPageChange('fitting'); }}
            className={`mt-1 w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all group ${
              activePage === 'fitting'
                ? 'bg-amber-50 border border-amber-300 text-amber-700'
                : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900 border border-transparent'
            }`}
          >
            <span className="text-lg">🧍</span>
            <div className="overflow-hidden">
              <div className="text-sm font-bold truncate">AI 바리에이션</div>
              <div className="text-[10px] text-gray-400 truncate">확정된 룩 유지, 포즈만 다양하게</div>
            </div>
            {activePage === 'fitting' && (
              <span className="ml-auto w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" />
            )}
          </button>
        </div>

        {/* 구분선 */}
        <div className="border-t border-gray-200 my-2" />

        {/* 히스토리 */}
        <div className="mb-2">
          <button
            onClick={() => { onPageChange('history'); }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all group ${
              activePage === 'history'
                ? 'bg-amber-50 border border-amber-300 text-amber-700'
                : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900 border border-transparent'
            }`}
          >
            <span className="text-lg">📚</span>
            <div className="overflow-hidden">
              <div className="text-sm font-bold truncate">히스토리</div>
              <div className="text-[10px] text-gray-400 truncate">전체 생성 기록 보기</div>
            </div>
            {activePage === 'history' && (
              <span className="ml-auto w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" />
            )}
          </button>
        </div>

        {/* 구분선 */}
        <div className="border-t border-gray-200 my-2" />

        {/* 기타 메뉴 */}
        <div>
          <div className="px-3 py-1.5 text-[10px] font-black text-gray-400 uppercase tracking-widest">
            관리
          </div>

          <button
            onClick={onOpenApiKeys}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all text-gray-500 hover:bg-gray-50 hover:text-gray-900 border border-transparent"
          >
            <span className="text-base">⚙️</span>
            <div>
              <div className="text-sm font-bold">API 설정</div>
              <div className="text-[10px] text-gray-400">Gemini · OpenAI 키</div>
            </div>
          </button>
        </div>
      </nav>

      {/* 하단 버전 */}
      <div className="px-5 py-4 border-t border-gray-200">
        <div className="text-[10px] text-gray-400 font-medium">
          NON STUDIO v2.0
        </div>
        <div className="text-[10px] text-gray-300">
          Gemini Vision + GPT-Image-2
        </div>
      </div>
    </aside>
  );
}
