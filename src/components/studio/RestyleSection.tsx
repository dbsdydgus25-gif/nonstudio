'use client';

import React, { useState, useEffect } from 'react';
import { ImageUploader } from './ImageUploader';
import { FittingResultViewer, type HistoryItem } from './FittingResultViewer';
import type { SourcedCategory } from '@/lib/fitting-prompts';
import { pollGenerationStatuses } from '@/lib/poll-generations';
import { useCancelableRun, isCanceledError } from '@/lib/use-cancelable-run';

interface RestyleSectionProps {
  geminiKey: string;
  openaiKey: string;
  onNeedKeys: () => void;
  /** 확정된 AI 피팅 결과를 AI 바리에이션 쪽으로 넘길 때 호출 */
  onSendToVariation?: (imageUrl: string) => void;
}

const CATEGORY_OPTIONS: { id: SourcedCategory; label: string; desc: string }[] = [
  { id: 'top', label: '상의', desc: '입고 있는 상의가 소싱 제품' },
  { id: 'bottom', label: '하의', desc: '입고 있는 하의가 소싱 제품' },
  { id: 'shoes', label: '신발', desc: '신고 있는 신발이 소싱 제품' },
  { id: 'accessory', label: '액세서리', desc: '가방 · 시계 · 주얼리 등' },
];

// 슬롯별로 입력 필드를 분리해서 보낸다 — 예전엔 "상하의 스타일" 한 칸에 여러 슬롯 지시(하의+신발 등)를
// 섞어서 적었더니 AI가 어느 문장이 어느 슬롯 얘기인지 잘못 해석해서 신발 같은 슬롯을 놓치는 경우가 많았음.
const STYLE_SLOT_META: Record<SourcedCategory, { label: string; placeholder: string }> = {
  top: { label: '상의 스타일', placeholder: '예: 미니멀한 톤의 니트' },
  bottom: { label: '하의 스타일', placeholder: '예: 생지 와이드 데님, 기장감 긴 걸로 (배바지 아님)' },
  shoes: { label: '신발 스타일', placeholder: '예: 베이지 계열 샌들' },
  accessory: { label: '액세서리 스타일', placeholder: '예: 토트백 하나' },
};

export function RestyleSection({ geminiKey, openaiKey, onNeedKeys, onSendToVariation }: RestyleSectionProps) {
  const [photo, setPhoto] = useState<string | null>(null);
  const [category, setCategory] = useState<SourcedCategory>('top');
  const [poseHint, setPoseHint] = useState('');
  const [styleHints, setStyleHints] = useState<Partial<Record<SourcedCategory, string>>>({});
  const otherSlots = CATEGORY_OPTIONS.map((c) => c.id).filter((id) => id !== category);

  const [isRunning, setIsRunning] = useState(false);
  const [stageMsg, setStageMsg] = useState('');
  // 초안 품질(low) — medium 대비 약 1/4 비용, 코디 확인용
  const [draftMode, setDraftMode] = useState(false);

  const [currentResult, setCurrentResult] = useState<{ imageUrl: string; prompt: string; revisedPrompt?: string; generationId?: string | null } | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const { begin, trackIds, finish, cancel, isCanceling, cancelNote } = useCancelableRun();

  // 페이지를 나갔다 들어와도 이전 결과를 볼 수 있도록 Supabase에서 히스토리를 불러온다
  useEffect(() => {
    fetch('/api/generations/history?source=fitting')
      .then((res) => res.json())
      .then((data) => {
        if (!data.success) return;
        setHistory(
          data.items.map((item: any) => ({
            id: item.id,
            imageUrl: item.imageUrl,
            prompt: item.prompt,
            revisedPrompt: item.poseLabel,
            timestamp: new Date(item.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
          })),
        );
      })
      .catch(() => {});
  }, []);

  const handleRate = async (generationId: string, rating: 'good' | 'bad') => {
    try {
      const res = await fetch('/api/generations/rate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generationId, rating }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '평가 저장 실패');
    } catch (err: any) {
      alert(err.message || '평가 저장 중 오류가 발생했습니다.');
    }
  };

  const handleRunRestyle = async () => {
    if (!photo) {
      alert('실사 사진을 먼저 업로드해주세요.');
      return;
    }
    if (!geminiKey || !openaiKey) {
      onNeedKeys();
      return;
    }

    const signal = begin();
    setIsRunning(true);
    setStageMsg('사진 분석 중 (의류 · 포즈)');
    setCurrentResult(null);

    // 자세 지시는 최종 프롬프트 끝에 보강 문구로만 덧붙고, 상하의 스타일 지시는
    // userPreferenceHint로 코디 자동 제안(generateStylingSuggestion) 단계부터 반영되어야
    // 실제로 하의/신발 슬롯에 그대로 나온다.
    const userAdditions = poseHint.trim() ? `자세 지시: ${poseHint.trim()}` : '';

    try {
      // 비동기 아키텍처: 이 요청은 "처리 중" 행의 id만 즉시 반환한다 — 실제 분석/생성은
      // 서버 응답 이후 백그라운드(after())에서 진행되고, 아래에서 상태를 폴링한다.
      const res = await fetch('/api/restyle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photoBase64: photo,
          category,
          geminiApiKey: geminiKey,
          openaiApiKey: openaiKey,
          userAdditions,
          draftMode,
          userPreferenceHints: otherSlots.reduce<Record<string, string>>((acc, slot) => {
            const v = styleHints[slot]?.trim();
            if (v) acc[slot] = v;
            return acc;
          }, {}),
        }),
      });

      let startData: any;
      try {
        startData = await res.json();
      } catch {
        if (res.status === 413) {
          throw new Error('업로드한 이미지 용량이 너무 큽니다. 사진 수를 줄이거나 다시 시도해주세요.');
        }
        throw new Error('서버 응답을 읽을 수 없습니다. 잠시 후 다시 시도해주세요.');
      }
      if (!res.ok || !startData.success) {
        throw new Error(startData.error || 'AI 피팅 시작에 실패했습니다.');
      }

      setStageMsg('모델 렌더링 중 (최대 90초)');

      trackIds([startData.generationId]);
      const [finalItem] = await pollGenerationStatuses([startData.generationId], () => {}, { signal });

      if (finalItem.status === 'failed') {
        throw new Error(finalItem.errorMessage || 'AI 피팅 처리에 실패했습니다.');
      }
      if (finalItem.imageUrl) {
        setCurrentResult({
          imageUrl: finalItem.imageUrl,
          prompt: finalItem.prompt || '',
          generationId: finalItem.id,
        });

        const timestamp = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
        setHistory((prev) => [
          { id: finalItem.id, imageUrl: finalItem.imageUrl!, prompt: finalItem.prompt || '', timestamp },
          ...prev,
        ]);
      }
    } catch (err: any) {
      // 중단은 사용자가 의도한 동작이므로 에러 알럿을 띄우지 않는다.
      if (!isCanceledError(err)) alert(err.message || '오류가 발생했습니다.');
    } finally {
      finish();
      setIsRunning(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-8 py-10 space-y-10">
      {/* 실사 사진 업로드 */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-semibold text-gray-300 tabular-nums">01</span>
          <h2 className="text-sm font-semibold text-gray-900 tracking-tight">실사 사진 업로드</h2>
        </div>
        <ImageUploader
          label="소싱 제품을 실제로 착용하고 찍은 사진"
          subLabel="대충 찍은 셀카도 괜찮습니다. 소싱한 부위만 정확히 나오면 됩니다"
          image={photo}
          onImageChange={setPhoto}
          badgeText="원본"
        />
      </section>

      {/* 소싱 카테고리 선택 */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-semibold text-gray-300 tabular-nums">02</span>
          <h2 className="text-sm font-semibold text-gray-900 tracking-tight">소싱 제품 카테고리</h2>
        </div>
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
          <p className="text-xs text-gray-400 leading-relaxed">
            선택한 부위는 색상 · 질감 · 핏을 충실히 재현하고, 몸은 저장된 모델 체형으로, 포즈 · 배경 · 나머지 착장은 새로 생성됩니다.
          </p>
          <div className="grid grid-cols-4 gap-2">
            {CATEGORY_OPTIONS.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setCategory(cat.id)}
                className={`py-3.5 px-2 rounded-xl border text-center transition-all ${
                  category === cat.id
                    ? 'border-gray-900 bg-gray-900 text-white'
                    : 'border-gray-200 bg-white text-gray-500 hover:text-gray-900 hover:border-gray-300'
                }`}
              >
                <div className="text-[13px] font-semibold tracking-tight">{cat.label}</div>
                <div className={`text-[10px] mt-0.5 ${category === cat.id ? 'text-gray-300' : 'text-gray-400'}`}>
                  {cat.desc}
                </div>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* 추가 스타일링 지시 */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-semibold text-gray-300 tabular-nums">03</span>
          <h2 className="text-sm font-semibold text-gray-900 tracking-tight">추가 스타일링 지시</h2>
          <span className="text-[11px] text-gray-400">선택</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="bg-white border border-gray-200 rounded-2xl p-5 space-y-2.5">
            <div className="text-[11px] font-semibold text-gray-900 tracking-wide">자세</div>
            <textarea
              value={poseHint}
              onChange={(e) => setPoseHint(e.target.value)}
              placeholder="예: 손 주머니에 넣고 살짝 옆으로 돌아선 포즈"
              rows={3}
              className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3.5 py-3 text-[13px] text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-900 resize-none leading-relaxed transition"
            />
          </div>

          {otherSlots.map((slot) => {
            const meta = STYLE_SLOT_META[slot];
            return (
              <div key={slot} className="bg-white border border-gray-200 rounded-2xl p-5 space-y-2.5">
                <div className="text-[11px] font-semibold text-gray-900 tracking-wide">{meta.label}</div>
                <textarea
                  value={styleHints[slot] || ''}
                  onChange={(e) => setStyleHints((prev) => ({ ...prev, [slot]: e.target.value }))}
                  placeholder={meta.placeholder}
                  rows={3}
                  className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3.5 py-3 text-[13px] text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-900 resize-none leading-relaxed transition"
                />
              </div>
            );
          })}
        </div>
        <p className="text-[11px] text-gray-400 leading-relaxed">
          슬롯별로 나눠 입력하면 그 슬롯에 정확히 반영됩니다. 제외할 스타일은 괄호로 명시하세요 — 예: &ldquo;와이드 데님 (배바지 아님)&rdquo;
        </p>
      </section>

      {/* 실행 버튼 */}
      <section className="space-y-3">
        <label className="flex items-center gap-2.5 cursor-pointer select-none px-1">
          <input
            type="checkbox"
            checked={draftMode}
            onChange={(e) => setDraftMode(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 accent-gray-900"
          />
          <span className="text-[12px] text-gray-500">
            <b className="text-gray-700 font-semibold">초안 품질로 생성</b> — 비용 약 1/4. 코디 확인용으로 쓰고, 최종 컷은 끄고 생성하세요
          </span>
        </label>
        <button
          onClick={handleRunRestyle}
          disabled={isRunning || !photo}
          className={`w-full py-4.5 rounded-xl font-semibold text-[15px] tracking-tight transition-all py-5 ${
            isRunning
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : !photo
              ? 'bg-gray-50 text-gray-300 cursor-not-allowed border border-gray-200'
              : 'bg-gray-900 text-white hover:bg-black'
          }`}
        >
          {isRunning ? (
            <span className="flex items-center justify-center gap-3">
              <span className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
              {stageMsg}
            </span>
          ) : (
            'AI 피팅 생성 — 전신 1장'
          )}
        </button>
        {isRunning && (
          <button
            onClick={cancel}
            disabled={isCanceling}
            className="w-full py-3 rounded-xl border border-gray-200 hover:border-gray-400 text-[13px] font-medium text-gray-500 hover:text-gray-900 transition disabled:opacity-40"
          >
            {isCanceling ? '중단하는 중...' : '생성 중단'}
          </button>
        )}
        {cancelNote && (
          <p className="text-[11px] text-gray-500 leading-relaxed px-1 pt-1">{cancelNote}</p>
        )}
      </section>

      {/* 결과 — history.length도 조건에 포함해야 새로 생성 안 해도 이전 결과를 바로 볼 수 있음 */}
      {(currentResult || isRunning || history.length > 0) && (
        <section className="space-y-4">
          <FittingResultViewer
            currentResult={currentResult}
            history={history}
            onSelectHistory={(item) => setCurrentResult({ imageUrl: item.imageUrl, prompt: item.prompt, revisedPrompt: item.revisedPrompt })}
            isGenerating={isRunning && !currentResult}
            loadingStage={stageMsg}
            onRate={handleRate}
            onSendToVariation={onSendToVariation}
          />
        </section>
      )}
    </div>
  );
}
