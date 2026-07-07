'use client';

import React, { useState, useEffect } from 'react';

interface ApiKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  geminiKey: string;
  openaiKey: string;
  onSave: (gemini: string, openai: string) => void;
}

export function ApiKeyModal({
  isOpen,
  onClose,
  geminiKey,
  openaiKey,
  onSave,
}: ApiKeyModalProps) {
  const [localGemini, setLocalGemini] = useState(geminiKey);
  const [localOpenai, setLocalOpenai] = useState(openaiKey);
  const [showGemini, setShowGemini] = useState(false);
  const [showOpenai, setShowOpenai] = useState(false);

  useEffect(() => {
    setLocalGemini(geminiKey);
    setLocalOpenai(openaiKey);
  }, [geminiKey, openaiKey]);

  if (!isOpen) return null;

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(localGemini.trim(), localOpenai.trim());
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md p-4 animate-fade-in">
      <div className="relative w-full max-w-lg rounded-3xl bg-white border border-gray-200 p-8 shadow-2xl overflow-hidden">
        {/* 상단 바 배경 글로우 */}
        <div className="absolute -top-24 -right-24 w-48 h-48 bg-violet-200/40 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -bottom-24 -left-24 w-48 h-48 bg-cyan-200/40 rounded-full blur-3xl pointer-events-none" />

        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-xl shadow-lg shadow-violet-500/20">
              🔑
            </div>
            <div>
              <h3 className="text-lg font-black text-gray-900 tracking-tight">API 키 맞춤 설정</h3>
              <p className="text-xs text-gray-400">개인용 로컬 스튜디오 전용 API 연결</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-400 hover:text-gray-900 flex items-center justify-center transition"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSave} className="space-y-5">
          {/* Gemini API Key */}
          <div className="space-y-2">
            <label className="flex items-center justify-between text-xs font-bold text-gray-700">
              <span className="flex items-center gap-1.5 text-cyan-700">
                <span>✨ Google Gemini API 키</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-cyan-100 text-cyan-700">Vision 이미지 분석용</span>
              </span>
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noreferrer"
                className="text-violet-600 hover:text-violet-700 underline"
              >
                발급받기 ↗
              </a>
            </label>
            <div className="relative">
              <input
                type={showGemini ? 'text' : 'password'}
                value={localGemini}
                onChange={(e) => setLocalGemini(e.target.value)}
                placeholder="AIzaSy... (입력하지 않으면 서버 환경변수 사용)"
                className="w-full bg-gray-50 border border-gray-300 rounded-xl px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-cyan-500 transition pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowGemini(!showGemini)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
              >
                {showGemini ? '숨김' : '보기'}
              </button>
            </div>
          </div>

          {/* OpenAI API Key */}
          <div className="space-y-2">
            <label className="flex items-center justify-between text-xs font-bold text-gray-700">
              <span className="flex items-center gap-1.5 text-emerald-700">
                <span>🎨 OpenAI API 키</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-100 text-emerald-700">DALL-E 3 피팅용</span>
              </span>
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noreferrer"
                className="text-violet-600 hover:text-violet-700 underline"
              >
                발급받기 ↗
              </a>
            </label>
            <div className="relative">
              <input
                type={showOpenai ? 'text' : 'password'}
                value={localOpenai}
                onChange={(e) => setLocalOpenai(e.target.value)}
                placeholder="sk-proj-... (충전된 개인 키 입력)"
                className="w-full bg-gray-50 border border-gray-300 rounded-xl px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-emerald-500 transition pr-10 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowOpenai(!showOpenai)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
              >
                {showOpenai ? '숨김' : '보기'}
              </button>
            </div>
          </div>

          <div className="pt-2 rounded-xl bg-gray-50 border border-gray-200 p-3 text-[11px] text-gray-500 leading-relaxed space-y-1">
            <p>💡 입력하신 API 키는 브라우저 내부(<code className="text-violet-600">localStorage</code>)에만 안전하게 보관됩니다.</p>
          </div>

          <div className="flex gap-3 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-700 font-bold text-sm transition"
            >
              취소
            </button>
            <button
              type="submit"
              className="flex-1 py-3 rounded-xl bg-gradient-to-r from-violet-600 via-indigo-600 to-cyan-600 hover:opacity-90 text-white font-black text-sm shadow-lg shadow-violet-600/30 transition"
            >
              저장하고 적용하기
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
