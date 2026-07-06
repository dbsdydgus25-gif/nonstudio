'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useReducer,
} from 'react';
import {
  CartItem,
  FittingState,
  UserInfo,
  WidgetStep,
} from '@/types/fitting';

// ======================================================
// 초기 상태
// ======================================================
const initialUserInfo: UserInfo = {
  gender: 'female',
  height: 165,
  weight: 55,
  originalImageUrl: null,
  originalImageFile: null,
};

/**
 * 데모용 장바구니 더미 데이터
 * IDM-VTON은 단일 의류 상품 이미지(흰 배경 또는 행거)에서 최적 결과를 냅니다.
 */
const DEMO_CART_ITEMS: CartItem[] = [
  {
    id: 'item-1',
    name: '오버사이즈 린넨 셔츠',
    brand: 'MANGO',
    price: 59000,
    imageUrl: 'https://images.unsplash.com/photo-1598033129183-c4f50c736f10?w=600&q=80',
    category: 'top',
  },
  {
    id: 'item-2',
    name: '와이드 데님 팬츠',
    brand: 'ZARA',
    price: 79000,
    imageUrl: 'https://images.unsplash.com/photo-1542272604-787c3835535d?w=600&q=80',
    category: 'bottom',
  },
  {
    id: 'item-3',
    name: '크롭 니트 가디건',
    brand: 'COS',
    price: 89000,
    imageUrl: 'https://images.unsplash.com/photo-1434389677669-e08b4cac3105?w=600&q=80',
    category: 'outer',
  },
  {
    id: 'item-4',
    name: '플로럴 미디 드레스',
    brand: 'H&M',
    price: 49000,
    imageUrl: 'https://images.unsplash.com/photo-1595777457583-95e059d581b8?w=600&q=80',
    category: 'dress',
  },
];

// 성별별 기본 스톡 모델 이미지 (사진 미업로드 시 사용)
const STOCK_AVATAR: Record<string, string> = {
  female: 'https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?w=600&q=90',
  male:   'https://images.unsplash.com/photo-1531891437562-4301cf35b7e4?w=600&q=90',
};

const initialState: FittingState = {
  isOpen: false,
  step: 'IDLE',
  userInfo: initialUserInfo,
  baseAvatarUrl: null,
  humanImageBase64: null,
  fittingResultUrl: null,
  activeFittingItemId: null,
  isGenerating: false,
  cartItems: DEMO_CART_ITEMS,
  error: null,
};

// ======================================================
// 파일 → base64 변환 유틸
// ======================================================
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ======================================================
// Reducer Actions
// ======================================================
type Action =
  | { type: 'OPEN_WIDGET' }
  | { type: 'CLOSE_WIDGET' }
  | { type: 'GO_TO_SETTING' }
  | { type: 'UPDATE_USER_INFO'; payload: Partial<UserInfo> }
  | { type: 'START_GENERATING' }
  | { type: 'SET_BASE_AVATAR'; payload: { avatarUrl: string; humanImageBase64: string | null } }
  | { type: 'START_FITTING'; payload: string }
  | { type: 'SET_FITTING_RESULT'; payload: string }
  | { type: 'SET_ERROR'; payload: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'RESET_FITTING' };

function fittingReducer(state: FittingState, action: Action): FittingState {
  switch (action.type) {
    case 'OPEN_WIDGET':
      return {
        ...state,
        isOpen: true,
        step: state.baseAvatarUrl ? 'FITTING' : 'SETTING',
      };
    case 'CLOSE_WIDGET':
      return { ...state, isOpen: false };
    case 'GO_TO_SETTING':
      return { ...state, step: 'SETTING', error: null };
    case 'UPDATE_USER_INFO':
      return {
        ...state,
        userInfo: { ...state.userInfo, ...action.payload },
      };
    case 'START_GENERATING':
      return { ...state, step: 'GENERATING', isGenerating: true, error: null };
    case 'SET_BASE_AVATAR':
      return {
        ...state,
        step: 'FITTING',
        isGenerating: false,
        baseAvatarUrl: action.payload.avatarUrl,
        humanImageBase64: action.payload.humanImageBase64,
        fittingResultUrl: null,
        activeFittingItemId: null,
      };
    case 'START_FITTING':
      return {
        ...state,
        isGenerating: true,
        activeFittingItemId: action.payload,
        error: null,
      };
    case 'SET_FITTING_RESULT':
      return {
        ...state,
        isGenerating: false,
        fittingResultUrl: action.payload,
        activeFittingItemId: null,
      };
    case 'SET_ERROR':
      return {
        ...state,
        isGenerating: false,
        error: action.payload,
        activeFittingItemId: null,
      };
    case 'CLEAR_ERROR':
      return { ...state, error: null };
    case 'RESET_FITTING':
      return {
        ...state,
        fittingResultUrl: null,
        activeFittingItemId: null,
        isGenerating: false,
        error: null,
      };
    default:
      return state;
  }
}

// ======================================================
// Context 정의
// ======================================================
interface FittingContextValue {
  state: FittingState;
  openWidget: () => void;
  closeWidget: () => void;
  goToSetting: () => void;
  updateUserInfo: (info: Partial<UserInfo>) => void;
  generateAvatar: () => Promise<void>;
  fitItem: (item: CartItem) => Promise<void>;
  resetFitting: () => void;
}

const FittingContext = createContext<FittingContextValue | null>(null);

// ======================================================
// Provider
// ======================================================
export function FittingProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(fittingReducer, initialState);

  const openWidget   = useCallback(() => dispatch({ type: 'OPEN_WIDGET' }), []);
  const closeWidget  = useCallback(() => dispatch({ type: 'CLOSE_WIDGET' }), []);
  const goToSetting  = useCallback(() => dispatch({ type: 'GO_TO_SETTING' }), []);
  const resetFitting = useCallback(() => dispatch({ type: 'RESET_FITTING' }), []);

  const updateUserInfo = useCallback((info: Partial<UserInfo>) => {
    dispatch({ type: 'UPDATE_USER_INFO', payload: info });
  }, []);

  /**
   * 아바타 세팅:
   * - 사진 업로드 시 → base64로 변환하여 아바타로 사용
   * - 사진 미업로드 시 → 성별에 맞는 스톡 모델 이미지 사용
   * (실제 배포 시 이 단계에서 Imagen/SDXL로 아바타 생성 가능)
   */
  const generateAvatar = useCallback(async () => {
    dispatch({ type: 'START_GENERATING' });
    try {
      let avatarUrl: string;
      let humanImageBase64: string | null = null;

      if (state.userInfo.originalImageFile) {
        // 사용자 사진이 있으면 base64로 변환
        humanImageBase64 = await fileToBase64(state.userInfo.originalImageFile);
        avatarUrl = humanImageBase64; // 업로드한 사진을 아바타로 바로 사용
      } else {
        // 사진 없으면 스톡 모델 이미지
        avatarUrl = STOCK_AVATAR[state.userInfo.gender];
      }

      // 로딩 효과를 위한 최소 대기 (UX)
      await new Promise((r) => setTimeout(r, 800));

      dispatch({
        type: 'SET_BASE_AVATAR',
        payload: { avatarUrl, humanImageBase64 },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '아바타 준비 중 오류가 발생했습니다.';
      dispatch({ type: 'SET_ERROR', payload: message });
    }
  }, [state.userInfo]);

  /**
   * VTON 합성:
   * - Replicate IDM-VTON API 호출 (실제 AI 합성)
   * - humanImageBase64가 있으면 사용, 없으면 스톡 이미지 URL 사용
   */
  const fitItem = useCallback(
    async (item: CartItem) => {
      dispatch({ type: 'START_FITTING', payload: item.id });
      try {
        // 사람 이미지: 업로드된 사진(base64) 또는 스톡 이미지 URL
        const humanImage =
          state.humanImageBase64 ||
          state.fittingResultUrl ||
          state.baseAvatarUrl;

        if (!humanImage) {
          throw new Error('사람 이미지가 없습니다. 체형 설정 화면에서 사진을 업로드해주세요.');
        }

        const response = await fetch('/api/vton', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            humanImage,              // base64 data URL 또는 이미지 URL
            garmentImageUrl: item.imageUrl,
            garmentDescription: `${item.name} - ${item.brand}`,
            category: item.category,
          }),
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || 'VTON 합성에 실패했습니다.');
        }

        const data = await response.json();
        dispatch({ type: 'SET_FITTING_RESULT', payload: data.resultUrl });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.';
        dispatch({ type: 'SET_ERROR', payload: message });
      }
    },
    [state.humanImageBase64, state.baseAvatarUrl, state.fittingResultUrl]
  );

  return (
    <FittingContext.Provider
      value={{
        state,
        openWidget,
        closeWidget,
        goToSetting,
        updateUserInfo,
        generateAvatar,
        fitItem,
        resetFitting,
      }}
    >
      {children}
    </FittingContext.Provider>
  );
}

// ======================================================
// Custom Hook
// ======================================================
export function useFitting() {
  const context = useContext(FittingContext);
  if (!context) {
    throw new Error('useFitting은 FittingProvider 내부에서 사용해야 합니다.');
  }
  return context;
}
