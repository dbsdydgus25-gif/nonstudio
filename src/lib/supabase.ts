import { createClient } from '@supabase/supabase-js';

// 마이그레이션(supabase/migrations/0001_generation_consistency.sql, 0002_async_generation_status.sql)
// 스키마와 대응하는 최소 타입 정의.
// 자동 생성 타입(generate_typescript_types)을 아직 못 붙여서(새 계정 프로젝트라 MCP 접근 불가) 수기로 유지.
export interface Database {
  public: {
    Tables: {
      generations: {
        Row: {
          id: string;
          pipeline: 'fitting' | 'restyle' | 'detail-video';
          mode_or_category: string | null;
          prompt: string;
          pose_label: string | null;
          reference_image_ids: string[];
          output_storage_path: string;
          status: 'pending' | 'completed' | 'failed';
          error_message: string | null;
          rating: 'good' | 'bad' | null;
          rating_note: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          pipeline: 'fitting' | 'restyle' | 'detail-video';
          mode_or_category?: string | null;
          prompt: string;
          pose_label?: string | null;
          reference_image_ids?: string[];
          output_storage_path: string;
          status?: 'pending' | 'completed' | 'failed';
          error_message?: string | null;
          rating?: 'good' | 'bad' | null;
          rating_note?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          pipeline?: 'fitting' | 'restyle' | 'detail-video';
          mode_or_category?: string | null;
          prompt?: string;
          pose_label?: string | null;
          reference_image_ids?: string[];
          output_storage_path?: string;
          status?: 'pending' | 'completed' | 'failed';
          error_message?: string | null;
          rating?: 'good' | 'bad' | null;
          rating_note?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      reference_images: {
        Row: {
          id: string;
          pipeline: 'fitting' | 'restyle' | 'detail-video';
          label: string | null;
          storage_path: string;
          is_active: boolean;
          source_generation_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          pipeline: 'fitting' | 'restyle' | 'detail-video';
          label?: string | null;
          storage_path: string;
          is_active?: boolean;
          source_generation_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          pipeline?: 'fitting' | 'restyle' | 'detail-video';
          label?: string | null;
          storage_path?: string;
          is_active?: boolean;
          source_generation_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}

let cached: ReturnType<typeof createClient<Database>> | null = null;

/** 서버 전용 admin 클라이언트 — service_role 키 사용, RLS 우회. API 라우트에서만 호출할 것. */
export function getSupabaseAdmin() {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 설정되지 않았습니다.');
  }

  cached = createClient<Database>(url, key, { auth: { persistSession: false } });
  return cached;
}

export const GENERATIONS_BUCKET = 'nonstudio-generations';
