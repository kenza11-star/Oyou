# Production deployment — GitHub Manager Bot V2

This guide targets **https://bot-xsync-delta.vercel.app**. The release contains the complete application and the GitHub Actions processor (no always-on worker; see `ACTIONS-DEPLOYMENT.md`, which supersedes the worker steps here). Infrastructure must be deployed and tested before the bot can be considered operational. No production credentials are included, requested or printed by the activation CLI.

## 1. Source, build and Vercel root directory

Extract `GitHub-Manager-Bot-V2-PRODUCTION-FINAL.zip`. The project is inside `github-manager-bot/`.

- If that folder remains in your Git repository, set Vercel **Root Directory = github-manager-bot**.
- If you commit the folder's contents directly at repository root, use the repository root instead.
- The selected root must contain `package.json`, `package-lock.json`, `next.config.mjs` and `src/app/`.
- Select the Next.js framework and Node.js **24.x**. The supplied `vercel.json` declares Next.js, `npm ci`, `npm run build` and the existing cleanup cron. Leave Output Directory at the framework default.
- Deploy through the existing Git integration or Vercel dashboard after the database upgrade below. Do not replace the project with a static HTML deployment.

Local validation:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm start` serves a built application locally. ZIP processing runs in GitHub Actions via `npm run worker:actions` (also `worker:once`, `worker:check`); it is not a Next.js request handler and not a permanent process.

The production routes implemented by this release are:

| Purpose | URL |
| --- | --- |
| Uploader | https://bot-xsync-delta.vercel.app/upload |
| GitHub OAuth callback | https://bot-xsync-delta.vercel.app/github/callback |
| Telegram webhook | https://bot-xsync-delta.vercel.app/api/telegram/webhook |
| Public liveness | https://bot-xsync-delta.vercel.app/api/health |
| Protected readiness | https://bot-xsync-delta.vercel.app/api/health?ready=1 |

An empty GET to the callback must return **400**, not 404. GET to the POST-only webhook normally returns **405**. POST to the webhook without its secret must return **401**. Public health must return service `github-manager-bot`, version `4`. These route probes alone do not prove external authentication works.

## 2. Existing ENV names — preserve values securely

Set the existing **Production** Vercel environment, and the matching GitHub Actions secrets (`GITHUB_*` names are mapped to `GH_*`, see `ACTIONS-DEPLOYMENT.md`), to the corresponding current values. No variable was renamed:

| Variable | Use |
| --- | --- |
| TELEGRAM_BOT_TOKEN | Bot API authentication |
| TELEGRAM_WEBHOOK_SECRET | Header validation and protected readiness; 1–256 characters allowed by Telegram: letters, digits, underscore, hyphen |
| GITHUB_CLIENT_ID | GitHub App OAuth client |
| GITHUB_CLIENT_SECRET | OAuth exchange/refresh and grant revocation |
| GITHUB_APP_SLUG | App installation link |
| DATABASE_URL | Existing PostgreSQL connection |
| SUPABASE_URL | Existing project API origin |
| SUPABASE_SECRET_KEY | Server-only Storage authentication |
| SUPABASE_STORAGE_BUCKET | Keep `github-uploads` |
| ENCRYPTION_KEY | Existing base64 32-byte AES-GCM key; keep it stable to decrypt existing credentials |
| TELEGRAM_ALLOWED_USER_IDS | Comma-separated owner/admin IDs; normal users are not restricted by this list |
| APP_URL | Set exactly `https://bot-xsync-delta.vercel.app` (HTTPS origin, no path/query/credentials) |
| GITHUB_APP_ID | Preserved required configuration; current per-user OAuth flow does not mint app-installation JWTs |
| GITHUB_APP_PRIVATE_KEY_BASE64 | Preserved required configuration; not exposed to the browser |
| GITHUB_WEBHOOK_SECRET | Preserved required configuration; this release uses `/actions` polling, not a GitHub webhook receiver |

Optional `CRON_SECRET` and `DATABASE_CA_CERT` keep their names. Use a long unpredictable webhook secret; the application checks Telegram's legal format but cannot assess the entropy of an existing value. Never paste secrets into a URL, command argument, ticket or screenshot.

`DATABASE_CA_CERT` can provide a PEM CA chain when the default trust store cannot verify your PostgreSQL endpoint. Database TLS always verifies certificates. URL SSL query options, including `ssl=false`, cannot override this setting. Connection/query timeouts are bounded.

The processor/activation CLI can load a protected environment file through Node when you run it by hand on a trusted machine:

```sh
node --env-file=.env.local --import tsx src/worker.ts --check
```

`.env*` files (except `.env.example`) are excluded from Git. Create the file privately from `.env.example`, fill existing values and set mode 0600. Do not send the file or its contents to someone else. In production the same values live only in Vercel and GitHub Actions secrets.

## 3. Supabase SQL migration order

Back up the production database using your existing process before changing its schema. No migrations were run against production during this task.

| Current database state | Apply |
| --- | --- |
| Fresh database | 0001 through 0008, in order |
| Stage 2 through 0004 | 0005, 0006, 0007 |
| Stage 2.5 through 0005 | 0006, 0007 |
| Stage 3 through 0006 | 0007, 0008 |
| Through 0007 | **0008_actions_worker.sql only** (additive: dispatch/run columns, retry counter, recovery index) |

Do not replay 0001–0003 on an existing database. 0004–0008 are re-runnable; the final release's 0007 adds session revocation versions, webhook delivery claims and worker heartbeat state. Existing users, encrypted credentials, jobs and files are preserved. Existing processed-update records default to completed so historical messages are not processed again.

For the supplied Stage 3 database, from a trusted administrator shell with PostgreSQL client installed:

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f db/migrations/0007_production_hardening.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f db/migrations/0008_actions_worker.sql
```

For a **fresh, empty** database only:

```sh
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f db/migrations/0001_init.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f db/migrations/0002_auth.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f db/migrations/0003_repos_and_refresh.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f db/migrations/0004_upload_jobs.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f db/migrations/0005_upload_safety.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f db/migrations/0006_github_processing.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f db/migrations/0007_production_hardening.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f db/migrations/0008_actions_worker.sql
```

0004–0008 already contain transaction boundaries. You can use Supabase SQL Editor to execute the same files in order. If historical duplicate GitHub account ownership blocks 0002's unique index, resolve ownership explicitly; do not delete identities automatically. The private `app` schema must not be exposed or granted to anonymous browser roles. All application tables are RLS-enabled; the server/worker uses the existing appropriately privileged database role.

Safe inspection:

```sql
select upload_session_version from app.telegram_users limit 0;
select processing_status, lease_until from app.processed_updates limit 0;
select to_regclass('app.upload_job_files'), to_regclass('app.worker_heartbeats');
select dispatched_at, actions_run_id, retry_count from app.upload_jobs limit 0;
select c.relname, c.relrowsecurity
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='app' and c.relkind='r';
```

Reauthentication/logout invalidates previous browser upload links. Open a fresh private `/upload` link after either action. Checkpointed jobs remain owner-bound; an account switch cancels unpublished work belonging to the previous connection.

## 4. Private Storage bucket

Keep the existing bucket **github-uploads** private. Review and run `db/setup-storage.sql` manually if necessary; it creates a missing bucket and sets private access without deleting objects or changing an existing size/MIME policy.

Each chunk is 8 MiB with content type `application/octet-stream`. The bucket/project limit must permit that size, and MIME rules must allow octet-stream or be unrestricted. A 100 MiB ZIP is split into chunks, so no 100 MiB Vercel request body is needed. Image, source and workflow files remain inside the ZIP; the bucket does not need a separate MIME allowlist for every archive entry.

Do not add public read/write policies. Signed upload URLs are minted server-side, and the browser receives only per-attempt upload capabilities, never the secret key. Private download checks, SHA-256, ZIP CRC and cleanup safety remain active.

## 5. GitHub App settings and permissions

Verify in the existing GitHub App dashboard:

- OAuth callback: **https://bot-xsync-delta.vercel.app/github/callback**.
- Contents: read and write; Metadata: read.
- Actions: read for workflow/artifact operations.
- Workflows: read and write to change `.github/workflows/*.yml` or `.yaml`; installation owners must accept permission changes.
- Install the App on every repository the corresponding user needs. Each public user connects their own GitHub account with `/login`.

The server checks user installation access at selection and processing/publication. Branch protection may still reject direct pushes; no force-push bypass is used. The repository must have an initial commit. Initialize a README first if empty.

Use `/repos` to select an authorized repository, `/branch` to list up to 30 branches, and `/branch feature/name` to select an existing branch. Both browser and direct Telegram upload now use the selected branch. Existing upload links remain bound to their original repository/branch.

## 6. GitHub Actions processor — required

ZIP processing runs in `.github/workflows/process-uploads.yml` in repository `kenza11-star/Bot-gitele`. There is no always-on worker, Docker host or systemd unit. Complete steps (Actions secrets, optional `ACTIONS_DISPATCH_TOKEN`, limits) are in **`docs/ACTIONS-DEPLOYMENT.md`**; do them before activating the webhook.

Manual commands, with the production environment loaded on a trusted machine:

```sh
npm run worker:check    # configuration + schema check
npm run worker:once     # process at most one job
npm run worker:actions  # drain the queue, then exit
```

Without `ACTIONS_DISPATCH_TOKEN`, queued jobs are picked up by the 30-minute scheduled sweep (best effort, can be delayed). Lease recovery, immutable blob checkpoints, deterministic commits, non-forced publication and at-least-once Telegram delivery are described in `STAGE3-DEPLOYMENT.md`.

## 7. Telegram activation — executable and safe

No production webhook was registered by this task. The code's implemented POST route is exactly:

**https://bot-xsync-delta.vercel.app/api/telegram/webhook**

Show the public target URLs without reading or printing tokens:

```sh
npm run telegram:activate -- --dry-run
```

With the existing environment loaded on a trusted host, verify an existing registration without changing it:

```sh
node --env-file=.env.local --import tsx scripts/telegram-activate.ts --check
```

Register/update after app, migrations, private bucket and Actions secrets are ready (or use the *Aktivasi webhook Telegram* workflow):

```sh
node --env-file=.env.local --import tsx scripts/telegram-activate.ts
```

Equivalent with variables already provided by a service manager:

```sh
npm run telegram:activate
```

The script:

1. Checks final public liveness/version and the implemented callback route.
2. Checks protected readiness using the current webhook secret.
3. Confirms unauthenticated webhook POST is rejected and an authenticated empty/no-op POST is accepted without producing user actions.
4. Calls `setWebhook` using the real bot token in a private HTTPS request, `secret_token=TELEGRAM_WEBHOOK_SECRET`, and allowed updates `message` / `callback_query`.
5. Keeps `drop_pending_updates=false` so existing messages are not discarded.
6. Calls `getWebhookInfo` and fails if its URL does not match.

Bot tokens, webhook secrets, provider responses and token-bearing transport errors are not printed. A failed deployment check stops before registration. The no-op probe verifies the route but is not a real Telegram user delivery. A successful registration must still be followed by the public-user tests below. Past `getWebhookInfo` delivery errors are reported as timestamps; inspect fresh delivery after sending `/start`.

Webhook retries are protected by durable claims. Completed deliveries return 200; concurrent active claims return 503/Retry-After; crashed claims can be reclaimed after their 90-second lease. Message side effects are at-least-once under an ambiguous crash, not an invented exactly-once guarantee.

## 8. Public-user acceptance tests

Use a non-admin Telegram account and a small test repository first:

1. `/start` → `/login` → GitHub authorization → return to Telegram.
2. `/repos` → select your private repository → `/branch develop` (or your real branch).
3. `/upload` → open the private link in Android Chrome and Telegram's in-app browser.
4. Confirm repository/branch before choosing a ZIP. Check filename, size, measured progress/chunks/speed, cancel, and resume by reselecting the same ZIP after interruption.
5. Upload source, PNG and `.github/workflows` YAML; verify a real final commit link and unchanged repository files remain.
6. Retry the same project: Already up to date must not fabricate a commit.
7. Try a second public account: it must not select the first account's private repo or inspect its jobs. `/admin` must be restricted.
8. `/actions`, `/apk` with an artifact APK, then with a release APK. Oversized, expired or missing files must produce a clear response.
9. `/status`, `/logout`, old-link rejection, and reauthentication.
10. Test an actual 100 MiB ZIP after the small case passes. Cancel a running Actions run mid-processing and check that the next run resumes from the checkpoint. Confirm the final branch and Telegram notice before calling the installation operational.

Local integration tests use controlled remote responses; they do not replace this live acceptance test.

## 9. Monitoring and cleanup

- Poll public `/api/health` for application liveness. Use the activation `--check` command from a trusted environment for readiness and current webhook URL; never put the readiness secret in a URL or public monitor.
- Inspect Vercel errors/status and the GitHub Actions run history of `process-uploads.yml`. The final release logs failure class/job ID, not credentials or request bodies.
- Inspect `getWebhookInfo` via `--check` for pending update growth and delivery-error timestamps.
- Query PostgreSQL privately for expired leases, undispatched jobs (`dispatch_error`), retry delays, failed jobs and undelivered terminal notices. Do not expose these tables publicly.

```sql
select id, status, dispatched_at, dispatch_error, actions_run_id from app.upload_jobs order by created_at desc limit 20;
select status, processing_stage, count(*) from app.upload_jobs group by status, processing_stage;
select id, status, lease_until, next_attempt_at
from app.upload_jobs where status in ('uploaded','processing') order by created_at;
```

Each Actions run drains the queue before exiting. Optional `CRON_SECRET` enables the retained daily cleanup endpoint at `/api/cron/cleanup`. Failed Storage deletion is retried. Signed URL safety windows and source retention remain intact. Completed/failed job metadata is retained after source-object cleanup.

## 10. Limits and operational status

The actual Vercel account/settings could not be inspected due to API **403 forbidden**. The public domain was reachable during this audit, but `/upload` and `/github/callback` returned **404** on the currently deployed version. Deploy this final source at the correct root before activation. Do not treat the existing root page or a GET 405 on the webhook as proof that the full bot is deployed.

No production Supabase/GitHub/Telegram authenticated calls, migration execution or real phone/in-app browser test were performed. A working bot requires Vercel, PostgreSQL, private Storage, GitHub, Telegram and GitHub Actions to remain operational; no uptime guarantee is fabricated.

Browser jobs support 100 MiB ZIPs, 20,000 files and 300 MiB expanded data with existing anti-bomb limits. ZIP64/encrypted archives, unsupported compression and symlinks are rejected explicitly. The processor uses bounded buffering, not constant-memory streaming. API quotas can defer jobs; the original source retention is finite. Direct Telegram uploads retain the 20 MiB download path and are synchronous, so use the browser/worker path for large or long projects.

## References

- https://core.telegram.org/bots/api#setwebhook
- https://core.telegram.org/bots/api#getwebhookinfo
- https://vercel.com/docs/functions/limitations
- https://supabase.com/docs/guides/storage/buckets/fundamentals
- https://docs.github.com/en/rest/git/refs
