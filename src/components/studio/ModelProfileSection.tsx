'use client';

import React, { useState, useEffect, useRef } from 'react';

interface ModelProfile {
  name: string;
  heightCm: number;
  weightKg: number;
  shoeSizeMm: number;
  specText: string;
  hasCustomIdentityImage: boolean;
  updatedAt: string | null;
}

/** 파일을 base64 data URL로 읽는다 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function ModelProfileSection() {
  const [profile, setProfile] = useState<ModelProfile | null>(null);
  const [identityImageUrl, setIdentityImageUrl] = useState<string | null>(null);
  const [newIdentityImage, setNewIdentityImage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/model-profile')
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          setProfile(data.profile);
          setIdentityImageUrl(data.identityImageUrl);
        }
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  const handleSave = async () => {
    if (!profile) return;
    setIsSaving(true);
    try {
      const res = await fetch('/api/model-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: profile.name,
          heightCm: profile.heightCm,
          weightKg: profile.weightKg,
          shoeSizeMm: profile.shoeSizeMm,
          specText: profile.specText,
          identityImageBase64: newIdentityImage,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || '저장에 실패했습니다.');
      setProfile(data.profile);
      setIdentityImageUrl(data.identityImageUrl);
      setNewIdentityImage(null);
      setSavedAt(new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }));
    } catch (err: any) {
      alert(err?.message || '저장 중 오류가 발생했습니다.');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading || !profile) {
    return <div className="max-w-4xl mx-auto px-8 py-24 text-center text-sm text-gray-400">불러오는 중</div>;
  }

  return (
    <div className="max-w-4xl mx-auto px-8 py-10 space-y-10">
      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-400">Model Profile</div>
        <h2 className="text-lg font-semibold text-gray-900 tracking-tight">{profile.name} 모델 정보</h2>
        <p className="text-xs text-gray-400 leading-relaxed">
          AI 피팅과 AI 제품 피팅이 매 생성마다 이 정보를 그대로 읽어갑니다. 여기서 수정하면 다음 생성부터 즉시 반영됩니다.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        {/* 참고 이미지 */}
        <div className="md:col-span-2 bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
          <div>
            <h3 className="text-[13px] font-semibold text-gray-900 tracking-tight">기준 참고 이미지</h3>
            <p className="text-[11px] text-gray-400 mt-1 leading-relaxed">
              얼굴 · 피부톤 · 체형의 시각 기준입니다. 텍스트보다 이 이미지가 일관성에 가장 큰 영향을 줍니다 —
              <b className="text-gray-600"> 전신이 나온 사진</b>일수록 체형(비율/다리 길이)이 안정적으로 고정됩니다.
            </p>
          </div>
          <div
            onClick={() => fileInputRef.current?.click()}
            className="aspect-[3/4] rounded-xl border border-gray-200 hover:border-gray-400 bg-gray-50 overflow-hidden cursor-pointer transition relative group"
          >
            {newIdentityImage || identityImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={newIdentityImage || identityImageUrl!}
                alt="기준 참고 이미지"
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs text-gray-400">
                이미지 없음 — 클릭해서 업로드
              </div>
            )}
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition">
              <span className="px-4 py-2 rounded-lg bg-white text-gray-900 font-medium text-xs">이미지 교체</span>
            </div>
            {newIdentityImage && (
              <span className="absolute top-2 left-2 px-2 py-0.5 rounded bg-gray-900 text-white text-[9px] font-medium tracking-wide">
                저장 시 교체됨
              </span>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) setNewIdentityImage(await fileToDataUrl(file));
              e.target.value = '';
            }}
          />
        </div>

        {/* 기본 수치 + 스펙 텍스트 */}
        <div className="md:col-span-3 space-y-4">
          <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
            <h3 className="text-[13px] font-semibold text-gray-900 tracking-tight">기본 수치</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-gray-500">모델 이름</label>
                <input
                  type="text"
                  value={profile.name}
                  onChange={(e) => setProfile({ ...profile, name: e.target.value })}
                  className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3.5 py-2.5 text-[13px] text-gray-900 focus:outline-none focus:border-gray-900 transition"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-gray-500">키 (cm)</label>
                <input
                  type="number"
                  value={profile.heightCm}
                  onChange={(e) => setProfile({ ...profile, heightCm: Number(e.target.value) })}
                  className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3.5 py-2.5 text-[13px] text-gray-900 focus:outline-none focus:border-gray-900 transition tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-gray-500">몸무게 (kg)</label>
                <input
                  type="number"
                  value={profile.weightKg}
                  onChange={(e) => setProfile({ ...profile, weightKg: Number(e.target.value) })}
                  className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3.5 py-2.5 text-[13px] text-gray-900 focus:outline-none focus:border-gray-900 transition tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-gray-500">신발 사이즈 (mm)</label>
                <input
                  type="number"
                  value={profile.shoeSizeMm}
                  onChange={(e) => setProfile({ ...profile, shoeSizeMm: Number(e.target.value) })}
                  className="w-full bg-gray-50 border border-gray-200 rounded-lg px-3.5 py-2.5 text-[13px] text-gray-900 focus:outline-none focus:border-gray-900 transition tabular-nums"
                />
              </div>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-3">
            <div className="flex items-baseline justify-between">
              <h3 className="text-[13px] font-semibold text-gray-900 tracking-tight">상세 체형 · 피부 스펙</h3>
              <span className="text-[10px] text-gray-400">프롬프트에 그대로 들어갑니다 (영어 권장)</span>
            </div>
            <textarea
              value={profile.specText}
              onChange={(e) => setProfile({ ...profile, specText: e.target.value })}
              rows={14}
              className="w-full bg-gray-50 border border-gray-200 rounded-lg px-4 py-3.5 text-[12px] text-gray-900 focus:outline-none focus:border-gray-900 resize-y font-mono leading-relaxed transition"
            />
            <div className="text-[11px] text-gray-400 leading-relaxed space-y-1 border-t border-gray-100 pt-3">
              <p className="font-medium text-gray-500">일관되게 나오게 적는 요령</p>
              <p>· 긍정형으로 구체적으로 — &ldquo;마른 패션모델 체형, 슬림한 허리&rdquo;처럼 원하는 모습 자체를 서술</p>
              <p>· 피하고 싶은 건 딱 한 번, 스코프와 함께 — 같은 금지어를 반복하면 오히려 그 특징이 강조됩니다</p>
              <p>· 흉터/점 같은 디테일은 &ldquo;희미하게, 자세히 봐야 보이는&rdquo; 수준으로 강도를 명시</p>
              <p>· 무엇보다 왼쪽 참고 이미지가 텍스트보다 강하게 작용합니다 — 마음에 든 전신 결과물을 등록하세요</p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="px-8 py-3.5 rounded-xl bg-gray-900 hover:bg-black text-white font-semibold text-sm tracking-tight transition disabled:opacity-40"
        >
          {isSaving ? '저장 중...' : '모델 정보 저장'}
        </button>
        {savedAt && <span className="text-[11px] text-gray-400">{savedAt} 저장됨 — 다음 생성부터 반영됩니다</span>}
        {!savedAt && profile.updatedAt && (
          <span className="text-[11px] text-gray-400">
            마지막 저장: {new Date(profile.updatedAt).toLocaleString('ko-KR')}
          </span>
        )}
      </div>
    </div>
  );
}
