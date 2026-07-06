# 논피팅 (Nonfitting) 스튜디오 서비스 개요

이 문서는 **논피팅(Nonfitting) 스튜디오** 서비스의 아키텍처, 핵심 기능 흐름, 기술 스택 및 디렉토리 구조를 정리한 개발 가이드입니다. 다른 AI 에이전트(예: Claude)나 신규 개발자가 프로젝트의 전체 맥락을 빠르게 이해하고 즉시 작업에 참여할 수 있도록 돕기 위해 작성되었습니다.

---

## 1. 서비스 소개 및 비즈니스 목적

* **서비스명**: 논피팅(Nonfitting) 스튜디오
* **주요 기능**: 의류 쇼핑몰 판매자가 소싱한 옷 이미지(혹은 상세 페이지 URL)를 등록하면, AI가 원단·핏·디테일을 분석하고 가상 피팅 모델의 포즈에 맞춰 자연스럽게 매칭된 고품질 **룩북 화보(가상 피팅) 이미지**를 자동으로 멀티 포즈 생성해 주는 솔루션입니다.
* **해결하는 문제**: 
  * 모델 촬영 비용 및 스튜디오 대관 비용 절감
  * 소싱 단계에서 상세페이지용 고품질 피팅 이미지(상의, 하의, 전신 컷 등)를 빠르게 확보
  * 텍스처와 원단의 물리적 특징(세로 골지, 리브 드레스, 워싱 등)을 높은 품질로 보존하는 가상 시착(Virtual Try-On) 제공

---

## 2. 핵심 기술 스택 (Tech Stack)

### 프론트엔드 및 프레임워크
* **Next.js** (v16.2.9, App Router)
* **React** (v19.2.4)
* **TypeScript**
* **Tailwind CSS v4** (기반 디자인 및 레이아웃 구현)

### AI 및 외부 연동 API
* **Google Gemini API** (`@google/genai` v2.10.0 / `gemini-2.5-flash`):
  * 의류 사진의 세부 원단/색상/디테일 분석 (`analyzeGarment`)
  * 레퍼런스 포즈 및 배경 이미지 분석 (`analyzePose`, `analyzeBackground`)
* **OpenAI API** (`openai` v6.45.0):
  * **GPT-4o-mini 비전**: Gemini API 429 Rate Limit(할당량 초과) 발생 시 백업용 비전 분석기로 자동 폴백
  * **GPT-Image-2 Edit API**: 베이스 모델 이미지와 소싱 의류 이미지를 합성하여 피팅 이미지 생성 (`runSingleFitting` / `dall-e-2` fallback 포함)
* **Replicate IDM-VTON API** (`cuuupid/idm-vton` 모델):
  * 상의/하의/아우터/드레스 등 가상 피팅 지원 카테고리에 대해 고정밀 가상 시착(Virtual Try-On)을 수행하는 최우선 엔진
  * Replicate 키가 없거나 합성에 실패하면 DALL-E(GPT-Image-2 Edit)로 자동 폴백

---

## 3. 핵심 기능 아키텍처 및 흐름

서비스는 크게 **의류 정보 수집 및 분석**, **레퍼런스 준비 및 캐싱**, **병렬 가상 피팅 및 이미지 렌더링**의 3단계로 이루어집니다.

```mermaid
graph TD
    A[사용자: 의류 이미지 업로드 & 링크/스펙 입력] --> B(API: /api/fitting 호출)
    B --> C{의류 분석 - Gemini 2.5 Flash}
    C -- 429/에러 발생 시 -- > C_Fallback[OpenAI GPT-4o-mini 분석 폴백]
    C --> D[의류 세부 스펙 JSON 도출]
    
    D --> E[포즈 및 배경 스크래핑]
    E --> F{분석 캐시 존재 여부?}
    F -- Yes -- > G[캐시된 설명 로드]
    F -- No -- > H[Gemini 2.5 Flash 분석 후 캐시 저장]
    
    G --> I[병렬 렌더링 태스크 구성 - 상의/하의/전신]
    H --> I
    
    I --> J{Replicate IDM-VTON 사용 가능?}
    J -- Yes - 지원 카테고리 -- > K[IDM-VTON 기반 고정밀 피팅]
    J -- No - 미지원 카테고리 또는 실패 -- > L[OpenAI gpt-image-2 Edit DALL-E 렌더링]
    
    K --> M[최종 멀티 컷 이미지 완성 및 다운로드]
    L --> M
```

### [1단계] 의류 정밀 분석 (Garment Analysis)
* 소싱 등록한 의류 이미지(다중 업로드 가능)와 도매처/경쟁사 URL 및 상세 스펙 텍스트를 인풋으로 받습니다.
* **URL 스크래핑**: 입력된 도매처 URL에서 HTML을 가져와 태그를 제거하고 텍스트 정보만 정제하여 Gemini에 분석 힌트로 제공합니다.
* **의류 분석**: `analyzeGarment`를 통해 원단의 질감, 광택, 디테일 장식, 카테고리를 면밀히 분석해 영어 프롬프트용 JSON 데이터를 출력합니다.

### [2단계] 포즈/배경 정보 준비 및 로컬 캐싱
* `/public/reference_poses/` 디렉토리 하위의 상의, 하의, 전신 디렉토리 내의 포즈 이미지 목록을 활용합니다.
* **로컬 파일 기반 분석 캐싱**: API 호출 수 및 할당량을 보존하기 위해 포즈 및 배경 이미지의 비전 분석 결과를 `src/lib/analysis-cache.json`에 영구적으로 보존하여 동일 이미지 분석 시 재사용합니다.

### [3단계] 병렬 가상 피팅 생성 (Multi-Pose AI Fitting / Virtual Try-On)
* 상의 컷, 하의 컷, 전신 컷 요청 개수만큼 루프를 돌며 병렬로 이미지 생성을 처리합니다.
* **IDM-VTON (Replicate)**: 실제 의류 착용 느낌을 보존하는 데 가장 유리하므로 상의, 하의, 아우터, 드레스 등 가상 피팅이 가능한 카테고리에 대해 IDM-VTON을 1순위로 호출합니다.
* **DALL-E 3/GPT-Image-2 Edit (OpenAI)**: IDM-VTON이 미지원하는 카테고리(신발, 액세서리 등)이거나 합성 도중 오류 발생 시, Gemini 분석 데이터를 조합한 상세 프롬프트를 빌드하여 DALL-E `edit` API로 합성 및 렌더링을 진행합니다.

---

## 4. 디렉토리 구조 및 주요 소스코드 가이드

```
📁 프로젝트 루트
 ├── 📁 src
 │    ├── 📁 types
 │    │    └── 📄 fitting.ts         # 공통 타입 정의 (Gender, UserInfo, FittingState 등)
 │    ├── 📁 context
 │    │    └── 📄 FittingContext.tsx # 전역 가상 피팅 상태 관리 컨텍스트
 │    ├── 📁 lib
 │    │    ├── 📄 garment-agent.ts      # Gemini/OpenAI Vision 기반 의류, 포즈, 배경 분석 로직
 │    │    ├── 📄 fitting-prompts.ts    # 포즈 사양 정의 및 프롬프트 빌더
 │    │    ├── 📄 analysis-cache.ts     # 로컬 파일(JSON) 기반 분석 캐싱 모듈
 │    │    └── 📄 analysis-cache.json   # 실제 포즈/배경 비전 분석 결과 캐시 데이터
 │    ├── 📁 components/studio
 │    │    ├── 📄 Sidebar.tsx         # 스튜디오 메인 레이아웃 사이드바
 │    │    ├── 📄 GarmentMultiUploader.tsx # 의류 다중 이미지 드래그앤드롭 업로더
 │    │    ├── 📄 PromptEditor.tsx    # 스타일 가이드 및 디테일 입력 영역
 │    │    ├── 📄 FittingResultViewer.tsx # 생성 완료된 멀티포즈 이미지 뷰어
 │    │    └── 📄 ApiKeyModal.tsx     # Gemini, OpenAI, Replicate API Key 입력창
 │    └── 📁 app
 │         ├── 📄 page.tsx                  # 스튜디오 대시보드 메인 클라이언트 페이지
 │         └── 📁 api
 │              ├── 📁 analyze
 │              │    └── 📄 route.ts   # 착장(인물) + 옷 이미지 단발성 분석 API
 │              ├── 📁 generate
 │              │    └── 📄 route.ts  # 착장 + 옷 이미지 단발성 피팅/합성 API
 │              └── 📁 fitting
 │                   └── 📄 route.ts   # 다중 컷 피팅/가상피팅 자동화 통합 백엔드 API
```

---

## 5. 추가 개발 및 고도화 가이드 (Claude 공유용 팁)

1. **VTON 모델과 DALL-E의 최적 배합**:
   * IDM-VTON은 실제 옷 질감을 그대로 투사하지만, 신발이나 가방, 액세서리 등이 레이아웃에 섞여 있을 때 혹은 배경 합성이 자연스러워야 할 때는 OpenAI DALL-E `gpt-image-2`가 더 자연스러운 룩북 화보를 그릴 수 있습니다.
   * `garmentCategory`가 `shoes`, `bag`, `accessory` 등인 경우에는 기본적으로 DALL-E 렌더링을 활용하도록 분기되어 있습니다.

2. **할당량(Rate Limit) 방어**:
   * Gemini 2.5 Flash API는 여러 장의 고해상도 이미지를 병렬로 분석할 때 429 Resource Exhausted 에러가 자주 발생합니다.
   * 이를 방지하기 위해 `src/lib/garment-agent.ts`에 `retryOn429` 재시도 로직이 적용되어 있고, 포즈 이미지 사전 분석 시 순차 처리(Sequential loop)와 대기시간(800ms)을 두어 API 과부하를 회피하고 있습니다.

3. **캐싱 활용**:
   * 새로운 포즈 이미지나 배경 이미지를 추가할 경우, `src/lib/analysis-cache.json`에 분석 결과가 누적됩니다.
   * 로컬에서 추가 모델 포즈나 배경 프리셋을 등록하는 경우, 분석 결과 캐시가 갱신되도록 구성되어 있으므로 캐시 파일의 Git 관리 여부를 상황에 맞게 조율해야 합니다.
