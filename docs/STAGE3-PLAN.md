> **Dokumen historis.** Rujukan ke worker permanen (`npm run worker`, Docker, systemd) sudah tidak berlaku; pemrosesan kini memakai GitHub Actions. Lihat `docs/ACTIONS-DEPLOYMENT.md`.

# Stage 3 implementation plan

Continue the supplied Stage 2.5 source. Keep Next.js/API upload boundaries and existing environment names.

1. Strengthen ZIP central/local-directory validation, duplicate detection, CRC checking, per-file mode and bounded extraction; exercise malformed archives, binary data, 100 MiB and thousands of files.
2. Add additive migration 0006: processing leases/fences, deterministic commit checkpoints, per-file manifests, GitHub pacing budgets and persistent Telegram notification state.
3. Implement an executable Node worker, continuous PostgreSQL polling plus lease heartbeat, restart recovery, cancellation and periodic cleanup. One job per worker, multiple independent workers supported via SKIP LOCKED.
4. Connect uploaded jobs to verified reconstruction, correct-user credentials, paginated installation authorization, base-branch snapshot, update-only comparisons, deduplicated adaptive blob upload, persisted tree/commit, non-forced branch update and final remote confirmation.
5. Persist progress and retryable terminal notifications; edit one progress message, send final summary and optional bundled GIF. Observe Telegram Retry-After and per-chat throttling. Never announce success before GitHub confirmation.
6. Extend browser status polling and cancellation; preserve existing upload behavior. Add Docker/systemd deployment instructions and runnable once/smoke entry points.
7. Run dependency install, typecheck, full tests, worker entry-point checks and production build. Report live-service/hosting-plan limitations explicitly.

Separate always-on worker chosen because archive size, extraction and GitHub quotas can exceed a request even when Fluid Compute is enabled. No unawaited request work and no daily-cron-only queue trigger. GitHub REST non-force updates prevent overwriting concurrent work but are not a strict compare-and-swap primitive. Telegram notifications are at-least-once under ambiguous network acknowledgements.
