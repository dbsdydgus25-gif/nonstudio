'use client';

import React, { useState } from 'react';
import { ImageUploader } from './ImageUploader';
import { FittingResultViewer, type HistoryItem } from './FittingResultViewer';
import type { SourcedCategory } from '@/lib/fitting-prompts';

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

export function RestyleSection({ geminiKey, openaiKey, onNeedKeys, onSendToVariation }: RestyleSectionProps) {
  const [photo, setPhoto] = useState<string | null>(null);
  const [category, setCategory] = useState<SourcedCategory>('top');
  const [backgroundHint, setBackgroundHint] = useState('');
  const [poseHint, setPoseHint] = useState('');
  const [outfitHint, setOutfitHint] = useState('');

  const [isRunning, setIsRunning] = useState(false);
  const [stageMsg, setStageMsg] = useState('');

  const [currentResult, setCurrentResult] = useState<{ imageUrl: string; prompt: string; revisedPrompt?: string; generationId?: string | null } | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const handleRate = async (generationId: string, rating: 'good' | 'bad', promote: boolean) => {
    try {
      const res = await fetch('/api/generations/rate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generationId, rating, promote, pipeline: 'restyle' }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '평가 저장 실패');
      if (promote) {
        alert('저장했습니다 — 다음 생성부터 이 사진을 기준 체형 참고 이미지로 같이 사용합니다.');
      }
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

    // 배경은 서버에서 별도 처리(지시 없으면 고정 흰색 스튜디오 유지)하므로 여기서는 빼고 전달한다
    const userAdditions = [
      poseHint.trim() && `자세 지시: ${poseHint.trim()}`,
      outfitHint.trim() && `상하의 스타일 지시: ${outfitHint.trim()}`,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      const res = await fetch('/api/restyle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photoBase64: photo,
          category,
          geminiApiKey: geminiKey,
          openaiApiKey: openaiKey,
          userAdditions,
          backgroundHint,
        }),
      });

      setStageMsg('2단계: 몸 리셰이프 · 전신 코디 · 배경 OpenAI 렌더링 중... (최대 90초 소요)');

      const data = await res.json();
      if (!res.ok || !data.success) {
        const detail = Array.isArray(data.errors) && data.errors.length > 0 ? `\n\n상세: ${data.errors.join(' / ')}` : '';
        throw new Error((data.error || 'AI 피팅 처리에 실패했습니다.') + detail);
      }

      const img = data.images?.[0];
      if (img) {
        setCurrentResult({
          imageUrl: img.imageUrl,
          prompt: img.prompt || '',
          revisedPrompt: img.engineUsed || '',
          generationId: img.generationId ?? null,
        });

        const timestamp = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
        setHistory((prev) => [
          { id: `${Date.now()}`, imageUrl: img.imageUrl, prompt: img.prompt || '', revisedPrompt: img.engineUsed, timestamp },
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

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="bg-white border border-amber-200 rounded-2xl p-4 space-y-2">
            <div className="text-[10px] font-black text-amber-600">🏞️ 뒤에 배경</div>
            <textarea
              value={backgroundHint}
              onChange={(e) => setBackgroundHint(e.target.value)}
              placeholder={`예:\n여름 휴양지 느낌\n콘크리트 스튜디오`}
              rows={3}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-amber-500 resize-none font-mono leading-relaxed transition"
            />
          </div>

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

          <div className="bg-white border border-amber-200 rounded-2xl p-4 space-y-2">
            <div className="text-[10px] font-black text-amber-600">👕👖 상하의 스타일</div>
            <textarea
              value={outfitHint}
              onChange={(e) => setOutfitHint(e.target.value)}
              placeholder={`예:\n미니멀 캐주얼 톤으로\n토트백 하나 들려줘`}
              rows={3}
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-amber-500 resize-none font-mono leading-relaxed transition"
            />
          </div>
        </div>
        <p className="text-[10px] text-gray-400">
          AI가 자동으로 만든 코디 프롬프트에 위 지시가 그대로 합쳐져서 최종 프롬프트가 완성됩니다. (선택한 소싱 카테고리 부위는 이미 색상·질감이 고정되어 있으니 그 부위에 대한 지시는 효과가 제한적일 수 있습니다)
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

      {/* 결과 */}
      {(currentResult || isRunning) && (
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
