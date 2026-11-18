-- Stage 3 additive migration. Run after 0005; no existing rows are deleted.
begin;
alter table app.upload_jobs
 add column if not exists storage_cleaned_at timestamptz,
 add column if not exists processing_stage text,
 add column if not exists lease_owner uuid,
 add column if not exists lease_until timestamptz,
 add column if not exists worker_failures integer not null default 0,
 add column if not exists worker_attempts integer not null default 0,
 add column if not exists next_attempt_at timestamptz not null default now(),
 add column if not exists cancel_requested_at timestamptz,
 add column if not exists processing_started_at timestamptz,
 add column if not exists files_extracted integer not null default 0,
 add column if not exists files_processed integer not null default 0,
 add column if not exists github_bytes_total bigint not null default 0,
 add column if not exists github_bytes_uploaded bigint not null default 0,
 add column if not exists base_head_sha text,
 add column if not exists base_tree_sha text,
 add column if not exists target_tree_sha text,
 add column if not exists commit_timestamp timestamptz,
 add column if not exists commit_author jsonb,
 add column if not exists publish_started_at timestamptz,
 add column if not exists confirmed_head_sha text,
 add column if not exists github_confirmed_at timestamptz,
 add column if not exists notify_owner uuid,
 add column if not exists notify_lease_until timestamptz,
 add column if not exists notify_after timestamptz not null default now(),
 add column if not exists notify_last_text text,
 add column if not exists notify_sample_at timestamptz,
 add column if not exists notify_sample_bytes bigint,
 add column if not exists notify_sample_stage text,
 add column if not exists terminal_notified_at timestamptz,
 add column if not exists terminal_message_id bigint,
 add column if not exists animation_attempted_at timestamptz;
create index if not exists upload_jobs_worker_queue_idx on app.upload_jobs(next_attempt_at,created_at)
 where status in ('uploaded','processing');
create index if not exists upload_jobs_notification_idx on app.upload_jobs(notify_after)
 where terminal_notified_at is null;
create table if not exists app.upload_job_files (
 job_id uuid not null references app.upload_jobs(id) on delete cascade,
 path text not null,
 blob_sha text not null check(blob_sha ~ '^[0-9a-f]{40}$'),
 size bigint not null check(size>=0),
 mode text not null check(mode in ('100644','100755')),
 kind text not null check(kind in ('added','updated','unchanged')),
 blob_uploaded boolean not null default false,
 primary key(job_id,path)
);
create index if not exists upload_job_files_blob_idx on app.upload_job_files(job_id,blob_sha);
create table if not exists app.worker_github_budgets (
 user_id bigint primary key references app.telegram_users(id) on delete cascade,
 minute_start timestamptz not null default now(), minute_count integer not null default 0,
 hour_start timestamptz not null default now(), hour_count integer not null default 0,
 blocked_until timestamptz not null default now()
);
create table if not exists app.worker_notify_chats (
 chat_id bigint primary key,
 next_allowed_at timestamptz not null default now()
);
alter table app.upload_job_files enable row level security;
alter table app.worker_github_budgets enable row level security;
alter table app.worker_notify_chats enable row level security;
revoke all on app.upload_job_files,app.worker_github_budgets,app.worker_notify_chats from anon,authenticated;
-- Bot upload initiation is private. Never infer a group chat from client input.
update app.upload_jobs set telegram_chat_id=telegram_user_id where telegram_chat_id is null;
commit;
