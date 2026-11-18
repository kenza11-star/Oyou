# Deploy tanpa worker permanen (Vercel + Supabase + GitHub saja)

Arsitektur: `Telegram/Web → Vercel API → Supabase Storage + tabel job → GitHub Actions (process-uploads.yml) → commit ke repo pengguna → status di Supabase → Telegram/Web`.
Tidak ada Railway/Render/VPS/Redis. Webhook Telegram (`/start`, `/login`, `/web`, dll.) **tidak bergantung** pada processor.

## 1. Migrasi database (aman, tanpa menghapus data)
Jalankan di Supabase SQL editor, berurutan, hanya yang belum pernah dijalankan: `0001` … `0008`.
Lalu jalankan `db/verify-migrations.sql`; semua baris harus `ok = true`. Migrasi 0008 hanya menambah kolom/indeks (repeat-safe).
Pemulihan: 0008 additive; jika perlu mundur, cukup berhenti memakai kolom baru (`actions_run_*`, `dispatched_at`, `retry_count`). Tidak ada DROP.

## 2. Variabel Vercel (Production)
Semua variabel di `.env.example`. Tambahan baru:
- `ACTIONS_DISPATCH_TOKEN` (opsional, disarankan): fine-grained PAT **hanya** untuk repo `kenza11-star/Bot-gitele`, izin *Actions: Read and write*. Tanpa ini, job tetap diproses oleh sapuan terjadwal (≤ ~30 menit).
- `WORKER_REPO`, `WORKER_REF` (default `kenza11-star/Bot-gitele`, `main`).
- `DATABASE_CA_CERT`: **isi jika koneksi DB gagal TLS** (`SELF_SIGNED_CERT_IN_CHAIN`). Ambil sertifikat CA dari Supabase → Database → SSL configuration.

## 3. Secret GitHub Actions (repo → Settings → Secrets and variables → Actions)
GitHub melarang nama berawalan `GITHUB_`, jadi dipetakan ke `GH_*`:

| Secret | Isi |
|---|---|
| `DATABASE_URL`, `DATABASE_CA_CERT` | sama dengan Vercel |
| `ENCRYPTION_KEY` | **sama persis** dengan Vercel (untuk mendekripsi token pengguna) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_USER_IDS`, `APP_URL` | sama dengan Vercel |
| `GH_APP_ID`, `GH_CLIENT_ID`, `GH_CLIENT_SECRET`, `GH_APP_PRIVATE_KEY_BASE64`, `GH_WEBHOOK_SECRET`, `GH_APP_SLUG` | nilai `GITHUB_*` yang sesuai |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET` | sama dengan Vercel |

Workflow hanya berjalan di `kenza11-star/Bot-gitele`, tanpa trigger `pull_request`, `contents: read`, dan **tidak pernah** checkout/menjalankan isi ZIP pengguna (ZIP dibaca sebagai byte lalu di-commit via Git API). Token pengguna tidak pernah menjadi input workflow.

## 4. Aktivasi webhook Telegram (tanpa token di URL browser)
Tambahkan secret `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `APP_URL`, lalu: **Actions → “Aktivasi webhook Telegram” → Run workflow → `register`**.
Hasil JSON menampilkan `webhookUrl`, `pendingUpdates`, dan `lastDeliveryError` dari Telegram sendiri (penyebab pasti jika /start tidak dibalas). Mode `check` hanya memverifikasi.
Aktivasi hanya mensyaratkan kesiapan inti (env, database, skema, route). Kesiapan ZIP dilaporkan terpisah dan tidak pernah memblokir.
Secara lokal: `npm run telegram:activate -- --check`.

## 5. Diagnosis cepat jika /start tidak dibalas
`GET /api/health?ready=1` dengan header `x-telegram-bot-api-secret-token: <TELEGRAM_WEBHOOK_SECRET>` mengembalikan `core.problems` (kode galat driver + petunjuk, tanpa rahasia). Log Vercel kini mencatat: `secret token mismatch`, `configuration invalid: <nama variabel>`, `database unavailable (<kode>)`, `update failed`.

## 6. Batasan nyata
- Antrean: satu run memproses job berurutan (concurrency group). Throughput dibatasi menit Actions & rate limit GitHub; tidak ada jaminan instan. Repo privat: 2.000 menit gratis/bulan; sapuan 30 menit ≈ 1.500 menit/bulan bila repo privat — ubah cron atau jadikan repo publik bila perlu.
- Cron GitHub bersifat best effort (bisa tertunda).
- Run dibatasi 60 menit; job yang terpotong dilanjutkan dari checkpoint oleh run berikutnya (maks 7 kegagalan otomatis, lalu gagal terminal; ulang manual maks 3x dari dashboard selama ZIP belum dibersihkan dan publikasi belum dimulai).
- Unduhan APK tetap lewat `/apk` di Telegram; dashboard menampilkan status run Actions.
