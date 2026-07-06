'use client';

import React, { useState } from 'react';
import { USER_ADDITION_EXAMPLES, FITTING_MODE_INFO, type FittingMode } from '@/lib/fitting-prompts';

interface PromptEditorProps {
  mode: FittingMode;
  userAdditions: string;
  onUserAdditionsChange: (val: string) => void;
  garmentAnalysis?: {
    color: string;
    material: string;
    fitType: string;
    details: string;
    texture: string;
    lightReaction: string;
  } | null;
}

export function PromptEditor({ mode, userAdditions, onUserAdditionsChange, garmentAnalysis }: PromptEditorProps) {
  const [isSystemExpanded, setIsSystemExpanded] = useState(false);
  const modeInfo = FITTING_MODE_INFO[mode];

  return (
    <div className="space-y-4">
      {/* 고정 시스템 프롬프트 뷰 (읽기 전용) */}
      <div className="bg-gray-50 border border-gray-200 rounded-2xl overflow-hidden">
        <button
          onClick={() => setIsSystemExpanded(!isSystemExpanded)}
          className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:bg-gray-100 transition"
        >
          <div className="flex items-center gap-2.5">
            <span className="text-sm">🔒</span>
            <div>
              <div className="text-xs font-black text-gray-700">고정 시스템 프롬프트 (변경 불가)</div>
              <div className="text-[10px] text-gray-400">모델 체형 · 스튜디오 환경 · 핏 표현 규칙 자동 포함</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold border border-amber-200">
              {modeInfo.icon} {modeInfo.label}
            </span>
            <svg
              className={`w-4 h-4 text-gray-400 transition-transform ${isSystemExpanded ? 'rotate-180' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </button>

        {isSystemExpanded && (
          <div className="px-4 pb-4 space-y-3 border-t border-gray-200">
            <div className="mt-3 space-y-2">
              {[
                { label: '👤 모델 신체', value: '177cm / 74kg / 어깨 넓음 / 슬림 머슬핏 한국 남성 모델' },
                { label: '🎬 카메라 앵글', value: modeInfo.description },
                { label: '💡 조명 환경', value: '소프트박스 정면 + 좌측 보조광 / 순백색 스튜디오 배경 (#FFFFFF)' },
                {
                  label: '👔 핏 표현 규칙',
                  value: '오버사이즈 → 몸에서 여유있게 떨어짐 / 레귤러 → 자연스러운 드레이프 / 슬림 → 몸에 밀착',
                },
                { label: '🔐 얼굴·포즈 고정', value: '원본 모델 얼굴 · 피부 · 헤어 · 포즈 100% 유지 (변경 절대 금지)' },
              ].map((row) => (
                <div key={row.label} className="flex gap-3 text-xs">
                  <span className="text-gray-400 font-bold flex-shrink-0 w-32">{row.label}</span>
                  <span className="text-gray-500">{row.value}</span>
                </div>
              ))}

              {/* Gemini 분석 결과 */}
              {garmentAnalysis && (
                <div className="mt-3 pt-3 border-t border-gray-200">
                  <div className="text-[10px] font-black text-emerald-600 mb-2">✅ Gemini 의류 분석 결과 (자동 주입됨)</div>
                  <div className="space-y-1.5">
                    {[
                      { label: '색상', value: garmentAnalysis.color },
                      { label: '소재', value: garmentAnalysis.material },
                      { label: '핏', value: garmentAnalysis.fitType.toUpperCase() },
                      { label: '디테일', value: garmentAnalysis.details },
                      { label: '질감', value: garmentAnalysis.texture },
                      { label: '빛 반응', value: garmentAnalysis.lightReaction },
                    ].map((row) => (
                      <div key={row.label} className="flex gap-2 text-xs">
                        <span className="text-gray-400 font-bold flex-shrink-0 w-12">{row.label}</span>
                        <span className="text-gray-600">{row.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 사용자 추가 입력 (자유 형식) */}
      <div className="bg-white border border-amber-200 rounded-2xl overflow-hidden">
        <div className="px-4 py-3.5 border-b border-gray-200">
          <div className="flex items-center gap-2.5">
            <span className="text-sm">✏️</span>
            <div>
              <div className="text-xs font-black text-amber-700">추가 스타일링 지시 (선택 입력)</div>
              <div className="text-[10px] text-gray-400">포즈, 액세서리, 세부 연출 등 자유롭게 입력</div>
            </div>
          </div>
        </div>

        <div className="p-4 space-y-3">
          <textarea
            value={userAdditions}
            onChange={(e) => onUserAdditionsChange(e.target.value)}
            placeholder={`예시:\n주머니에 손을 넣고 있어줘\n은색 팔찌 차고 있게 해줘\n후드는 올려줘`}
            rows={4}
            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-amber-500 resize-none font-mono leading-relaxed transition"
          />

          {/* 예시 태그 빠른 입력 */}
          <div className="space-y-2">
            <div className="text-[10px] text-gray-400 font-bold">⚡ 빠른 예시 (클릭하면 추가됨)</div>
            <div className="flex flex-wrap gap-2">
              {USER_ADDITION_EXAMPLES.map((example) => (
                <button
                  key={example}
                  onClick={() => {
                    const newVal = userAdditions
                      ? `${userAdditions}\n${example}`
                      : example;
                    onUserAdditionsChange(newVal);
                  }}
                  className="px-2.5 py-1 rounded-lg bg-gray-100 border border-gray-200 text-xs text-gray-500 hover:bg-amber-50 hover:border-amber-300 hover:text-amber-700 transition"
                >
                  + {example}
                </button>
              ))}
            </div>
          </div>

          {userAdditions && (
            <button
              onClick={() => onUserAdditionsChange('')}
              className="text-[10px] text-gray-400 hover:text-red-500 transition"
            >
              ✕ 추가 입력 초기화
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
