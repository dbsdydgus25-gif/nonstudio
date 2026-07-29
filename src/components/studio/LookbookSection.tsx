'use client';

/**
 * AI 룩북 — 신규 섹션 (2026-07-29 Phase A: 배선만, 실제 UI는 Phase B에서 채움).
 * 1단계: 링크 임포트 → 색상 선택 → 사람 없는 깨끗한 앞/뒤/옆(좌)/옆(우) 4컷 확보.
 * 2단계: 포즈 프리셋을 골라 등록된 가상 모델에게 배치로 입혀 생성.
 */
interface LookbookSectionProps {
  geminiKey: string;
  openaiKey: string;
  onNeedKeys: () => void;
}

export function LookbookSection({ geminiKey, openaiKey, onNeedKeys }: LookbookSectionProps) {
  const keysSet = geminiKey && openaiKey;

  return (
    <div className="max-w-4xl mx-auto px-8 py-10">
      <div className="rounded-xl border border-dashed border-gray-300 px-6 py-16 text-center text-gray-400">
        <p className="text-sm font-medium text-gray-500">AI 룩북 — 준비 중</p>
        <p className="text-xs mt-1.5">링크 임포트 + 4각도 기준컷 확보 UI는 다음 단계에서 채워집니다.</p>
        {!keysSet && (
          <button
            onClick={onNeedKeys}
            className="mt-4 px-3.5 py-2 rounded-lg border border-gray-200 hover:border-gray-400 text-xs text-gray-500 hover:text-gray-900 font-medium tracking-wide transition"
          >
            API 키 설정
          </button>
        )}
      </div>
    </div>
  );
}
