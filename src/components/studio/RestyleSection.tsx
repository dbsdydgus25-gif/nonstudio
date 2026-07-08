'use client';

import React, { useState, useEffect } from 'react';
import { ImageUploader } from './ImageUploader';
import { FittingResultViewer, type HistoryItem } from './FittingResultViewer';
import type { SourcedCategory } from '@/lib/fitting-prompts';
import { pollGenerationStatuses } from '@/lib/poll-generations';

interface RestyleSectionProps {
  geminiKey: string;
  openaiKey: string;
  onNeedKeys: () => void;
  /** 확정된 AI 피팅 결과를 AI 바리에이션 쪽으로 넘길 때 호출 */
  onSendToVariation?: (imageUrl: string) => void;
}

const CATEGORY_OPTIONS: { id: SourcedCategory; label: string; desc: string }[] = [
  { id: 'top', label: '👕 상의', desc: '입고 있는 상의가 소싱 제품' },
  { id: 'bottom', label: '👖 하의', desc: '입고 있는 하의가 소싱 제품' },
  { id: 'shoes', label: '👟 신발', desc: '신고 있는 신발이 소싱 제품' },
  { id: 'accessory', label: '💍 액세서리', desc: '착용 중인 가방/시계/주얼리 등' },
];

// 슬롯별로 입력 필드를 분리해서 보낸다 — 예전엔 "상하의 스타일" 한 칸에 여러 슬롯 지시(하의+신발 등)를
// 섞어서 적었더니 AI가 어느 문장이 어느 슬롯 얘기인지 잘못 해석해서 신발 같은 슬롯을 놓치는 경우가 많았음.
const STYLE_SLOT_META: Record<SourcedCategory, { icon: string; label: string; placeholder: string }> = {
  top: { icon: '👕', label: '상의 스타일', placeholder: '예:\n미니멀한 톤의 니트' },
  bottom: { icon: '👖', label: '하의 스타일', placeholder: '예:\n생지 와이드 데님, 기장감 긴 걸로\n(배바지 아님)' },
  shoes: { icon: '👟', label: '신발 스타일', placeholder: '예:\n베이지 계열 샌들' },
  accessory: { icon: '💍', label: '액세서리 스타일', placeholder: '예:\n토트백 하나' },
};

export function RestyleSection({ geminiKey, openaiKey, onNeedKeys, onSendToVariation }: RestyleSectionProps) {
  const [photo, setPhoto] = useState<string | null>(null);
  const [category, setCategory] = useState<SourcedCategory>('top');
  const [poseHint, setPoseHint] = useState('');
  const [styleHints, setStyleHints] = useState<Partial<Record<SourcedCategory, string>>>({});
  const otherSlots = CATEGORY_OPTIONS.map((c) => c.id).filter((id) => id !== category);

  const [isRunning, setIsRunning] = useState(false);
  const [stageMsg, setStageMsg] = useState('');

  const [currentResult, setCurrentResult] = useState<{ imageUrl: string; prompt: string; revisedPrompt?: string; generationId?: string | null } | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

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

    setIsRunning(true);
    setStageMsg('1단계: 사진 분석 중 (옷 분석 · 포즈 분석)...');
    setCurrentResult(null);

    // 자세 지시는 최종 프롬프트 끝에 보강 문구로만 덧붙고, 상하의 스타일 지시는
    // userPreferenceHint로 코디 자동 제안(generateStylingSuggestion) 단계부터 반영되어야
    // 실제로 하의/신발 슬롯에 그대로 나온다 — 예전엔 outfitHint가 끝에만 덧붙어서
    // AI가 이미 자체적으로 짜둔 코디(예: 정장바지+로퍼)와 충돌해 거의 무시됐었음.
    const userAdditions = poseHint.trim() ? `자세 지시: ${poseHint.trim()}` : '';

    try {
      // 배경은 항상 고정 흰색 스튜디오(백엔드에서 실제 참고 사진으로 강제) — 배경 지시 입력은 없앰
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
        throw new Error('서버 응답을 읽을 수 없습니다. 잠시 후 다시 시도해주세요.');
      }
      if (!res.ok || !startData.success) {
        throw new Error(startData.error || 'AI 피팅 시작에 실패했습니다.');
      }

      setStageMsg('2단계: 몸 리셰이프 · 전신 코디 · 배경 OpenAI 렌더링 중... (최대 90초 소요)');

      const [finalItem] = await pollGenerationStatuses([startData.generationId], () => {});

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
      alert(err.message || '오류가 발생했습니다.');
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-8 py-8 space-y-8">
      {/* 실사 사진 업로드 */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-black text-amber-600 uppercase tracking-widest">Step 01</span>
          <h2 className="text-sm font-black text-gray-900">실사 사진 업로드</h2>
        </div>
        <ImageUploader
          label="소싱 제품을 실제로 입고/착용하고 찍은 사진"
          subLabel="대충 찍은 셀카도 괜찮습니다. 소싱한 부위만 정확히 나오면 됩니다"
          image={photo}
          onImageChange={setPhoto}
          badgeText="실사 원본"
          badgeColor="bg-amber-100 text-amber-700"
        />
      </section>

      {/* 소싱 카테고리 선택 */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-black text-amber-600 uppercase tracking-widest">Step 02</span>
          <h2 className="text-sm font-black text-gray-900">소싱 제품 카테고리 (정확히 재현할 부위)</h2>
        </div>
        <div className="bg-gray-50 border border-gray-200 rounded-2xl p-6 space-y-2">
          <p className="text-xs text-gray-500">
            선택한 부위는 색상 · 질감 · 핏을 충실히 재현하고, 몸은 매력적인 체형(177/74 마른 근육형)으로, 포즈 · 배경 · 나머지 착장은 새로 생성됩니다.
          </p>
          <div className="grid grid-cols-4 gap-2 pt-2">
            {CATEGORY_OPTIONS.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setCategory(cat.id)}
                className={`py-3 rounded-xl border text-center transition-all ${
                  category === cat.id
                    ? 'border-amber-400 bg-amber-50 text-amber-700 font-bold shadow-sm'
                    : 'border-gray-200 bg-white text-gray-500 hover:text-gray-900 hover:border-gray-300'
                }`}
              >
                <div className="text-xs">{cat.label}</div>
                <div className="text-[9px] text-gray-400 font-normal mt-0.5">{cat.desc}</div>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* 추가 프롬프트 (배경 / 자세 / 상하의) + 변형 개수 */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-black text-amber-600 uppercase tracking-widest">Step 03</span>
          <h2 className="text-sm font-black text-gray-900">추가 스타일링 지시 (선택)</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="bg-white border border-amber-200 rounded-2xl p-4 space-y-2">
            <div className="text-[10px] font-black text-amber-600">🧍 자세</div>
            <textarea
              value={poseHint}
              onChange={(e) => setPoseHint(e.target.value)}
              placeholder={`예:\n손 주머니에 넣고\n살짝 옆으로 돌아선 포즈`}
              rows={3}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-amber-500 resize-none font-mono leading-relaxed transition"
            />
          </div>

          {otherSlots.map((slot) => {
            const meta = STYLE_SLOT_META[slot];
            return (
              <div key={slot} className="bg-white border border-amber-200 rounded-2xl p-4 space-y-2">
                <div className="text-[10px] font-black text-amber-600">{meta.icon} {meta.label}</div>
                <textarea
                  value={styleHints[slot] || ''}
                  onChange={(e) => setStyleHints((prev) => ({ ...prev, [slot]: e.target.value }))}
                  placeholder={meta.placeholder}
                  rows={3}
                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-amber-500 resize-none font-mono leading-relaxed transition"
                />
              </div>
            );
          })}
        </div>
        <p className="text-[10px] text-gray-400">
          슬롯별로 나눠서 입력하면 그 슬롯에 정확히 반영됩니다. 제외하고 싶은 스타일은 괄호로 명시하세요 (예: "와이드 데님 (배바지 아님)"). 선택한 소싱 카테고리 부위는 이미 색상·질감이 고정되어 있어 그 부위에 대한 지시는 효과가 제한적일 수 있습니다.
        </p>
      </section>

      {/* 실행 버튼 */}
      <section>
        <button
          onClick={handleRunRestyle}
          disabled={isRunning || !photo}
          className={`w-full py-5 rounded-2xl font-black text-base tracking-tight transition-all ${
            isRunning
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : !photo
              ? 'bg-gray-50 text-gray-300 cursor-not-allowed border border-gray-200'
              : 'bg-gradient-to-r from-amber-500 to-orange-500 text-black hover:from-amber-400 hover:to-orange-400 shadow-lg shadow-amber-500/20 hover:scale-[1.01] active:scale-[0.99]'
          }`}
        >
          {isRunning ? (
            <span className="flex items-center justify-center gap-3">
              <span className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
              {stageMsg}
            </span>
          ) : (
            <span className="flex items-center justify-center gap-2">✨ AI 피팅 생성 (전신 1장)</span>
          )}
        </button>
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
