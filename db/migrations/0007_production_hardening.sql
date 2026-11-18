-- Additive Stage 4 migration. Existing processed updates stay completed.
begin;
alter table app.telegram_users add column if not exists upload_session_version integer not null default 0;
alter table app.processed_updates
 add column if not exists processing_status text not null default 'completed' check(processing_status in ('pending','processing','completed')),
 add column if not exists claim_token uuid,
 add column if not exists lease_until timestamptz,
 add column if not exists completed_at timestamptz;
create index if not exists processed_updates_pending_idx on app.processed_updates(lease_until) where processing_status<>'completed';
create table if not exists app.worker_heartbeats (
 instance_id uuid primary key,
 started_at timestamptz not null default now(),
 last_seen_at timestamptz not null default now()
);
alter table app.worker_heartbeats enable row level security;
revoke all on app.worker_heartbeats from anon,authenticated;
commit;
