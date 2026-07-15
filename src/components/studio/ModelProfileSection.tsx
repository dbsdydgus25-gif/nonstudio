'use client';

/**
 * ModelProfileSection — "가상 모델 만들기" 마법사 + 확정된 모델 요약 카드 (2026-07-14 개편)
 *
 * 플로우: 01 기본 정보(성별/나이/키/몸무게/신발) → 02 신체 특징(피부톤 + 자유 입력) →
 * 03 외모(프리셋 or 직접 입력) → 04 초안 미리보기(다시 만들기 반복) → 확정(생성하기) →
 * 고품질 정면/뒤/좌/우 4컷이 백엔드에 저장되고, 모든 생성 서비스가 이 모델을 사용한다.
 *
 * 상세 영문 프롬프트는 백엔드에만 저장 — 사용자에게는 큰 정보만 요약해서 보여준다.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';

/** 파일을 base64 data URL로 읽는다 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface ModelProfile {
  name: string;
  heightCm: number;
  weightKg: number;
  shoeSizeMm: number;
  specText: string;
  hasCustomIdentityImage: boolean;
  updatedAt: string | null;
  gender?: 'male' | 'female';
  age?: number;
  featuresText?: string;
  appearanceText?: string;
  builderStatus?: 'building' | 'ready' | 'failed';
  builderError?: string | null;
}

interface ViewImageUrls {
  back: string | null;
  left: string | null;
  right: string | null;
}

interface BuilderInput {
  name: string;
  gender: 'male' | 'female';
  age: number;
  heightCm: number;
  weightKg: number;
  shoeSizeMm: number;
  skinTone: 'fair' | 'natural' | 'tan';
  featuresText: string;
  appearancePreset: 'clean_urban' | 'chic_editorial' | 'soft_warm' | 'custom';
  appearanceCustomText: string;
}

const DEFAULT_INPUT: BuilderInput = {
  name: '내 모델',
  gender: 'male',
  age: 27,
  heightCm: 177,
  weightKg: 68,
  shoeSizeMm: 270,
  skinTone: 'natural',
  featuresText: '',
  appearancePreset: 'clean_urban',
  appearanceCustomText: '',
};

const SKIN_TONES: Array<{ key: BuilderInput['skinTone']; label: string; desc: string }> = [
  { key: 'fair', label: '밝은 톤', desc: '환하고 균일한 밝은 피부' },
  { key: 'natural', label: '자연스러운 톤', desc: '평범하고 건강한 중간 톤' },
  { key: 'tan', label: '태닝 톤', desc: '따뜻하게 그을린 건강한 톤' },
];

const APPEARANCES: Array<{ key: BuilderInput['appearancePreset']; label: string; desc: string }> = [
  { key: 'clean_urban', label: '깔끔한 도시형', desc: '단정한 머리, 호감형의 세련된 얼굴' },
  { key: 'chic_editorial', label: '시크한 모델형', desc: '뚜렷한 이목구비, 패션 화보 분위기' },
  { key: 'soft_warm', label: '부드러운 훈훈형', desc: '온화한 인상, 자연스러운 미소' },
  { key: 'custom', label: '직접 입력', desc: '원하는 외모를 자유롭게 서술' },
];

interface Props {
  geminiKey: string;
  openaiKey: string;
  onNeedKeys: () => void;
  /** 모델 확정 완료 시 상위(page)에서 잠금 해제하도록 알림 */
  onModelReady?: () => void;
}

export function ModelProfileSection({ openaiKey, onNeedKeys, onModelReady }: Props) {
  const [profile, setProfile] = useState<ModelProfile | null>(null);
  const [identityImageUrl, setIdentityImageUrl] = useState<string | null>(null);
  const [viewImageUrls, setViewImageUrls] = useState<ViewImageUrls>({ back: null, left: null, right: null });
  const [isLoading, setIsLoading] = useState(true);

  // 마법사 상태
  const [mode, setMode] = useState<'summary' | 'wizard'>('summary');
  const [track, setTrack] = useState<'text' | 'photo' | null>(null); // 트랙 선택 전엔 null
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [input, setInput] = useState<BuilderInput>(DEFAULT_INPUT);
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [photoImages, setPhotoImages] = useState<string[]>([]); // 트랙 2 업로드 사진 (여러 장 가능)
  const [draftImage, setDraftImage] = useState<string | null>(null);
  const [isDrafting, setIsDrafting] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [error, setError] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const loadProfile = useCallback(async () => {
    try {
      const res = await fetch('/api/model-profile');
      const data = await res.json();
      if (data.success) {
        setProfile(data.profile);
        setIdentityImageUrl(data.identityImageUrl);
        setViewImageUrls(data.viewImageUrls || { back: null, left: null, right: null });
        return data;
      }
    } catch {
      // 로드 실패 시 아래 return
    }
    return null;
  }, []);

  useEffect(() => {
    loadProfile().finally(() => setIsLoading(false));
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadProfile]);

  // building 상태면 5초 간격 폴링으로 ready/failed 감지
  useEffect(() => {
    if (profile?.builderStatus === 'building' && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        const data = await loadProfile();
        const status = data?.profile?.builderStatus;
        if (status === 'ready' || status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          if (status === 'ready') onModelReady?.();
        }
      }, 5000);
    }
    if (profile?.builderStatus !== 'building' && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [profile?.builderStatus, loadProfile, onModelReady]);

  const startWizard = () => {
    setInput({
      ...DEFAULT_INPUT,
      name: profile?.name && profile.name !== '윤용현' ? profile.name : DEFAULT_INPUT.name,
    });
    setDraftImage(null);
    setReferenceImage(null);
    setPhotoImages([]);
    setTrack(null);
    setError('');
    setStep(1);
    setMode('wizard');
  };

  const buildFromPhoto = async () => {
    if (!openaiKey) {
      onNeedKeys();
      return;
    }
    if (!photoImages.length) {
      setError('모델 사진을 최소 1장 업로드해 주세요.');
      return;
    }
    setIsConfirming(true);
    setError('');
    try {
      const res = await fetch('/api/model-builder/from-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: {
            name: input.name,
            gender: input.gender,
            age: input.age,
            heightCm: input.heightCm,
            weightKg: input.weightKg,
            shoeSizeMm: input.shoeSizeMm,
          },
          photosBase64: photoImages,
          openaiApiKey: openaiKey,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '사진 모델 저장에 실패했습니다.');
      await loadProfile(); // building 반영 → 폴링 시작
      setMode('summary');
    } catch (err: any) {
      setError(err?.message || '사진 모델 저장 중 오류가 발생했습니다.');
    } finally {
      setIsConfirming(false);
    }
  };

  const makeDraft = async () => {
    if (!openaiKey) {
      onNeedKeys();
      return;
    }
    setIsDrafting(true);
    setError('');
    try {
      const res = await fetch('/api/model-builder/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: toServerInput(input),
          openaiApiKey: openaiKey,
          appearanceReferenceImageBase64: referenceImage,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '초안 생성에 실패했습니다.');
      setDraftImage(data.imageDataUrl);
      setStep(4);
    } catch (err: any) {
      setError(err?.message || '초안 생성 중 오류가 발생했습니다.');
    } finally {
      setIsDrafting(false);
    }
  };

  const confirmModel = async () => {
    if (!draftImage) return;
    setIsConfirming(true);
    setError('');
    try {
      const res = await fetch('/api/model-builder/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: toServerInput(input),
          draftImageBase64: draftImage,
          openaiApiKey: openaiKey,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '모델 확정에 실패했습니다.');
      await loadProfile(); // builderStatus='building' 반영 → 폴링 시작
      setMode('summary');
    } catch (err: any) {
      setError(err?.message || '모델 확정 중 오류가 발생했습니다.');
    } finally {
      setIsConfirming(false);
    }
  };

  function toServerInput(v: BuilderInput) {
    return {
      name: v.name,
      gender: v.gender,
      age: v.age,
      heightCm: v.heightCm,
      weightKg: v.weightKg,
      shoeSizeMm: v.shoeSizeMm,
      skinTone: v.skinTone,
      featuresText: v.featuresText,
      appearancePreset: v.appearancePreset,
      appearanceCustomText: v.appearanceCustomText,
    };
  }

  if (isLoading) {
    return <div className="max-w-4xl mx-auto px-8 py-24 text-center text-sm text-gray-400">불러오는 중</div>;
  }

  const modelReady = !!identityImageUrl && profile?.builderStatus !== 'building';
  const isBuilding = profile?.builderStatus === 'building';

  // ───────────────────────── 요약(확정된 모델) 화면 ─────────────────────────
  if (mode === 'summary') {
    return (
      <div className="max-w-4xl mx-auto px-8 py-10 space-y-8">
        <div className="flex items-end justify-between">
          <div className="space-y-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-400">My Model</div>
            <h2 className="text-lg font-semibold text-gray-900 tracking-tight">
              {modelReady || isBuilding ? `${profile?.name || '내 모델'}` : '아직 모델이 없습니다'}
            </h2>
            <p className="text-xs text-gray-400 leading-relaxed">
              AI 피팅 · AI 제품 피팅 · AI 바리에이션의 모든 생성이 이 모델(이미지 + 저장된 스펙)을 기준으로 만들어집니다.
            </p>
          </div>
          {!isBuilding && (
            <button
              onClick={startWizard}
              className="px-5 py-3 rounded-xl bg-gray-900 hover:bg-black text-white font-semibold text-[13px] tracking-tight transition flex-shrink-0"
            >
              {modelReady ? '모델 새로 만들기' : '가상 모델 만들기'}
            </button>
          )}
        </div>

        {isBuilding && (
          <div className="bg-white border border-gray-200 rounded-2xl p-10 text-center space-y-3">
            <div className="text-[13px] font-semibold text-gray-900 animate-pulse">
              모델 확정 컷(정면 · 뒤 · 좌 · 우) 생성 중…
            </div>
            <p className="text-[11px] text-gray-400 leading-relaxed">
              고품질 4컷을 만들어 저장하고 있습니다. 보통 3~6분 정도 걸리며, 완료되면 자동으로 아래에 표시됩니다.
              <br />이 화면을 벗어나도 생성은 계속됩니다.
            </p>
          </div>
        )}

        {profile?.builderStatus === 'failed' && (
          <div className="bg-red-50 border border-red-100 rounded-2xl p-6 space-y-2">
            <div className="text-[13px] font-semibold text-red-600">모델 확정 생성에 실패했습니다</div>
            <p className="text-[11px] text-red-400">{profile.builderError || '알 수 없는 오류'}</p>
            <button onClick={startWizard} className="text-[12px] font-medium text-gray-900 underline underline-offset-2">
              다시 만들기
            </button>
          </div>
        )}

        {(modelReady || isBuilding) && (
          <>
            {/* 4컷 뷰 */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {(
                [
                  { label: '정면', url: identityImageUrl },
                  { label: '뒤', url: viewImageUrls.back },
                  { label: '좌측', url: viewImageUrls.left },
                  { label: '우측', url: viewImageUrls.right },
                ] as const
              ).map((v) => (
                <div key={v.label} className="space-y-1.5">
                  <div className="aspect-[2/3] rounded-xl border border-gray-200 bg-gray-50 overflow-hidden">
                    {v.url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={v.url} alt={v.label} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[10px] text-gray-300">
                        {isBuilding ? '생성 중…' : '없음'}
                      </div>
                    )}
                  </div>
                  <div className="text-center text-[10px] font-medium tracking-[0.14em] text-gray-400 uppercase">
                    {v.label}
                  </div>
                </div>
              ))}
            </div>

            {/* 요약 정보 — 상세 프롬프트는 백엔드 전용, 여기선 큰 정보만 */}
            <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
              <h3 className="text-[13px] font-semibold text-gray-900 tracking-tight">모델 정보 요약</h3>
              <div className="flex flex-wrap gap-2">
                {profile?.gender && (
                  <span className="px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200 text-[11px] text-gray-600">
                    {profile.gender === 'male' ? '남성' : '여성'}
                  </span>
                )}
                {profile?.age ? (
                  <span className="px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200 text-[11px] text-gray-600">
                    {profile.age}세
                  </span>
                ) : null}
                <span className="px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200 text-[11px] text-gray-600 tabular-nums">
                  {profile?.heightCm}cm
                </span>
                <span className="px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200 text-[11px] text-gray-600 tabular-nums">
                  {profile?.weightKg}kg
                </span>
                <span className="px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200 text-[11px] text-gray-600 tabular-nums">
                  {profile?.shoeSizeMm}mm
                </span>
                {profile?.appearanceText && (
                  <span className="px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200 text-[11px] text-gray-600">
                    {profile.appearanceText}
                  </span>
                )}
              </div>
              {profile?.featuresText && (
                <p className="text-[11px] text-gray-500 leading-relaxed border-t border-gray-100 pt-3">
                  {profile.featuresText}
                </p>
              )}
              <p className="text-[10px] text-gray-300 leading-relaxed">
                생성에 쓰이는 상세 스펙 프롬프트는 시스템이 자동으로 관리합니다 — 모든 서비스가 위 이미지와 함께 이 스펙을
                그대로 사용해 동일한 모델을 유지합니다.
              </p>
            </div>
          </>
        )}

        {!modelReady && !isBuilding && profile?.builderStatus !== 'failed' && (
          <div className="bg-gray-50 border border-dashed border-gray-300 rounded-2xl p-12 text-center space-y-2">
            <p className="text-[13px] font-medium text-gray-500">가상 모델을 먼저 만들어야 다른 서비스를 사용할 수 있습니다</p>
            <p className="text-[11px] text-gray-400">
              성별 · 나이 · 신체 스펙 · 특징 · 외모를 입력하면 초안을 보고 확정할 수 있습니다
            </p>
          </div>
        )}
      </div>
    );
  }

  // ───────────────────────── 마법사 화면 ─────────────────────────
  const inputCls =
    'w-full bg-gray-50 border border-gray-200 rounded-lg px-3.5 py-2.5 text-[13px] text-gray-900 focus:outline-none focus:border-gray-900 transition';

  return (
    <div className="max-w-3xl mx-auto px-8 py-10 space-y-8">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-400">Model Builder</div>
          <h2 className="text-lg font-semibold text-gray-900 tracking-tight">가상 모델 만들기</h2>
        </div>
        <button
          onClick={() => (track ? setTrack(null) : setMode('summary'))}
          className="text-[11px] text-gray-400 hover:text-gray-900 underline underline-offset-2 transition"
        >
          {track ? '방식 다시 선택' : '취소하고 돌아가기'}
        </button>
      </div>

      {error && !track && (
        <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-4 py-3">{error}</p>
      )}

      {/* 트랙 선택 — 말로 만들기 vs 사진으로 만들기 */}
      {!track && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <button
            onClick={() => { setError(''); setTrack('text'); setStep(1); }}
            className="text-left bg-white border border-gray-200 hover:border-gray-900 rounded-2xl p-6 space-y-2 transition group"
          >
            <div className="w-10 h-10 rounded-xl bg-gray-900 text-white flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
                <path d="M4 7h16M4 12h10M4 17h7" />
              </svg>
            </div>
            <h3 className="text-[14px] font-semibold text-gray-900">말로 만들기</h3>
            <p className="text-[11px] text-gray-500 leading-relaxed">
              성별 · 나이 · 신체 스펙 · 특징 · 외모를 입력해 가상 모델을 새로 생성합니다. (참고 이미지 첨부 가능)
            </p>
          </button>
          <button
            onClick={() => { setError(''); setTrack('photo'); }}
            className="text-left bg-white border border-gray-200 hover:border-gray-900 rounded-2xl p-6 space-y-2 transition group"
          >
            <div className="w-10 h-10 rounded-xl bg-gray-900 text-white flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <circle cx="8.5" cy="10" r="1.5" />
                <path d="m21 16-5-5L5 19" />
              </svg>
            </div>
            <h3 className="text-[14px] font-semibold text-gray-900">사진으로 만들기</h3>
            <p className="text-[11px] text-gray-500 leading-relaxed">
              실제 자기 사진이나 원하는 사진을 업로드하면 <b className="text-gray-700">그 사람 그대로</b> 모델로 저장합니다. AI 과장 없이 가장 자연스럽습니다.
            </p>
          </button>
        </div>
      )}

      {/* 트랙 2 — 사진으로 만들기 */}
      {track === 'photo' && (
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-5">
          <div>
            <h3 className="text-[13px] font-semibold text-gray-900">사진으로 만들기</h3>
            <p className="text-[11px] text-gray-400 mt-0.5">
              전신이 나온 사진일수록 좋습니다. 여러 장을 넣으면 첫 번째 사진을 기준(포즈 · 착장)으로 삼고, 나머지는 얼굴 · 피부 · 체형을
              더 정확히 반영하는 데 사용해 하나로 종합합니다. 그 결과가 정면 기준이 되고, 뒤 · 좌 · 우 컷은 거기서 파생됩니다.
            </p>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
            {photoImages.map((img, i) => (
              <div key={i} className="relative aspect-[2/3] rounded-xl overflow-hidden border border-gray-200 bg-gray-50 group">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img} alt={`모델 사진 ${i + 1}`} className="w-full h-full object-cover" />
                {i === 0 && (
                  <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-gray-900 text-white text-[9px] font-medium">기준</span>
                )}
                <button
                  onClick={() => setPhotoImages(photoImages.filter((_, idx) => idx !== i))}
                  className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white text-[11px] font-medium transition"
                >
                  제거
                </button>
              </div>
            ))}
            {photoImages.length < 6 && (
              <button
                onClick={() => photoInputRef.current?.click()}
                className="aspect-[2/3] rounded-xl border border-dashed border-gray-300 hover:border-gray-400 bg-gray-50 flex flex-col items-center justify-center gap-1 text-gray-400 hover:text-gray-600 transition"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-6 h-6">
                  <path d="M12 16V4m0 0 4 4m-4-4-4 4" />
                  <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
                </svg>
                <span className="text-[10px] font-medium">{photoImages.length === 0 ? '사진 업로드' : '사진 추가'}</span>
              </button>
            )}
          </div>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={async (e) => {
              const files = Array.from(e.target.files || []).slice(0, 6 - photoImages.length);
              if (files.length) {
                const dataUrls = await Promise.all(files.map(fileToDataUrl));
                setPhotoImages([...photoImages, ...dataUrls]);
              }
              e.target.value = '';
            }}
          />

          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-gray-100">
            <div className="space-y-1.5 col-span-2">
              <label className="text-[11px] font-medium text-gray-500">모델 이름</label>
              <input type="text" value={input.name} onChange={(e) => setInput({ ...input, name: e.target.value })} className={inputCls} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-gray-500">성별</label>
              <div className="grid grid-cols-2 gap-2">
                {(['male', 'female'] as const).map((g) => (
                  <button
                    key={g}
                    onClick={() => setInput({ ...input, gender: g })}
                    className={`py-2.5 rounded-lg border text-[13px] font-medium transition ${
                      input.gender === g ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
                    }`}
                  >
                    {g === 'male' ? '남성' : '여성'}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-gray-500">나이</label>
              <input type="number" value={input.age} onChange={(e) => setInput({ ...input, age: Number(e.target.value) })} className={`${inputCls} tabular-nums`} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-gray-500">키 (cm)</label>
              <input type="number" value={input.heightCm} onChange={(e) => setInput({ ...input, heightCm: Number(e.target.value) })} className={`${inputCls} tabular-nums`} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-gray-500">몸무게 (kg)</label>
              <input type="number" value={input.weightKg} onChange={(e) => setInput({ ...input, weightKg: Number(e.target.value) })} className={`${inputCls} tabular-nums`} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-gray-500">신발 사이즈 (mm)</label>
              <input type="number" value={input.shoeSizeMm} onChange={(e) => setInput({ ...input, shoeSizeMm: Number(e.target.value) })} className={`${inputCls} tabular-nums`} />
            </div>
          </div>

          {error && <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-4 py-3">{error}</p>}

          <div className="flex justify-end">
            <button
              onClick={buildFromPhoto}
              disabled={isConfirming || !photoImages.length}
              className="px-8 py-3 rounded-xl bg-gray-900 hover:bg-black text-white font-semibold text-[13px] transition disabled:opacity-40"
            >
              {isConfirming ? '저장 중…' : '이 사진으로 모델 만들기'}
            </button>
          </div>
          <p className="text-right text-[10px] text-gray-400">확정 후 뒤 · 좌 · 우 컷 생성에 2~4분 걸립니다</p>
        </div>
      )}

      {/* 트랙 1 — 말로 만들기 (스텝 마법사) */}
      {track === 'text' && (
      <>
      {/* 스텝 인디케이터 */}
      <div className="flex items-center gap-2">
        {[1, 2, 3, 4].map((s) => (
          <React.Fragment key={s}>
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold ${
                step >= s ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-400'
              }`}
            >
              {s}
            </div>
            {s < 4 && <div className={`flex-1 h-px ${step > s ? 'bg-gray-900' : 'bg-gray-200'}`} />}
          </React.Fragment>
        ))}
      </div>

      {error && (
        <p className="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-4 py-3">{error}</p>
      )}

      {/* STEP 1 — 기본 정보 */}
      {step === 1 && (
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-5">
          <div>
            <h3 className="text-[13px] font-semibold text-gray-900">01 기본 정보</h3>
            <p className="text-[11px] text-gray-400 mt-0.5">성별 · 나이 · 신체 스펙</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5 col-span-2">
              <label className="text-[11px] font-medium text-gray-500">모델 이름</label>
              <input type="text" value={input.name} onChange={(e) => setInput({ ...input, name: e.target.value })} className={inputCls} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-gray-500">성별</label>
              <div className="grid grid-cols-2 gap-2">
                {(['male', 'female'] as const).map((g) => (
                  <button
                    key={g}
                    onClick={() => setInput({ ...input, gender: g })}
                    className={`py-2.5 rounded-lg border text-[13px] font-medium transition ${
                      input.gender === g
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
                    }`}
                  >
                    {g === 'male' ? '남성' : '여성'}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-gray-500">나이</label>
              <input type="number" value={input.age} onChange={(e) => setInput({ ...input, age: Number(e.target.value) })} className={`${inputCls} tabular-nums`} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-gray-500">키 (cm)</label>
              <input type="number" value={input.heightCm} onChange={(e) => setInput({ ...input, heightCm: Number(e.target.value) })} className={`${inputCls} tabular-nums`} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-gray-500">몸무게 (kg)</label>
              <input type="number" value={input.weightKg} onChange={(e) => setInput({ ...input, weightKg: Number(e.target.value) })} className={`${inputCls} tabular-nums`} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-gray-500">신발 사이즈 (mm)</label>
              <input type="number" value={input.shoeSizeMm} onChange={(e) => setInput({ ...input, shoeSizeMm: Number(e.target.value) })} className={`${inputCls} tabular-nums`} />
            </div>
          </div>
          <div className="flex justify-end">
            <button onClick={() => setStep(2)} className="px-6 py-3 rounded-xl bg-gray-900 hover:bg-black text-white font-semibold text-[13px] transition">
              다음 — 신체 특징
            </button>
          </div>
        </div>
      )}

      {/* STEP 2 — 신체 특징 */}
      {step === 2 && (
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-5">
          <div>
            <h3 className="text-[13px] font-semibold text-gray-900">02 신체 특징</h3>
            <p className="text-[11px] text-gray-400 mt-0.5">피부톤과 몸의 디테일 — 매 생성마다 그대로 유지됩니다</p>
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-gray-500">피부톤</label>
            <div className="grid grid-cols-3 gap-2">
              {SKIN_TONES.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setInput({ ...input, skinTone: t.key })}
                  className={`p-3 rounded-lg border text-left transition ${
                    input.skinTone === t.key
                      ? 'bg-gray-900 text-white border-gray-900'
                      : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
                  }`}
                >
                  <div className="text-[12px] font-semibold">{t.label}</div>
                  <div className={`text-[10px] mt-0.5 ${input.skinTone === t.key ? 'text-gray-300' : 'text-gray-400'}`}>{t.desc}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-gray-500">신체 특징 (선택 — 자유롭게)</label>
            <textarea
              value={input.featuresText}
              onChange={(e) => setInput({ ...input, featuresText: e.target.value })}
              rows={4}
              placeholder={'예: 팔에 자연스러운 솜털, 손등 근처에 희미한 핏줄, 왼쪽 전완근에 1cm 흐린 흉터, 마른 체형에 어깨는 적당히 넓게'}
              className={`${inputCls} resize-y leading-relaxed`}
            />
            <p className="text-[10px] text-gray-400 leading-relaxed">
              핏줄 · 털 · 점 · 상처 같은 디테일은 &ldquo;희미하게 / 자연스럽게&rdquo; 수준을 함께 적으면 과장되지 않게 나옵니다.
            </p>
          </div>
          <div className="flex justify-between">
            <button onClick={() => setStep(1)} className="px-5 py-3 rounded-xl border border-gray-200 hover:border-gray-400 text-gray-500 text-[13px] font-medium transition">이전</button>
            <button onClick={() => setStep(3)} className="px-6 py-3 rounded-xl bg-gray-900 hover:bg-black text-white font-semibold text-[13px] transition">다음 — 외모</button>
          </div>
        </div>
      )}

      {/* STEP 3 — 외모 */}
      {step === 3 && (
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-5">
          <div>
            <h3 className="text-[13px] font-semibold text-gray-900">03 외모</h3>
            <p className="text-[11px] text-gray-400 mt-0.5">프리셋에서 고르거나 직접 서술하세요</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {APPEARANCES.map((a) => (
              <button
                key={a.key}
                onClick={() => setInput({ ...input, appearancePreset: a.key })}
                className={`p-4 rounded-lg border text-left transition ${
                  input.appearancePreset === a.key
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
                }`}
              >
                <div className="text-[12px] font-semibold">{a.label}</div>
                <div className={`text-[10px] mt-0.5 ${input.appearancePreset === a.key ? 'text-gray-300' : 'text-gray-400'}`}>{a.desc}</div>
              </button>
            ))}
          </div>
          {input.appearancePreset === 'custom' && (
            <textarea
              value={input.appearanceCustomText}
              onChange={(e) => setInput({ ...input, appearanceCustomText: e.target.value })}
              rows={3}
              placeholder="예: 짧은 검은 머리에 눈매가 서글서글하고, 옅은 쌍꺼풀, 웃을 때 보조개"
              className={`${inputCls} resize-y leading-relaxed`}
            />
          )}

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-gray-500">참고 이미지 (선택 — 없어도 진행 가능)</label>
            <p className="text-[10px] text-gray-400 leading-relaxed">
              사진을 넣으면 얼굴 · 헤어스타일 · 분위기를 참고해서 초안을 만듭니다. 옷 · 포즈 · 배경은 참고하지 않고 위 설정대로 새로 생성됩니다.
            </p>
            {referenceImage ? (
              <div className="flex items-center gap-3">
                <div className="w-16 h-20 rounded-lg overflow-hidden border border-gray-200 bg-gray-50 flex-shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={referenceImage} alt="참고 이미지" className="w-full h-full object-cover" />
                </div>
                <div className="flex-1 text-[11px] text-gray-500">참고 이미지가 등록되었습니다</div>
                <button
                  onClick={() => setReferenceImage(null)}
                  className="text-[11px] text-gray-400 hover:text-gray-900 underline underline-offset-2 transition"
                >
                  제거
                </button>
              </div>
            ) : (
              <button
                onClick={() => referenceInputRef.current?.click()}
                className="w-full py-4 rounded-lg border border-dashed border-gray-300 hover:border-gray-400 text-[12px] text-gray-400 hover:text-gray-600 transition"
              >
                클릭해서 참고 이미지 업로드
              </button>
            )}
            <input
              ref={referenceInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setReferenceImage(await fileToDataUrl(file));
                e.target.value = '';
              }}
            />
          </div>

          <div className="bg-gray-50 border border-gray-100 rounded-lg px-4 py-3 text-[11px] text-gray-500 leading-relaxed">
            초안은 <b className="text-gray-700">검은 반팔 티셔츠 + 검은 반바지</b>를 입은 전신 정면 1장으로, 저비용 초안 품질로
            생성됩니다. 마음에 들 때까지 다시 만들 수 있습니다.
          </div>
          <div className="flex justify-between">
            <button onClick={() => setStep(2)} className="px-5 py-3 rounded-xl border border-gray-200 hover:border-gray-400 text-gray-500 text-[13px] font-medium transition">이전</button>
            <button
              onClick={makeDraft}
              disabled={isDrafting}
              className="px-6 py-3 rounded-xl bg-gray-900 hover:bg-black text-white font-semibold text-[13px] transition disabled:opacity-40"
            >
              {isDrafting ? '초안 생성 중… (약 1분)' : '초안 만들기'}
            </button>
          </div>
        </div>
      )}

      {/* STEP 4 — 초안 미리보기 / 확정 */}
      {step === 4 && (
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-5">
          <div>
            <h3 className="text-[13px] font-semibold text-gray-900">04 초안 확인</h3>
            <p className="text-[11px] text-gray-400 mt-0.5">
              이 모델로 확정하면 고품질 정면 · 뒤 · 좌 · 우 4컷이 저장되고, 모든 서비스가 이 모델로 생성됩니다
            </p>
          </div>
          <div className="max-w-xs mx-auto aspect-[2/3] rounded-xl border border-gray-200 bg-gray-50 overflow-hidden">
            {isDrafting ? (
              <div className="w-full h-full flex items-center justify-center text-xs text-gray-400 animate-pulse">
                새 초안 생성 중… (약 1분)
              </div>
            ) : draftImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={draftImage} alt="모델 초안" className="w-full h-full object-cover" />
            ) : null}
          </div>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={makeDraft}
              disabled={isDrafting || isConfirming}
              className="px-5 py-3 rounded-xl border border-gray-200 hover:border-gray-400 text-gray-600 text-[13px] font-medium transition disabled:opacity-40"
            >
              다시 만들기
            </button>
            <button
              onClick={confirmModel}
              disabled={isDrafting || isConfirming || !draftImage}
              className="px-8 py-3 rounded-xl bg-gray-900 hover:bg-black text-white font-semibold text-[13px] transition disabled:opacity-40"
            >
              {isConfirming ? '확정 요청 중…' : '이 모델로 생성하기'}
            </button>
          </div>
          <p className="text-center text-[10px] text-gray-400">
            확정 후 4컷 생성에 3~6분 정도 걸립니다 — 진행 상황은 모델 정보 화면에 표시됩니다
          </p>
          <div className="flex justify-start">
            <button onClick={() => setStep(3)} className="text-[11px] text-gray-400 hover:text-gray-900 underline underline-offset-2 transition">
              이전 단계로 (외모 수정)
            </button>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}
