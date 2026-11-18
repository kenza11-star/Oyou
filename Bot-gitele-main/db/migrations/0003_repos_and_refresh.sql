-- Run after 0001 and 0002. Adds repository state, refresh tokens, and operation metadata.

alter table app.telegram_users
  add column selected_repo_id bigint,
  add column selected_repo_full_name text,
  add column selected_branch text,
  add column pending_action text check (pending_action in ('await_zip')),
  add column pending_expires_at timestamptz;

alter table app.github_credentials
  add column refresh_ciphertext text,
  add column refresh_expires_at timestamptz;

alter table app.push_operations
  add column github_repo_id bigint,
  add column github_repo_full_name text;

create index rate_limits_window_idx on app.rate_limits (window_start);
create index processed_updates_received_idx on app.processed_updates (received_at);
create index telegram_users_pending_idx on app.telegram_users (pending_expires_at)
  where pending_action is not null;
