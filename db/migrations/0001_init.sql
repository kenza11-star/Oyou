-- Private application schema. Not exposed through the Supabase Data API.
create schema if not exists app;

create table app.telegram_users (
  id bigint primary key,
  username text,
  first_name text,
  first_seen_at timestamptz not null default now(),
  last_active_at timestamptz not null default now()
);

create table app.github_identities (
  id bigserial primary key,
  telegram_user_id bigint not null references app.telegram_users(id) on delete cascade,
  github_user_id bigint not null,
  github_login text not null,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  unique (github_user_id, telegram_user_id)
);
create index github_identities_tg_idx on app.github_identities (telegram_user_id);

create table app.github_credentials (
  id bigserial primary key,
  identity_id bigint not null unique references app.github_identities(id) on delete cascade,
  auth_type text not null check (auth_type in ('github_app_user', 'pat')),
  ciphertext text not null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table app.github_installations (
  installation_id bigint primary key,
  identity_id bigint not null references app.github_identities(id) on delete cascade,
  account_login text not null,
  created_at timestamptz not null default now(),
  suspended_at timestamptz
);

create table app.repo_selections (
  id bigserial primary key,
  telegram_user_id bigint not null references app.telegram_users(id) on delete cascade,
  github_repo_id bigint not null,
  full_name text not null,
  default_branch text,
  is_private boolean not null default false,
  selected_at timestamptz not null default now(),
  unique (telegram_user_id, github_repo_id)
);

create table app.push_operations (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null references app.telegram_users(id) on delete cascade,
  repo_selection_id bigint references app.repo_selections(id) on delete set null,
  branch text not null,
  mode text not null check (mode in ('update', 'replace')),
  status text not null check (status in ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  commit_sha text,
  error text,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index push_operations_user_idx on app.push_operations (telegram_user_id, created_at desc);

create table app.workflow_subscriptions (
  id bigserial primary key,
  telegram_user_id bigint not null references app.telegram_users(id) on delete cascade,
  github_repo_id bigint not null,
  created_at timestamptz not null default now(),
  unique (telegram_user_id, github_repo_id)
);

create table app.build_events (
  id uuid primary key default gen_random_uuid(),
  delivery_id text not null unique,
  github_repo_id bigint not null,
  event_type text not null,
  run_id bigint,
  status text,
  received_at timestamptz not null default now()
);

create table app.activity_logs (
  id bigserial primary key,
  telegram_user_id bigint references app.telegram_users(id) on delete set null,
  operation text not null,
  repository text,
  result text not null check (result in ('success', 'failure', 'info')),
  duration_ms integer,
  error_detail text,
  created_at timestamptz not null default now()
);
create index activity_logs_created_idx on app.activity_logs (created_at desc);

create table app.admin_sessions (
  id text primary key,
  telegram_user_id bigint not null,
  csrf_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table app.upload_jobs (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null references app.telegram_users(id) on delete cascade,
  storage_path text not null unique,
  declared_size bigint,
  status text not null check (status in ('awaiting_upload', 'uploaded', 'processing', 'ready', 'failed', 'expired')),
  error text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index upload_jobs_status_idx on app.upload_jobs (status, expires_at);

alter table app.telegram_users enable row level security;
alter table app.github_identities enable row level security;
alter table app.github_credentials enable row level security;
alter table app.github_installations enable row level security;
alter table app.repo_selections enable row level security;
alter table app.push_operations enable row level security;
alter table app.workflow_subscriptions enable row level security;
alter table app.build_events enable row level security;
alter table app.activity_logs enable row level security;
alter table app.admin_sessions enable row level security;
alter table app.upload_jobs enable row level security;

revoke all on schema app from anon, authenticated;
