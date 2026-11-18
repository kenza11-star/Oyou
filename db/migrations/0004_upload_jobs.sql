begin;
-- 0004: browser ZIP uploads (Stage 2). Idempotent and safe on databases that already contain upload_jobs rows from 0001.

-- 1. Allow every status the application uses. Legacy statuses from 0001 are kept.
alter table app.upload_jobs drop constraint if exists upload_jobs_status_check;

-- Preserve legacy values; NOT VALID checks new writes without rewriting existing rows.
alter table app.upload_jobs add constraint upload_jobs_status_check check (status in (
  'awaiting_upload', 'uploaded', 'processing', 'ready', 'failed', 'expired',
  'created', 'uploading', 'cancelled', 'verifying', 'extracting', 'validating',
  'comparing', 'uploading_blobs', 'creating_commit', 'updating_branch', 'completed'
)) not valid;

-- 2. Columns. "if not exists" keeps the migration re-runnable.
alter table app.upload_jobs
  add column if not exists file_name text,
  add column if not exists repo_id bigint,
  add column if not exists repo_full_name text,
  add column if not exists branch text,
  add column if not exists total_bytes bigint,
  add column if not exists chunk_size integer,
  add column if not exists chunk_count integer,
  add column if not exists bytes_received bigint not null default 0,
  add column if not exists files_total integer,
  add column if not exists files_added integer not null default 0,
  add column if not exists files_updated integer not null default 0,
  add column if not exists files_unchanged integer not null default 0,
  add column if not exists files_failed integer not null default 0,
  add column if not exists commit_sha text,
  add column if not exists commit_url text,
  add column if not exists idempotency_key text,
  add column if not exists telegram_chat_id bigint,
  add column if not exists telegram_message_id bigint,
  add column if not exists completed_at timestamptz,
  add column if not exists version integer not null default 0;

-- Removes a mistaken index from an earlier draft of this migration, if it was ever applied.
drop index if exists app.upload_jobs_one_commit_idx;

-- 3. Idempotent job creation: one job per (user, client key). Rows without a key are unaffected.
create unique index if not exists upload_jobs_idempotency_idx
  on app.upload_jobs (telegram_user_id, idempotency_key) where idempotency_key is not null;
create index if not exists upload_jobs_user_idx on app.upload_jobs (telegram_user_id, created_at desc);
create index if not exists upload_jobs_expiry_idx on app.upload_jobs (expires_at)
  where status in ('created', 'uploading', 'uploaded', 'cancelled');

-- 4. Per-chunk state, persisted so uploads can resume after a reload or restart.
create table if not exists app.upload_job_chunks (
  job_id uuid not null references app.upload_jobs(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  size bigint not null check (size > 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'uploaded', 'verified')),
  attempts integer not null default 0,
  uploaded_at timestamptz,
  primary key (job_id, chunk_index)
);

alter table app.upload_job_chunks enable row level security;

commit;
