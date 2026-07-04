# DISPATCH — the ONE live work order (2026-07-04)

**This is the only document to dispatch agents from.** It turns the 6-model migration-readiness audit (`../../rank.md` + the source audit) into copy-pasteable lanes. Every claim below was re-verified against the code at `25c4b35` before it became a lane — findings that failed verification (qwen's cross-tenant HIGH, the three "missing" indexes that exist) are NOT here.

**How to use:** copy ONE fenced block below — it is the agent's ENTIRE job (branch, spec, tests, constraints, gate, report format). Paste it verbatim to one agent. The agent pushes its branch and reports; the main session re-gates in a clean checkout, merges `--no-ff`, deletes the branch, and marks the lane DONE here in the same turn.

**Scope discipline:** this repo is the SellRight **product** (`D:\Claude\sellright`), not the RightApps fork. Edit here, push `origin/main`, pull on the box. Every lane targets `packages/api` unless it says otherwise. No lane may touch `packages/storefront` payment code except S-CFG-flip (Lane P1) and only behind the flag.

## Dispatch table — status (updated 2026-07-04)

Phase 1 (pure-code security) = **MERGED to `main`** (laptop-validated: typecheck + 169 unit tests + build + deps:audit). Phase 2 (DB/money) = **built + typechecked + pushed as branches, UNMERGED** pending box validation (no local test DB) — see `BOX-VALIDATION-CHECKLIST.md`.

| # | Lane | Class | Status |
|---|---|---|---|
| 1 | SEC-1 newsletter SSRF + rate-limit | security | ✅ **MERGED** `3b71c58` |
| 2 | SEC-2 admin-logout CSRF + bearer-validated CSRF | security | ✅ **MERGED** `4b421da` |
| 3 | SEC-3 blog HTML sanitization | security | ✅ **MERGED** `8f50ae7` (adds `sanitize-html`) |
| 4 | SEC-4 download open-redirect allowlist | security | ✅ **MERGED** `57548d4` |
| 5 | SEC-5 trusted-proxy IP + Secure-from-scheme + sanitize errors | security/config | ✅ **MERGED** `5b6ecd9` |
| 6 | HYG-1 pnpm CI/local version match | hygiene | ✅ **MERGED** `1204615` |
| 7 | MONEY-1 payment idempotency: unique `(store_id,provider_ref)` + store-scoped claim | money integrity | 🟢 **BOX-GREEN, branch** `feat/money-payment-idempotency` `2c75e9f` — box `test:db` **51/51** after fixing a real `42P10` bug it surfaced. NOT merged. |
| 8 | MONEY-2 refund idempotency key + lock return-approve (+gateway-out-of-txn deferred) | money integrity | 🟡 **branch, rebased on fixed MONEY-1** — push pending (force-push approval); not box-validated |
| 9 | MONEY-3 draft `markPaid` issues licenses | money/fulfillment | 🟡 **branch** `fix/money-draft-license` `b195602` — typecheck-clean; not box-validated |
| 10 | OPS-1 host→store routing + CORS + pool connect-timeout | multi-tenant blocker | 🟡 **branch** `feat/ops-host-routing-cors` `bd53f62` — not box-validated (host via `store.config`, CORS via `hono/cors`) |
| 11 | OPS-2 job leader-lock + release-stale batch/lock | multi-instance | 🟡 **branch** `fix/ops-job-leader-lock` `2bc2f69` — not box-validated |
| 12 | SEC-6 RBAC: gate refunds/cancel/releases | security | 🟡 **branch** `fix/sec-rbac-refunds` `bcd74c1` — not box-validated (deny-by-default — grant keys before deploy) |
| 13 | PERF-1 `order(store_id,code)` index | perf | ⚪ **NO-OP** — index already exists (`order_store_code` unique, `0000`) |

**Box validation (live, 2026-07-04):** `main` (phase-1) validated on the box against real Postgres + RLS — `assert-rls` OK (51 FORCE-RLS tables), **`test:db` 47/47**. MONEY-1 validated → **caught a real bug local gates missed** (partial-index `ON CONFLICT` without its `WHERE` predicate → `42P10` on every payment insert) → fixed → **51/51 green**. MONEY-2/3, OPS-1/2, SEC-6 still need their `test:db` run on the box. Full coverage ledger is at the end of this doc.

**Correction from the audit:** the perf audits claimed 4 missing indexes; PERF-1 verification found **all four already exist**. My own claim-18 ("only `order(store_id,code)` missing") was also too generous — it exists as the `order_store_code` unique constraint. Never add these.

Security + money + ops lanes are independent files and run concurrently; only MONEY-2 waits (it edits the same `admin-orders.ts` refund seam MONEY-1 conventions establish). Never dispatch a lane before its "blocked on" is ON MAIN. Not included as lanes (correct-as-conditions, tracked in the audit but not a code fix here): multi-instance Redis rate-limiter migration (OPS-3, deferred until N≥2), observability floor (pino + `/readyz` — do as OBS-1 when you want it), storefront checkout flag-flip (needs a live test-card run, human gate — not an agent task).

---

## 1. Lane SEC-1 — newsletter SSRF guard + rate-limit  `[security · PARALLEL, dispatch now]`

```
WORKTREE: cd D:/Claude/sellright && git fetch origin && git worktree add ../sr-sec-newsletter -b fix/sec-newsletter-ssrf origin/main && cd ../sr-sec-newsletter

TASK: the PUBLIC, unauthenticated POST /v1/shop/newsletter-signup makes a server-side fetch() to an admin-supplied Listmonk URL with a Basic-auth credential header, bypassing the codebase's own SSRF guard, and is not rate-limited. Route it through safeOutboundFetch and add per-IP rate limiting.

CONTEXT (verified anchors):
- Offending call: packages/api/src/routes/shop-extra.ts:124-129 — reads (row?.config).listmonk = {url, apiUser, apiToken} then `await fetch(`${lm.url.replace(/\/$/,'')}/api/subscribers`, { headers: { authorization: `Basic ${auth}` } })`. No SSRF guard, no rate-limit. Route defined at shop-extra.ts:110.
- The CORRECT pattern already exists: packages/api/src/routes/admin-marketing.ts calls assertSafeOutboundUrl at save + safeOutboundFetch at call. Both live in packages/api/src/security/outbound-url.ts (DNS-pinned, private-IP blocking, redirect-to-private refusal).
- Rate-limit infra: packages/api/src/auth/rate-limit.ts exports clientIp(c) + loginRetryAfter/recordLoginFailure. See any route that calls clientIp (e.g. routes/pay.ts:41 `pay:${payIp}:${method}`) for the usage shape.

SPEC (do exactly this):
  1. In shop-extra.ts newsletter handler, replace the raw fetch with safeOutboundFetch(lm.url + '/api/subscribers', {...}) — import from ../security/outbound-url.js. safeOutboundFetch DNS-resolves + pins the IP + refuses private targets, killing the rebinding + metadata-endpoint vector.
  2. Add per-IP rate limiting at the top of the handler using the existing clientIp()/loginRetryAfter pattern (a `newsletter:${ip}` bucket). On limit, return 429. Pick a conservative window (e.g. 5/15min) mirroring existing buckets.
  3. Keep the try/catch that swallows Listmonk errors (a subscribe failure must not 500 the signup) — but a BLOCKED-by-SSRF-guard throw should be caught the same way and logged, never surfaced with the credential.

TESTS: add packages/api/src/routes/shop-extra.newsletter.test.ts (or extend an existing shop-extra test): (a) a private-IP Listmonk URL is refused by the guard and does NOT perform the outbound call (mock the resolver or assert on the thrown guard error path); (b) the rate-limiter returns 429 after the window is exceeded from one IP. Keep every existing test green.

CONSTRAINTS:
- pnpm ONLY (never npm). Modules stay small. UTF-8. ADD behavior, don't remove the existing success path.
- Do NOT touch the RLS/db layer, other routes, or the money paths. No sub-agents.

DoD GATE (run and paste REAL output): cd packages/api && pnpm build && pnpm typecheck && pnpm test

COMMIT MESSAGE: fix(security): SSRF-guard + rate-limit the public newsletter-signup Listmonk fetch (SEC-1)

WHEN DONE: commit, `git push -u origin fix/sec-newsletter-ssrf`, VERIFY with `git ls-remote origin fix/sec-newsletter-ssrf`, report: branch, hash, ls-remote line, gate tail, files touched, deviations. Do NOT merge to main.
```

---

## 2. Lane SEC-2 — admin-logout CSRF + bearer-validated CSRF exemption  `[security · PARALLEL, dispatch now]`

```
WORKTREE: cd D:/Claude/sellright && git fetch origin && git worktree add ../sr-sec-csrf -b fix/sec-admin-logout-csrf origin/main && cd ../sr-sec-csrf

TASK: (1) admin logout has NO CSRF check while customer logout does — an attacker can force-logout an admin via a cross-site POST. (2) csrfValid/customerCsrfValid grant a blanket exemption to ANY request carrying an `authorization` header, even a bogus one, while the auth chain falls back to the session cookie — a latent CSRF bypass if CORS or Basic-auth ever lands on the API origin.

CONTEXT (verified anchors):
- Admin logout: packages/api/src/routes/admin.ts:61 (POST /v1/admin/logout) — resolves token, deletes session, clears cookies. NO csrfValid(c) call.
- The correct pattern: packages/api/src/routes/auth.ts:234 (customer logout) — `if (!customerCsrfValid(c)) return c.json({ error: 'invalid CSRF token' }, 403);` BEFORE the delete.
- Exemption bug: packages/api/src/auth/cookies.ts:57 `if (c.req.header('authorization')) return true;` (csrfValid) and :81 (customerCsrfValid) — returns valid on header PRESENCE, not on a valid bearer.

SPEC (do exactly this):
  1. admin.ts logout: add `if (!csrfValid(c)) return c.json({ error: 'invalid CSRF token' }, 403);` as the first line of the handler, mirroring auth.ts:234. Import csrfValid if not already imported.
  2. cookies.ts csrfValid (:57) and customerCsrfValid (:81): change the exemption from "authorization header present" to "authorization header present AND it is a well-formed bearer token" — i.e. only exempt genuine API clients, not a victim's cookie-authenticated browser that happens to carry any authorization value. Use the existing bearer() parser (same module the auth chain uses) to require a non-empty parsed token; a missing/malformed bearer must NOT waive CSRF. Do not change behavior for real bearer API clients.

TESTS: extend packages/api/src/auth/cookies.test.ts (or add one): (a) csrfValid returns false when authorization is absent/empty and no valid CSRF token pair is present; (b) csrfValid still returns true for a real bearer; (c) a route-level test asserting POST /v1/admin/logout without a CSRF token returns 403. Keep existing tests green.

CONSTRAINTS:
- pnpm ONLY. UTF-8. ADD, don't remove real-bearer behavior. Do NOT touch the money/db layer. No sub-agents.

DoD GATE (run and paste REAL output): cd packages/api && pnpm build && pnpm typecheck && pnpm test

COMMIT MESSAGE: fix(security): CSRF-protect admin logout + require a valid bearer before waiving CSRF (SEC-2)

WHEN DONE: commit, `git push -u origin fix/sec-admin-logout-csrf`, VERIFY with `git ls-remote origin fix/sec-admin-logout-csrf`, report: branch, hash, ls-remote line, gate tail, files touched, deviations. Do NOT merge to main.
```

---

## 3. Lane SEC-3 — blog HTML sanitization (stored XSS)  `[security · PARALLEL, dispatch now]`

```
WORKTREE: cd D:/Claude/sellright && git fetch origin && git worktree add ../sr-sec-blog -b fix/sec-blog-xss origin/main && cd ../sr-sec-blog

TASK: admin blog input is stored into BOTH `body` and `bodyHtml` with zero sanitization, and the public unauthenticated blog route serves `bodyHtml` verbatim. A compromised/malicious admin (or any staff-role account, given the coarse RBAC) plants stored XSS on every storefront visitor.

CONTEXT (verified anchors):
- Create: packages/api/src/routes/admin-content.ts:47 `body: b.body ?? null, bodyHtml: b.body ?? null` (bodyHtml is the RAW input, unsanitized).
- Update: admin-content.ts:89 `patch.body = b.body; patch.bodyHtml = b.body;`.
- Public read: packages/api/src/routes/shop-extra.ts blog route returns the full row incl. bodyHtml to unauthenticated visitors.

SPEC (do exactly this):
  1. Add server-side HTML sanitization on WRITE. Use `isomorphic-dompurify` (works in Node) OR the `sanitize-html` package — pick one, add it as a dependency with pnpm, pin it. Create a tiny shared helper packages/api/src/lib/sanitize-html.ts exporting `sanitizeBlogHtml(input: string): string` with a conservative allowlist (headings, p, a[href], lists, img[src|alt], strong/em, blockquote, code/pre — NO script, NO event handlers, NO style/`javascript:` URLs).
  2. Apply it in admin-content.ts at create (:47) and update (:89): store the raw markdown/text in `body` (unchanged), store `sanitizeBlogHtml(b.body ?? '')` in `bodyHtml`.
  3. Do not change the public read path shape (it can keep returning bodyHtml — it is now sanitized at rest).

TESTS: add packages/api/src/lib/sanitize-html.test.ts: `<script>`, `onerror=`, and `javascript:` URLs are stripped; allowed tags/attrs survive. If a route test harness exists for admin-content, assert a create with a script payload persists a clean bodyHtml. Keep existing tests green.

CONSTRAINTS:
- pnpm ONLY — add the sanitizer dep via `pnpm add`, commit the lockfile change. Do NOT remove `packageManager` or alter unrelated deps. UTF-8. No sub-agents.

DoD GATE (run and paste REAL output): cd packages/api && pnpm build && pnpm typecheck && pnpm test AND from repo root `pnpm run deps:audit` (paste tail — a new dep must pass the audit gate).

COMMIT MESSAGE: fix(security): sanitize blog bodyHtml on write to close stored XSS (SEC-3)

WHEN DONE: commit, `git push -u origin fix/sec-blog-xss`, VERIFY with `git ls-remote origin fix/sec-blog-xss`, report: branch, hash, ls-remote line, gate tails, the sanitizer package + version chosen, files touched, deviations. Do NOT merge to main.
```

---

## 4. Lane SEC-4 — download open-redirect allowlist  `[security · PARALLEL, dispatch now]`

```
WORKTREE: cd D:/Claude/sellright && git fetch origin && git worktree add ../sr-sec-redirect -b fix/sec-download-redirect origin/main && cd ../sr-sec-redirect

TASK: the licensed-download route 302-redirects to `artifact.path` whenever it looks like an http(s) URL, with no host allowlist. artifact.path is admin/staff-supplied, so a release can point a signed download link from the legitimate domain at an attacker host — a malware-delivery phishing vector for a software store.

CONTEXT (verified anchors):
- packages/api/src/routes/apps.ts:300 `if (/^https?:\/\//i.test(artifact.path)) return c.redirect(artifact.path, 302);` (release create at ~apps.ts:41-54 sets artifact.path with no host constraint).
- The SSRF module already has the primitives: packages/api/src/security/outbound-url.ts (assertSafeOutboundUrl) — but here we want a POSITIVE allowlist of storage hosts, not just "not private".

SPEC (do exactly this):
  1. Add a config-driven allowlist of external artifact hosts. Introduce an env var (e.g. ARTIFACT_EXTERNAL_HOST_ALLOWLIST — comma-separated host suffixes, default empty) validated in packages/api/src/env.ts with the existing Zod pattern.
  2. In apps.ts:300, before redirecting: parse the URL, and redirect ONLY if its hostname matches an allowlisted suffix (e.g. `*.r2.cloudflarestorage.com`, the store's own CDN). If the allowlist is empty OR the host doesn't match, do NOT redirect to an arbitrary host — return 502 with a generic message and log the rejected host.
  3. Keep local (non-http) DOWNLOAD_DIR artifact paths working exactly as before.

TESTS: add/extend an apps route test: an allowlisted host redirects 302; a non-allowlisted external host returns 502 (no redirect); a local path still serves. Keep existing tests green.

CONSTRAINTS:
- pnpm ONLY. UTF-8. ADD the env knob + guard; don't change local-path behavior. No sub-agents.

DoD GATE (run and paste REAL output): cd packages/api && pnpm build && pnpm typecheck && pnpm test

COMMIT MESSAGE: fix(security): allowlist external artifact redirect hosts on licensed downloads (SEC-4)

WHEN DONE: commit, `git push -u origin fix/sec-download-redirect`, VERIFY with `git ls-remote origin fix/sec-download-redirect`, report: branch, hash, ls-remote line, gate tail, the env var name + default, files touched, deviations. Do NOT merge to main.
```

---

## 5. Lane SEC-5 — trusted-proxy IP + Secure-from-scheme + always-sanitize errors  `[security/config · PARALLEL, dispatch now]`

```
WORKTREE: cd D:/Claude/sellright && git fetch origin && git worktree add ../sr-sec-config -b fix/sec-proxy-cookie-errors origin/main && cd ../sr-sec-config

TASK: three linked prod/staging footguns: (1) clientIp() trusts `cf-connecting-ip`/`x-real-ip` unconditionally, so any store NOT behind Cloudflare has spoofable, defeatable rate limiting; (2) the Secure cookie flag and (3) error-message exposure are both gated on `NODE_ENV === 'production'`, so a staging box booted without that value serves session cookies without Secure over HTTP and echoes raw internal errors to clients.

CONTEXT (verified anchors):
- clientIp: packages/api/src/auth/rate-limit.ts:51 `return c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip') ?? c.env?.remoteAddr ?? 'unknown';`
- Secure: packages/api/src/auth/cookies.ts:42 and :68 `const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';`
- Error exposure: packages/api/src/app.ts:97 `const expose = process.env.NODE_ENV !== 'production';` → `:98` echoes err.message.

SPEC (do exactly this):
  1. Trusted proxy: add an env flag (e.g. BEHIND_CLOUDFLARE, default false) + optional TRUSTED_PROXY_HEADER (default 'x-real-ip') in env.ts. clientIp only honors `cf-connecting-ip` when BEHIND_CLOUDFLARE is true; otherwise it uses the configured trusted header / remoteAddr. Never trust an arbitrary client-forgeable header by default.
  2. Secure from scheme: derive Secure from the request being HTTPS (`c.req.header('x-forwarded-proto') === 'https'`) rather than from NODE_ENV, so a TLS-terminated staging box also gets Secure cookies. Keep local http://localhost dev working (no forwarded-proto → no Secure).
  3. Always sanitize errors: in app.ts onError, return a generic 'internal error' to the client unless an explicit debug flag is set (e.g. DEBUG_ERRORS=1), independent of NODE_ENV. Keep the server-side console.error(err) for operator logs.

TESTS: unit tests for clientIp (spoofed cf-connecting-ip ignored when BEHIND_CLOUDFLARE=false; honored when true), and for the error handler (client body is generic without DEBUG_ERRORS). If cookies are unit-testable, assert Secure appears when x-forwarded-proto=https. Keep existing tests green.

CONSTRAINTS:
- pnpm ONLY. UTF-8. ADD env knobs with safe defaults; do NOT weaken any current production behavior. No sub-agents.

DoD GATE (run and paste REAL output): cd packages/api && pnpm build && pnpm typecheck && pnpm test

COMMIT MESSAGE: fix(security): trusted-proxy IP gating + Secure-from-scheme + always-sanitize client errors (SEC-5)

WHEN DONE: commit, `git push -u origin fix/sec-proxy-cookie-errors`, VERIFY with `git ls-remote origin fix/sec-proxy-cookie-errors`, report: branch, hash, ls-remote line, gate tail, the three env knobs + defaults, files touched, deviations. Do NOT merge to main.
```

---

## 6. Lane SEC-6 — RBAC: gate refunds / cancel / releases with per-action permissions  `[security · PARALLEL, dispatch now]`

```
WORKTREE: cd D:/Claude/sellright && git fetch origin && git worktree add ../sr-sec-rbac -b fix/sec-rbac-refunds origin/main && cd ../sr-sec-rbac

TASK: the per-action permission gate requirePermission() is wired for exactly TWO actions (giftcards, webhooks). Every other sensitive admin mutation — refunds, order cancel, release/artifact publish, product/asset delete — is gated only by the coarse requireWrite (any non-read_only staff). A picker/VA staff account can drain revenue via refunds or swap release artifacts. Extend enforcement to the money- and supply-chain-sensitive actions.

CONTEXT (verified anchors):
- The gate: packages/api/src/routes/admin-helpers.ts exports requirePermission(st, action). Enforced today ONLY at admin-marketing.ts (action 'giftcards') and admin-settings-advanced.ts (action 'webhooks').
- Ungated sensitive mutations: admin-orders.ts refund/return-approve (~:173, ~:336), order cancel (admin.ts / admin-order-ops.ts), release create (apps.ts:41-54), asset/product delete (admin-assets.ts, admin-catalog.ts). They call requireWrite/requireManage only.
- Permission keys surface: admin-settings-advanced.ts defines UI_PERMISSION_KEYS (currently ['giftcards','webhooks']).

SPEC (do exactly this):
  1. Define permission keys for the sensitive actions: at minimum `refunds`, `cancel_orders`, `releases` (extend to `products`, `assets`, `returns` if low-risk to add). Add them to UI_PERMISSION_KEYS so the admin can grant/deny them per staff member.
  2. Add `requirePermission(st, '<key>')` immediately after the existing requireWrite in each corresponding handler: refunds + return-approve → 'refunds'; order cancel → 'cancel_orders'; release create/publish → 'releases'.
  3. Deny-by-default posture: a staff member with no explicit permission for a gated action is denied (the gate already throws on absence — verify owner/manager still pass via role, and that an empty staff permission set now fails the gated routes).
  4. Do NOT change behavior for owner/manager (they should retain access via role); the new gate must compose with, not replace, the role check.

TESTS: add tests asserting: owner passes the refund route; a staff account WITHOUT 'refunds' is 403 on refund but still 200 on a non-gated write; the same for cancel_orders and releases. Add a guard-style test (optional but valuable) that every admin refund/cancel/release route calls requirePermission. Keep existing tests green.

CONSTRAINTS:
- pnpm ONLY. UTF-8. ADD gates; do not loosen any existing check or change owner/manager access. Do NOT touch the money math or db layer. No sub-agents.

DoD GATE (run and paste REAL output): cd packages/api && pnpm build && pnpm typecheck && pnpm test

COMMIT MESSAGE: fix(security): enforce per-action RBAC on refunds, cancel, and releases (SEC-6)

WHEN DONE: commit, `git push -u origin fix/sec-rbac-refunds`, VERIFY with `git ls-remote origin fix/sec-rbac-refunds`, report: branch, hash, ls-remote line, gate tail, the permission keys added, files touched, deviations. Do NOT merge to main.
```

---

## 7. Lane MONEY-1 — payment idempotency: unique `(store_id, provider_ref)` + store-scoped claim  `[money integrity · PARALLEL, dispatch now]`

```
WORKTREE: cd D:/Claude/sellright && git fetch origin && git worktree add ../sr-money-idem -b fix/money-payment-idempotency origin/main && cd ../sr-money-idem

TASK: two payment-ledger integrity gaps. (1) applyPaymentResult inserts the payment row UNCONDITIONALLY before the FSM guard, and there is NO unique index on (store_id, provider_ref) — so the /pay-vs-webhook settle race can write TWO payment rows for one Stripe capture (revenue double-count, refund links to the dup). (2) The /pay derived idempotency claim key omits storeId while the processed_event PK is global + RLS-exempt, so two stores that generate the same order-code suffix collide and the second order becomes permanently unpayable.

CONTEXT (verified anchors):
- Unconditional insert: packages/api/src/payments/settle.ts:31 `await tx.insert(s.payment).values({... providerRef: result.providerRef ...})` precedes the `canTransition(...)` guard at :41.
- No unique index: grep of packages/api/drizzle/*.sql shows only a non-unique payment index; there is no `UNIQUE (store_id, provider_ref)`.
- Claim key: packages/api/src/routes/pay.ts:65 `const claimKey = idemKey ?? `pay:${code}:${method}`;` then :67-70 `insert(processedEvent).values({ id: claimKey, storeId: st.id, ... })`. PK is global text: packages/api/src/db/schema-content.ts:33 `id: text().primaryKey()`; processed_event is RLS-EXEMPT (packages/api/src/db/assert-force-rls.ts:20). Order code: packages/api/src/routes/checkout.ts:48 `'SR' + randomUUID()...slice(0,10)`.

SPEC (do exactly this):
  1. New hand-written migration (next number after 0036) adding `CREATE UNIQUE INDEX payment_store_provider_ref_uidx ON payment (store_id, provider_ref) WHERE provider_ref IS NOT NULL;`. Follow the hand-written-migration discipline (this repo has assert-hand-written-migrations — register it correctly so `pnpm verify` passes; do NOT let drizzle-kit regenerate it).
  2. Make applyPaymentResult (settle.ts) insert the payment row with `ON CONFLICT (store_id, provider_ref) DO NOTHING RETURNING ...` and treat 0 returned rows as "already settled" → skip the state transition + downstream side-effects (license issuance is already per-line idempotent; the point is to not double-insert the payment or re-fire the transition). Preserve the manual/COD path where provider_ref may be non-unique or null (the partial index only covers NOT NULL — confirm manual payments still insert).
  3. Store-scope the derived claim key: change pay.ts:65 to `pay:${st.id}:${code}:${method}` (and any sibling derived key). The webhook path already keys on the globally-unique Stripe event.id — leave it.
  4. Also take `SELECT ... FOR UPDATE` on the order at the top of the /pay settle path so the second waiter re-reads committed state (belt-and-suspenders with the unique index).

TESTS (this is a money path — tests are the deliverable): a DB integration test (runs vs sellright_test) proving: (a) two concurrent settles for the same provider_ref yield exactly ONE payment row; (b) two different stores with the same order-code suffix can each pay independently (no cross-store claim collision); (c) manual/COD payment still inserts. Extend the existing settle/checkout DB test files. Keep all tests green.

CONSTRAINTS:
- pnpm ONLY. Migrations run against sellright_test via `pnpm db:migrate` with the 5433 dev/test DSN — NEVER against prod/:5432, NEVER via raw psql/docker (the prod-db-guard hook will block it). UTF-8. ADD, don't remove the manual path. Do NOT touch memright/unrelated crates. No sub-agents.

DoD GATE (run and paste REAL output): cd packages/api && pnpm build && pnpm typecheck && pnpm test && pnpm test:db (against sellright_test) && from repo root `pnpm run verify` (must pass assert-hand-written + assert-rls).

COMMIT MESSAGE: fix(payments): unique (store_id,provider_ref) + ON CONFLICT settle + store-scoped /pay claim key (MONEY-1)

WHEN DONE: commit, `git push -u origin fix/money-payment-idempotency`, VERIFY with `git ls-remote origin fix/money-payment-idempotency`, report: branch, hash, ls-remote line, gate tails (incl. the db test output proving single-row), migration filename, files touched, deviations. Do NOT merge to main.
```

---

## 8. Lane MONEY-2 — refund idempotency key + lock return-approve + gateway-out-of-txn  `[money integrity · SEQUENTIAL — after MONEY-1 on main]`

```
WORKTREE (only after MONEY-1 merged): cd D:/Claude/sellright && git fetch origin && git worktree add ../sr-money-refund -b fix/money-refund-idempotency origin/main && cd ../sr-money-refund

TASK: the refund path can double-refund on retry and orphan a Stripe refund. (1) stripe refunds.create is called with NO idempotencyKey, so an admin retry after a transient failure issues a SECOND refund. (2) The Stripe call runs INSIDE the withStore transaction holding the order row lock across a network RTT (pool-starvation + orphan-on-commit-failure). (3) The return-APPROVE path takes no row lock (unlike the direct refund path), so two concurrent approves both pass the balance check.

CONTEXT (verified anchors):
- No idempotency key: packages/api/src/payments/stripe.ts:145 `stripeClient(input.stripeMode).refunds.create({ payment_intent: input.providerRef, amount: input.amount })` — no 2nd arg. Contrast :169 where createPaymentIntent DOES pass one.
- Direct refund locks + in-txn gateway: packages/api/src/routes/admin-orders.ts:173 `.for('update')` then :204 executeGatewayRefund inside the same withStore.
- Return-approve does NOT lock: admin-orders.ts:309 `tx.select().from(returnRequest)...limit(1)` (no .for('update')), then :322 alreadyRefunded, then :336 executeGatewayRefund.
- Helper: packages/api/src/routes/admin-order-payment-helpers.ts (executeGatewayRefund → provider.refundPayment).

SPEC (do exactly this):
  1. Pass a deterministic idempotencyKey to refunds.create in stripe.ts (e.g. `refund:${orderId}:${amount}:${attempt}` — thread orderId/return-id + a stable attempt token through RefundInput). Stripe returns the same `re_` for a repeat within 24h → no double-refund. This is the single most important line.
  2. Lock the return-approve path: add `SELECT ... FOR UPDATE` on both the returnRequest and the order at the top of the approve handler (admin-orders.ts:309-322), re-checking status after the lock, mirroring the direct refund path at :173.
  3. Move the gateway call OUT of the long-held transaction: restructure so the flow is — short txn to read+lock and claim "refund in flight" → call Stripe (no DB connection held) → short txn to insert the refund ledger row + transition. On ledger-write failure, rely on the existing reconcileStripeRefund webhook path to reconcile (do not leave the gateway call inside a txn that also does other writes). If a full restructure is too broad for one lane, AT MINIMUM ship (1)+(2) and document (3) as a follow-up deviation — but attempt (3).

TESTS: DB integration test: (a) a retried refund with the same key does NOT produce a second ledger row / second gateway effect (assert the idempotencyKey is passed and the second call is a no-op at the ledger); (b) two concurrent return-approves for one return yield exactly one refund. Extend the admin-orders bulk/return test files. Keep all tests green.

CONSTRAINTS:
- pnpm ONLY. Tests vs sellright_test on :5433 only — never prod, never raw psql. UTF-8. Preserve the gateway-before-ledger invariant (a gateway failure must still abort the ledger write). No sub-agents.

DoD GATE (run and paste REAL output): cd packages/api && pnpm build && pnpm typecheck && pnpm test && pnpm test:db && from repo root `pnpm run verify`.

COMMIT MESSAGE: fix(payments): idempotency-key refunds + lock return-approve + gateway outside txn (MONEY-2)

WHEN DONE: commit, `git push -u origin fix/money-refund-idempotency`, VERIFY with `git ls-remote origin fix/money-refund-idempotency`, report: branch, hash, ls-remote line, gate tails, whether (3) landed or was deferred + why, files touched, deviations. Do NOT merge to main.
```

---

## 9. Lane MONEY-3 — draft `markPaid` issues licenses  `[money/fulfillment · PARALLEL, dispatch now]`

```
WORKTREE: cd D:/Claude/sellright && git fetch origin && git worktree add ../sr-money-draft -b fix/money-draft-license origin/main && cd ../sr-money-draft

TASK: a draft/manual order created with markPaid:true inserts a Settled manual payment and flips the order to Paid, but NEVER issues licenses. Every other Paid transition (checkout gift-card full-cover, applyPaymentResult, subscription first cycle) issues licenses. An operator taking a phone order for a licensed/digital product leaves the customer with no license.

CONTEXT (verified anchors):
- packages/api/src/routes/admin-order-ops.ts:60-66 — draft-order handler; :64 inserts `{ ... method: 'manual', state: 'Settled', ... }` when body.markPaid, then audit-logs. `issueLicensesForPaidOrder` is imported nowhere in this file.
- The canonical issuance call is issueLicensesForPaidOrder (used by settle.ts and the checkout gift-card full-cover path) — it is idempotent (per-orderLine shortfall counting, SELECT ... FOR UPDATE).

SPEC (do exactly this):
  1. In admin-order-ops.ts, when markPaid inserts the Settled payment and transitions to Paid, ALSO call issueLicensesForPaidOrder(tx, {storeId, order}) inside the same withStore transaction, matching how settle.ts invokes it (import from the same module).
  2. Because issuance is already idempotent, a later real settlement of the same order must not double-issue — verify the existing per-line guard covers the manual path (add a test).

TESTS: DB integration test: a draft order with a licensed product line + markPaid:true issues exactly the right number of license rows; a second settlement attempt issues zero more. Extend the admin-order-ops / licensing test files. Keep all tests green.

CONSTRAINTS:
- pnpm ONLY. Tests vs sellright_test on :5433 only. UTF-8. Reuse issueLicensesForPaidOrder — do NOT fork issuance logic. No sub-agents.

DoD GATE (run and paste REAL output): cd packages/api && pnpm build && pnpm typecheck && pnpm test && pnpm test:db

COMMIT MESSAGE: fix(orders): issue licenses on draft markPaid, matching every other Paid transition (MONEY-3)

WHEN DONE: commit, `git push -u origin fix/money-draft-license`, VERIFY with `git ls-remote origin fix/money-draft-license`, report: branch, hash, ls-remote line, gate tails, files touched, deviations. Do NOT merge to main.
```

---

## 10. Lane OPS-1 — host→store routing + CORS + pool connect-timeout  `[multi-tenant blocker · PARALLEL, dispatch now]`

```
WORKTREE: cd D:/Claude/sellright && git fetch origin && git worktree add ../sr-ops-routing -b feat/ops-host-routing-cors origin/main && cd ../sr-ops-routing

TASK: three coupled go-live blockers for multi-brand hosting on one API. (1) There is NO host→store routing — every shop route resolves the store from an x-store-slug header and falls back to 'damned'; behind a CDN that strips custom headers, EVERY request becomes a Damned request. (2) There is NO CORS middleware — cross-origin storefronts get blocked. (3) The pg pool connect timeout is 0 (infinite wait), so under saturation requests hang instead of shedding load.

CONTEXT (verified anchors):
- Store resolution: packages/api/src/store-context.ts — `resolveStore(slug)`; the header-or-'damned' fallback is here; its own comment says "in production this maps an incoming host/subdomain to a store" but no such code exists. Per-request entry: packages/api/src/routes/store-context.ts (resolveStoreFromCtx reads the header).
- No CORS: zero `cors|Access-Control` matches in packages/api/src; app wiring is packages/api/src/app.ts.
- Pool: packages/api/src/env.ts:25 `PGPOOL_MAX default 10`, :27 `PGPOOL_CONNECTION_TIMEOUT_MS default 0`; pool built in packages/api/src/db/client.ts:7.

SPEC (do exactly this):
  1. Host→store map: add a resolution layer that maps the incoming Host (or x-forwarded-host) to a store BEFORE the header/fallback. Prefer a `store_domain` table (store_id + host_pattern) queried in resolveStore, OR a per-store host list in store.config — pick the smaller change consistent with the schema; add a hand-written migration if you add a table. Order of precedence: explicit x-store-slug header (dev/admin tooling) > host match > and in PRODUCTION, if neither resolves, return 404 (do NOT silently serve 'damned'). Keep the 'damned' dev fallback only when NODE_ENV !== 'production'.
  2. CORS: add `@hono/cors` (pnpm add) mounted in app.ts with a per-store origin allowlist (from store config / env) and credentials allowed. Do not use a wildcard with credentials.
  3. Pool timeout: change the PGPOOL_CONNECTION_TIMEOUT_MS default to a finite value (e.g. 5000) in env.ts so saturation fails fast with a 503 rather than hanging. Do NOT raise PGPOOL_MAX in this lane (that interacts with the in-txn-gateway money lanes).

TESTS: unit/integration tests: host 'damned.example' resolves the damned store; an unknown host in production returns 404 (not a fallback); an explicit x-store-slug still wins; a CORS preflight from an allowlisted origin succeeds and a non-allowlisted one is rejected. Keep existing tests green.

CONSTRAINTS:
- pnpm ONLY — add @hono/cors via pnpm, commit the lockfile. Any new table = hand-written migration run only against sellright_test on :5433. UTF-8. ADD, don't break the existing header path. No sub-agents.

DoD GATE (run and paste REAL output): cd packages/api && pnpm build && pnpm typecheck && pnpm test (+ pnpm test:db if a migration was added) && from repo root `pnpm run verify`.

COMMIT MESSAGE: feat(multi-tenant): host→store routing + per-store CORS + finite pool connect-timeout (OPS-1)

WHEN DONE: commit, `git push -u origin feat/ops-host-routing-cors`, VERIFY with `git ls-remote origin feat/ops-host-routing-cors`, report: branch, hash, ls-remote line, gate tails, whether you used a store_domain table or config, the CORS package, files touched, deviations. Do NOT merge to main.
```

---

## 11. Lane OPS-2 — job leader-lock + release-stale batch/lock  `[multi-instance · PARALLEL, dispatch now]`

```
WORKTREE: cd D:/Claude/sellright && git fetch origin && git worktree add ../sr-ops-jobs -b fix/ops-job-leader-lock origin/main && cd ../sr-ops-jobs

TASK: the setInterval job scheduler is single-instance-only. The `running` flag guards intra-process overlap, but the moment a second API instance starts, releaseStaleAllocations and abandonStaleCarts and autoDeliver all run on BOTH — releaseStaleAllocations double-releases stock (real data corruption) because it has no FOR UPDATE / SKIP LOCKED / LIMIT. Add a single-leader guard and make the stale-release job claim its rows.

CONTEXT (verified anchors):
- Scheduler: packages/api/src/jobs/scheduler.ts — every() with a process-local `running` flag; no cross-process coordination. deliverWebhooks (packages/api/src/webhooks/emit.ts) is the ONE job done right (FOR UPDATE SKIP LOCKED) — mirror it.
- Corrupting job: packages/api/src/jobs/release-stale-allocations.ts:45 selects `state='PendingPayment' AND createdAt < cutoff` with NO lock/limit; :48 loops per-order line reads then subtracts stock (double-release under two instances; N+1 at scale).

SPEC (do exactly this):
  1. Single leader: wrap the scheduler tick (or each mutating job) in a Postgres advisory lock — `pg_try_advisory_lock(<stable-key>)` at the start of the tick, release at the end; skip the tick if the lock isn't acquired. One instance runs jobs; others no-op. (This is the documented natural fix; do not add Redis in this lane.)
  2. Claim rows in release-stale: add `... FOR UPDATE SKIP LOCKED LIMIT N` to the stale-order select (mirror deliverWebhooks) and batch the stock release (single UPDATE ... FROM (VALUES ...) instead of the per-line loop) so a second instance (or a crash mid-pass) can't double-subtract. Keep the dry-run default (JOBS_RELEASE_STALE_APPLY) behavior.
  3. Leave the other jobs' correctness for a follow-up EXCEPT: make abandonStaleCarts and autoDeliver event/audit writes idempotent OR covered by the same advisory lock (the leader lock alone is sufficient for single-leader safety; note which you relied on).

TESTS: DB integration test: two simulated concurrent releaseStale passes release each stale allocation exactly once (no double-subtract); the advisory lock makes the second tick a no-op. Keep existing tests green.

CONSTRAINTS:
- pnpm ONLY. Tests vs sellright_test on :5433 only — never prod, never raw psql/docker (prod-db-guard blocks it). UTF-8. Keep dry-run defaults. No sub-agents.

DoD GATE (run and paste REAL output): cd packages/api && pnpm build && pnpm typecheck && pnpm test && pnpm test:db

COMMIT MESSAGE: fix(jobs): advisory-lock single-leader scheduler + SKIP LOCKED batched stale-release (OPS-2)

WHEN DONE: commit, `git push -u origin fix/ops-job-leader-lock`, VERIFY with `git ls-remote origin fix/ops-job-leader-lock`, report: branch, hash, ls-remote line, gate tails, the advisory-lock key strategy, files touched, deviations. Do NOT merge to main.
```

---

## 12. Lane PERF-1 — `order(store_id, code)` index  `[perf · PARALLEL, dispatch now]`

```
WORKTREE: cd D:/Claude/sellright && git fetch origin && git worktree add ../sr-perf-index -b perf/order-store-code-index origin/main && cd ../sr-perf-index

TASK: order-by-code lookups (checkout confirm, /pay, tracking) filter on (store_id, code) but there is no composite index for it — verified that cart(token), customer(store_id,email), and variant(store_id,sku) already exist, so this is the ONE genuinely missing index from the audit's list. Add it.

CONTEXT (verified anchors):
- Hot lookups: packages/api/src/routes/pay.ts:56 and checkout.ts confirm read `where(eq(order.code, code))` scoped by store. Existing order indexes (packages/api/drizzle/0007_order_idempotency_and_indexes.sql, 0033_order_soft_delete.sql) cover (store_id, state, created_at), (store_id, placed_at), (store_id, deleted_at), unique (store_id, idempotency_key) — but NOT (store_id, code).
- Migration discipline: hand-written SQL, registered so assert-hand-written-migrations passes.

SPEC (do exactly this):
  1. New hand-written migration (next number after the highest present) adding `CREATE INDEX IF NOT EXISTS order_store_code_idx ON "order" (store_id, code) WHERE deleted_at IS NULL;` (partial to match the soft-delete read pattern). If order.code already has a global unique constraint that Postgres can serve for these lookups, VERIFY that first (grep the migrations); if a serving index already exists, report that and make this lane a no-op with evidence rather than adding a redundant index.
  2. Do NOT add the indexes the audit wrongly flagged as missing — cart(token) [0005], customer(store_id,email) [0000], variant(store_id,sku) [0000] already exist. Adding them would be redundant.

TESTS: `pnpm run verify` must pass (assert-hand-written accepts the new migration; assert-rls unaffected). No behavioral test needed for an index; confirm the migration applies cleanly against sellright_test.

CONSTRAINTS:
- pnpm ONLY. Migration applies to sellright_test on :5433 via pnpm db:migrate — never prod, never raw psql. UTF-8. No sub-agents.

DoD GATE (run and paste REAL output): cd packages/api && pnpm db:migrate (against sellright_test) && from repo root `pnpm run verify`.

COMMIT MESSAGE: perf(db): add order(store_id, code) partial index for by-code lookups (PERF-1)

WHEN DONE: commit, `git push -u origin perf/order-store-code-index`, VERIFY with `git ls-remote origin perf/order-store-code-index`, report: branch, hash, ls-remote line, migration filename, whether an existing unique already served it, gate tail, deviations. Do NOT merge to main.
```

---

## 13. Lane HYG-1 — pnpm CI/local version match  `[hygiene · PARALLEL, dispatch now]`

```
WORKTREE: cd D:/Claude/sellright && git fetch origin && git worktree add ../sr-hyg-pnpm -b chore/pnpm-ci-version origin/main && cd ../sr-hyg-pnpm

TASK: root package.json pins packageManager pnpm@11.9.0 but the CI workflow does `corepack prepare pnpm@10.34.1 --activate` — a major-version drift between CI and local that risks lockfile churn.

CONTEXT (verified anchors):
- package.json:4 `"packageManager": "pnpm@11.9.0"`.
- CI: .github/workflows/*.yml `corepack prepare pnpm@10.34.1 --activate` (grep `corepack|pnpm@` in .github/workflows).

SPEC (do exactly this):
  1. Update the CI workflow(s) to use pnpm@11.9.0 (match package.json exactly). Prefer letting corepack read packageManager (e.g. `corepack enable` + rely on the pinned field) OR explicitly `corepack prepare pnpm@11.9.0 --activate` — whichever the workflow structure favors.
  2. Verify no other workflow or Dockerfile pins a different pnpm.

TESTS: none beyond CI. Locally run `pnpm install --frozen-lockfile` to confirm the lockfile is consistent under 11.9.0 and print the pnpm version.

CONSTRAINTS:
- pnpm ONLY. Do NOT change the lockfile content beyond what a frozen install validates. UTF-8. No sub-agents.

DoD GATE (run and paste REAL output): `pnpm --version` (must be 11.x) && `pnpm install --frozen-lockfile` (paste tail) && from repo root `pnpm run build`.

COMMIT MESSAGE: chore(ci): align CI pnpm to the pinned 11.9.0 packageManager (HYG-1)

WHEN DONE: commit, `git push -u origin chore/pnpm-ci-version`, VERIFY with `git ls-remote origin chore/pnpm-ci-version`, report: branch, hash, ls-remote line, gate tail, files touched, deviations. Do NOT merge to main.
```

---

## Validator contract (main session, every returned branch)
1. Diff review vs the lane spec — scope creep, fence violations (money lanes must not touch RLS crates; security lanes must not touch money math), and confirm the lane did NOT "fix" a non-existent issue (the audit had false positives — e.g. never add the cart(token)/customer(email)/variant(sku) indexes; never treat the cross-tenant-session HIGH as real — RLS blocks it).
2. Re-gate the merge result in a clean checkout: full `pnpm run verify` (+ `pnpm test:db` against sellright_test when a money/db lane). Judge by exit codes, never a wrapper's echo. Money lanes: read the db-test output proving single-row / single-refund yourself.
3. Merge `--no-ff`, push, delete branch + worktree, mark the lane DONE in THIS doc, and sync `docs/FEATURES.md` / `docs/COMMERCE-GAP-ANALYSIS.md` rows in the same turn.

# AUDIT COVERAGE LEDGER — source of truth

Every distinct finding across the 8 audit sections (minimax, glm, deepseek, qwen, kimi, the two unlabeled Production-Readiness + Frontend audits, mimo) is recorded here with exactly one status. The dispatch above deliberately closed only the **security + money blocker tier**; this ledger accounts for the rest so nothing is silently dropped. ~150 distinct findings after de-dup; the lanes close/refute ~25, the remainder are enumerated as PENDING with a tracked ID.

**Status legend:** ✅ ACTIONED — on `main`, box-validated · 🟢 ACTIONED — branch, box-validated green · 🟡 ACTIONED — branch, typecheck-clean, **not yet box-validated** · 🔵 ACTIONED — branch, box-validated FAILED then fixed (see note) · ⚪ REFUTED — verified false against code · ⏳ PENDING — real, not yet a lane · 🚫 OUT — deliberately out of scope (breadth, not migration-blocker) · 👤 HUMAN-GATED.

## 1 · ACTIONED (the 12 lanes)

| Lane | Finding(s) closed | Status | Validation |
|---|---|---|---|
| SEC-1 | newsletter SSRF + no rate-limit (minimax H-1, glm H-1, qwen HIGH-01) | ✅ | on `main` `3b71c58`; box `test:db` on main green |
| SEC-2 | admin-logout CSRF (qwen CRIT-01), CSRF bearer-exemption (qwen, deepseek) | ✅ | on `main` `4b421da`; unit tests |
| SEC-3 | blog stored XSS (qwen CRIT-02/MEDIUM-08, kimi) | ✅ | on `main` `8f50ae7`; unit tests |
| SEC-4 | licensed-download open redirect (qwen LOW-05, kimi) | ✅ | on `main` `57548d4`; unit tests |
| SEC-5 | clientIp spoof (minimax H-2, deepseek M-01, qwen M-02); NODE_ENV cookie/error footgun (minimax M-5, deepseek, qwen M-04) | ✅ | on `main` `5b6ecd9`; unit tests |
| HYG-1 | pnpm CI/local drift (Prod audit) | ✅ | on `main` `1204615`; **confirmed on box** (box pnpm was 10.34.1) |
| MONEY-1 | duplicate payment-ledger race + no unique `(store_id,provider_ref)` (minimax M-1, deepseek "duplicate payment ledger"/High#1); cross-store idempotency-key collision | 🔵→🟢 | branch `feat/money-payment-idempotency` `2c75e9f`. **Box test:db surfaced a real bug** (partial-index `ON CONFLICT` missing its `WHERE` predicate → `42P10` on EVERY payment insert; 8 subscription tests failed). Fixed (`onConflictDoNothing` `where:`); **re-validated box green: 51/51**. NOT merged. |
| MONEY-2 | refund double-spend + no Stripe idempotency key (minimax M-2, deepseek Critical#2); unlocked return-approve | 🟡 | branch `fix/money-refund-idempotency`; rebased onto fixed MONEY-1 locally, **push pending** (force-push to feature branch awaiting approval); not yet box-validated. Gateway-out-of-txn (item 3) **deferred** with rationale. |
| MONEY-3 | draft `markPaid` issues no licenses (minimax, deepseek, kimi C2) | 🟡 | branch `fix/money-draft-license` `b195602`; typecheck-clean; **not box-validated** |
| OPS-1 | host→store routing (minimax A1) + CORS (minimax A2) + pool connect-timeout 0→5000 (deepseek, mimo P0#7, kimi) | 🟡 | branch `feat/ops-host-routing-cors` `bd53f62`; typecheck-clean; **not box-validated**. Host via `store.config.hostnames`; CORS via `hono/cors` (no phantom dep). |
| OPS-2 | jobs unsafe >1 instance + release-stale double-release (minimax A3, deepseek High#2, qwen, kimi P1, mimo P0#5) | 🟡 | branch `fix/ops-job-leader-lock` `2bc2f69`; typecheck-clean; **not box-validated**. Advisory leader-lock + SKIP LOCKED batched release. |
| SEC-6 | RBAC only-2-of-N enforced; refunds/cancel/releases ungated (minimax H-3, qwen, kimi) | 🟡 | branch `fix/sec-rbac-refunds` `bcd74c1`; typecheck-clean (api+admin); **not box-validated**. Deny-by-default — grant keys before deploy. |

**Only phase-1 (SEC/HYG) is on `main`.** MONEY-1 is box-green on a branch; MONEY-2/3, OPS-1/2, SEC-6 are typecheck-clean branches **not yet box-validated or merged** (blocked on: force-push approval for MONEY-2, then per-branch `test:db` on the box). MONEY-1 is the proof that typecheck-clean ≠ correct — it passed every local gate and still broke all payments.

## 2 · REFUTED (verified false — never action)

| Finding | Source | Why false (code) |
|---|---|---|
| Cross-tenant customer session access | qwen HIGH-04 | `resolveCustomer` (`session.ts:41`) has no storeId filter, but its `innerJoin` to the RLS-scoped `customer` table (`:54`) returns 0 rows under the wrong store → token resolves to guest, not another tenant. |
| `cart(token)` index missing | perf audits, kimi 1260 | Exists — `0005_cart_tables.sql`. |
| `customer(store_id,email)` index missing | perf audits | Exists — `0000`. |
| `product_variant(store_id,sku)` index missing | perf audits | Exists — `0000`. |
| `order(store_id,code)` index missing (PERF-1) | claim-18, perf audits | Exists — `order_store_code` UNIQUE (`schema-orders.ts:72`, `0000`), B-tree-backed. PERF-1 = **no-op**. |
| `customer_token_hash_idx` commented out | mimo P0#6 | Re-added in `0023_customer_tokens.sql`. |
| Production runs `tsx` not compiled `dist/` | Prod audit #1911, mimo | REFUTED **on this box**: pm2 `sellright-api` runs `node …/packages/api/dist/index`. (Keep it that way.) |

## 3 · PENDING — real gaps, not yet lanes (tracked IDs)

Correctly scoped OUT of the migration-blocker work order; enumerated here so they're not mistaken for "audited, nothing found." Proposed lane IDs for when they're picked up.

**Reliability / ops** (Prod-Readiness audit + mimo + deepseek):
- `REL-1` graceful shutdown — SIGTERM drain in-flight + close pool (Prod #1876, mimo P0#2, deepseek). **Highest-value pending; every deploy currently drops in-flight requests.**
- `REL-2` `process.on('unhandledRejection')` handler (Prod #1937).
- `REL-3` circuit breaker for Stripe/SMTP (Prod #1878, deepseek Tier-2#4, mimo P2).
- `REL-4` SMTP fire-and-forget → retry / dead-letter (Prod #1880, mimo P1#4).
- `REL-5` `pool.on('error')` health handler (Prod #1862).
- `REL-6` migration runner doesn't wrap files in BEGIN/COMMIT (Prod #1863; low risk — PG DDL is transactional).
- `OBS-1` structured logging (pino) + request-id (Prod #1934, mimo P1#3).
- `OBS-2` readiness probe `/readyz` (DB ping, distinct from liveness) (Prod #1936, mimo P0#3).
- `OBS-3` metrics/APM — Prometheus or Sentry (Prod, mimo P2).
- `SCALE-1` Redis-backed rate-limiter + TOTP replay store — **only when N≥2 instances** (minimax A3 remainder).

**Performance** (kimi + deepseek + mimo — optimizations, not blockers at current scale):
- `PERF-2` no server-side cache / `resolveStore()` per-request DB hit → LRU (kimi 1317, mimo P0#4, deepseek 494).
- `PERF-3` dashboard full-table aggregations per load → rollup/window (deepseek 478).
- `PERF-4` OFFSET pagination → cursor/keyset (Prod #1928, deepseek, kimi).
- `PERF-5` two-query COUNT pattern → `count(*) OVER()` (kimi 1274).
- `PERF-6` ILIKE-OR two-column search → FTS/`to_tsvector` (kimi 1284).
- `PERF-7` `withStore` wraps read-only work in a txn → `withStoreRead` (kimi 1298).
- `PERF-8` checkout re-reads order in a 2nd txn for email (kimi 1341).
- `PERF-9` checkout txn too wide (kimi 1355).
- `PERF-10` cart-merge N+1 (kimi 1365).
- `PERF-11` sequential stock-reservation loop → batched UPDATE (kimi 1385).
- `PERF-12` **auto-deliver N+1** — OPS-2 batched release-stale but NOT auto-deliver (kimi 1253).
- `PERF-13` bulk ops = N transactions (mimo P1#1).
- `PERF-14` webhook delivery holds a connection across the outbound HTTP (mimo P1#2, kimi) — same class as MONEY-2 item 3.
- `PERF-15` no image pipeline; sharp runs in the API process (kimi 1441, Prod #1930).
- `PERF-16` smart-collection browse loads ALL products into JS (mimo P0#5, deepseek).
- `PERF-17` CSV export buffers everything in memory → stream (mimo).

**Frontend / a11y / i18n** (unlabeled Frontend audit + qwen — the entire storefront/admin UI tier, untouched by dispatch):
- `FE-1` broken skip-link (`#main-content` target missing) — WCAG (2092).
- `FE-2` checkout inputs placeholder-only, no `<label>` — WCAG (2094).
- `FE-3` no `aria-describedby` on validation errors (2095).
- `FE-4` breadcrumbs missing `aria-label` (2093).
- `FE-5` i18n entirely stubbed; currency hardcoded USD — a multi-tenant store can't localize (2107-2108).
- `FE-6` CSP `default-src` includes `unsafe-inline data: blob:` — effectively no CSP (2116).
- `FE-7` admin SPA has no CSP headers (2174).
- `FE-8` no React error boundary in admin — one render error white-screens it (qwen).
- `FE-9` storefront still carries dual API layer (Vendure GraphQL + REST) (kimi 1460).
- `FE-10` hardcoded client-side shipping calc disagrees with server (kimi 1469, qwen).
- `FE-11` cart in `localStorage` unencrypted + no expiry (qwen).

**Compliance** (deepseek GDPR/PCI — legal, not just quality):
- `COMP-1` self-service data export — GDPR (901).
- `COMP-2` account deletion / hard-delete cascade — GDPR (903, kimi).
- `COMP-3` consent tracking (905) · `COMP-4` cookie-consent banner (907) — GDPR/CCPA.
- `COMP-5` PCI SAQ-A attestation — required even with Stripe Elements (913).

**Testing** (mimo + all):
- `TEST-1` route-level integration tests for `checkout.ts` / `auth.ts` / `payment-webhooks.ts` — the highest-value untested revenue paths (mimo P0#1). Partially chipped at by the money lanes' new `test:db` files, not closed.
- `TEST-2` E2E checkout→pay→fulfill (no automated end-to-end coverage anywhere).

## 4 · OUT of scope (breadth — tracked in `COMMERCE-GAP-ANALYSIS.md`, not this work order)
Payment breadth (PayPal/wallets/BNPL), automatic tax (Avalara/TaxJar/EU-VAT-MOSS), live carrier shipping, reviews/loyalty/subscriptions-upsell/bundles/wishlist, multi-currency **settlement**, POS/multi-channel. These are product-roadmap items, not migration-readiness gates — see `COMMERCE-GAP-ANALYSIS.md` §"Where competitors are AHEAD".

## 5 · HUMAN-GATED
- Storefront `VITE_SR_CHECKOUT` flag-flip → default — needs a live Stripe test-card run + side-by-side vs Vendure (FEATURES.md launch gap #2). Not an agent lane.

---
_Coverage math: ~150 distinct findings · 12 lanes actioned (6 on main, 1 box-green, 5 branch-only) · 7 refuted · ~45 pending with tracked IDs · breadth + human-gated referenced out. The security+money blocker tier is exhaustively closed or refuted; reliability/perf/frontend/compliance are enumerated PENDING, not silently omitted._
