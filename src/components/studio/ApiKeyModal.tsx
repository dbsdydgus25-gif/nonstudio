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
      <div className="relative w-full max-w-lg rounded-2xl bg-white border border-gray-200 p-8">
        <div className="flex items-start justify-between mb-7">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-400 mb-1">Settings</div>
            <h3 className="text-base font-semibold text-gray-900 tracking-tight">API 키 설정</h3>
            <p className="text-xs text-gray-400 mt-0.5">키는 로그인 계정에 안전하게 저장됩니다</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg border border-gray-200 hover:border-gray-400 text-gray-400 hover:text-gray-900 flex items-center justify-center transition text-sm"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSave} className="space-y-5">
          {/* Gemini API Key */}
          <div className="space-y-2">
            <label className="flex items-center justify-between text-xs font-medium text-gray-700">
              <span className="flex items-center gap-2">
                <span className="font-semibold">Google Gemini</span>
                <span className="text-[10px] px-2 py-0.5 rounded border border-gray-200 text-gray-400">이미지 분석</span>
              </span>
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noreferrer"
                className="text-gray-400 hover:text-gray-900 underline underline-offset-2"
              >
                발급받기
              </a>
            </label>
            <div className="relative">
              <input
                type={showGemini ? 'text' : 'password'}
                value={localGemini}
                onChange={(e) => setLocalGemini(e.target.value)}
                placeholder="AIzaSy..."
                className="w-full bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-900 transition pr-14 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowGemini(!showGemini)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-900 text-[11px] font-medium"
              >
                {showGemini ? '숨김' : '보기'}
              </button>
            </div>
          </div>

          {/* OpenAI API Key */}
          <div className="space-y-2">
            <label className="flex items-center justify-between text-xs font-medium text-gray-700">
              <span className="flex items-center gap-2">
                <span className="font-semibold">OpenAI</span>
                <span className="text-[10px] px-2 py-0.5 rounded border border-gray-200 text-gray-400">이미지 생성</span>
              </span>
              <a
                href="https://platform.openai.com/api-keys"
                target="_blank"
                rel="noreferrer"
                className="text-gray-400 hover:text-gray-900 underline underline-offset-2"
              >
                발급받기
              </a>
            </label>
            <div className="relative">
              <input
                type={showOpenai ? 'text' : 'password'}
                value={localOpenai}
                onChange={(e) => setLocalOpenai(e.target.value)}
                placeholder="sk-proj-..."
                className="w-full bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-900 transition pr-14 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowOpenai(!showOpenai)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-900 text-[11px] font-medium"
              >
                {showOpenai ? '숨김' : '보기'}
              </button>
            </div>
          </div>

          <p className="text-[11px] text-gray-400 leading-relaxed border-t border-gray-100 pt-4">
            입력한 API 키는 로그인 계정(비공개 저장소)에 보관됩니다 — 어느 브라우저에서 로그인해도 동일하게 유지되고, 브라우저 데이터를 지워도 사라지지 않습니다.
          </p>

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3 rounded-lg border border-gray-200 hover:border-gray-400 text-gray-600 font-medium text-sm transition"
            >
              취소
            </button>
            <button
              type="submit"
              className="flex-1 py-3 rounded-lg bg-gray-900 hover:bg-black text-white font-semibold text-sm transition"
            >
              저장
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
