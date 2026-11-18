-- Remembers the Telegram message that carries the Login button so the OAuth
-- callback can turn it into "Success" / "Failed". Additive and idempotent.
alter table app.oauth_states add column if not exists message_id bigint;
