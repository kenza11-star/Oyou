-- Run manually in Supabase SQL Editor after reviewing the target project.
-- Existing objects and existing bucket size/MIME settings are preserved.
begin;
insert into storage.buckets(id,name,public)
values('github-uploads','github-uploads',false)
on conflict(id) do nothing;
update storage.buckets set public=false where id='github-uploads';
commit;
-- Inspect; allow >= 8 MiB per object and application/octet-stream (or no MIME restriction).
select id,public,file_size_limit,allowed_mime_types from storage.buckets where id='github-uploads';
