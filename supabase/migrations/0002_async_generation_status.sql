-- NON STUDIO: 비동기 생성 아키텍처 — pending/completed/failed 상태 추적
-- Supabase 대시보드 → SQL Editor에서 전체 실행

-- 기존 행은 전부 이미 완료된 결과이므로 기본값을 'completed'로 둔다.
-- 새로 생성되는 pending/failed 행은 코드에서 명시적으로 status를 지정한다.
alter table generations add column if not exists status text not null default 'completed' check (status in ('pending', 'completed', 'failed'));
alter table generations add column if not exists error_message text;

create index if not exists idx_generations_status on generations (status);
