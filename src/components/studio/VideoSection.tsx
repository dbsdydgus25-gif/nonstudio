'use client';

import React, { useState, useEffect } from 'react';
import { ImageUploader } from './ImageUploader';
import { DETAIL_VIDEO_PRESETS } from '@/lib/detail-video-prompts';
import { pollGenerationStatuses } from '@/lib/poll-generations';
import { downloadResultImage } from '@/lib/download-image';
import { useCancelableRun, isCanceledError } from '@/lib/use-cancelable-run';

interface HistoryItem {
  id: string;
  imageUrl: string;
  prompt: string;
  label?: string;
  timestamp: string;
}

interface VideoSectionProps {
  geminiKey: string;
  onNeedKeys: () => void;
  /** AI 제품 피팅/바리에이션에서 "보내기"로 넘어온 이미지 — 도착하면 자동으로 입력창에 채워짐 */
  incomingImage?: string | null;
  onConsumeIncomingImage?: () => void;
}

const DETAIL_PRESETS = DETAIL_VIDEO_PRESETS.filter((p) => p.kind === 'detail');
const MOTION_PRESETS = DETAIL_VIDEO_PRESETS.filter((p) => p.kind === 'motion');

export function VideoSection({ geminiKey, onNeedKeys, incomingImage, onConsumeIncomingImage }: VideoSectionProps) {
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string>(MOTION_PRESETS[0]?.id ?? '');
  const [customInstruction, setCustomInstruction] = useState('');
  // 기본은 Lite(약 $0.20), 켜면 Fast(약 $0.40)
  const [highQuality, setHighQuality] = useState(false);

  const [isRunning, setIsRunning] = useState(false);
  const [stageMsg, setStageMsg] = useState('');
  const [result, setResult] = useState<{ imageUrl: string; prompt: string } | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const { begin, trackIds, finish, cancel, isCanceling, cancelNote } = useCancelableRun();

  // 다른 화면에서 넘어온 이미지가 있으면 자동으로 입력창을 채운다
  useEffect(() => {
    if (incomingImage) {
      setSourceImage(incomingImage);
      setResult(null);
      onConsumeIncomingImage?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingImage]);

  // 페이지를 나갔다 들어와도 이전 결과를 볼 수 있도록 Supabase에서 히스토리를 불러온다
  useEffect(() => {
    fetch('/api/generations/history?source=video')
      .then((res) => res.json())
      .then((data) => {
        if (!data.success) return;
        setHistory(
          data.items.map((item: any) => ({
            id: item.id,
            imageUrl: item.imageUrl,
            prompt: item.prompt,
            label: item.poseLabel ?? undefined,
            timestamp: new Date(item.createdAt).toLocaleString('ko-KR', {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
          })),
        );
      })
      .catch(() => {});
  }, []);

  const selectedPreset = DETAIL_VIDEO_PRESETS.find((p) => p.id === selectedPresetId);
  // 자유 텍스트를 쓰면 프리셋 대신 그걸 쓰고, 종류는 선택된 프리셋의 kind를 따라간다
  const effectiveInstruction = customInstruction.trim() || selectedPreset?.instruction || '';
  const effectiveKind = selectedPreset?.kind ?? 'motion';

  const handleRun = async () => {
    if (!sourceImage) {
      alert('영상으로 만들 사진을 등록하거나, 제품 피팅 결과에서 보내주세요.');
      return;
    }
    if (!effectiveInstruction) {
      alert('어떤 움직임을 만들지 프리셋을 고르거나 직접 입력해주세요.');
      return;
    }
    if (!geminiKey) {
      onNeedKeys();
      return;
    }

    const signal = begin();
    setIsRunning(true);
    setStageMsg('영상 생성 준비 중');
    setResult(null);

    try {
      const res = await fetch('/api/detail-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceImageBase64: sourceImage,
          detailInstruction: effectiveInstruction,
          motionKind: effectiveKind,
          quality: highQuality ? 'fast' : 'lite',
          geminiApiKey: geminiKey,
        }),
      });

      let startData: any;
      try {
        startData = await res.json();
      } catch {
        if (res.status === 413) {
          throw new Error('업로드한 이미지 용량이 너무 큽니다. 다시 시도해주세요.');
        }
        throw new Error('서버 응답을 읽을 수 없습니다. 잠시 후 다시 시도해주세요.');
      }
      if (!res.ok || !startData.success) {
        throw new Error(startData.error || '영상 생성 시작에 실패했습니다.');
      }

      trackIds([startData.generationId]);
      setStageMsg('영상 렌더링 중 (보통 1~2분)');

      const finalItems = await pollGenerationStatuses(
        [startData.generationId],
        () => {},
        // 영상은 이미지보다 오래 걸린다 — 라우트의 폴링 한도(240초)보다 넉넉하게
        { intervalMs: 5000, timeoutMs: 300000, signal },
      );

      const done = finalItems[0];
      if (!done || done.status !== 'completed' || !done.imageUrl) {
        throw new Error(done?.errorMessage || '영상 생성에 실패했습니다.');
      }

      setResult({ imageUrl: done.imageUrl, prompt: done.prompt });
      setHistory((prev) => [
        {
          id: done.id,
          imageUrl: done.imageUrl!,
          prompt: done.prompt,
          label: done.poseLabel ?? undefined,
          timestamp: new Date().toLocaleString('ko-KR', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          }),
        },
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

  const renderPresetGroup = (
    title: string,
    desc: string,
    presets: typeof DETAIL_PRESETS | typeof MOTION_PRESETS,
  ) => (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2 px-1">
        <span className="text-[11px] font-semibold text-gray-700 tracking-tight">{title}</span>
        <span className="text-[10px] text-gray-400">{desc}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {presets.map((p) => (
          <button
            key={p.id}
            onClick={() => setSelectedPresetId(p.id)}
            className={`px-3.5 py-3 rounded-xl border text-left transition ${
              selectedPresetId === p.id
                ? 'border-gray-900 bg-gray-900 text-white'
                : 'border-gray-200 hover:border-gray-400 text-gray-600'
            }`}
          >
            <span className="block text-[12px] font-semibold tracking-tight">{p.label}</span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="max-w-4xl mx-auto px-8 py-10 space-y-10">
      {/* 기준 사진 */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-semibold text-gray-300 tabular-nums">01</span>
          <h2 className="text-sm font-semibold text-gray-900 tracking-tight">기준 사진</h2>
          <span className="text-[11px] text-gray-400">AI 제품 피팅 결과 또는 직접 업로드</span>
        </div>
        <ImageUploader
          label="영상으로 만들 착용 컷"
          subLabel="세로 9:16으로 자동 크롭되어 영상이 만들어집니다 — 인물·의상은 그대로 유지"
          image={sourceImage}
          onImageChange={setSourceImage}
          badgeText="기준"
        />
      </section>

      {/* 움직임 */}
      <section className="space-y-4">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] font-semibold text-gray-300 tabular-nums">02</span>
          <h2 className="text-sm font-semibold text-gray-900 tracking-tight">움직임</h2>
          <span className="text-[11px] text-gray-400">4초 영상 · GIF로 저장됩니다</span>
        </div>
        <div className="bg-white border border-gray-200 rounded-2xl p-5 space-y-5">
          {renderPresetGroup('전신 모션', '인물이 실제로 움직입니다', MOTION_PRESETS)}
          {renderPresetGroup('디테일 모션', '화면은 고정, 손·원단만 움직입니다', DETAIL_PRESETS)}

          <div className="space-y-2 pt-1">
            <div className="text-[11px] font-semibold text-gray-700 tracking-tight px-1">직접 입력 (선택)</div>
            <textarea
              value={customInstruction}
              onChange={(e) => setCustomInstruction(e.target.value)}
              placeholder="예: 천천히 걸어오면서 카메라를 바라본다 (비워두면 위에서 고른 프리셋 사용)"
              rows={2}
              className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3.5 py-3 text-[13px] text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-900 resize-none leading-relaxed transition"
            />
            {customInstruction.trim() && (
              <p className="text-[11px] text-gray-400 px-1">
                직접 입력한 내용이 사용됩니다. 화면 고정 여부는 위에서 선택한 프리셋 종류(
                {effectiveKind === 'motion' ? '전신 모션' : '디테일 모션'})를 따릅니다.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* 실행 */}
      <section className="space-y-3">
        <label className="flex items-center gap-2.5 cursor-pointer select-none px-1">
          <input
            type="checkbox"
            checked={highQuality}
            onChange={(e) => setHighQuality(e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 accent-gray-900"
          />
          <span className="text-[12px] text-gray-500">
            <b className="text-gray-700 font-semibold">고화질로 생성</b> — 기본(약 $0.20) 대신 약 $0.40. 인물·원단
            일관성이 더 안정적입니다. 테스트는 끄고, 최종본만 켜서 뽑으세요
          </span>
        </label>
        <button
          onClick={handleRun}
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
            'AI 영상 생성'
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
      {(result || isRunning) && (
        <section className="space-y-4">
          <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-400 mb-1">Result</div>
                <h4 className="text-sm font-semibold text-gray-900 tracking-tight">생성된 영상</h4>
              </div>
              {result && (
                <button
                  onClick={async () => {
                    try {
                      await downloadResultImage(result.imageUrl, `nonfitting_video_${Date.now()}.gif`);
                    } catch (err: any) {
                      alert(err?.message || 'GIF 다운로드 중 오류가 발생했습니다.');
                    }
                  }}
                  className="px-3.5 py-2 rounded-lg border border-gray-200 hover:border-gray-400 text-gray-600 hover:text-gray-900 text-xs font-medium tracking-wide transition"
                >
                  GIF 다운로드
                </button>
              )}
            </div>
            <div className="flex justify-center">
              {result ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={result.imageUrl}
                  alt="생성된 영상"
                  className="max-h-[560px] w-auto rounded-xl border border-gray-200"
                />
              ) : (
                <div className="w-[280px] aspect-[9/16] bg-gray-50 rounded-xl flex flex-col items-center justify-center gap-3">
                  <span className="w-6 h-6 border-2 border-gray-200 border-t-gray-900 rounded-full animate-spin" />
                  <span className="text-[11px] text-gray-400">{stageMsg}</span>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* 히스토리 */}
      {history.length > 0 && (
        <section className="space-y-4">
          <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-400 mb-1">History</div>
              <h4 className="text-sm font-semibold text-gray-900 tracking-tight">이전 영상 {history.length}개</h4>
            </div>
            <div className="grid grid-cols-4 gap-3">
              {history.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setResult({ imageUrl: item.imageUrl, prompt: item.prompt })}
                  className="group relative rounded-lg overflow-hidden border border-gray-200 hover:border-gray-400 transition text-left"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.imageUrl} alt={item.prompt} className="w-full aspect-[9/16] object-cover" />
                  <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-2.5 py-2">
                    <div className="text-[10px] font-medium text-white truncate">{item.label || item.timestamp}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
