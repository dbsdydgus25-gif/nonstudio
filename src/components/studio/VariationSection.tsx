'use client';

import React, { useState, useEffect } from 'react';
import { ImageUploader } from './ImageUploader';
import { FittingResultViewer, type HistoryItem } from './FittingResultViewer';
import { pollGenerationStatuses } from '@/lib/poll-generations';
import { downloadResultImage } from '@/lib/download-image';
import { useCancelableRun, isCanceledError } from '@/lib/use-cancelable-run';

interface BatchItem {
  generationId: string;
  poseLabel: string;
  status: 'pending' | 'completed' | 'failed';
  imageUrl?: string;
}

interface VariationSectionProps {
  openaiKey: string;
  onNeedKeys: () => void;
  /** AI 피팅에서 "보내기"로 넘어온 이미지 — 도착하면 자동으로 입력창에 채워짐 */
  incomingImage?: string | null;
  onConsumeIncomingImage?: () => void;
  /** 확정된 결과를 AI 영상 쪽으로 넘길 때 호출 */
  onSendToVideo?: (imageUrl: string) => void;
}

export function VariationSection({ openaiKey, onNeedKeys, incomingImage, onConsumeIncomingImage, onSendToVideo }: VariationSectionProps) {
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  // (2026-07-17) 비워두면 기존처럼 고정 흰 배경 스튜디오 사진이 기본으로 사용됨
  const [customBackgroundImage, setCustomBackgroundImage] = useState<string | null>(null);
  // (2026-07-23) 컷 하나로 자세부터 확인하고 마음에 들면 늘리는 흐름이 더 자연스럽다는
  // 대표님 요청으로 기본값을 4장에서 1장으로 낮춤.
  const [variationCount, setVariationCount] = useState(1);
  // (2026-07-23) "모델 정보와 동일" — 기본 켜짐. 리포즈 중 몸이 과하게 근육질/핏줄지고 얼굴이
  // 미묘하게 달라지는 드리프트를 저장된 모델 참고 이미지로 붙잡아준다. 대표님 본인 모델이 아닌
  // 사진(포즈만 참고하려고 넣은 남의 사진 등)을 돌릴 땐 꺼서, 그 사진에 얼굴/체형을 억지로
  // 입히지 않게 한다.
  const [matchModelIdentity, setMatchModelIdentity] = useState(true);
  // (2026-07-23) 프레이밍 — 'close'면 위 사진의 옷 부위를 확대한 디테일컷으로 뽑는다
  const [framing, setFraming] = useState<'full' | 'close'>('full');
  // 컷마다 자세를 따로 지정 — 특정 컷을 비워두면 그 컷만 기존처럼 프리셋 포즈 중 랜덤으로 뽑힘.
  // 최대 컷 수(4)만큼 고정 슬롯을 두고, 실제로는 variationCount개만 화면에 노출/전송한다.
  const [customPoseTexts, setCustomPoseTexts] = useState<string[]>(['', '', '', '']);
  // (2026-07-22) 컷마다 "이 자세로 찍어줘" 참고 사진을 직접 올릴 수 있다 — 텍스트만으로는
  // 각도/프레이밍이 매번 흔들려서, 사진 한 장이 훨씬 정확하게 포즈를 고정한다.
  const [customPoseImages, setCustomPoseImages] = useState<Array<string | null>>([null, null, null, null]);

  const { begin, trackIds, finish, cancel, isCanceling, cancelNote } = useCancelableRun();

  const [isRunning, setIsRunning] = useState(false);
  const [stageMsg, setStageMsg] = useState('');
  // 초안 품질(low) — medium 대비 약 1/4 비용, 포즈 확인용
  const [draftMode, setDraftMode] = useState(false);

  const [batchImages, setBatchImages] = useState<BatchItem[]>([]);
  const [isBatchDownloading, setIsBatchDownloading] = useState(false);
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

    const signal = begin();
    setIsRunning(true);
    setStageMsg(`${variationCount}개 포즈 준비 중`);
    setBatchImages([]);
    setCurrentResult(null);

    try {
      // 비동기 아키텍처: 이 요청은 포즈별 "처리 중" 행의 id 목록만 즉시 반환한다 — 실제 생성은
      // 서버 응답 이후 백그라운드(after())에서 병렬 진행되고, 아래에서 상태를 폴링한다.
      const res = await fetch('/api/variation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceImageBase64: sourceImage,
          variationCount,
          openaiApiKey: openaiKey,
          draftMode,
          customPoseTexts: customPoseTexts.slice(0, variationCount).map((t) => t.trim()),
          customPoseImagesBase64: customPoseImages.slice(0, variationCount).map((img) => img || ''),
          customBackgroundImageBase64: customBackgroundImage || undefined,
          matchModelIdentity,
          framing,
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
        throw new Error(startData.error || 'AI 바리에이션 시작에 실패했습니다.');
      }

      const jobs: Array<{ generationId: string; poseLabel: string; prompt: string }> = startData.jobs || [];
      trackIds(jobs.map((j) => j.generationId));
      setBatchImages(jobs.map((j) => ({ generationId: j.generationId, poseLabel: j.poseLabel, status: 'pending' as const })));
      setStageMsg(`${jobs.length}개 포즈 렌더링 중 (최대 90초)`);

      const finalItems = await pollGenerationStatuses(
        jobs.map((j) => j.generationId),
        (items) => {
          setBatchImages((prev) =>
            prev.map((b) => {
              const match = items.find((i) => i.id === b.generationId);
              if (!match) return b;
              return { ...b, status: match.status, imageUrl: match.imageUrl ?? undefined };
            }),
          );
          // 가장 먼저 완료된 포즈를 바로 메인 뷰어에 띄운다
          const firstCompleted = items.find((i) => i.status === 'completed' && i.imageUrl);
          if (firstCompleted) {
            setCurrentResult((prev) =>
              prev ?? { imageUrl: firstCompleted.imageUrl!, prompt: firstCompleted.prompt, generationId: firstCompleted.id },
            );
          }
        },
        { signal },
      );

      const succeeded = finalItems.filter((i) => i.status === 'completed' && i.imageUrl);
      if (succeeded.length === 0) {
        // 실제 원인(각 포즈별 에러 메시지)을 같이 보여줘야 다음에 뭐가 문제인지 바로 알 수 있다.
        const reasons = Array.from(new Set(finalItems.map((i) => i.errorMessage).filter(Boolean)));
        const detail = reasons.length > 0 ? `\n\n상세: ${reasons.join(' / ')}` : '';
        throw new Error(`모든 포즈 생성에 실패했습니다.${detail}`);
      }

      const timestamp = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      setHistory((prev) => [
        ...succeeded.map((item) => ({
          id: item.id,
          imageUrl: item.imageUrl!,
          prompt: item.prompt,
          revisedPrompt: item.poseLabel ?? undefined,
          timestamp,
        })),
        ...prev,
      ]);
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
      {/* 입력 사진 */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-semibold text-gray-300 tabular-nums">01</span>
          <h2 className="text-sm font-semibold text-gray-900 tracking-tight">기준 사진</h2>
          <span className="text-[11px] text-gray-400">AI 피팅 결과 또는 직접 업로드</span>
        </div>
        <ImageUploader
          label="포즈를 다양화할 확정 룩 사진"
          subLabel="몸 · 피부톤 · 전체 착장은 그대로 유지되고 포즈만 바뀝니다"
          image={sourceImage}
          onImageChange={setSourceImage}
          badgeText="기준"
        />
        <label className="flex items-start gap-2.5 cursor-pointer select-none bg-white border border-gray-200 rounded-2xl px-5 py-4">
          <input
            type="checkbox"
            checked={matchModelIdentity}
            onChange={(e) => setMatchModelIdentity(e.target.checked)}
            className="w-4 h-4 mt-0.5 rounded border-gray-300 accent-gray-900"
          />
          <span className="text-[12px] text-gray-500 leading-relaxed">
            <b className="text-gray-700 font-semibold">모델 정보와 동일</b> — 저장된 내 모델 참고 이미지를 함께 참고해서 리포즈 도중 몸이
            과하게 근육질로 변하거나 얼굴이 미묘하게 달라지는 걸 막습니다. 위 사진이 내 모델이 아닌 경우(포즈만 참고하는 다른 사진)엔 꺼주세요.
          </span>
        </label>
      </section>

      {/* 배경/장소 */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-semibold text-gray-300 tabular-nums">02</span>
          <h2 className="text-sm font-semibold text-gray-900 tracking-tight">배경/장소</h2>
          <span className="text-[11px] text-gray-400">선택 — 비워두면 기본 흰 배경 스튜디오</span>
        </div>
        <ImageUploader
          label="원하는 배경/장소 사진"
          subLabel="이 장소의 분위기를 참고해 자연스러운 장면을 새로 만듭니다 (사진 그대로 복사 아님) — 인물·의상은 그대로, 조명만 그 장소에 맞게 조정"
          image={customBackgroundImage}
          onImageChange={setCustomBackgroundImage}
          badgeText="배경"
        />
      </section>

      {/* 바리에이션 수 */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-semibold text-gray-300 tabular-nums">03</span>
          <h2 className="text-sm font-semibold text-gray-900 tracking-tight">컷 수</h2>
        </div>
        <div className="bg-white border border-gray-200 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <div className="text-[13px] font-semibold text-gray-900 tracking-tight">룩북 컷 수</div>
            <div className="text-[11px] text-gray-400 mt-0.5">
              {customPoseTexts.slice(0, variationCount).some((t) => t.trim())
                ? '컷마다 아래에서 자세를 지정할 수 있습니다'
                : '서로 다른 포즈로 몇 장 만들지 선택합니다'}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setVariationCount(Math.max(1, variationCount - 1))}
              className="w-9 h-9 rounded-lg border border-gray-200 hover:border-gray-400 text-gray-600 hover:text-gray-900 font-medium flex items-center justify-center text-sm transition"
            >
              −
            </button>
            <span className="text-[15px] font-semibold text-gray-900 w-10 text-center tabular-nums">{variationCount}장</span>
            <button
              onClick={() => setVariationCount(Math.min(4, variationCount + 1))}
              className="w-9 h-9 rounded-lg border border-gray-200 hover:border-gray-400 text-gray-600 hover:text-gray-900 font-medium flex items-center justify-center text-sm transition"
            >
              +
            </button>
          </div>
        </div>

        {/* 프레이밍 — 클로즈업은 위 사진의 옷 부위를 확대한 디테일컷 */}
        <div className="bg-white border border-gray-200 rounded-2xl p-5 flex items-center justify-between">
          <div>
            <div className="text-[13px] font-semibold text-gray-900 tracking-tight">프레이밍</div>
            <div className="text-[11px] text-gray-400 mt-0.5">
              클로즈업은 위 사진의 옷 부위를 확대한 디테일컷 — 원단 짜임 · 스티치가 선명하게 나옵니다
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(['full', 'close'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFraming(f)}
                className={`px-4 py-2 rounded-lg border text-[13px] font-medium tracking-tight transition ${
                  framing === f
                    ? 'border-gray-900 bg-gray-900 text-white'
                    : 'border-gray-200 bg-white text-gray-500 hover:text-gray-900 hover:border-gray-300'
                }`}
              >
                {f === 'full' ? '원본 그대로' : '클로즈업'}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* 자세 직접 지정 — 컷마다 따로 지정 가능, 비워둔 컷은 프리셋 포즈 중 랜덤으로 뽑힌다 */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-semibold text-gray-300 tabular-nums">04</span>
          <h2 className="text-sm font-semibold text-gray-900 tracking-tight">자세 지시</h2>
          <span className="text-[11px] text-gray-400">선택 — 컷별로 지정, 비워두면 그 컷은 프리셋 포즈 중 랜덤</span>
        </div>
        <div className="space-y-3">
          {Array.from({ length: variationCount }, (_, i) => (
            <div key={i} className="bg-white border border-gray-200 rounded-2xl p-5 space-y-3">
              <div className="text-[11px] font-semibold text-gray-500 tracking-tight">자세 지시 {i + 1}</div>
              <textarea
                value={customPoseTexts[i] ?? ''}
                onChange={(e) => {
                  const next = [...customPoseTexts];
                  next[i] = e.target.value;
                  setCustomPoseTexts(next);
                }}
                placeholder="예: 오른쪽을 바라보며 몸을 살짝 돌린 자세, 정면 응시 아님 (비워두면 랜덤 포즈)"
                rows={2}
                className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3.5 py-3 text-[13px] text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-900 resize-none leading-relaxed transition"
              />
              <ImageUploader
                label={`자세 참고 사진 ${i + 1} (선택)`}
                subLabel="이 사진의 자세·카메라 앵글만 참고합니다 — 인물·의상·배경은 무시됩니다"
                image={customPoseImages[i] ?? null}
                onImageChange={(img) => {
                  const next = [...customPoseImages];
                  next[i] = img;
                  setCustomPoseImages(next);
                }}
                badgeText="자세"
              />
            </div>
          ))}
          <p className="text-[11px] text-gray-400 leading-relaxed px-1">
            방향(왼쪽 · 오른쪽 · 뒤)을 지정하면 몸과 카메라 앵글이 실제로 그 방향을 보도록 반영됩니다. 컷 수를 줄이면 뒤쪽 지시는
            무시됩니다.
          </p>
        </div>
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
            <b className="text-gray-700 font-semibold">초안 품질로 생성</b> — 비용 약 1/4. 포즈 확인용으로 쓰고, 최종 컷은 끄고 생성하세요
          </span>
        </label>
        <button
          onClick={handleRunVariation}
          disabled={isRunning || !sourceImage}
          className={`w-full py-5 rounded-xl font-semibold text-[15px] tracking-tight transition-all ${
            isRunning
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : !sourceImage
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
            'AI 바리에이션 생성'
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

      {/* 결과 */}
      {(batchImages.length > 0 || isRunning || history.length > 0) && (
        <section className="space-y-4">
          <FittingResultViewer
            currentResult={currentResult}
            history={history}
            onSelectHistory={(item) => setCurrentResult({ imageUrl: item.imageUrl, prompt: item.prompt, revisedPrompt: item.revisedPrompt })}
            isGenerating={isRunning && !currentResult}
            loadingStage={stageMsg}
            onRate={handleRate}
            onSendToVideo={onSendToVideo}
          />

          {batchImages.length > 1 && (
            <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-400 mb-1">Batch</div>
                  <h4 className="text-sm font-semibold text-gray-900 tracking-tight">이번 배치 {batchImages.length}장</h4>
                </div>
                <button
                  disabled={isBatchDownloading}
                  onClick={async () => {
                    // cross-origin URL에 <a download>를 쓰면 브라우저가 조용히 무시함 —
                    // 서버 프록시로 한 장씩 받아서 저장한다 (동시 다운로드는 브라우저가 일부 차단할 수 있어 순차 처리).
                    setIsBatchDownloading(true);
                    try {
                      const completed = batchImages.filter((img) => img.status === 'completed' && img.imageUrl);
                      for (const [i, img] of completed.entries()) {
                        await downloadResultImage(img.imageUrl!, `variation_${i + 1}_${Date.now()}.png`);
                      }
                    } catch (err: any) {
                      alert(err?.message || '전체 다운로드 중 오류가 발생했습니다.');
                    } finally {
                      setIsBatchDownloading(false);
                    }
                  }}
                  className="px-3.5 py-2 rounded-lg border border-gray-200 hover:border-gray-400 text-gray-600 hover:text-gray-900 text-xs font-medium tracking-wide transition disabled:opacity-40"
                >
                  {isBatchDownloading ? '저장 중...' : '전체 다운로드'}
                </button>
              </div>
              <div className="grid grid-cols-4 gap-3">
                {batchImages.map((img) => (
                  <div
                    key={img.generationId}
                    className={`group relative rounded-lg overflow-hidden border border-gray-200 ${
                      img.status === 'completed' ? 'hover:border-gray-400 transition cursor-pointer' : ''
                    }`}
                    onClick={() => {
                      if (img.status === 'completed' && img.imageUrl) {
                        setCurrentResult({ imageUrl: img.imageUrl, prompt: '', revisedPrompt: img.poseLabel, generationId: img.generationId });
                      }
                    }}
                  >
                    {img.status === 'completed' && img.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={img.imageUrl} alt={img.poseLabel} className="w-full aspect-[2/3] object-cover" />
                    ) : (
                      <div className="w-full aspect-[2/3] bg-gray-50 flex items-center justify-center">
                        {img.status === 'failed' ? (
                          <span className="text-[10px] font-medium text-gray-400 text-center px-2">생성 실패</span>
                        ) : (
                          <span className="w-5 h-5 border-2 border-gray-200 border-t-gray-900 rounded-full animate-spin" />
                        )}
                      </div>
                    )}
                    <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-3 py-2.5">
                      <div className="text-[10px] font-medium text-white truncate">
                        {img.status === 'failed' ? `${img.poseLabel} — 실패` : img.poseLabel}
                      </div>
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
