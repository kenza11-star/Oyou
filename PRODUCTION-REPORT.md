# Production final verification report

> **Pembaruan Stage 5:** worker permanen yang dijelaskan di laporan ini sudah diganti dengan GitHub Actions (`.github/workflows/process-uploads.yml`, `npm run worker:actions`, `worker:once`, `worker:check`). Langkah deploy terbaru: `docs/ACTIONS-DEPLOYMENT.md`. Tabel hasil di bawah adalah hasil audit **sebelum** Stage 5 dan tidak diverifikasi ulang untuk kode terbaru; rujukan ke worker/Docker/systemd/heartbeat di bawah bersifat historis.

Audit date: 2026-11-16 UTC. This release continues the supplied Stage 3 source; it is not a rebuild. Every original project file is retained. Original ZIP SHA-256: `20085375a54a4e6a3a4537b8c80bc1584230f17febc764d405cbddbc9240a123`.

## Release status

| Area | Actual result |
| --- | --- |
| Implemented | Source hardening, selected branches, bounded APK downloads, session revocation, webhook claim recovery, readiness/activation CLI and deployment guide |
| Clean installation | `npm ci` executed successfully; lockfile matches package manifest |
| Typecheck | `npm run typecheck` executed successfully on final code |
| Tests | `npm test`: **178 passed, 36 files passed**, including real local PostgreSQL-engine SQL through PGlite; remote provider replies are controlled test responses |
| Production build | `npm run build` executed successfully; uploader, callback, webhook, health and all upload API routes appear in the Next.js build |
| Dependency security | `npm audit --json`: **0 reported vulnerabilities**, successful registry response; this is not a guarantee of no vulnerabilities |
| Built server HTTP smoke | Executed `next start` with dummy ENV: uploader 200, empty OAuth callback 400, webhook GET 405, unauthenticated POST 401, authenticated no-op POST 200, protected readiness without secret 401; liveness reports version 4 and uploader sends no-referrer |
| CLI entry points | Worker `--help`, activation `--help` and activation `--dry-run` executed successfully |
| External services | Public production HTTP inspected; no authenticated Supabase/GitHub/Telegram production journey verified |
| Blocked | Existing Vercel project API access returned 403; production service credentials were not available to this task. No deployment, webhook registration, live migrations or worker provisioning performed |

Runtime: Node.js 24.22.1, npm 11.9.0, Next.js 15.5.29. npm emitted a host `http-proxy` configuration deprecation warning and a transitive `whatwg-encoding` deprecation warning; neither prevented installation, checks or build. No dependency update was made solely to suppress these warnings.

## Architecture retained and verified in code

Private Telegram `/upload` links contain short-lived signed owner/repository/branch scope and revocable session version. The browser hashes the selected archive and uploads 8 MiB chunks directly to the private Supabase bucket with bounded adaptive concurrency. The server verifies downloaded chunk lengths and SHA-256 before accepting completion. Finalization requires every verified chunk.

The processor (now a GitHub Actions run; originally an always-on worker) atomically leases PostgreSQL jobs, reconstructs and validates ZIP/CRC/path/size limits, uses the original user's encrypted OAuth credentials and authorized installation repositories, compares Git blob identities, checkpoints blob uploads, builds an update-only tree, creates a deterministic commit and updates the branch without force. Completion requires remote commit confirmation. Durable notices update one Telegram message, then deliver the terminal result with real links; the bundled animation has a text fallback. No-op archives return Already up to date. Nothing removes repository files absent from the ZIP.

The Vercel web app and the GitHub Actions processor are both required. Work is awaited by the Actions run, not an unawaited request promise or daily cron. Existing recovery, throttling, cancellation, source cleanup, permission hints, binary/workflow support and job ownership checks remain intact.

## Confirmed defects fixed

- Connection-string `ssl=false` could override explicit verified TLS in `pg`. URL SSL overrides are removed before constructing the pool. The regression checks the real `pg.Client` connection parameters.
- Logout followed by reauthentication could reactivate an old upload capability. Session versions now revoke old links permanently; account switching disconnects the older identity, clears selection and cancels unpublished work. Active identity selection is consistent.
- Webhook duplicate markers could drop work after a crash. Atomic fenced processing claims, lease expiration and retryable failures distinguish completed messages from active/abandoned deliveries.
- Branch selection was not exposed consistently and direct ZIP handling could use the default branch. `/branch` lists/selects a real authorized branch; both upload paths honor it. Two simultaneous direct uploads can no longer consume the same pending authorization.
- APK fetching could fully buffer an excessive response or inflate every artifact entry. Streaming byte caps, timeouts, a validated single APK extraction and CRC protect memory/integrity. Release APK fallback is now connected before ZIP fallback; expired and oversized artifacts are skipped.
- Invalid production APP_URL schemes/paths and illegal Telegram webhook secret format now fail validation. Correct callback and webhook paths are shared with deployment checks. Callback pages have restrictive CSP; post-link Telegram failure does not misreport successful OAuth as failure.
- The uploader now loads validated repository/branch context before enabling file selection, shows real processing counters and provides mobile touch targets and accessible progress.
- Readiness checks database/schema and private bucket configuration (core readiness no longer depends on the processor; processing readiness is reported separately). The activation script refuses a missing/old deployment or unready dependencies, verifies webhook secret enforcement, registers only after probes, then verifies getWebhookInfo without printing credentials.

## Tests and audit coverage

Retained exact-100-MiB pipeline tests reconstruct verified chunks through confirmed GitHub publication with controlled provider boundaries. Binary PNG, YAML workflows, thousands of paths, unchanged files, duplicate/fenced jobs, interrupted processing, rate limits, branch conflicts, cancellation, missing/corrupt chunks, cross-user access, progress and final Telegram notices remain tested.

New Stage 4 SQL-backed journeys cover a public non-admin user's start/login/one-time OAuth state, authorized private repository, selected branch and scoped upload link; another user's denied access; status/admin/Actions/release APK; logout/relogin revocation; duplicate webhook ownership and worker/private-bucket readiness. Migrations are exercised in order and 0007 is applied twice over populated Stage 3 users, historical deliveries and multiple legacy job states, preserving those rows and RLS protection.

Static audit covered all Next.js route entry points, imports/types, Telegram command/callback/document dispatch, OAuth/refresh/encryption, installation/repository authorization, upload/Storage validation, migrations, Git publication, worker/notification/cleanup loops, Actions/artifacts/releases, configuration and browser bundles. No server secret ENV identifiers were found in generated browser JavaScript. This scan is narrower than a live secret leakage assessment.

## Migration and deployment requirements

For an existing Stage 3 database apply only `db/migrations/0007_production_hardening.sql` after your normal backup. It is additive and re-runnable; no existing row is deleted. Older databases must first apply missing migrations in order. `db/setup-storage.sql` is separate manual setup for the private bucket and preserves existing objects/policies/limits. No production SQL was executed.

Follow `docs/PRODUCTION-DEPLOYMENT.md` for the exact SQL commands, all existing unchanged ENV names, Vercel root directory, GitHub permissions, GitHub Actions secrets, activation and public-user acceptance checklist. No secret values are bundled. Existing app ID, private key and GitHub webhook secret remain configured; the current per-user OAuth pipeline does not mint installation JWTs or implement a GitHub webhook receiver. Actions are queried by bot commands.

The supplied domain and callback match final source. The **currently deployed** domain returned root GET 200, uploader GET 404, callback GET 404 and webhook GET 405 during this audit. These results describe the previous deployment, not a deployment of this ZIP. Vercel project access returned HTTP 403, so its actual plan/runtime settings could not be verified. Deploy the final Next.js root correctly before activation.

## Remaining limitations and unverified infrastructure

- Real OAuth consent, private Storage transfers/CORS, live GitHub writes/workflow permissions, real Telegram message/animation delivery and a live 100 MiB transfer require acceptance testing with the existing accounts after deployment.
- The GitHub Actions processor has not been run against live Supabase/GitHub/Telegram by this audit; the former Docker/systemd configurations were removed.
- Mobile layout and UI behavior have DOM/CSS coverage; no actual Android/Telegram in-app browser session or successful full browser automation run is claimed.
- The legacy direct Telegram upload path remains synchronous and limited to 20 MiB. Use browser/worker uploads for large or long jobs.
- Existing archive limits remain: 100 MiB compressed, 300 MiB expanded, 20,000 entries plus anti-bomb checks. ZIP64, encryption, unsafe paths/symlinks and unsupported compression are rejected explicitly. Buffering is bounded, not constant-memory streaming.
- Git branch publication uses non-forced GitHub reference updates and remote confirmation; branch protection and concurrent upstream edits can require retry. GitHub's REST ref API is not a compare-and-swap primitive.
- Telegram delivery and webhook side effects are at-least-once across ambiguous network/crash outcomes. A durable outbox retries terminal notices; exactly-once external message delivery is not claimed.
- Service quotas, finite source retention and outages can defer/fail jobs. No measured throughput improvement, uptime guarantee or zero-error claim is made.

## Exact file changes against Stage 3

Modified existing files:

- `.env.example`
- `README.md`
- `next.config.mjs`
- `package-lock.json`
- `package.json`
- `src/app/api/telegram/webhook/route.ts`
- `src/app/github/callback/route.ts`
- `src/app/upload/uploader.tsx`
- `src/lib/db.ts`
- `src/lib/env.ts`
- `src/lib/github/actions.ts`
- `src/lib/github/linking.ts`
- `src/lib/github/oauth.ts`
- `src/lib/github/upload.ts`
- `src/lib/telegram/api.ts`
- `src/lib/telegram/documents.ts`
- `src/lib/telegram/handlers.ts`
- `src/lib/telegram/messages.ts`
- `src/lib/telegram/state.ts`
- `src/lib/upload/http.ts`
- `src/lib/upload/session.ts`
- `src/lib/upload/token.ts`
- `src/lib/upload/zip-entries.ts`
- `src/lib/worker/runtime.ts`
- `src/worker.ts`
- `tests/db-tls.test.ts`
- `tests/upload-http-auth.test.ts`
- `tests/uploader-dom.test.tsx`
- `vercel.json`

Added files (including this report):

- `PRODUCTION-REPORT.md`
- `db/migrations/0007_production_hardening.sql`
- `db/setup-storage.sql`
- `docs/PRODUCTION-DEPLOYMENT.md`
- `scripts/telegram-activate.ts`
- `src/app/api/health/route.ts`
- `src/lib/deployment/activate.ts`
- `src/lib/deployment/readiness.ts`
- `src/lib/deployment/urls.ts`
- `src/lib/github/branches.ts`
- `src/lib/http/bounded.ts`
- `src/lib/telegram/update-claims.ts`
- `tests/helpers/database.ts`
- `tests/stage4-activation.test.ts`
- `tests/stage4-branch.test.ts`
- `tests/stage4-direct-upload.test.ts`
- `tests/stage4-hardening.test.ts`
- `tests/stage4-journeys.test.ts`
- `tests/stage4-migrations.test.ts`
