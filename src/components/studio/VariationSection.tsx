'use client';

import React, { useState, useEffect } from 'react';
import { ImageUploader } from './ImageUploader';
import { FittingResultViewer, type HistoryItem } from './FittingResultViewer';

interface VariationSectionProps {
  openaiKey: string;
  onNeedKeys: () => void;
  /** AI 피팅에서 "보내기"로 넘어온 이미지 — 도착하면 자동으로 입력창에 채워짐 */
  incomingImage?: string | null;
  onConsumeIncomingImage?: () => void;
}

export function VariationSection({ openaiKey, onNeedKeys, incomingImage, onConsumeIncomingImage }: VariationSectionProps) {
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [variationCount, setVariationCount] = useState(4);

  const [isRunning, setIsRunning] = useState(false);
  const [stageMsg, setStageMsg] = useState('');

  const [batchImages, setBatchImages] = useState<Array<{ imageUrl: string; variationLabel: string; generationId?: string | null }>>([]);
  const [currentResult, setCurrentResult] = useState<{ imageUrl: string; prompt: string; revisedPrompt?: string; generationId?: string | null } | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  // AI 피팅에서 넘어온 이미지가 있으면 자동으로 입력창을 채운다
  useEffect(() => {
    if (incomingImage) {
      setSourceImage(incomingImage);
      setBatchImages([]);
      setCurrentResult(null);
      onConsumeIncomingImage?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingImage]);

  // 페이지를 나갔다 들어와도 이전 결과를 볼 수 있도록 Supabase에서 히스토리를 불러온다
  useEffect(() => {
    fetch('/api/generations/history?source=variation')
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

  const handleRunVariation = async () => {
    if (!sourceImage) {
      alert('AI 피팅에서 결과를 받아오거나, 사진을 직접 업로드해주세요.');
      return;
    }
    if (!openaiKey) {
      onNeedKeys();
      return;
    }

    setIsRunning(true);
    setStageMsg(`${variationCount}장의 포즈로 렌더링 중... (최대 90초 소요)`);
    setBatchImages([]);
    setCurrentResult(null);

    try {
      const res = await fetch('/api/variation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceImageBase64: sourceImage,
          variationCount,
          openaiApiKey: openaiKey,
        }),
      });

      let data: any;
      try {
        data = await res.json();
      } catch {
        // gpt-image-2 호출이 90~100초 걸리는데 Vercel Hobby 플랜의 함수 실행 제한 때문에
        // 타임아웃으로 요청이 죽어서 JSON이 아닌 에러 페이지가 오는 경우가 있음.
        throw new Error('서버 응답 시간이 초과됐을 가능성이 높습니다 (Vercel 함수 실행 제한). 다시 시도해보시고, 계속되면 배포 플랜(Vercel Pro) 업그레이드가 필요할 수 있습니다.');
      }
      if (!res.ok || !data.success) {
        const detail = Array.isArray(data.errors) && data.errors.length > 0 ? `\n\n상세: ${data.errors.join(' / ')}` : '';
        throw new Error((data.error || 'AI 바리에이션 처리에 실패했습니다.') + detail);
      }

      const imgs: Array<{ imageUrl: string; variationLabel: string; generationId?: string | null }> = (data.images || []).map((img: any) => ({
        imageUrl: img.imageUrl,
        variationLabel: img.variationLabel || '',
        generationId: img.generationId ?? null,
      }));
      setBatchImages(imgs);

      if (imgs.length > 0) {
        setCurrentResult({
          imageUrl: imgs[0].imageUrl,
          prompt: data.images?.[0]?.prompt || '',
          revisedPrompt: data.images?.[0]?.engineUsed || '',
          generationId: imgs[0].generationId,
        });
      }

      const timestamp = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      setHistory((prev) => [
        ...imgs.map((img, i) => ({
          id: `${Date.now()}_${i}`,
          imageUrl: img.imageUrl,
          prompt: data.images?.[i]?.prompt || '',
          revisedPrompt: img.variationLabel,
          timestamp,
        })),
        ...prev,
      ]);
    } catch (err: any) {
      alert(err.message || '오류가 발생했습니다.');
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-8 py-8 space-y-8">
      {/* 입력 사진 */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-black text-amber-600 uppercase tracking-widest">Step 01</span>
          <h2 className="text-sm font-black text-gray-900">기준 사진 (AI 피팅 결과 또는 직접 업로드)</h2>
        </div>
        <ImageUploader
          label="포즈를 다양화할 확정된 룩 사진"
          subLabel="몸/피부톤/전체 착장(색상·재질·핏·신발)은 100% 그대로 유지하고 포즈만 바뀝니다"
          image={sourceImage}
          onImageChange={setSourceImage}
          badgeText="기준 사진"
          badgeColor="bg-amber-100 text-amber-700"
        />
      </section>

      {/* 바리에이션 수 */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-black text-amber-600 uppercase tracking-widest">Step 02</span>
          <h2 className="text-sm font-black text-gray-900">포즈 바리에이션 수</h2>
        </div>
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 flex items-center justify-between">
          <div>
            <div className="text-xs font-bold text-gray-900">룩북 컷 수</div>
            <div className="text-[10px] text-gray-400 mt-1">서로 다른 포즈로 몇 장 만들지 선택 (몸/옷/배경은 항상 동일)</div>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={() => setVariationCount(Math.max(1, variationCount - 1))}
              className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 border border-gray-200 text-gray-900 font-bold flex items-center justify-center text-sm transition"
            >
              -
            </button>
            <span className="text-base font-black text-amber-600 w-6 text-center">{variationCount}장</span>
            <button
              onClick={() => setVariationCount(Math.min(4, variationCount + 1))}
              className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 border border-gray-200 text-gray-900 font-bold flex items-center justify-center text-sm transition"
            >
              +
            </button>
          </div>
        </div>
      </section>

      {/* 실행 버튼 */}
      <section>
        <button
          onClick={handleRunVariation}
          disabled={isRunning || !sourceImage}
          className={`w-full py-5 rounded-2xl font-black text-base tracking-tight transition-all ${
            isRunning
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : !sourceImage
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
            <span className="flex items-center justify-center gap-2">🧍 AI 바리에이션 생성</span>
          )}
        </button>
      </section>

      {/* 결과 */}
      {(batchImages.length > 0 || isRunning || history.length > 0) && (
        <section className="space-y-4">
          <FittingResultViewer
            currentResult={currentResult}
            history={history}
            onSelectHistory={(item) => setCurrentResult({ imageUrl: item.imageUrl, prompt: item.prompt, revisedPrompt: item.revisedPrompt })}
            isGenerating={isRunning && batchImages.length === 0}
            loadingStage={stageMsg}
            onRate={handleRate}
          />

          {batchImages.length > 1 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-black text-gray-900">이번 배치 ({batchImages.length}장)</h4>
                <button
                  onClick={() => {
                    batchImages.forEach((img, i) => {
                      const a = document.createElement('a');
                      a.href = img.imageUrl;
                      a.download = `variation_${i + 1}_${Date.now()}.png`;
                      a.click();
                    });
                  }}
                  className="px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 border border-gray-200 text-xs text-gray-600 font-bold transition flex items-center gap-1.5"
                >
                  ⬇ 전체 다운로드
                </button>
              </div>
              <div className="grid grid-cols-4 gap-4">
                {batchImages.map((img, i) => (
                  <div
                    key={i}
                    className="group relative rounded-2xl overflow-hidden border border-gray-200 hover:border-amber-400 transition cursor-pointer shadow-sm"
                    onClick={() => setCurrentResult({ imageUrl: img.imageUrl, prompt: '', revisedPrompt: img.variationLabel, generationId: img.generationId })}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={img.imageUrl} alt={img.variationLabel} className="w-full aspect-[2/3] object-cover" />
                    <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent px-3 py-3">
                      <div className="text-[10px] font-bold text-white">{img.variationLabel}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
