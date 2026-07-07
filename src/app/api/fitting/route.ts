/**
 * /api/fitting/route.ts
 * 통합 피팅 API: Gemini 의류 분석 → 상의/하의/전신 폴더의 참고 포즈 자동 스크래핑 & 분석 → GPT-Image-2로 가상 피팅 병렬 렌더링
 */

import { NextResponse } from 'next/server';
import OpenAI, { toFile } from 'openai';
import Replicate from 'replicate';
import fs from 'fs';
import path from 'path';
import { analyzeGarment, analyzePose, analyzeBackground } from '@/lib/garment-agent';
import { getCachedAnalysis, saveAnalysisToCache } from '@/lib/analysis-cache';
import { listModelPhotoNames, getModelPhotoBuffer, getModelPhotoBase64 } from '@/lib/model-photos';
import {
  buildFittingPromptWithPose,
  TOP_POSES,
  BOTTOM_POSES,
  FULLBODY_POSES,
  type FittingMode,
  type PoseVariation
} from '@/lib/fitting-prompts';

export const runtime = 'nodejs';
export const maxDuration = 120;

function parseBase64Image(dataUrl: string): { buffer: Buffer; mimeType: string } {
  if (dataUrl.startsWith('data:')) {
    const [header, data] = dataUrl.split(',');
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
    return { buffer: Buffer.from(data, 'base64'), mimeType };
  }
  return { buffer: Buffer.from(dataUrl, 'base64'), mimeType: 'image/jpeg' };
}

async function toOpenAIFile(buffer: Buffer, mimeType: string, name: string) {
  return await toFile(buffer, name, { type: mimeType });
}

// 로컬 이미지 파일을 base64로 로드
function getLocalFileAsBase64(filePath: string): string {
  const fileBuffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
}

// 사전 정의된 배경에 대한 설명 매핑 (Gemini Quota 절약용)
function getStaticBackgroundDescription(filename: string): string | null {
  const lower = filename.toLowerCase();
  if (lower.includes('02fa6e')) {
    return 'A minimalist modern indoor living room studio background with a light-grey fabric sofa, off-white walls, clean floor, and soft natural sunlight streaming from a window, casting realistic shadows.';
  }
  if (lower.includes('3dd746')) {
    return 'A cozy warm studio interior background with a cream-colored couch, soft warm ambient studio lighting, minimalist design, and elegant indoor aesthetics.';
  }
  if (lower.includes('gemini_generated')) {
    return 'A modern concrete studio interior background with clean concrete walls and floor, minimalist aesthetic, soft professional studio spotlighting, realistic shadow cast.';
  }
  return null;
}

// 로컬 이미지 파일을 OpenAI 전송용 Buffer 및 Mime Type으로 로드
function getLocalFileAsBuffer(filePath: string): { buffer: Buffer; mimeType: string } {
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return { buffer, mimeType };
}

// 단일 피팅 실행 태스크
async function runSingleFitting(
  openai: OpenAI,
  personBuf: Buffer,
  personMime: string,
  garmentBuf: Buffer,
  garmentMime: string,
  prompt: string,
): Promise<{ imageUrl: string; engineUsed: string }> {
  const size = '1024x1536';

  try {
    const personFile = await toOpenAIFile(personBuf, personMime, `model.${personMime.split('/')[1] || 'jpg'}`);
    const garmentFile = await toOpenAIFile(garmentBuf, garmentMime, `garment.${garmentMime.split('/')[1] || 'jpg'}`);

    const res = await (openai.images as any).edit({
      model: 'gpt-image-2',
      image: [personFile, garmentFile],
      prompt: prompt.slice(0, 4000),
      n: 1,
      size,
      quality: 'medium', // 'auto'(기본값)는 비용/시간이 크게 늘어남 — 커머셜 컷 용도로는 medium이면 충분
    });

    const item = res?.data?.[0];
    const imageUrl = item?.url || (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : '');
    if (!imageUrl) throw new Error('빈 이미지 응답');
    return { imageUrl, engineUsed: 'gpt-image-2 (multi-image edit)' };
  } catch {
    const personFile2 = await toOpenAIFile(personBuf, personMime, `model.${personMime.split('/')[1] || 'jpg'}`);
    const res2 = await (openai.images as any).edit({
      model: 'gpt-image-2',
      image: personFile2,
      prompt: prompt.slice(0, 4000),
      n: 1,
      size,
      quality: 'medium',
    });
    const item2 = res2?.data?.[0];
    const imageUrl = item2?.url || (item2?.b64_json ? `data:image/png;base64,${item2.b64_json}` : '');
    if (!imageUrl) throw new Error('가상 피팅 이미지 생성 최종 실패');
    return { imageUrl, engineUsed: 'gpt-image-2 (single-image edit)' };
  }
}

export async function POST(req: Request) {
  try {
    const {
      garmentImages,     // 소싱한 옷 이미지 배열
      openaiApiKey,
      geminiApiKey,
      replicateApiKey,
      sourceUrl,
      rawSpecs,
      userAdditions = '',
      topCount = 0,
      bottomCount = 0,
      fullbodyCount = 0,
      selectedBackground = null, // 선택된 배경 파일명 (선택)
      generateFace = false,      // 얼굴 노출 여부 (선택)
      garmentCategory,           // 소싱 제품 카테고리 (선택)
    } = await req.json();

    if (!garmentImages || garmentImages.length === 0) {
      return NextResponse.json({ error: '소싱한 의류 사진이 1장 이상 필요합니다.' }, { status: 400 });
    }

    const gKey = geminiApiKey || process.env.GEMINI_API_KEY;
    const oKey = openaiApiKey || process.env.OPENAI_API_KEY;
    const rKey = replicateApiKey || process.env.REPLICATE_API_TOKEN;

    if (!gKey) return NextResponse.json({ error: 'Gemini API 키가 없습니다.' }, { status: 400 });
    if (!oKey) return NextResponse.json({ error: 'OpenAI API 키가 없습니다.' }, { status: 400 });

    // ── 1. 기본 모델 사진 목록 로드 (로컬 우선, 없으면 Supabase Storage — 배포 환경 대응) ──────
    let modelFiles: string[] = [];
    try {
      modelFiles = await listModelPhotoNames();
    } catch (mfErr) {
      console.error('[Fitting] 모델 사진 목록 조회 실패:', mfErr);
    }

    if (modelFiles.length === 0) {
      return NextResponse.json({ error: '서버에 등록된 기본 피팅 모델 정보 사진이 없습니다.' }, { status: 500 });
    }

    // ── 2. 참고 포즈 디렉토리 로드 ─────────────────────────────────────
    const refDir = path.join(process.cwd(), 'public', 'reference_poses');
    const getRefFiles = (sub: string) => {
      const subDir = path.join(refDir, sub);
      if (!fs.existsSync(subDir)) return [];
      return fs.readdirSync(subDir)
        .filter(f => !f.startsWith('.') && /\.(png|jpe?g|webp)$/i.test(f))
        .map(f => path.join(subDir, f));
    };

    const topRefFiles = getRefFiles('상의');
    const bottomRefFiles = getRefFiles('하의');
    const fullbodyRefFiles = getRefFiles('전신');

    console.log(`[Fitting] 스크래핑된 포즈 개수 - 상의: ${topRefFiles.length}, 하의: ${bottomRefFiles.length}, 전신: ${fullbodyRefFiles.length}`);

    // ── 3. 배경 이미지 분석 (선택된 배경이 있을 경우 1회 실행) ────────────────
    let customBackgroundDesc: string | undefined = undefined;
    if (selectedBackground) {
      const bgPath = path.join(process.cwd(), 'public', 'backgrounds', selectedBackground);
      if (fs.existsSync(bgPath)) {
        try {
          // (a) 사전 정의된 정적 배경 매핑 시도
          const staticBgDesc = getStaticBackgroundDescription(selectedBackground);
          if (staticBgDesc) {
            console.log('[BackgroundAgent] 사전 정의된 정적 배경 설명 사용:', selectedBackground);
            customBackgroundDesc = staticBgDesc;
          } else {
            // (b) 모르는 배경인 경우 캐시 또는 Gemini 분석
            const cachedBg = getCachedAnalysis(bgPath);
            if (cachedBg) {
              console.log('[BackgroundAgent] 캐시된 배경 분석 데이터 사용');
              customBackgroundDesc = cachedBg;
            } else {
              console.log('[BackgroundAgent] 배경 이미지 분석 중:', selectedBackground);
              const bgB64 = getLocalFileAsBase64(bgPath);
              customBackgroundDesc = await analyzeBackground(bgB64, gKey, oKey);
              saveAnalysisToCache(bgPath, customBackgroundDesc);
              console.log('[BackgroundAgent] 배경 분석 성공 및 캐시 저장 완료:', customBackgroundDesc);
            }
          }
        } catch (bge) {
          console.warn('[BackgroundAgent] 배경 분석 실패, 흰색 스튜디오 기본값 폴백:', bge);
          customBackgroundDesc = 'A clean minimalist white studio background with soft professional lighting.';
        }
      }
    }

    // ── 4. Gemini 의류 공통 분석 ─────────────────────────────────────
    console.log('[Fitting] 의류 분석 시작...');
    let garmentAnalysis;
    try {
      garmentAnalysis = await analyzeGarment(garmentImages, gKey, sourceUrl, rawSpecs, garmentCategory, oKey);
    } catch (err) {
      console.warn('[Fitting] Gemini 의류 분석 429/할당량 초과 오류 감지, 입력 데이터 기반 템플릿 폴백 진입:', err);
      // Gemini 장애/할당량 초과 시 정적 템플릿 대체 (OpenAI 단독 렌더링 유지)
      garmentAnalysis = {
        color: 'as described by the user or shown in the image',
        material: 'high-quality fabric',
        fitType: (garmentCategory === 'bottom' ? 'wide-leg' : 'regular') as any,
        category: garmentCategory || 'top',
        details: rawSpecs || 'as shown in the reference garment photo',
        texture: 'soft hand feel fabric',
        lightReaction: 'matte finish'
      };
    }
    console.log('[Fitting] 분석 완료:', garmentAnalysis);

    // ── 5. 생성할 타겟 태스크 설정 ─────────────────────────────────────
    const tasksToGenerate: Array<{
      mode: FittingMode;
      modelPath: string;
      refPosePath?: string;
      defaultPose: PoseVariation;
      label: string;
    }> = [];

    // 상의 컷
    for (let i = 0; i < topCount; i++) {
      const baseModels = modelFiles.filter(f => /1\.png|2\.png|8\.jpg/i.test(f));
      const modelPath = baseModels.length > 0 ? baseModels[i % baseModels.length] : modelFiles[i % modelFiles.length];
      const refPosePath = topRefFiles.length > 0 ? topRefFiles[i % topRefFiles.length] : undefined;

      tasksToGenerate.push({
        mode: 'top',
        modelPath,
        refPosePath,
        defaultPose: TOP_POSES[i % TOP_POSES.length],
        label: `상의 포즈 #${i + 1}`,
      });
    }

    // 하의 컷
    for (let i = 0; i < bottomCount; i++) {
      const baseModels = modelFiles.filter(f => /7\.png|3\.png|1\.png/i.test(f));
      const modelPath = baseModels.length > 0 ? baseModels[i % baseModels.length] : modelFiles[i % modelFiles.length];
      const refPosePath = bottomRefFiles.length > 0 ? bottomRefFiles[i % bottomRefFiles.length] : undefined;

      tasksToGenerate.push({
        mode: 'bottom',
        modelPath,
        refPosePath,
        defaultPose: BOTTOM_POSES[i % BOTTOM_POSES.length],
        label: `하의 포즈 #${i + 1}`,
      });
    }

    // 전신 컷
    for (let i = 0; i < fullbodyCount; i++) {
      const baseModels = modelFiles.filter(f => /7\.png|8\.jpg|5\.webp/i.test(f));
      const modelPath = baseModels.length > 0 ? baseModels[i % baseModels.length] : modelFiles[i % modelFiles.length];
      const refPosePath = fullbodyRefFiles.length > 0 ? fullbodyRefFiles[i % fullbodyRefFiles.length] : undefined;

      tasksToGenerate.push({
        mode: 'fullbody',
        modelPath,
        refPosePath,
        defaultPose: FULLBODY_POSES[i % FULLBODY_POSES.length],
        label: `전신 포즈 #${i + 1}`,
      });
    }

    // 아무 옵션도 없으면 상의 1, 전신 1 (4장이면 로컬 테스트로도 93초 걸려 Vercel 서버리스
    // 시간 제한(특히 Hobby 플랜 60초 하드캡)을 넘기기 쉬움 — 기본값을 줄여 타임아웃 위험을 낮춤)
    if (tasksToGenerate.length === 0) {
      const defaultPlans = [
        { mode: 'top' as const, model: '1.png', pose: TOP_POSES[0], ref: topRefFiles[0], label: '상의 포즈 #1' },
        { mode: 'fullbody' as const, model: '7.png', pose: FULLBODY_POSES[0], ref: fullbodyRefFiles[0], label: '전신 포즈 #1' },
      ];
      for (const plan of defaultPlans) {
        const matchingModel = modelFiles.find(f => f.endsWith(plan.model)) || modelFiles[0];
        tasksToGenerate.push({
          mode: plan.mode,
          modelPath: matchingModel,
          refPosePath: plan.ref,
          defaultPose: plan.pose,
          label: plan.label,
        });
      }
    }

    // ── 5.5. 포즈 이미지 사전 분석 (순차 처리하여 429 방지 및 캐싱 극대화) ─────────
    console.log('[PoseAgent] 포즈 이미지 사전 분석 시작...');
    const poseInstructionsMap = new Map<string, string>();

    for (const task of tasksToGenerate) {
      if (task.refPosePath && fs.existsSync(task.refPosePath)) {
        const refPath = task.refPosePath;
        if (poseInstructionsMap.has(refPath)) continue;

        try {
          const cachedPose = getCachedAnalysis(refPath);
          if (cachedPose) {
            console.log(`[PoseAgent] 캐시 히트: ${path.basename(refPath)}`);
            poseInstructionsMap.set(refPath, `Pose reference description: ${cachedPose}`);
          } else {
            console.log(`[PoseAgent] 캐시 미스 - 순차 분석 실행: ${path.basename(refPath)}`);
            const poseB64 = getLocalFileAsBase64(refPath);
            const analyzedPoseText = await analyzePose(poseB64, gKey, oKey);
            saveAnalysisToCache(refPath, analyzedPoseText);
            poseInstructionsMap.set(refPath, `Pose reference description: ${analyzedPoseText}`);
            // API 호출 간 대기시간 (안전장치)
            await new Promise(resolve => setTimeout(resolve, 800));
          }
        } catch (pe) {
          console.warn(`[PoseAgent] 포즈 분석 오류 (429/할당량 초과), 기본 포즈 설명어 사용:`, pe);
          // 실패 시 기본 포즈 설명어로 안전 폴백
          poseInstructionsMap.set(refPath, task.defaultPose.poseInstruction);
        }
      }
    }

    // ── 6. 병렬 태스크 실행 (GPT-Image-2 이미지 생성) ─────────
    console.log(`[Fitting] 총 ${tasksToGenerate.length}개 태스크 빌드 완료. 이미지 병렬 생성 시작...`);
    const openai = new OpenAI({ apiKey: oKey });
    const { buffer: garmentBuf, mimeType: garmentMime } = parseBase64Image(garmentImages[0]); // 첫 번째 의류 이미지를 메인 텍스처 레퍼런스로 사용

    const results = await Promise.allSettled(
      tasksToGenerate.map(async (task, idx) => {
        // (a) 베이스 모델 버퍼 로드 및 기본 메타데이터 설정 (로컬 우선, 없으면 Supabase)
        const { buffer: personBuf, mimeType: personMime } = await getModelPhotoBuffer(task.modelPath);

        // (b) 사전 분석된 포즈 설명 가져오기
        let poseInstruction = task.defaultPose.poseInstruction;
        if (task.refPosePath && poseInstructionsMap.has(task.refPosePath)) {
          poseInstruction = poseInstructionsMap.get(task.refPosePath)!;
        }

        // (c) 최종 포즈 객체 정의
        const customPose: PoseVariation = {
          id: task.refPosePath ? path.basename(task.refPosePath) : task.defaultPose.id,
          label: task.label,
          poseInstruction,
        };

        // ── 6.5. Replicate IDM-VTON 피팅 엔진 가동 (Replicate API 키 입력 및 의류 카테고리인 경우) ──
        const isVtonSupported = ['top', 'bottom', 'outer', 'dress'].includes(garmentCategory || '');

        if (rKey && isVtonSupported) {
          console.log(`[Fitting] [Replicate IDM-VTON] 가상 피팅 실행 시작: ${task.label}`);
          try {
            const replicate = new Replicate({ auth: rKey });
            
            // 베이스 모델 및 소싱 옷 이미지 base64 로드
            const humanImgB64 = await getModelPhotoBase64(task.modelPath);
            const garmentImgB64 = garmentImages[0];
            
            // 카테고리 매핑: top/outer -> upper_body, bottom -> lower_body
            const replicateCategory = garmentCategory === 'bottom' ? 'lower_body' : 'upper_body';

            const output = await replicate.run(
              "cuuupid/idm-vton:c871bb9b046607b680449ecbae55fd8c6d945e0a1948644bf2361b3d021d3ff4",
              {
                input: {
                  garm_img: garmentImgB64,
                  human_img: humanImgB64,
                  garment_des: garmentAnalysis.details || garmentCategory || 'apparel',
                  category: replicateCategory,
                  crop: true,
                  steps: 30,
                }
              }
            );

            const imageUrl = Array.isArray(output) ? output[0] : (typeof output === 'string' ? output : '');
            if (!imageUrl) throw new Error('Replicate VTON 결과 URL 생성 실패');

            console.log(`[Fitting] [Replicate IDM-VTON] 성공: ${task.label} -> ${imageUrl}`);
            return {
              imageUrl,
              engineUsed: 'Replicate IDM-VTON (High-Fidelity Virtual Try-On)',
              poseId: customPose.id,
              poseLabel: `[${task.mode === 'top' ? '상의' : task.mode === 'bottom' ? '하의' : '전신'}] ${task.label}`,
              prompt: `VTON Category: ${replicateCategory}, Description: ${garmentAnalysis.details}`,
              mode: task.mode,
            };
          } catch (vtonError: any) {
            console.error('[Fitting] Replicate VTON 실패, DALL-E로 폴백 실행:', vtonError.message || vtonError);
            // VTON 에러 시 DALL-E 3로 자동 폴백해서 렌더링 유지
          }
        }

        // ── 7. OpenAI DALL-E 이미지 렌더링 실행 (기본 또는 폴백) ──────────────────
        const finalPrompt = buildFittingPromptWithPose(
          task.mode,
          garmentAnalysis,
          customPose,
          userAdditions,
          customBackgroundDesc,
          generateFace
        );

        const output = await runSingleFitting(openai, personBuf, personMime, garmentBuf, garmentMime, finalPrompt);

        return {
          ...output,
          poseId: customPose.id,
          poseLabel: `[${task.mode === 'top' ? '상의' : task.mode === 'bottom' ? '하의' : '전신'}] ${task.label}`,
          prompt: finalPrompt,
          mode: task.mode,
        };
      })
    );

    const images = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map((r) => r.value);

    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason?.message || '알 수 없는 오류');

    if (images.length === 0) {
      throw new Error(`모든 이미지 렌더링에 실패했습니다. 오류: ${errors.join(', ')}`);
    }

    return NextResponse.json({
      success: true,
      images,
      garmentAnalysis,
      totalGenerated: images.length,
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (err: any) {
    console.error('[Fitting API Error]', err);
    return NextResponse.json(
      { error: err?.error?.message || err.message || '피팅 처리 중 오류가 발생했습니다.' },
      { status: 500 }
    );
  }
}
