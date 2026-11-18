-- Read-only. Run in the Supabase SQL editor. Every row should show ok = true.
select 'processed_updates.processing_status (0007)' as check_name,
  exists(select 1 from information_schema.columns where table_schema='app' and table_name='processed_updates' and column_name='processing_status') as ok
union all select 'telegram_users.upload_session_version (0007)',
  exists(select 1 from information_schema.columns where table_schema='app' and table_name='telegram_users' and column_name='upload_session_version')
union all select 'upload_jobs.lease_owner (0006)',
  exists(select 1 from information_schema.columns where table_schema='app' and table_name='upload_jobs' and column_name='lease_owner')
union all select 'upload_job_files table (0006)', to_regclass('app.upload_job_files') is not null
union all select 'upload_jobs.actions_run_id (0008)',
  exists(select 1 from information_schema.columns where table_schema='app' and table_name='upload_jobs' and column_name='actions_run_id')
union all select 'upload_jobs.dispatched_at (0008)',
  exists(select 1 from information_schema.columns where table_schema='app' and table_name='upload_jobs' and column_name='dispatched_at')
union all select 'oauth_states.message_id (0009)',
  exists(select 1 from information_schema.columns where table_schema='app' and table_name='oauth_states' and column_name='message_id');
