'use client';

import React, { useState, useEffect } from 'react';
import { Sidebar } from '@/components/studio/Sidebar';
import { RestyleSection } from '@/components/studio/RestyleSection';
import { ProductFittingSection } from '@/components/studio/ProductFittingSection';
import { VariationSection } from '@/components/studio/VariationSection';
import { VideoSection } from '@/components/studio/VideoSection';
import { ModelProfileSection } from '@/components/studio/ModelProfileSection';
import { HistorySection } from '@/components/studio/HistorySection';
import { ApiKeyModal } from '@/components/studio/ApiKeyModal';
import { LoginScreen } from '@/components/studio/LoginScreen';

export default function StudioPage() {
  // 로그인 상태 — API 키/모델 정보/히스토리가 전부 계정에 귀속되므로 로그인이 첫 관문
  const [authState, setAuthState] = useState<'loading' | 'loggedOut' | 'loggedIn'>('loading');
  const [username, setUsername] = useState('');

  // API Keys — 계정별로 서버(Supabase Storage)에 저장. localStorage는 더 이상 쓰지 않는다.
  const [geminiKey, setGeminiKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [isKeyModalOpen, setIsKeyModalOpen] = useState(false);

  // Navigation — 'restyle' = AI 피팅, 'product' = AI 제품 피팅, 'fitting' = AI 바리에이션, 'video' = AI 영상
  const [activePage, setActivePage] = useState<'fitting' | 'restyle' | 'product' | 'video' | 'model' | 'history'>('restyle');

  // 가상 모델 확정 여부 — 모델이 없으면 생성 서비스(피팅/제품 피팅/바리에이션)는 잠금
  const [modelReady, setModelReady] = useState(false);

  // AI 피팅 → AI 바리에이션으로 넘기는 이미지
  const [variationSourceImage, setVariationSourceImage] = useState<string | null>(null);
  // AI 제품 피팅 / 바리에이션 → AI 영상으로 넘기는 이미지
  const [videoSourceImage, setVideoSourceImage] = useState<string | null>(null);

  /** 모델 준비 여부 확인 — 기준 이미지가 있고 빌더가 생성 중이 아니면 사용 가능 */
  const checkModelReady = async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/model-profile');
      if (!res.ok) return false;
      const data = await res.json();
      const ready = !!data?.identityImageUrl && data?.profile?.builderStatus !== 'building';
      setModelReady(ready);
      return ready;
    } catch {
      return false;
    }
  };

  /** 로그인 후 계정 설정(API 키) 로드 — 과거 localStorage에 남아있던 키는 1회 서버로 이관 */
  const loadSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) return;
      const data = await res.json();
      let g = data?.settings?.geminiKey || '';
      let o = data?.settings?.openaiKey || '';

      if (!g && !o) {
        const legacyG =
          localStorage.getItem('elon_gemini_key') || localStorage.getItem('personal_gemini_key') || '';
        const legacyO =
          localStorage.getItem('elon_openai_key') || localStorage.getItem('personal_openai_key') || '';
        if (legacyG || legacyO) {
          g = legacyG;
          o = legacyO;
          await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ geminiKey: g, openaiKey: o }),
          });
        }
      }
      setGeminiKey(g);
      setOpenaiKey(o);
    } catch {
      // 설정 로드 실패해도 스튜디오는 열어준다 — API 설정 모달에서 다시 저장 가능
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/auth/me');
        if (res.ok) {
          const data = await res.json();
          setUsername(data.username || '');
          setAuthState('loggedIn');
          const [, ready] = await Promise.all([loadSettings(), checkModelReady()]);
          if (!ready) setActivePage('model'); // 모델이 없으면 모델 만들기부터
        } else {
          setAuthState('loggedOut');
        }
      } catch {
        setAuthState('loggedOut');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLoggedIn = async (name: string) => {
    setUsername(name);
    setAuthState('loggedIn');
    const [, ready] = await Promise.all([loadSettings(), checkModelReady()]);
    if (!ready) setActivePage('model');
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      setGeminiKey('');
      setOpenaiKey('');
      setUsername('');
      setAuthState('loggedOut');
    }
  };

  const handleSaveKeys = async (g: string, o: string) => {
    setGeminiKey(g);
    setOpenaiKey(o);
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geminiKey: g, openaiKey: o }),
      });
    } catch {
      // 저장 실패 시에도 이번 세션 상태에는 반영되어 있음 — 다음 저장에서 재시도
    }
  };

  const handleSendToVariation = (imageUrl: string) => {
    setVariationSourceImage(imageUrl);
    setActivePage('fitting');
  };

  const handleSendToVideo = (imageUrl: string) => {
    setVideoSourceImage(imageUrl);
    setActivePage('video');
  };

  if (authState === 'loading') {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-[11px] tracking-[0.22em] text-gray-300 uppercase animate-pulse">
          Non Fitting
        </div>
      </div>
    );
  }

  if (authState === 'loggedOut') {
    return <LoginScreen onLoggedIn={handleLoggedIn} />;
  }

  return (
    <div className="flex min-h-screen bg-white text-gray-900 font-sans">
      {/* 왼쪽 사이드바 */}
      <Sidebar
        activePage={activePage}
        onPageChange={(p) => {
          // 모델 미확정 상태에선 생성 서비스 진입을 막고 모델 만들기로 유도
          if (!modelReady && (p === 'restyle' || p === 'product' || p === 'fitting')) {
            setActivePage('model');
            return;
          }
          setActivePage(p);
        }}
        onOpenApiKeys={() => setIsKeyModalOpen(true)}
        geminiKey={geminiKey}
        openaiKey={openaiKey}
        username={username}
        onLogout={handleLogout}
        modelReady={modelReady}
      />

      {/* 오른쪽 워크스페이스 */}
      <main className="flex-1 overflow-y-auto">
        {/* 상단 헤더 */}
        <header className="sticky top-0 z-30 border-b border-gray-200 bg-white/90 backdrop-blur-xl px-8 h-14 flex items-center justify-between">
          <div>
            {activePage === 'restyle' ? (
              <>
                <h1 className="text-[13px] font-semibold text-gray-900 tracking-tight">AI 피팅</h1>
                <p className="text-[10px] text-gray-400">실사 사진 한 장으로 확정 룩 제작</p>
              </>
            ) : activePage === 'product' ? (
              <>
                <h1 className="text-[13px] font-semibold text-gray-900 tracking-tight">AI 제품 피팅</h1>
                <p className="text-[10px] text-gray-400">제품 사진만으로 모델 착용 화보 제작 — 색상 옵션별 지원</p>
              </>
            ) : activePage === 'fitting' ? (
              <>
                <h1 className="text-[13px] font-semibold text-gray-900 tracking-tight">AI 바리에이션</h1>
                <p className="text-[10px] text-gray-400">확정 룩을 그대로 유지한 채 포즈만 다양화</p>
              </>
            ) : activePage === 'model' ? (
              <>
                <h1 className="text-[13px] font-semibold text-gray-900 tracking-tight">모델 정보</h1>
                <p className="text-[10px] text-gray-400">모든 생성이 참고하는 기준 이미지와 체형 스펙 관리</p>
              </>
            ) : (
              <>
                <h1 className="text-[13px] font-semibold text-gray-900 tracking-tight">히스토리</h1>
                <p className="text-[10px] text-gray-400">전체 생성 기록</p>
              </>
            )}
          </div>
          <button
            onClick={() => setIsKeyModalOpen(true)}
            className="px-3.5 py-2 rounded-lg border border-gray-200 hover:border-gray-400 text-xs text-gray-500 hover:text-gray-900 font-medium tracking-wide transition"
          >
            API 설정
          </button>
        </header>

        {activePage === 'restyle' ? (
          <RestyleSection
            geminiKey={geminiKey}
            openaiKey={openaiKey}
            onNeedKeys={() => setIsKeyModalOpen(true)}
            onSendToVariation={handleSendToVariation}
          />
        ) : activePage === 'product' ? (
          <ProductFittingSection
            geminiKey={geminiKey}
            openaiKey={openaiKey}
            onNeedKeys={() => setIsKeyModalOpen(true)}
            onSendToVariation={handleSendToVariation}
            onSendToVideo={handleSendToVideo}
          />
        ) : activePage === 'fitting' ? (
          <VariationSection
            openaiKey={openaiKey}
            onNeedKeys={() => setIsKeyModalOpen(true)}
            incomingImage={variationSourceImage}
            onConsumeIncomingImage={() => setVariationSourceImage(null)}
            onSendToVideo={handleSendToVideo}
          />
        ) : activePage === 'video' ? (
          <VideoSection
            geminiKey={geminiKey}
            onNeedKeys={() => setIsKeyModalOpen(true)}
            incomingImage={videoSourceImage}
            onConsumeIncomingImage={() => setVideoSourceImage(null)}
          />
        ) : activePage === 'model' ? (
          <ModelProfileSection
            geminiKey={geminiKey}
            openaiKey={openaiKey}
            onNeedKeys={() => setIsKeyModalOpen(true)}
            onModelReady={() => setModelReady(true)}
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
