# Module 07 — Import URL + Storage/File + Auth/Login + Worker: the bar (scenarios I1–I8)

Reference: `app/api/import-url/route.ts` (248 ln), `app/api/file/[...path]/route.ts` (189 ln), `app/api/storage/route.ts` (55 ln), `lib/deleteFiles.ts`, `worker/index.js` (184 ln), `app/login/page.tsx` (74 ln), `lib/auth.ts` (login rate limiting).

Harness: shared `scripts/gauntlet/` boot. The fetch-mock is NOT needed for import-url (it downloads real URLs — use a LOCAL fixture server: the harness boots a tiny http server serving test files with configurable statuses/redirects/Content-Types, and import-url is pointed at it via seeded URLs).

## I1 — import-url robustness (downloads)

Local fixture server serving: (a) a real 100KB mp4; (b) a small PNG; (c) a 301 redirect → mp4; (d) a 404; (e) a 403; (f) oversized (exceeds MAX_SIZE — read the route's cap); (g) wrong Content-Type (HTML served as mp4 — content sniffing?); (h) a slow stream (bounded time).
Pass: (a)/(b) → item created with correct type + file on disk + size; (c) → follows redirect, item created; (d)/(e) → 4xx clean, no partial file, no crash; (f) → 413, no partial file; (g) → documented behavior (accepted per declared type or rejected — assert whatever the code does, no silent corruption); (h) → bounded time (the fetch timeout), clean error. No orphan files in uploads after any failure (drift scan).

## I2 — file serving (app/api/file/[...path])

Seed items with files; GET the URL.
Pass: correct content + Content-Type; 404 for missing; path traversal attempts (`../`, `%2e%2e`, absolute) → 4xx, never serving outside uploads; a file with a space/unicode name serves correctly; HEAD requests work (or documented); no crash on a directory-style path.

## I3 — storage API + quota

Seed items totaling under/over the quota (UPLOAD_QUOTA_BYTES env — read the storage route).
Pass: GET /api/storage returns used/total/quota consistent with the seeded files (stat-based or DB-based — assert the real contract); over-quota uploads are rejected at finalize (module-00 covered this — regression guard); delete frees the storage accounting (recompute after delete).

## I4 — deleteFiles drift cleanup

Seed items + files; delete some rows directly in the DB (simulating drift); run the drift cleanup path the app exposes (read where deleteFiles/drift cleanup is wired — maybe admin restore or a storage sweep).
Pass: orphan files are removed; live files untouched; traversal-safe paths refused (deleteFiles already guards — assert it); no crash on concurrent delete (two deletes of the same file → both succeed, no ENOENT crash).

## I5 — login/auth

Pass: wrong password → 401 with generic message (no user enumeration); correct → session works; rate limiting: 10+ failed attempts from the same IP → 429/403 (read the rate limiter in lib/auth.ts — MAX_LOGIN_ATTEMPTS=10, window 15 min) and a correct password ALSO fails while limited (lockout); the login page shows the error inline (visual part); a session cookie works across routes (already proven by every harness — smoke check).

## I6 — worker health

Read worker/index.js: what it does (calls the publisher cron on interval, health checks?).
Pass: the worker's HTTP loop logic is sound — no unbounded retry on app-down (backoff?), respects the interval, logs clearly. Since the worker is a separate process, drive it in a harness with a STUB app URL (point APP_URL at the fixture server): assert it calls the cron endpoint with the right auth header, retries with backoff on 5xx, and does not spin. Document the real behavior in the baseline.

## I7 — login page visual (Playwright)

Flows: renders, wrong-password error shown inline, submit disabled while loading, mobile 390×844 no h-scroll, autofocus.
Pass: console errors == 0; screenshots; the inline error text appears after a failed login (assert DOM); no crash on empty fields (validation message or disabled button — assert the real contract).

## I8 — performance

Login page + file serving of a 5MB file: TTFT of the file endpoint ≤ baseline × 1.1 (the file route streams or buffers — read it; buffering a 5MB file per request is a memory concern: assert streaming if the code claims it, or document buffering); the login page initial render measured (rAF probe); numbers recorded in gates/.

## Gates (every round)

`npx tsc --noEmit` 0 · touched-file eslint 0 · `npm run build` 0 · I1–I8 green. Baseline on current code first (round-00) — failing scenarios are the value.

## Out of scope

Upload/finalize (module 00), content CRUD (module 02), channels OAuth (module 04), settings (module 06).
