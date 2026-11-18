-- 0008: GitHub Actions processor (replaces the always-on worker). Additive and repeat-safe.
-- Nothing is dropped or rewritten; existing users, credentials, jobs and uploads are untouched.
begin;
alter table app.upload_jobs
  add column if not exists dispatched_at timestamptz,
  add column if not exists dispatch_error text,
  add column if not exists actions_run_id bigint,
  add column if not exists actions_run_url text,
  add column if not exists retry_count integer not null default 0;

-- Recovery sweeps look for runnable jobs that nothing has picked up.
create index if not exists upload_jobs_runnable_idx
  on app.upload_jobs (next_attempt_at, created_at)
  where status in ('uploaded', 'processing');

-- Shared worker bookkeeping already exists (0007). Re-assert it so 0008 can run on its own.
create table if not exists app.worker_heartbeats (
  instance_id uuid primary key,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
alter table app.worker_heartbeats enable row level security;
revoke all on app.worker_heartbeats from anon, authenticated;
commit;
