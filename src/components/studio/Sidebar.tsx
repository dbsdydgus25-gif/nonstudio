'use client';

import React from 'react';

interface SidebarProps {
  activePage: 'fitting' | 'restyle' | 'product' | 'history';
  onPageChange: (page: 'fitting' | 'restyle' | 'product' | 'history') => void;
  onOpenApiKeys: () => void;
  geminiKey: string;
  openaiKey: string;
}

/** 미니멀 라인 아이콘 (stroke=currentColor) — 이모지 대신 사용 */
const Icon = {
  fitting: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-[18px] h-[18px]">
      <circle cx="12" cy="6" r="3" />
      <path d="M7 21v-4a5 5 0 0 1 10 0v4" />
    </svg>
  ),
  product: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-[18px] h-[18px]">
      <path d="M12 4a2 2 0 1 0-2-2" />
      <path d="M12 4 3.5 9.5a1.5 1.5 0 0 0 .9 2.7h15.2a1.5 1.5 0 0 0 .9-2.7L12 4Z" />
    </svg>
  ),
  variation: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-[18px] h-[18px]">
      <rect x="3" y="3" width="7" height="18" rx="1.5" />
      <rect x="14" y="3" width="7" height="8" rx="1.5" />
      <rect x="14" y="15" width="7" height="6" rx="1.5" />
    </svg>
  ),
  history: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-[18px] h-[18px]">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-[18px] h-[18px]">
      <path d="M4 8h10M4 16h6" />
      <circle cx="17" cy="8" r="2.5" />
      <circle cx="13" cy="16" r="2.5" />
    </svg>
  ),
};

const NAV_ITEMS: Array<{
  id: 'restyle' | 'product' | 'fitting' | 'history';
  label: string;
  desc: string;
  icon: React.ReactNode;
}> = [
  { id: 'restyle', label: 'AI 피팅', desc: '실사 사진 한 장으로 확정 룩 제작', icon: Icon.fitting },
  { id: 'product', label: 'AI 제품 피팅', desc: '제품 사진만으로 착용 화보 제작', icon: Icon.product },
  { id: 'fitting', label: 'AI 바리에이션', desc: '확정 룩 유지, 포즈 다양화', icon: Icon.variation },
  { id: 'history', label: '히스토리', desc: '전체 생성 기록', icon: Icon.history },
];

export function Sidebar({ activePage, onPageChange, onOpenApiKeys, geminiKey, openaiKey }: SidebarProps) {
  const keysSet = geminiKey && openaiKey;

  return (
    <aside className="w-64 min-h-screen bg-white border-r border-gray-200 flex flex-col">
      {/* 로고 */}
      <div className="px-6 py-7 border-b border-gray-100">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="NON STUDIO" className="w-full h-auto" />
      </div>

      {/* API 상태 */}
      <div className="px-4 pt-4">
        <button
          onClick={onOpenApiKeys}
          className="w-full flex items-center gap-2 px-3.5 py-2.5 rounded-lg border border-gray-200 hover:border-gray-300 transition text-left"
        >
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${keysSet ? 'bg-gray-900' : 'bg-gray-300'}`} />
          <span className="text-[11px] font-medium tracking-wide text-gray-600">
            {keysSet ? 'API 연결됨' : 'API 키 설정 필요'}
          </span>
        </button>
      </div>

      {/* 메뉴 */}
      <nav className="flex-1 px-4 py-5 space-y-6">
        <div>
          <div className="px-2 pb-2 text-[10px] font-semibold text-gray-400 uppercase tracking-[0.18em]">
            Studio
          </div>
          <div className="space-y-0.5">
            {NAV_ITEMS.slice(0, 3).map((item) => (
              <button
                key={item.id}
                onClick={() => onPageChange(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                  activePage === item.id
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <span className={activePage === item.id ? 'text-white' : 'text-gray-400'}>{item.icon}</span>
                <span className="overflow-hidden">
                  <span className="block text-[13px] font-semibold tracking-tight truncate">{item.label}</span>
                  <span className={`block text-[10px] truncate ${activePage === item.id ? 'text-gray-300' : 'text-gray-400'}`}>
                    {item.desc}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="px-2 pb-2 text-[10px] font-semibold text-gray-400 uppercase tracking-[0.18em]">
            Library
          </div>
          <div className="space-y-0.5">
            {NAV_ITEMS.slice(3).map((item) => (
              <button
                key={item.id}
                onClick={() => onPageChange(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                  activePage === item.id
                    ? 'bg-gray-900 text-white'
                    : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <span className={activePage === item.id ? 'text-white' : 'text-gray-400'}>{item.icon}</span>
                <span className="overflow-hidden">
                  <span className="block text-[13px] font-semibold tracking-tight truncate">{item.label}</span>
                  <span className={`block text-[10px] truncate ${activePage === item.id ? 'text-gray-300' : 'text-gray-400'}`}>
                    {item.desc}
                  </span>
                </span>
              </button>
            ))}
            <button
              onClick={onOpenApiKeys}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors text-gray-500 hover:bg-gray-50 hover:text-gray-900"
            >
              <span className="text-gray-400">{Icon.settings}</span>
              <span className="overflow-hidden">
                <span className="block text-[13px] font-semibold tracking-tight truncate">API 설정</span>
                <span className="block text-[10px] text-gray-400 truncate">Gemini · OpenAI 키</span>
              </span>
            </button>
          </div>
        </div>
      </nav>

      {/* 하단 */}
      <div className="px-6 py-5 border-t border-gray-100">
        <div className="text-[10px] font-medium tracking-[0.18em] text-gray-400 uppercase">Non Studio</div>
        <div className="text-[10px] text-gray-300 mt-0.5">AI Fitting Suite v2</div>
      </div>
    </aside>
  );
}
