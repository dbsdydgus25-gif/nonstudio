// ======================================================
// AI 가상 피팅 위젯 - 공통 타입 정의
// ======================================================

/** 사용자의 성별 */
export type Gender = 'male' | 'female';

/** 위젯 단계: IDLE(미세팅) → SETTING(체형 입력) → GENERATING(아바타 생성 중) → FITTING(피팅룸) */
export type WidgetStep = 'IDLE' | 'SETTING' | 'GENERATING' | 'FITTING';

/** 유저 체형 정보 */
export interface UserInfo {
  gender: Gender;
  height: number;        // cm
  weight: number;        // kg
  originalImageUrl: string | null;  // 업로드된 전신 사진의 ObjectURL
  originalImageFile: File | null;
}

/** 장바구니 상품 아이템 */
export interface CartItem {
  id: string;
  name: string;
  brand: string;
  price: number;
  imageUrl: string;
  category: 'top' | 'bottom' | 'outer' | 'dress' | 'shoes';
}

/** Mock API: 아바타 생성 요청 body */
export interface AvatarRequest {
  gender: Gender;
  height: number;
  weight: number;
  imageBase64?: string;
}

/** Mock API: 아바타 생성 응답 */
export interface AvatarResponse {
  avatarUrl: string;
  jobId: string;
}

/** Mock API: VTON 합성 요청 body */
export interface VtonRequest {
  avatarUrl: string;
  garmentImageUrl: string;
  category: CartItem['category'];
}

/** Mock API: VTON 합성 응답 */
export interface VtonResponse {
  resultUrl: string;
  jobId: string;
}

/** FittingContext에서 관리하는 전역 상태 */
export interface FittingState {
  isOpen: boolean;
  step: WidgetStep;
  userInfo: UserInfo;
  baseAvatarUrl: string | null;
  humanImageBase64: string | null;  // Replicate VTON에 전달할 사용자 사진 base64
  fittingResultUrl: string | null;
  activeFittingItemId: string | null;  // 현재 피팅 중인 아이템 ID
  isGenerating: boolean;
  cartItems: CartItem[];
  error: string | null;
}
