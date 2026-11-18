> **Dokumen historis.** Rujukan ke worker permanen (`npm run worker`, Docker, systemd) sudah tidak berlaku; pemrosesan kini memakai GitHub Actions. Lihat `docs/ACTIONS-DEPLOYMENT.md`.

# Stage 3 implementation and verification report

Continued from the supplied `GitHub-Manager-Bot-V2-Stage2.5-Fixed.zip` (SHA-256 `f10bacd40dd6ffa3cd0a6a7e5834e4c218a6fc6d32ade05cefc14ac5b3ecaac0`), extracted into a fresh project directory. No older source was substituted. All original files remain in the project. This report supersedes the retained historical Stage 2.5 report.

## Implemented architecture

The browser upload is now connected end-to-end: private Telegram upload initiation → direct signed Supabase PUT → server-verified chunk completion → short PostgreSQL enqueue transaction → executable always-on worker → whole ZIP/chunk/CRC validation → user-owned GitHub authorization → persistent file comparison/blob checkpoints → update-only tree → deterministic candidate commit → non-forced ref update → remote branch/commit confirmation → persisted completion → Telegram summary and optional valid GIF.

Next.js handles upload/auth/status/cancel requests. PostgreSQL is the durable queue, fencing authority, checkpoint store, mutation budget and Telegram delivery ledger. No unawaited promise is used to process jobs after an HTTP response. Processing is triggered by continuous worker polling, independently of the preserved daily cleanup cron. Worker processing, notification and cleanup loops are all awaited by the CLI process.

### Correctness and durability

- Atomic queue claiming uses `FOR UPDATE SKIP LOCKED`; leases last 90 seconds and renew every 30 seconds. State changes are fenced by owner/freshness and consistent row-lock ordering.
- Each chunk retains an immutable attempt path. Completion checks owner/size/attempt, downloads and hashes outside a transaction, then re-locks to validate current state and save. Concurrent downloads do not hold the job lock; cancellations and competing verified winners remain safe.
- Worker rechecks chunk count, exact order/index/size, SHA-256, source ownership and whole-archive SHA-256 before any Git mutation.
- ZIP validation checks central/local header correspondence, duplicate names, CRC, compression method, declared/actual size, overlap, path safety, symlinks/special files, file/directory conflicts and expansion limits. UTF-8/CP437 names and Unicode path extras are handled. No ordinary extension is filtered; binary bytes and relative paths are preserved.
- Per-path manifests and blob acknowledgements persist. SHA-identical files share a blob operation; unchanged/already-present objects are reused. Request concurrency starts at six, is bounded at sixteen, and is coupled with a separate byte-allocation gate. Persistent per-user mutation budgets and rate-limit deferral preserve GitHub Retry-After across restarts.
- The original branch/base tree is checkpointed. Files missing from the ZIP are never deleted. The candidate commit request persists its parent/tree/job marker/author/committer/timestamp so replay is deterministic. The candidate SHA is stored before publication.
- Publication uses `force:false` and confirms the branch or a descendant containing that commit. No success status/notification is emitted just because blobs or a commit object were created. No-change jobs return Already up to date without a fabricated commit.
- Cancellation fences queued/processing work. A documented publication boundary rejects cancellation once an external ref update may already be underway. `/cancel`, its optional job ID and the progress-message button enforce original-user ownership. Logout cancels that user's unpublished pending jobs.
- OAuth token refresh is serialized and re-read under a credential lock, preserving rotated tokens across concurrent browser/worker requests. Transient OAuth errors do not erase credentials. Repository-installation pagination no longer silently excludes later pages.
- Legacy direct Telegram commits also use the correct singular read-ref endpoint and confirm the final branch before reporting success. The existing direct 20 MiB route remains synchronous; large/long projects should use the browser/worker path.

### Real Telegram progress and success

A notification loop reads persisted bytes/chunks/extracted files/processed files/counts/stage/errors and updates one progress message. Pre-confirmation counts are explicitly described as not committed. ZIP bytes are server-verified stored bytes, not invented in-flight estimates. Speed and current-transfer ETA require a recent measurable delta.

Per-chat three-second and bot-wide pacing, message IDs, samples, notification leases and Telegram Retry-After persist across processes. Terminal text delivery is independent of the animation. Confirmed success includes actual repository/commit URLs; no-change success omits a commit. Failures are reported clearly. A valid 96×96, 13-frame GIF is bundled and uploaded as real multipart bytes; no fabricated Telegram file_id is used.

## Migration and deployment requirements

Existing Stage 2.5 database: apply **`db/migrations/0006_github_processing.sql`** before deploying this code. Fresh database: apply 0001–0006 in order. Migration 0006 is additive/re-runnable and does not remove users, credentials, jobs or files. New tables have RLS and revoke anon/authenticated access.

Run a separate always-on Node worker using **`npm run worker`** or the supplied Docker Compose/systemd configuration. Entry point: `src/worker.ts`; default continuous mode, `--once`, `--check`, `--help` are implemented. No new worker credential/URL variables are required. Every existing ENV name, including optional CRON_SECRET/DATABASE_CA_CERT, is preserved.

GitHub App Contents read/write and Metadata read are required. Workflow file changes also require **Workflows read/write**, accepted by installation owners. Keep Actions read for the existing APK/Actions commands. Branch protection remains authoritative; the worker never force-pushes around it.

Full commands, memory guidance, permissions, hosting limits and recovery semantics: **`docs/STAGE3-DEPLOYMENT.md`**. The actual Vercel plan/account was not supplied; plan-specific deployment limits were documented from official references rather than guessed.

## Executed verification

Local runtime: Node.js 24.22.1. Commands actually executed:

| Check | Actual result |
| --- | --- |
| `npm ci` / `npm install` | Passed; final package-lock.json included |
| `npm run typecheck` | Passed |
| `npm test` | **158 passed, 30 test files, no failed tests** |
| Full pipeline test file | 25 SQL-backed cases, including exact 100 MiB archive, 3,000 paths, interrupted workers, duplicate claims, missing chunks, rate limits, conflicts, permissions, cancellation, OAuth rotation, persistent notifications and parallel chunk verification |
| Uploader DOM tests | 4 passed, using the actual React component with controlled fetch/XHR boundaries |
| `npm run build` | Passed, including compilation, type validation, static generation and traces |
| `npm run worker -- --help` | Passed through the actual executable entry point and imports |
| `runOneJob()` executable processing path | Executed successfully in SQL-backed integration tests, from queued upload through confirmed commit and final notices |
| `npm run worker:check` | **Blocked** without real environment/database credentials; exits non-zero and reports missing required variables, not a fabricated healthy state |
| `npm audit` | 0 known vulnerabilities across installed production/development dependencies after updating tsx to 4.23.15 |
| Built browser JavaScript scan | No SUPABASE_SECRET_KEY, GITHUB_CLIENT_SECRET or ENCRYPTION_KEY identifiers found in .next/static |
| Bundled animation inspection | Valid GIF, 96×96, 13 frames, 1,336 bytes |

GitHub/Supabase/Telegram responses were controlled in the end-to-end tests; PostgreSQL SQL was executed by PGlite. These results do not establish live-provider success or production worker operation.

## Remaining limitations — not a production readiness claim

- No live deployment or real Supabase/GitHub/Telegram integration was executed. No production credentials or worker host were supplied. The implementation is connected and locally tested; it is not an already operational worker or a production-ready certification.
- SQL integration uses embedded PostgreSQL (PGlite) with a serialized pool adapter. Tests exercise real SQL/constraints/checkpoints and controlled external HTTP responses. Multi-connection PostgreSQL contention, real GitHub throttling/protection/organization policies and Telegram delivery still need a deployment smoke test.
- Exact 100 MiB and thousands-of-file tests exercise the full local service/worker path with controlled remote responses. They are not a real 100 MiB internet transfer or a production throughput/memory benchmark.
- The selected branch/repository must have an initial commit; initialize a README first for an empty repository. ZIP64, encrypted archives, unsupported compression and symlinks/special files are rejected explicitly. Git cannot store empty directories. Limits remain 20,000 files, 300 MiB expanded content and 100:1 compression ratio.
- Worker extraction/reconstruction is bounded but buffered, not constant-memory streaming. Start with the documented worker memory allocation and measure real workloads. GitHub quotas can intentionally defer large unique-file jobs for hours; sources have finite retention.
- REST non-force publication is atomic fast-forward safety, not strict expected-head CAS. Publication cannot be safely canceled after the durable boundary. Ambiguous failures are reconciled using the checkpointed commit and branch ancestry; if confirmation ultimately fails, users must inspect GitHub before retrying.
- Telegram sendMessage has no idempotency key. A crash after delivery but before its acknowledgement can duplicate a notification. Optional animation is at-most-once and may be omitted on crash/failure; the confirmed text summary is delivered independently.
- Real Chromium was not executed for this Stage 3 release. Four actual uploader DOM tests ran; the optional Chromium smoke script is included. Docker/systemd configuration was not deployed; no Docker engine was available here.
- Browser tokens expire after 30 minutes; durable processing/Telegram notices continue without the browser. Reopen a private scoped link as needed. Supabase signed upload URLs cannot be individually revoked; cancellation closes the job immediately, while storage deletion waits beyond their validity window.

## Exact source changes

### Modified

- `README.md`
- `package-lock.json`
- `package.json`
- `scripts/check-uploader.cjs`
- `src/app/api/upload/jobs/[id]/ready/route.ts`
- `src/app/upload/uploader.tsx`
- `src/lib/db.ts`
- `src/lib/github/client.ts`
- `src/lib/github/credentials.ts`
- `src/lib/github/linking.ts`
- `src/lib/github/oauth.ts`
- `src/lib/github/repos.ts`
- `src/lib/github/upload.ts`
- `src/lib/telegram/api.ts`
- `src/lib/telegram/callbacks.ts`
- `src/lib/telegram/handlers.ts`
- `src/lib/upload/service.ts`
- `src/lib/upload/zip-entries.ts`
- `tests/upload-database.test.ts`
- `tests/uploader-dom.test.tsx`

### Added

- `.dockerignore`
- `.gitignore`
- `Dockerfile.worker`
- `STAGE3-REPORT.md`
- `assets/upload-success.gif`
- `compose.worker.yaml`
- `db/migrations/0006_github_processing.sql`
- `deploy/github-manager-worker.service`
- `docs/STAGE3-DEPLOYMENT.md`
- `docs/STAGE3-PLAN.md`
- `src/lib/worker/github.ts`
- `src/lib/worker/notifications.ts`
- `src/lib/worker/processor.ts`
- `src/lib/worker/runtime.ts`
- `src/lib/worker/state.ts`
- `src/worker.ts`
- `tests/stage3-direct-commit.test.ts`
- `tests/stage3-github-http.test.ts`
- `tests/stage3-notifications.test.ts`
- `tests/stage3-pipeline.test.ts`
- `tests/stage3-state.test.ts`
- `tests/stage3-zip.test.ts`

No original project file was removed. Build output, node_modules and transient caches are intentionally excluded from the deliverable; the complete source, lockfile, migrations, assets, tests and deployment files are included.
