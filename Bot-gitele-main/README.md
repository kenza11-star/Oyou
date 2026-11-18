# GitHub Manager Bot V2 — Production Final

Public multi-user Telegram bot built on the existing Next.js / PostgreSQL / Supabase / GitHub App project. Every user connects their own GitHub account. Normal commands are public; `/admin` remains owner-only.

**Browser pipeline:** Telegram `/upload` → signed direct-to-private-Storage chunks → durable PostgreSQL queue → GitHub Actions processor (`process-uploads.yml`) → validated ZIP → update-only GitHub commit → branch confirmation → Telegram progress and text/GIF result. ZIP limit: **100 MiB**.

Stage 4 adds existing-branch selection, safe APK streaming/extraction and Release fallback, durable webhook delivery claims, upload-session revocation, account-switch isolation, actual pg TLS override protection, protected readiness and a safe executable webhook activation script. Existing features and environment variable names remain.

## Run and verify

Use **Node.js 24.x**.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run worker:check   # verifies configuration/schema (needs DB env); the processor itself runs in GitHub Actions
npm run telegram:activate -- --dry-run
```

Processor commands (used by `.github/workflows/process-uploads.yml`, runnable manually with the same environment):

```sh
npm run worker:actions   # drain the upload queue, then exit
npm run worker:once      # process at most one job
npm run worker:check     # verify configuration and database schema
```

`npm start` serves the built web app. ZIP processing runs in GitHub Actions (`.github/workflows/process-uploads.yml`); there is no always-on worker. See docs/ACTIONS-DEPLOYMENT.md.

## Deploy

1. Existing database: apply the migrations it is missing, ending with **0008_actions_worker.sql** (additive, repeat-safe). Fresh database: apply 0001–0008 in order, then run `db/verify-migrations.sql`.
2. Keep `github-uploads` private and permit 8 MiB octet-stream chunk objects.
3. Deploy the project as Next.js at the correct Vercel root, targeting **https://bot-xsync-delta.vercel.app**.
4. Keep all existing ENV names. Set `APP_URL=https://bot-xsync-delta.vercel.app`; OAuth callback is `/github/callback`.
5. Add the GitHub Actions secrets and (optionally) `ACTIONS_DISPATCH_TOKEN` as described in **[docs/ACTIONS-DEPLOYMENT.md](docs/ACTIONS-DEPLOYMENT.md)**. No always-on worker, VPS or extra hosting is used.
6. Register the webhook with the *Aktivasi webhook Telegram* workflow, or run `npm run telegram:activate` with existing environment values loaded on a trusted host. It checks deployment first, registers the implemented `/api/telegram/webhook` with secret_token, then verifies getWebhookInfo. It does not print tokens or discard pending updates.
7. Test a real non-admin user and inspect the confirmed commit/Telegram result.

Complete commands, SQL, permissions, monitoring and blockers: **[docs/PRODUCTION-DEPLOYMENT.md](docs/PRODUCTION-DEPLOYMENT.md)**.

Actual audit changes and verification results: **[PRODUCTION-REPORT.md](PRODUCTION-REPORT.md)**. Historical Stage 2.5/3 reports and documentation are retained; the final deployment guide supersedes their setup steps.

## Operational status

This is the complete final source package, **not a claim that production infrastructure has already been activated**. The Vercel API inspection was blocked by account permission (403). The public domain responded, but the deployed uploader/callback returned 404 during this audit. Production secrets were not requested or printed; no live webhook registration or database migration was performed. Follow the deployment and acceptance checks before declaring the bot operational.
