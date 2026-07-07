'use client';

import React, { useState, useEffect } from 'react';
import { Sidebar } from '@/components/studio/Sidebar';
import { ImageUploader } from '@/components/studio/ImageUploader';
import { GarmentMultiUploader } from '@/components/studio/GarmentMultiUploader';
import { PromptEditor } from '@/components/studio/PromptEditor';
import { FittingResultViewer, type HistoryItem } from '@/components/studio/FittingResultViewer';
import { RestyleSection } from '@/components/studio/RestyleSection';
import { ApiKeyModal } from '@/components/studio/ApiKeyModal';
import { MY_FITTING_MODELS, SAMPLE_GARMENT_IMAGE, type ModelPreset } from '@/components/studio/presets';
import { FITTING_MODE_INFO, type FittingMode } from '@/lib/fitting-prompts';

async function urlToBase64(url: string): Promise<string> {
  const res = await fetch(url);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

const BACKGROUND_PRESETS = [
  { id: 'default', name: '기본 흰색 스튜디오', url: null, filename: null },
  { id: 'bg1', name: '도시 골목 로케이션', url: '/backgrounds/02fa6e4b8ee1fee6b3cf604ef0a01f2d.jpg', filename: '02fa6e4b8ee1fee6b3cf604ef0a01f2d.jpg' },
  { id: 'bg2', name: '자연광 모던 실내', url: '/backgrounds/3dd746bf41c43a71fa2137e5cbd1d9a1.jpg', filename: '3dd746bf41c43a71fa2137e5cbd1d9a1.jpg' },
  { id: 'bg3', name: '콘크리트 스튜디오', url: '/backgrounds/Gemini_Generated_Image_uee39tuee39tuee3.png', filename: 'Gemini_Generated_Image_uee39tuee39tuee3.png' },
];

export default function StudioPage() {
  // API Keys
  const [geminiKey, setGeminiKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [replicateKey, setReplicateKey] = useState('');
  const [isKeyModalOpen, setIsKeyModalOpen] = useState(false);

  // Navigation
  const [activePage, setActivePage] = useState<'fitting' | 'restyle' | 'models' | 'settings'>('restyle');
  const [activeMode, setActiveMode] = useState<FittingMode>('top');

  // Images & Garments
  const [garmentImages, setGarmentImages] = useState<string[]>([]);

  // Prompt & Source
  const [userAdditions, setUserAdditions] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');

  // 소싱 의류 카테고리 및 세부 특징 설명
  const [garmentCategory, setGarmentCategory] = useState<'top' | 'bottom' | 'shoes' | 'bag' | 'accessory'>('top');
  const [garmentDetailsInput, setGarmentDetailsInput] = useState('');

  // 생성 장수 설정 (상의, 하의, 전신)
  const [topCount, setTopCount] = useState<number>(0);
  const [bottomCount, setBottomCount] = useState<number>(0);
  const [fullbodyCount, setFullbodyCount] = useState<number>(0);

  // 배경 선택 설정
  const [selectedBackground, setSelectedBackground] = useState<string | null>(null);

  // 얼굴 생성 여부 설정 (기본 false: 얼굴 없음)
  const [generateFace, setGenerateFace] = useState<boolean>(false);

  // Pipeline state
  const [isRunning, setIsRunning] = useState(false);
  const [stage, setStage] = useState<'idle' | 'analyzing' | 'fitting' | 'done'>('idle');
  const [stageMsg, setStageMsg] = useState('');
  const [garmentAnalysis, setGarmentAnalysis] = useState<any>(null);

  // Results
  const [batchImages, setBatchImages] = useState<Array<{ imageUrl: string; poseLabel: string; poseId: string }>>([]);
  const [currentResult, setCurrentResult] = useState<{ imageUrl: string; prompt: string; revisedPrompt?: string } | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  useEffect(() => {
    const g =
      localStorage.getItem('elon_gemini_key') ||
      localStorage.getItem('personal_gemini_key') ||
      '';
    const o =
      localStorage.getItem('elon_openai_key') ||
      localStorage.getItem('personal_openai_key') ||
      '';
    const r =
      localStorage.getItem('elon_replicate_key') ||
      '';
    setGeminiKey(g);
    setOpenaiKey(o);
    setReplicateKey(r);
    if (g) localStorage.setItem('elon_gemini_key', g);
    if (o) localStorage.setItem('elon_openai_key', o);
    if (r) localStorage.setItem('elon_replicate_key', r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveKeys = (g: string, o: string, r: string) => {
    localStorage.setItem('elon_gemini_key', g);
    localStorage.setItem('elon_openai_key', o);
    localStorage.setItem('elon_replicate_key', r);
    setGeminiKey(g);
    setOpenaiKey(o);
    setReplicateKey(r);
  };

  const handleLoadSampleGarment = async () => {
    try {
      const b64 = await urlToBase64(SAMPLE_GARMENT_IMAGE);
      setGarmentImages([b64]);
    } catch {
      alert('샘플 이미지 로드 실패');
    }
  };

  // ────────── 원클릭 피팅 실행 ──────────
  const handleRunFitting = async () => {
    if (garmentImages.length === 0) {
      alert('소싱한 의류 이미지를 1장 이상 등록해주세요.');
      return;
    }
    if (!geminiKey || !openaiKey) {
      setIsKeyModalOpen(true);
      return;
    }

    setIsRunning(true);
    setStage('analyzing');
    setStageMsg('1단계: Gemini Vision이 의류 소재·핏·디테일을 정밀 분석 중...');
    setCurrentResult(null);
    setBatchImages([]);

    try {
      const res = await fetch('/api/fitting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          garmentImages,
          mode: activeMode,
          userAdditions,
          openaiApiKey: openaiKey,
          geminiApiKey: geminiKey,
          replicateApiKey: replicateKey,
          sourceUrl: sourceUrl.trim() || undefined,
          rawSpecs: garmentDetailsInput.trim() || undefined,
          garmentCategory,
          topCount,
          bottomCount,
          fullbodyCount,
          selectedBackground,
          generateFace,
        }),
      });

      const totalShots = (topCount + bottomCount + fullbodyCount) || 2;
      setStage('fitting');
      setStageMsg(`2단계: 총 ${totalShots}장의 포즈로 GPT-Image-2 병렬 렌더링 중... (최대 90초 소요)`);

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || '피팅 처리에 실패했습니다.');
      }

      setGarmentAnalysis(data.garmentAnalysis || null);

      // 4장 배열로 상태 업데이트
      const imgs: Array<{ imageUrl: string; poseLabel: string; poseId: string }> = (data.images || []).map((img: any) => ({
        imageUrl: img.imageUrl,
        poseLabel: img.poseLabel || '',
        poseId: img.poseId || '',
      }));
      setBatchImages(imgs);

      // 첫 번째 이미지를 currentResult로도 세팅
      if (imgs.length > 0) {
        setCurrentResult({
          imageUrl: imgs[0].imageUrl,
          prompt: data.images?.[0]?.prompt || '',
          revisedPrompt: data.images?.[0]?.engineUsed || '',
        });
      }

      // 히스토리에 4장 모두 추가
      const timestamp = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      setHistory((prev) => [
        ...imgs.map((img, i) => ({
          id: `${Date.now()}_${i}`,
          imageUrl: img.imageUrl,
          prompt: data.images?.[i]?.prompt || '',
          revisedPrompt: img.poseLabel,
          timestamp,
        })),
        ...prev,
      ]);

      setStage('done');
    } catch (err: any) {
      alert(err.message || '오류가 발생했습니다.');
      setStage('idle');
    } finally {
      setIsRunning(false);
    }
  };

  const modeInfo = FITTING_MODE_INFO[activeMode];

  return (
    <div className="flex min-h-screen bg-white text-gray-900 font-sans">
      {/* 왼쪽 사이드바 */}
      <Sidebar
        activeMode={activeMode}
        onModeChange={(m) => { setActiveMode(m); setStage('idle'); }}
        activePage={activePage}
        onPageChange={(p) => {
          setActivePage(p);
          // settings는 헤더의 API 설정 버튼으로 대체 (자동 모달 제거)
        }}
        geminiKey={geminiKey}
        openaiKey={openaiKey}
      />

      {/* 오른쪽 워크스페이스 */}
      <main className="flex-1 overflow-y-auto">
        {/* 상단 헤더 */}
        <header className="sticky top-0 z-30 border-b border-gray-200 bg-white/90 backdrop-blur-xl px-8 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {activePage === 'restyle' ? (
              <>
                <span className="text-xl">✨</span>
                <div>
                  <h1 className="text-sm font-black text-gray-900">AI 리스타일링</h1>
                  <p className="text-[10px] text-gray-400">실사 사진 한 장으로 매력적인 AI 피팅컷 생성</p>
                </div>
              </>
            ) : (
              <>
                <span className="text-xl">{modeInfo.icon}</span>
                <div>
                  <h1 className="text-sm font-black text-gray-900">{modeInfo.label}</h1>
                  <p className="text-[10px] text-gray-400">{modeInfo.description}</p>
                </div>
              </>
            )}
          </div>
          <button
            onClick={() => setIsKeyModalOpen(true)}
            className="px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 border border-gray-200 text-xs text-gray-600 font-bold transition"
          >
            🔑 API 설정
          </button>
        </header>

        {activePage === 'restyle' ? (
          <RestyleSection
            geminiKey={geminiKey}
            openaiKey={openaiKey}
            onNeedKeys={() => setIsKeyModalOpen(true)}
          />
        ) : (
        <div className="max-w-4xl mx-auto px-8 py-8 space-y-8">
          {/* 의류 이미지 등록 */}
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black text-amber-600 uppercase tracking-widest">Step 01</span>
              <h2 className="text-sm font-black text-gray-900">의류 이미지 등록</h2>
            </div>

            <div className="grid grid-cols-1 gap-6">
              <GarmentMultiUploader
                label="소싱 의류 사진 (여러 장 등록 가능)"
                subLabel="정면, 측면, 세부 원단 등 상세할수록 좋습니다"
                images={garmentImages}
                onImagesChange={setGarmentImages}
                presetButtonText="샘플 의류 로드"
                onLoadPreset={handleLoadSampleGarment}
                badgeText="소싱 상품"
                badgeColor="bg-amber-100 text-amber-700"
              />
            </div>

            {/* 소싱 제품 상세 설정 */}
            <div className="bg-gray-50 border border-gray-200 rounded-2xl p-6 space-y-5">
              {/* 카테고리 선택 */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-700 flex items-center gap-1.5">
                  <span>🏷️</span>
                  <span>소싱 제품 카테고리</span>
                </label>
                <div className="grid grid-cols-5 gap-2">
                  {[
                    { id: 'top', label: '👕 상의', desc: 'T셔츠, 니트, 아우터 등' },
                    { id: 'bottom', label: '👖 하의', desc: '슬랙스, 청바지, 반바지 등' },
                    { id: 'shoes', label: '👟 신발', desc: '스니커즈, 샌들, 구두 등' },
                    { id: 'bag', label: '👜 가방', desc: '백팩, 숄더백, 보스턴백 등' },
                    { id: 'accessory', label: '💍 악세사리', desc: '팔찌, 목걸이, 선글라스 등' },
                  ].map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setGarmentCategory(cat.id as any)}
                      className={`py-3 rounded-xl border text-center transition-all ${
                        garmentCategory === cat.id
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

              {/* 세부 특징 설명 */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-700 flex items-center gap-1.5">
                  <span>✏️</span>
                  <span>세부 옷 특징 설명 (상세히 적을수록 분석이 정확해집니다)</span>
                </label>
                <textarea
                  value={garmentDetailsInput}
                  onChange={(e) => setGarmentDetailsInput(e.target.value)}
                  placeholder="예: 얇고 탄탄한 코튼 재질의 그레이 반팔티, 넥 라인과 소매 끝부분에 블랙 색상 시보리 배색 띠 디자인, 전면에 파란색 세련된 자동차 일러스트와 'MIDNIGHT RUN SEOUL CITY' 텍스트 빈티지 프린팅 나염 처리가 되어 있음."
                  rows={3}
                  className="w-full bg-white border border-gray-300 rounded-xl px-4 py-3 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-amber-500 transition resize-none leading-relaxed"
                />
              </div>

              {/* 참고 링크 */}
              <div className="space-y-2">
                <label className="text-xs font-bold text-gray-700 flex items-center gap-1.5">
                  <span>🔗</span>
                  <span>도매처 / 경쟁사 상세페이지 참고 링크 (선택)</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={sourceUrl}
                    onChange={(e) => setSourceUrl(e.target.value)}
                    placeholder="https://smartstore.naver.com/... 또는 도매처 링크"
                    className="flex-1 bg-white border border-gray-300 rounded-xl px-4 py-2.5 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-amber-500 font-mono transition"
                  />
                  {sourceUrl && (
                    <button
                      onClick={() => setSourceUrl('')}
                      className="px-3 rounded-xl bg-gray-100 hover:bg-gray-200 text-xs text-gray-500 hover:text-gray-900 transition"
                    >
                      ✕ 초기화
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* 생성 컷 수 설정 */}
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black text-amber-600 uppercase tracking-widest">Step 02</span>
              <h2 className="text-sm font-black text-gray-900">생성 컷 수 설정 (다중 포즈 선택)</h2>
            </div>
            <div className="bg-gray-50 border border-gray-200 rounded-2xl p-6 grid grid-cols-3 gap-6">
              {[
                { id: 'top', label: '👕 상의 위주 컷', val: topCount, setVal: setTopCount, desc: '상반신 클로즈업 및 핏 집중' },
                { id: 'bottom', label: '👖 하의 위주 컷', val: bottomCount, setVal: setBottomCount, desc: '허리부터 발목, 기장감 집중' },
                { id: 'fullbody', label: '🧍 전신 풀샷 컷', val: fullbodyCount, setVal: setFullbodyCount, desc: '177cm 머리-발끝 전체 비율 집중' },
              ].map((item) => (
                <div key={item.id} className="bg-white border border-gray-200 rounded-xl p-4 flex flex-col justify-between space-y-3">
                  <div>
                    <div className="text-xs font-bold text-gray-900">{item.label}</div>
                    <div className="text-[10px] text-gray-400 mt-1">{item.desc}</div>
                  </div>
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => item.setVal(Math.max(0, item.val - 1))}
                      className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 border border-gray-200 text-gray-900 font-bold flex items-center justify-center text-sm transition"
                    >
                      -
                    </button>
                    <span className="text-base font-black text-amber-600 w-6 text-center">{item.val}장</span>
                    <button
                      onClick={() => item.setVal(Math.min(4, item.val + 1))}
                      className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 border border-gray-200 text-gray-900 font-bold flex items-center justify-center text-sm transition"
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* 배경 선택 */}
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black text-amber-600 uppercase tracking-widest">Step 03</span>
              <h2 className="text-sm font-black text-gray-900">피팅 배경 선택 (선택 사항)</h2>
            </div>
            <div className="grid grid-cols-4 gap-4">
              {BACKGROUND_PRESETS.map((bg) => (
                <button
                  key={bg.id}
                  onClick={() => setSelectedBackground(bg.filename)}
                  className={`group relative aspect-[4/3] rounded-2xl overflow-hidden border-2 transition flex flex-col items-center justify-center p-2 text-center ${
                    selectedBackground === bg.filename
                      ? 'border-amber-400 bg-amber-50 shadow-sm'
                      : 'border-gray-200 bg-gray-50 hover:border-gray-300'
                  }`}
                >
                  {bg.url ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={bg.url} alt={bg.name} className="absolute inset-0 w-full h-full object-cover opacity-70 group-hover:opacity-90 transition-opacity duration-300" />
                      <div className="absolute inset-0 bg-black/40" />
                      <div className="relative z-10 text-xs font-bold text-white">{bg.name}</div>
                    </>
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-2">
                      <span className="text-2xl">⬜</span>
                      <div className="text-xs font-bold text-gray-700">{bg.name}</div>
                    </div>
                  )}
                  {selectedBackground === bg.filename && (
                    <div className="absolute top-2.5 right-2.5 z-20 w-5 h-5 rounded-full bg-amber-400 text-black flex items-center justify-center text-[10px] font-bold">
                      ✓
                    </div>
                  )}
                </button>
              ))}
            </div>
          </section>

          {/* 얼굴 노출 여부 토글 */}
          <section className="bg-gray-50 border border-gray-200 rounded-2xl p-5 flex items-center justify-between">
            <div>
              <div className="text-xs font-bold text-gray-900 flex items-center gap-1.5">
                <span>👦</span>
                <span>모델 얼굴 노출 설정</span>
              </div>
              <div className="text-[10px] text-gray-400 mt-1">
                기본은 얼굴 없는 크롭 컷입니다. 스튜디오 구도 상 얼굴이 꼭 나와야 자연스러운 경우에만 켜주세요.
              </div>
            </div>
            <button
              onClick={() => setGenerateFace(!generateFace)}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all border ${
                generateFace
                  ? 'bg-amber-50 border-amber-400 text-amber-700 shadow-sm'
                  : 'bg-white border-gray-200 text-gray-500 hover:text-gray-900'
              }`}
            >
              {generateFace ? '얼굴 노출 ON (얼굴 생성)' : '얼굴 제외 OFF (목 아래 크롭)'}
            </button>
          </section>

          {/* 프롬프트 에디터 */}
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black text-amber-600 uppercase tracking-widest">Step 04</span>
              <h2 className="text-sm font-black text-gray-900">스타일링 설정</h2>
            </div>
            <PromptEditor
              mode={activeMode}
              userAdditions={userAdditions}
              onUserAdditionsChange={setUserAdditions}
              garmentAnalysis={garmentAnalysis}
            />
          </section>

          {/* 실행 버튼 */}
          <section>
            <button
              onClick={handleRunFitting}
              disabled={isRunning || garmentImages.length === 0}
              className={`w-full py-5 rounded-2xl font-black text-base tracking-tight transition-all ${
                isRunning
                  ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                  : garmentImages.length === 0
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
                <span className="flex items-center justify-center gap-2">
                  ⚡ 멀티 포즈 AI 피팅 시작
                </span>
              )}
            </button>

            {/* 파이프라인 진행 표시기 */}
            {isRunning && (
              <div className="mt-4 flex items-center gap-4">
                {[
                  { key: 'analyzing', label: '1. Gemini 의류 분석', icon: '🔍' },
                  { key: 'fitting', label: '2. GPT-Image-2 피팅', icon: '🎨' },
                  { key: 'done', label: '3. 완료', icon: '✅' },
                ].map((s, i) => {
                  const stageOrder = ['analyzing', 'fitting', 'done'];
                  const currentIdx = stageOrder.indexOf(stage);
                  const stepIdx = stageOrder.indexOf(s.key);
                  const isDone = stepIdx < currentIdx || stage === 'done';
                  const isActive = stepIdx === currentIdx;
                  return (
                    <React.Fragment key={s.key}>
                      <div className={`flex items-center gap-2 text-xs font-bold transition-colors ${
                        isDone ? 'text-emerald-600' : isActive ? 'text-amber-600' : 'text-gray-300'
                      }`}>
                        <span>{s.icon}</span>
                        <span>{s.label}</span>
                        {isActive && <span className="w-3 h-3 border border-amber-500 border-t-transparent rounded-full animate-spin" />}
                      </div>
                      {i < 2 && <span className="text-gray-300">→</span>}
                    </React.Fragment>
                  );
                })}
              </div>
            )}
          </section>

          {/* 결과 뷰어 — 4장 포즈 그리드 */}
          {(batchImages.length > 0 || (isRunning && stage === 'fitting')) && (
            <section>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-black text-amber-600 uppercase tracking-widest">Step 05</span>
                  <h2 className="text-sm font-black text-gray-900">피팅 결과</h2>
                  {batchImages.length > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-[10px] font-bold">
                      {batchImages.length}장 완성
                    </span>
                  )}
                </div>
                {batchImages.length > 0 && (
                  <button
                    onClick={() => {
                      batchImages.forEach((img) => {
                        const a = document.createElement('a');
                        a.href = img.imageUrl;
                        a.download = `fitting_${img.poseId}_${Date.now()}.png`;
                        a.click();
                      });
                    }}
                    className="px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 border border-gray-200 text-xs text-gray-600 font-bold transition flex items-center gap-1.5"
                  >
                    ⬇ 전체 다운로드
                  </button>
                )}
              </div>

              <div className="grid grid-cols-4 gap-4">
                {isRunning && batchImages.length === 0
                  ? Array.from({ length: (topCount + bottomCount + fullbodyCount) || 2 }).map((_, i) => (
                      <div key={i} className="aspect-[2/3] bg-gray-50 rounded-2xl border border-gray-200 flex flex-col items-center justify-center gap-3">
                        <div className="w-8 h-8 border-2 border-amber-200 border-t-amber-500 rounded-full animate-spin" />
                        <div className="text-[10px] text-gray-400 font-bold">렌더링 중...</div>
                      </div>
                    ))
                  : batchImages.map((img, i) => (
                      <div
                        key={img.poseId}
                        className="group relative rounded-2xl overflow-hidden border border-gray-200 hover:border-amber-400 transition cursor-pointer shadow-sm"
                        onClick={() => setCurrentResult({ imageUrl: img.imageUrl, prompt: '', revisedPrompt: img.poseLabel })}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={img.imageUrl} alt={img.poseLabel} className="w-full aspect-[2/3] object-cover" />
                        <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent px-3 py-3">
                          <div className="text-[10px] font-bold text-white">{img.poseLabel}</div>
                          <div className="text-[9px] text-slate-300">#{i + 1}</div>
                        </div>
                        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition">
                          <a
                            href={img.imageUrl}
                            download={`fitting_${img.poseId}.png`}
                            onClick={(e) => e.stopPropagation()}
                            className="w-8 h-8 rounded-lg bg-black/60 backdrop-blur flex items-center justify-center text-sm hover:bg-amber-500/80 transition"
                          >
                            ⬇
                          </a>
                        </div>
                      </div>
                    ))
                }
              </div>

              {history.length > 4 && (
                <div className="mt-6">
                  <div className="text-[10px] font-black text-gray-400 uppercase tracking-widest mb-3">이전 세션 히스토리</div>
                  <div className="flex gap-3 overflow-x-auto pb-2">
                    {history.slice(4).map((item) => (
                      <button
                        key={item.id}
                        onClick={() => setCurrentResult({ imageUrl: item.imageUrl, prompt: item.prompt, revisedPrompt: item.revisedPrompt })}
                        className="flex-shrink-0 w-20 rounded-xl overflow-hidden border border-gray-200 hover:border-gray-300 transition"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={item.imageUrl} alt="" className="w-full aspect-[2/3] object-cover" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
        )}
      </main>

      <ApiKeyModal
        isOpen={isKeyModalOpen}
        onClose={() => setIsKeyModalOpen(false)}
        geminiKey={geminiKey}
        openaiKey={openaiKey}
        replicateKey={replicateKey}
        onSave={handleSaveKeys}
      />
    </div>
  );
}
