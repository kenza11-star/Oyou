> **Dokumen historis.** Rujukan ke worker permanen (`npm run worker`, Docker, systemd) sudah tidak berlaku; pemrosesan kini memakai GitHub Actions. Lihat `docs/ACTIONS-DEPLOYMENT.md`.

# Stage 2.5 repair report

Source: the attached `GitHub-Manager-Bot-V2-Stage2-WebUpload.zip`, extracted into a new directory. No older workspace was used. No Stage 3 browser processing was implemented.

## Repairs

1. Supabase private object reads now use the authenticated endpoint. Signed URL creation validates the returned origin/path and uses immutable non-upsert uploads. The browser sends PUT with raw octet-stream bytes and no secret/Authorization/upsert header. Deletion retains the documented prefixes API. Opaque `sb_secret_` authentication stays server-side. Storage reads have timeouts, no cache, response-size bounds, status-code normalization and Retry-After support.
2. Removed delete-before-sign. Each signed request owns a distinct UUID attempt path, recorded in the database. Job and chunk rows are locked in one consistent order for verification/cancellation. Actual server-downloaded bytes must match planned size and SHA-256. Verified winners cannot be overwritten by stale attempts. Duplicate completion (including after finalization) accepts only the same size/checksum and an owned attempt.
3. Added complete-file SHA-256 validation at job creation/resume and finalization. Resume identity includes authenticated user, original repository ID/name/branch, filename, size and content hash. The backend rejects cross-user, cross-repository and mismatched-file requests independently of localStorage. Expired job keys are replaced, not revived. Existing verified chunks are skipped.
4. Private-chat commands prevent public disclosure of login/upload links and repository information. Upload sessions are short-lived, signed and scoped to the selected repository/branch. Each API checks owner and scope. Disconnected GitHub accounts cannot reuse upload sessions. Normal users remain allowed; `/admin` still uses the configured owner/admin IDs only.
5. Browser cancellation aborts XHR/fetch and retry backoff; unmount aborts active work. XHR listeners are removed and transfers have a timeout. Completion retries do not upload bytes again. Cancellation during final file hashing prevents finalization. Active-job creation quotas are atomic, and signed attempts are bounded to 20 per chunk.
6. Safe cleanup records all abandoned attempt paths, waits beyond signed URL lifetime and rechecks current state under lock. Failed deletions stay eligible for retry. Canceled jobs cannot be verified or resurrected by delayed completion requests.
7. Fixed the existing missing `githubAppSlug` in the authorization test fixture. Added Next-required TypeScript configuration. Added a real lockfile and updated vulnerable framework, React, ZIP parser and development-test dependencies; PostCSS has a pinned security override.

## Migration instructions

- Fresh database: apply 0001, 0002, 0003, corrected 0004, then 0005 in order.
- Already through 0004: apply **0005_upload_safety.sql** before deploying the new code. Do not replay 0001–0003.
- 0005 only adds nullable checksum/path columns and an RLS-protected attempt table/index. No existing user data is removed or rewritten. It is re-runnable.
- Corrected 0004 is transactional, keeps all statuses from 0001 and no longer changes unknown historical statuses to `failed`; a NOT VALID check preserves existing rows and enforces new writes. Existing 0004 installations do not need to replay it. Previous normalization cannot be automatically undone.
- Old jobs without a whole-file checksum remain stored. They cannot be resumed with the new identity format; select the original file through a fresh `/upload` link to create a new job.
- If historical duplicate active GitHub links prevent 0002's unique index, ownership must be resolved explicitly; no automated identity deletion was added.

## Verification

Executed on Node.js v24.22.1:

| Check | Result |
| --- | --- |
| `npm install` | Passed; valid package-lock generated and retained |
| `npm run typecheck` | Passed |
| `npm test` | Passed: 123 tests in 24 files, including 11 SQL integration tests and 4 uploader DOM tests |
| `npm run build` | Passed: production Next.js compilation, type validation, page generation and traces |
| `npm audit` | Passed: 0 known vulnerabilities across installed production and development dependencies |
| Browser bundle credential-marker scan | No Supabase secret-key, encryption-key or GitHub client-secret identifiers found in `.next/static` JavaScript |
| Real Chromium smoke | Blocked by environment, not claimed passing |

The 100 MiB exact boundary, binary/dotfile/workflow/Android-file preservation, checksum failure, missing chunks, cross-user ownership, scope isolation, expiry, duplicate completion, stale attempt rejection, cancellation during finalization, and cleanup were covered locally.

## Remaining deployment checks and limitations

- No live Supabase/GitHub/Telegram calls or production database migrations were executed: deployment credentials were not supplied. The service tests use PGlite PostgreSQL and mocked Storage/GitHub boundaries. The DOM tests use the actual uploader component with simulated HTTP and XHR.
- PGlite runs on one connection. Cross-instance row-lock contention must still be checked on the deployed PostgreSQL service; it is not claimed as a live concurrency test.
- Real Chromium smoke execution was blocked: the browser download returned an invalid archive, and the preinstalled Chromium process could not create its singleton socket (`Operation not permitted`). The optional browser smoke script is included but is **not reported as passing**. Four uploader DOM tests executed successfully.
- Confirm that Telegram preserves the fragment in inline upload links in your deployed client. Use `/upload` privately to mint a fresh scoped link after upgrading.
- Supabase signed upload URLs cannot be individually revoked. Job cancellation blocks application use immediately; cleanup waits three hours beyond the last signed attempt before deleting objects. Configure optional `CRON_SECRET` to enable the existing scheduled cleanup.
- Finalization reads the archive a second time for integrity and declares a 300-second function duration. Confirm hosting-plan support and run an actual 100 MiB upload against the deployed bucket. The 100 MiB boundary and 6/16 concurrency bounds are covered by local tests; a real 100 MiB network transfer is unverified.
- Browser uploads intentionally stop at `uploaded`; GitHub processing remains Stage 3. Existing Telegram direct-upload commits and other features remain present.

## Files changed

### Modified

- `README.md`
- `package.json`
- `tsconfig.json`
- `src/app/api/upload/jobs/route.ts`
- `src/app/api/upload/jobs/[id]/chunks/[index]/complete/route.ts`
- `src/app/api/upload/jobs/[id]/ready/route.ts`
- `src/app/upload/uploader.tsx`
- `src/lib/supabase/storage.ts`
- `src/lib/telegram/handlers.ts`
- `src/lib/telegram/callbacks.ts`
- `src/lib/upload/session.ts`
- `src/lib/upload/service.ts`
- `src/lib/upload/http.ts`
- `src/lib/upload/token.ts`
- `src/lib/transfer/engine.ts`
- `tests/upload-token.test.ts`
- `tests/upload-validation.test.ts`
- `tests/upload-session.test.ts`
- `tests/zip-limits.test.ts`
- `tests/authorization.test.ts`
- `tests/transfer-engine.test.ts`
- `db/migrations/0004_upload_jobs.sql`

### Added

- `STAGE-2.5-REPORT.md`
- `db/migrations/0005_upload_safety.sql`
- `next-env.d.ts`
- `package-lock.json`
- `scripts/check-uploader.cjs`
- `src/app/api/upload/context/route.ts`
- `src/lib/upload/resume.ts`
- `tests/resume-identity.test.ts`
- `tests/storage-http.test.ts`
- `tests/upload-database.test.ts`
- `tests/upload-http-auth.test.ts`
- `tests/upload-reliability.test.ts`
- `tests/upload-scope.test.ts`
- `tests/uploader-dom.test.tsx`
- `vitest.config.mts`

### Renamed

- `vitest.config.ts` → `vitest.config.mts` (ESM test config)

