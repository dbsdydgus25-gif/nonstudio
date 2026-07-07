'use client';

import React, { useState, useEffect } from 'react';
import { Sidebar } from '@/components/studio/Sidebar';
import { RestyleSection } from '@/components/studio/RestyleSection';
import { VariationSection } from '@/components/studio/VariationSection';
import { HistorySection } from '@/components/studio/HistorySection';
import { ApiKeyModal } from '@/components/studio/ApiKeyModal';

export default function StudioPage() {
  // API Keys
  const [geminiKey, setGeminiKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [isKeyModalOpen, setIsKeyModalOpen] = useState(false);

  // Navigation — 'restyle' = AI 피팅, 'fitting' = AI 바리에이션 (내부 상태값 이름은 유지, 화면 라벨만 바뀜)
  const [activePage, setActivePage] = useState<'fitting' | 'restyle' | 'history'>('restyle');

  // AI 피팅 → AI 바리에이션으로 넘기는 이미지
  const [variationSourceImage, setVariationSourceImage] = useState<string | null>(null);

  useEffect(() => {
    const g =
      localStorage.getItem('elon_gemini_key') ||
      localStorage.getItem('personal_gemini_key') ||
      '';
    const o =
      localStorage.getItem('elon_openai_key') ||
      localStorage.getItem('personal_openai_key') ||
      '';
    setGeminiKey(g);
    setOpenaiKey(o);
    if (g) localStorage.setItem('elon_gemini_key', g);
    if (o) localStorage.setItem('elon_openai_key', o);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveKeys = (g: string, o: string) => {
    localStorage.setItem('elon_gemini_key', g);
    localStorage.setItem('elon_openai_key', o);
    setGeminiKey(g);
    setOpenaiKey(o);
  };

  const handleSendToVariation = (imageUrl: string) => {
    setVariationSourceImage(imageUrl);
    setActivePage('fitting');
  };

  return (
    <div className="flex min-h-screen bg-white text-gray-900 font-sans">
      {/* 왼쪽 사이드바 */}
      <Sidebar
        activePage={activePage}
        onPageChange={(p) => setActivePage(p)}
        onOpenApiKeys={() => setIsKeyModalOpen(true)}
        geminiKey={geminiKey}
        openaiKey={openaiKey}
      />

      {/* 오른쪽 워크스페이스 */}
      <main className="flex-1 overflow-y-auto">
        {/* 상단 헤더 */}
        <header className="sticky top-0 z-30 border-b border-gray-200 bg-white/90 backdrop-blur-xl px-8 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {activePage === 'restyle' ? (
              <>
                <span className="text-xl">✨</span>
                <div>
                  <h1 className="text-sm font-black text-gray-900">AI 피팅</h1>
                  <p className="text-[10px] text-gray-400">대충 찍은 실사 사진 한 장 → 전신 1장으로 확정된 룩</p>
                </div>
              </>
            ) : activePage === 'fitting' ? (
              <>
                <span className="text-xl">🧍</span>
                <div>
                  <h1 className="text-sm font-black text-gray-900">AI 바리에이션</h1>
                  <p className="text-[10px] text-gray-400">확정된 룩을 그대로 유지한 채 포즈만 다양하게</p>
                </div>
              </>
            ) : (
              <>
                <span className="text-xl">📚</span>
                <div>
                  <h1 className="text-sm font-black text-gray-900">히스토리</h1>
                  <p className="text-[10px] text-gray-400">전체 생성 기록 보기</p>
                </div>
              </>
            )}
          </div>
          <button
            onClick={() => setIsKeyModalOpen(true)}
            className="px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 border border-gray-200 text-xs text-gray-600 font-bold transition"
          >
            🔑 API 설정
          </button>
        </header>

        {activePage === 'restyle' ? (
          <RestyleSection
            geminiKey={geminiKey}
            openaiKey={openaiKey}
            onNeedKeys={() => setIsKeyModalOpen(true)}
            onSendToVariation={handleSendToVariation}
          />
        ) : activePage === 'fitting' ? (
          <VariationSection
            openaiKey={openaiKey}
            onNeedKeys={() => setIsKeyModalOpen(true)}
            incomingImage={variationSourceImage}
            onConsumeIncomingImage={() => setVariationSourceImage(null)}
          />
        ) : activePage === 'history' ? (
          <HistorySection />
        ) : null}
      </main>

      <ApiKeyModal
        isOpen={isKeyModalOpen}
        onClose={() => setIsKeyModalOpen(false)}
        geminiKey={geminiKey}
        openaiKey={openaiKey}
        onSave={handleSaveKeys}
      />
    </div>
  );
}
