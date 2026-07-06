-- NON STUDIO: 생성 기록 + 참고 이미지 저장 스키마
-- Supabase 대시보드 → SQL Editor에서 전체 실행

create extension if not exists pgcrypto;

-- 매 생성 시도 기록 (모델 피팅 / AI 리스타일링 공통)
create table if not exists generations (
  id uuid primary key default gen_random_uuid(),
  pipeline text not null check (pipeline in ('fitting', 'restyle')),
  mode_or_category text,
  prompt text not null,
  pose_label text,
  reference_image_ids uuid[] not null default '{}',
  output_storage_path text not null,
  rating text check (rating in ('good', 'bad')),
  rating_note text,
  created_at timestamptz not null default now()
);

-- 승격된 "기준" 참고 이미지 (다음 생성 때 두 번째 입력 이미지로 재사용)
create table if not exists reference_images (
  id uuid primary key default gen_random_uuid(),
  pipeline text not null check (pipeline in ('fitting', 'restyle')),
  label text,
  storage_path text not null,
  is_active boolean not null default true,
  source_generation_id uuid references generations(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_generations_pipeline_created on generations (pipeline, created_at desc);
create index if not exists idx_reference_images_active on reference_images (pipeline, is_active);

-- 생성 결과물 저장용 비공개 버킷 (service_role 키로만 접근 — RLS 우회)
insert into storage.buckets (id, name, public)
values ('nonstudio-generations', 'nonstudio-generations', false)
on conflict (id) do nothing;
