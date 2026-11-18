-- Stage 2.5. Additive upgrade; no jobs, users, chunks or credentials are deleted.
begin;
alter table app.upload_jobs add column if not exists file_sha256 text
  check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$');
alter table app.upload_job_chunks add column if not exists object_path text;
-- Immutable attempt paths keep stale upload URLs away from verified chunks.
create table if not exists app.upload_chunk_attempts (
 id uuid primary key,
 job_id uuid not null,
 chunk_index integer not null,
 object_path text not null unique,
 created_at timestamptz not null default now(),
 foreign key (job_id,chunk_index) references app.upload_job_chunks(job_id,chunk_index) on delete cascade
);
create index if not exists upload_chunk_attempts_job_idx on app.upload_chunk_attempts(job_id,chunk_index,created_at);
alter table app.upload_chunk_attempts enable row level security;
revoke all on app.upload_chunk_attempts from anon, authenticated;
commit;
