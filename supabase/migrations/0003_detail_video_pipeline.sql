-- NON STUDIO: 디테일컷 영상 파이프라인 추가
-- Supabase 대시보드 → SQL Editor에서 전체 실행

alter table generations drop constraint if exists generations_pipeline_check;
alter table generations add constraint generations_pipeline_check check (pipeline in ('fitting', 'restyle', 'detail-video'));

alter table reference_images drop constraint if exists reference_images_pipeline_check;
alter table reference_images add constraint reference_images_pipeline_check check (pipeline in ('fitting', 'restyle', 'detail-video'));
