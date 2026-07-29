/**
 * /api/lookbook/batch
 * AI 룩북 2단계 — 1단계에서 승인한 "사람 없는 깨끗한 기준컷"을 제품 근거로, 등록된 가상 모델에게
 * 옷을 입혀 선택한 포즈 프리셋 개수만큼 한 번에 생성한다.
 *
 * 기존 파이프라인과 동일한 비동기 패턴: pending 행 생성 → id 즉시 반환 → after()에서 실제 생성
 * → 프론트가 /api/generations/status 폴링.
 */
import { NextResponse, after } from 'next/server';
import OpenAI from 'openai';
import { buildLookbookFittingPrompt, type CleanAngle } from '@/lib/lookbook-prompts';
import type { GarmentAnalysis, SourcedCategory } from '@/lib/fitting-prompts';
import {
  createPendingGeneration,
  markGenerationCompleted,
  markGenerationFailed,
  isGenerationCanceled,
} from '@/lib/generation-store';
import { getDefaultBackgroundReferenceImage } from '@/lib/background-reference';
import { getModelProfile, getModelIdentityImage, buildBodySpecFromProfile } from '@/lib/model-profile';
import { getPosePresetRefImage, listPosePresets } from '@/lib/pose-presets';
import { getSessionUserId } from '@/lib/auth';
import { downscaleImage, runWithConcurrency } from '@/lib/image-utils';
import { parseBase64Image, resultImageToBuffer, runGptImageEdit } from '@/lib/gpt-image-edit';

export const runtime = 'nodejs';
export const maxDuration = 280;

/**
 * 대표컷 외에 함께 넣는 기준컷 수. AI 제품 피팅에서는 이 값이 2였는데(스크래핑 사진을 여러 장
 * 밀어넣으면 서로 다른 컷이 뒤섞여 "완전히 다른 옷"이 나오는 사고가 있었다), 여기 들어가는
 * 4컷은 우리가 같은 스펙으로 생성한 동일 제품·동일 색상의 깨끗한 컷이라 그 위험이 훨씬 낮다.
 * 뒷모습 포즈에 뒷면 근거가 없으면 지어내므로 3장(뒤/좌/우)까지 허용한다.
 */
const MAX_EXTRA_REFERENCES = 3;
const ANGLE_ORDER: CleanAngle[] = ['front', 'back', 'left', 'right'];

export async function POST(req: Request) {
  try {
    const uid = await getSessionUserId();
    if (!uid) return NextResponse.json({ success: false, error: '로그인이 필요합니다.' }, { status: 401 });

    const {
      referenceImages,
      garmentAnalysis,
      category,
      presetIds,
      openaiApiKey,
      colorOverride,
      draftMode,
    }: {
      /** 1단계에서 승인한 각도별 기준컷 (base64 data URL) */
      referenceImages: Partial<Record<CleanAngle, string>>;
      garmentAnalysis: GarmentAnalysis;
      category: SourcedCategory;
      presetIds: string[];
      openaiApiKey: string;
      colorOverride?: string;
      draftMode?: boolean;
    } = await req.json();

    const orderedRefs = ANGLE_ORDER.map((a) => referenceImages?.[a]).filter((x): x is string => !!x);
    if (orderedRefs.length === 0) {
      return NextResponse.json(
        { success: false, error: '기준컷이 없습니다. 1단계를 먼저 완료해주세요.' },
        { status: 400 },
      );
    }
    if (!presetIds?.length) {
      return NextResponse.json({ success: false, error: '포즈 프리셋을 하나 이상 선택해주세요.' }, { status: 400 });
    }
    if (!openaiApiKey) {
      return NextResponse.json({ success: false, error: 'OpenAI API 키가 없습니다.' }, { status: 400 });
    }

    const allPresets = await listPosePresets(uid);
    const selected = presetIds
      .map((id) => allPresets.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => !!p);
    if (selected.length === 0) {
      return NextResponse.json({ success: false, error: '선택한 포즈 프리셋을 찾지 못했습니다.' }, { status: 400 });
    }

    // 프리셋마다 pending 행을 만들어 id를 즉시 반환 — 실제 생성은 아래 after()에서.
    const jobs = await Promise.all(
      selected.map(async (preset) => ({
        preset,
        generationId: await createPendingGeneration({
          pipeline: 'restyle',
          modeOrCategory: 'lookbook',
          poseLabel: preset.name,
          prompt: '',
        }),
      })),
    );

    after(async () => {
      const openai = new OpenAI({ apiKey: openaiApiKey });

      // 공통 자원(배경/모델)을 먼저 준비 — 여기서 실패하면 모든 job을 명확한 사유로 실패
      // 처리한다(예전에 이 구간이 보호되지 않아 pending이 영원히 남는 사고가 있었다).
      let backgroundReferenceImage: { buffer: Buffer; mimeType: string } | null = null;
      let identityReferenceImage: { buffer: Buffer; mimeType: string } | null = null;
      let bodySpec = '';
      let primaryRef = '';
      let extraRefs: Array<{ buffer: Buffer; mimeType: string }> = [];

      try {
        const rawBackground = getDefaultBackgroundReferenceImage();
        backgroundReferenceImage = rawBackground
          ? await downscaleImage(rawBackground.buffer, rawBackground.mimeType)
          : null;

        const modelProfile = await getModelProfile(uid);
        const rawIdentity = await getModelIdentityImage(uid);
        identityReferenceImage = rawIdentity ? await downscaleImage(rawIdentity.buffer, rawIdentity.mimeType) : null;
        // 등록된 얼굴을 못 읽어오면 조용히 진행하지 않는다 — 다른 사람 얼굴로 생성되어 비용만 날린다.
        if (!identityReferenceImage) {
          throw new Error(
            '등록된 모델 참고 사진을 불러오지 못해 생성을 중단했습니다. "모델 정보" 페이지에서 참고 사진이 정상 저장돼 있는지 확인한 뒤 다시 시도해주세요.',
          );
        }
        bodySpec = buildBodySpecFromProfile(modelProfile);

        primaryRef = orderedRefs[0];
        extraRefs = await Promise.all(
          orderedRefs.slice(1, 1 + MAX_EXTRA_REFERENCES).map(async (b64) => {
            const parsed = parseBase64Image(b64);
            return downscaleImage(parsed.buffer, parsed.mimeType);
          }),
        );
      } catch (prepErr: any) {
        const msg = prepErr?.message || '생성 준비 중 오류가 발생했습니다.';
        console.error('[api/lookbook/batch][after] 준비 실패 — 전체 job 실패 처리:', prepErr);
        await Promise.all(jobs.map((j) => markGenerationFailed(j.generationId, msg)));
        return;
      }

      await runWithConcurrency(jobs, 2, async ({ preset, generationId }) => {
        try {
          if (await isGenerationCanceled(generationId)) return;

          const rawPoseRef = preset.hasRefImage ? await getPosePresetRefImage(uid, preset.id) : null;
          const poseRefImage = rawPoseRef ? await downscaleImage(rawPoseRef.buffer, rawPoseRef.mimeType) : null;

          const prompt = buildLookbookFittingPrompt(category, garmentAnalysis, preset.poseInstruction, bodySpec, {
            extraReferenceCount: extraRefs.length,
            hasPoseRefImage: !!poseRefImage,
            hasBackgroundImage: !!backgroundReferenceImage,
            colorOverride,
          });

          // 이미지 순서는 buildLookbookFittingPrompt의 번호 계산과 반드시 일치해야 한다:
          // [identity, 대표 기준컷, 나머지 기준컷…, 포즈 참고, 배경]
          // 포즈 참고는 styleReferenceImages 슬롯을 빌려 쓴다(그 슬롯이 배경 바로 앞이라 순서가 맞다).
          const imageUrl = await runGptImageEdit(
            openai,
            primaryRef,
            prompt,
            identityReferenceImage,
            backgroundReferenceImage,
            draftMode ? 'low' : 'medium',
            extraRefs,
            [],
            poseRefImage ? [poseRefImage] : [],
          );

          const { buffer, mimeType } = await resultImageToBuffer(imageUrl);
          await markGenerationCompleted(generationId, { outputBuffer: buffer, outputMimeType: mimeType, prompt });
        } catch (err: any) {
          console.error(`[api/lookbook/batch][after] "${preset.name}" 생성 실패:`, err);
          await markGenerationFailed(generationId, err?.message || '생성 중 오류가 발생했습니다.');
        }
      });
    });

    return NextResponse.json({
      success: true,
      jobs: jobs.map((j) => ({ generationId: j.generationId, presetId: j.preset.id, label: j.preset.name })),
    });
  } catch (err: any) {
    console.error('[api/lookbook/batch] 처리 실패:', err);
    return NextResponse.json(
      { success: false, error: err?.message || '배치 생성 중 오류가 발생했습니다.' },
      { status: 500 },
    );
  }
}
