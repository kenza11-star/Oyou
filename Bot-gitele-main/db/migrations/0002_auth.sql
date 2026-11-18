-- Authorization and abuse-control tables for public multi-user access.

create table app.oauth_states (
  state_hash text primary key,
  telegram_user_id bigint not null references app.telegram_users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index oauth_states_expires_idx on app.oauth_states (expires_at);

create table app.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

create table app.processed_updates (
  update_id bigint primary key,
  received_at timestamptz not null default now()
);

-- A GitHub account may be actively linked to at most one Telegram user.
create unique index github_identities_active_user_idx
  on app.github_identities (github_user_id) where disconnected_at is null;

alter table app.oauth_states enable row level security;
alter table app.rate_limits enable row level security;
alter table app.processed_updates enable row level security;
