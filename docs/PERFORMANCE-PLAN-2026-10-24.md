<!-- Astra (gpt-6-astra, high) single-pass verification of #360, the gap report and the Ads audit, plus the phased plan. Generated 2026-10-24 from the inputs in ~/sites/tmp/perf-plan-inputs on the Hetzner box (read-only). -->
**SellRight performance verification and implementation plan — 2026-10-24**

**Decision**

Proceed with measurement, isolation, and checkout contention fixes before scaling processes. Separate cacheable content from database-backed availability. Do not implement the proposed stock map, stock debounce, blanket HTML caching, session-scoped RLS helper, or per-core workers across every brand.

#358 addresses the deployed pool starvation mechanism, but the committed implementation needs additional safeguards before release. Neither report establishes current sustainable throughput or proves that hardware is irrelevant.

**Scope and evidence**

- Reviewed committed main `54c6a3ba109ebb06db50794300267a731bc83415`, deployed API `d952d61`, frontend revision `4b5c123d`, Rotten Hand overlay, nginx configuration, supplied captures, and supplied database statistics.
- The first audit contains **69 numbered findings**, not 60.
- Deployed API source was reconstructed with `git show`; the deployed directory contains compiled output.
- No files changed, database connections opened, builds run, deployments performed, or production load generated.
- Measurements below are supplied observations. Targets are proposed acceptance criteria.
- Concurrent edits appeared in `packages/api/src/env.ts`, `packages/api/src/jobs/scheduler.ts`, `packages/api/src/sdk/authorization-matrix.boundary-cases.testkit.ts`, and `packages/storefront/e2e/support/start-api.mjs`. They were preserved, along with `.work/`. Conclusions target the committed revision; the new scheduler test override is not part of that revision.

Evidence aliases:

| Alias | Root |
|---|---|
| `A/` | `/home/vendure/sites/sellright-src/packages/api/src/` |
| `F/` | `/home/vendure/sites/sellright-src/packages/storefront/src/` |
| `U/` | `/home/vendure/sites/sellright-src/packages/admin/src/` |
| `SQL/` | `/home/vendure/sites/sellright-src/packages/api/drizzle/` |
| `R/` | `/home/vendure/sites/sellright-src/` |
| `O/` | `/home/vendure/sites/rotten/storefront/overlay/src/` |
| `N/` | `/home/vendure/sites/nginx/` |
| `I/` | `/home/vendure/sites/tmp/perf-plan-inputs/` |
| `D@` | File at deployed API revision `d952d61` |

Line references identify the inspected implementation. Concurrent edits can shift working-tree lines.

**Verification: original audit**

`CONFIRMED` verifies the mechanism, not an unmeasured severity or throughput estimate. Duplicate findings retain their original IDs and share a resolution.

| Finding | Verdict | Verified result and evidence |
|---|---|---|
| A1: shared request/job pool; aligned intervals | CONFIRMED | Deployed implementation shares the pool and aligns steady-state intervals. Main introduces job scope, separate pools, and staggered scheduling. `D@A/db/client.ts:27`, `D@A/jobs/scheduler.ts:93`; `A/db/client.ts:37`, `A/jobs/scheduler.ts:148`. |
| A2: pinned leader connection across external I/O | CONFIRMED | Deployed leader holds a client throughout the pass. Main replaces this with a lease. SMTP/APNs still lack explicit workflow deadlines; Listmonk already has deadlines. `D@A/jobs/leader-lock.ts:82`; `A/email/mailer.ts:43`, `A/push/apns.ts:101`. |
| A3: LISTEN occupies request slot | CONFIRMED | Deployed listener uses the pool. Main uses a dedicated client. `D@A/store-context.ts:150`; `A/store-context.ts:170`. |
| A4: nested manifest leadership consumes three clients | CONFIRMED | True for deployed implementation. Main leases remove pinned clients. Do **not** remove per-store publication exclusion: drain, startup, and request-triggered publishers have different entry points. `D@A/jobs/scheduler.ts:186`; `A/jobs/scheduler.ts:265`, `A/manifest/stock-hook.ts:144`. |
| A5: full regeneration after stock changes | OVERSTATED | Missing variant IDs select full regeneration, but publishing depends on configuration and queued work can merge. No stock debounce is acceptable. `A/routes/checkout.ts:939`, `A/manifest/stock-hook.ts:115`, `:118`, `:129`. |
| A6: transactional limiter on cart reads and checkout | CONFIRMED | Cart root and GET routes are covered; checkout consumes two budgets. Unlocked `INSERT … SELECT count(*)` would race. `A/routes/cart.ts:215`, `A/routes/checkout.ts:321`, `A/auth/rate-limit-backend.ts:129`. |
| A7: fourth payment necessarily fails; unlimited advisory wait | OVERSTATED | Advisory cap is three at default request-pool size, four at size 20. Failure depends on occupancy and timing. Deployed role lock timeout is 5s; main explicitly disables it. Stripe client has no timeout override. `A/db/client.ts:52`, `:75`; `A/routes/pay.ts:97`, `:274`; `A/payments/stripe-client.ts:22`; `I/db-stats-2026-10-24.txt:13`. |
| A8: nested gateway advisory locks deadlock pool | OVERSTATED | Nested acquisition exists; three concurrent outer job holders are not the default single serial pass. Multiple workers or other payment traffic can still exhaust capacity. `A/jobs/reconcile-gateway-events.ts:15`, `:43`; `A/payments/gateway-payment.ts:264`. |
| A9: fresh webhook delivery pool | CONFIRMED | Two extra connections per pass, outside the main pool budget. Existing teardown and short timeouts must survive any reuse change. `A/webhooks/emit.ts:146`, `:157`. |
| A10: readiness consumes request capacity and leaves waiter | CONFIRMED | Deployed issue exists. Main moves the probe and clears its timer, but `Promise.race` does not cancel the query/acquisition. `A/app.ts:423`, `:431`, `:451`. |
| A11: pool timeout returns 500; no gauges | CONFIRMED | True deployed; main adds 503/Retry-After and gauges. These fixes are not deployed. `A/app.ts:484`, `A/db/client.ts:79`, `:110`. |
| A12: no PostgreSQL timeouts | OVERSTATED | Old installer omission is real. Supplied production roles already have statement 30s, idle-in-transaction 15s, lock 5s. Main compose adds settings. `I/db-stats-2026-10-24.txt:8`; `R/deploy/compose.yaml:65`. |
| A13: shutdown immediately kills requests | OVERSTATED | It stops accepting connections and drains active work; default drain budget is short relative to gateway calls. Compose lacks explicit grace. `A/sdk/create-app.ts:212`, `:229`, `:331`. |
| B1: all promotions locked during pricing, including public quotes | CONFIRMED | Store-wide `FOR UPDATE` occurs for payment or selected-credit-only pricing. Quote routes can activate it. Exact repetition varies by path. `A/money/promotion-resolver.ts:44`, `A/routes/cart.ts:136`, `:244`, `:586`; `A/routes/checkout.ts:797`. |
| B2: store order counter serializes checkout | CONFIRMED | Allocation happens before substantial remaining transaction work. Moving it “last” requires changing code-dependent inserts; independent allocation must happen before taking the main transaction client. `A/routes/checkout.ts:672`, `A/orders/order-number.ts:120`. |
| B3: inconsistent stock lock order | CONFIRMED | Reservation and admin bulk paths follow caller order. Guard covers some implicit updates, but not all stock/counter locks. `A/orders/stock-reservation.ts:53`, `A/routes/admin-products.ts:259`; `R/packages/api/scripts/assert-lock-order.mjs:61`. |
| B4: store `FOR UPDATE` blocks FK checks | CONFIRMED | Replace only updates that cannot change referenced keys with `FOR NO KEY UPDATE`. `A/routes/admin-settings.ts:82`, `:172`; `A/routes/admin-seo.ts:32`; `A/account-credit/service.ts:145`. |
| B5: repeated planning and transaction acquisition | CONFIRMED | Separate planning and locked replanning are real correctness mechanisms. Transaction counts vary; removing planning generically is unsafe. `A/db/locks.ts:413`, `:417`, `:424`. |
| C1: order GET calls Stripe while holding advisory lock | OVERSTATED | GET awaits reconciliation, but the inspected retrieval runs between short locked phases. Network latency still delays GET. `A/routes/orders.ts:107`; `A/payments/stripe-reconcile.ts:414`, `:423`, `:427`. |
| C2: blog sanitation inside transaction caused incident | OVERSTATED | Synchronous sanitation under transaction/row lock is confirmed; incident causation is not. Response is already compact. `A/routes/admin-content.ts:110`, `:120`; `A/routes/admin-blog-protocol.ts:40`. |
| C3: listing join/grouping defeats index | OVERSTATED | Redundant variant join/grouping and extra work are present. Actual index selection requires plans under the application role. `A/routes/catalog.ts:157`, `:179`, `:464`. |
| C4: all promotions/credits loaded; usage N+1; duplicate customer lookup | CONFIRMED | Filter and batch without excluding automatic promotions or exposing other customers’ credits. `A/money/promotion-resolver.ts:44`, `:85`, `:92`; `A/routes/cart.ts:112`, `:437`; `SQL/0052_account_credit.sql:16`. |
| C5: bulk stock does per-item work/purges | CONFIRMED | Per-item statements/events exist. Stock publication is already requested once after the batch, not once per item. `A/routes/admin-products.ts:259`, `:271`, `:285`; `A/webhooks/catalog.ts:21`. |
| C6: password verification under customer row lock | CONFIRMED | Move expensive verification outside the transaction and recheck the password/version before accepting. Raising libuv threads to 16 is not justified without measurement. `A/routes/auth.ts:162`, `:177`. |
| C7 / G2: unknown-host scans | CONFIRMED | Misses scan store configuration and are not negatively cached. Actual RH nginx overwrites tenant routing headers, reducing the claimed public attack surface. `A/store-context.ts:348`, `:366`; `A/cors-origins.ts:74`; `N/rottenhand-sellright.conf:291`. |
| C8: large export materialization | CONFIRMED | Up to 50k rows are materialized. XLSX generation occurs **after** the DB transaction; the writer runs before its stream consumer is attached. `A/orders/export.ts:167`; `A/routes/admin-order-ops.ts:235`, `:249`. |
| C9 / G5: Stripe signature fan-out | OVERSTATED | Bad nonempty signatures can trigger store/mode fan-out. Missing signatures return before it. Stripe lacks the smaller route-specific body cap. `A/routes/payment-webhooks.ts:104`, `:139`, `:158`. |
| C10: order effective-date sort/search lacks matching indexes | CONFIRMED | Query shape verified; cost depends on dataset and plan. `A/routes/admin.ts:362`, `:383`; `SQL/0007_indexes.sql:18`. |
| C11: generic server/proxy defaults mismatch | OVERSTATED | Generic nginx template omits explicit limits/timeouts. RH already sets an 11m upload limit. Exact Node defaults require the deployed runtime. `A/sdk/create-app.ts:276`; `R/packages/admin/nginx.conf.template:20`; `N/rottenhand-sellright.conf:267`. |
| C12: OpenAPI rebuilt each request | UNVERIFIABLE | Route registration and production admin gate verified; installed library implementation was unavailable for confirming regeneration behavior. `A/app.ts:95`, `:614`. |
| C13: unbounded lists; short search terms | CONFIRMED | Blog/collection list limits are absent and one-character search is accepted. “Trigram cannot serve any short query” is too absolute. `A/routes/admin-content.ts:24`; `A/routes/catalog.ts:324`, `:443`. |
| D1: every job always opens per-store transactions | OVERSTATED | Many enabled jobs do, including pending effects; optional flags and job-specific behavior invalidate “every/always.” `A/payments/settlement/effects.ts:332`; `A/jobs/scheduler.ts:250`. |
| D2: crashed webhook claims remain processing | CONFIRMED | Normal delivery claims pending rows; recovery apply flag defaults off. Actual production flag remains unknown. `A/webhooks/emit.ts:85`; `A/jobs/scheduler.ts:330`. |
| D3: global processed-event table scanned per store | CONFIRMED | Unscoped table is repeatedly counted through store loops; apply defaults off and time index is absent. Deletion must preserve replay protection. `A/jobs/processed-event-reaper.ts:46`, `:57`; `A/jobs/scheduler.ts:338`. |
| D4: rate-limit cleanup unbounded/unindexed by time | CONFIRMED | Existing index starts with bucket/key, not cleanup timestamp. `A/auth/rate-limit-backend.ts:206`; `SQL/0078_rate_limit_attempt.sql`. |
| D5: restock notification transaction too broad | CONFIRMED | Up to 200 variants and their waitlists share a transaction. `A/routes/restock.ts:255`, `:283`, `:366`. |
| D6: birthday work repeats whole-day scan/transaction | CONFIRMED | Batches remain inside the same transaction. Existing exclusion prevents granting the same bonus 24 times. `A/loyalty/bonus.ts:173`, `:181`; `A/jobs/scheduler.ts:319`. |
| D7: recovery limit precedes due filtering | CONFIRMED | Backing-off rows can occupy the window. `A/jobs/gateway-recovery.ts:243`, `:251`. |
| D8: reservation sweep starvation | CONFIRMED | Imported reconciliation can retain the marker; query lacks stable order and includes consumed reservations beyond the held-only index. `A/jobs/reservation-release-sweep.ts:31`, `:40`. |
| D9: Listmonk/gateway retry fairness | CONFIRMED | Backoff/fairness gaps exist. Gateway threshold means the 30th failed processing attempt, not 29 failures. `A/jobs/listmonk-sync.ts:206`; `A/jobs/reconcile-gateway-events.ts:56`. |
| D10: auto-deliver locks even in dry-run | CONFIRMED | Locking occurs before the apply check; matching index absent. `A/jobs/auto-deliver.ts:77`, `:99`. |
| D11: exactly 800 sequential gateway calls | OVERSTATED | Four candidate batches can each admit 200; calls per candidate vary. Main no longer pins a leader client. `A/jobs/release-stale-allocations.ts:94`, `:101`, `:117`. |
| E1: compose routes API/assets to SSR | CONFIRMED | Generic Caddy wiring is defective. RH production nginx already routes `/v1/` and assets separately. `R/deploy/Caddyfile:31`; `N/rottenhand-sellright.conf:288`, `:320`. |
| E2: production PostgreSQL uses defaults | WRONG | Generic compose is underconfigured; supplied production is already tuned. `R/deploy/compose.yaml:10`; `I/db-stats-2026-10-24.txt:2`. |
| E3: no resource limits; permissive installer minimum | CONFIRMED | Generic stack lacks explicit CPU/memory budgets; installer accepts approximately 2GiB. Safe capacity is not established. `R/deploy/install.sh:38`; `R/deploy/compose.yaml:10`. |
| E4: generic compose lacks manifest wiring | CONFIRMED | Missing shared manifest configuration combines with a build-time default store slug. RH’s configured snapshot path is a separate case. `F/services/catalog-snapshot.ts:7`, `:42`; `R/deploy/compose.yaml:206`. |
| E5: storefront healthcheck couples startup to SSR/API | CONFIRMED | `/` is fetched with a short timeout; Caddy depends on health. A returned 404 can count as healthy, so host failure behavior is conditional. `R/packages/storefront/Dockerfile:65`; `R/deploy/compose.yaml:239`. |
| E6: nginx stale Docker DNS and no keepalive | OVERSTATED | Generic static upstream can retain an obsolete IP; failure requires an IP change. RH uses a different upstream arrangement. `R/packages/admin/nginx.conf.template:27`; `N/rottenhand-sellright.conf:290`. |
| E7: logs inevitably fill disk | OVERSTATED | Compose has no rotation limits; daemon/host rotation was not established. `R/deploy/compose.yaml`; `A/lib/logger.ts:31`. |
| E8: backup runs pg_dump inside API container | WRONG | `pg_dump` runs in the PostgreSQL container; asset tar runs in API. Resource competition remains. `R/deploy/sellright.sh:76`, `:79`. |
| E9: Node process per health probe | CONFIRMED | Present; low priority relative to critical paths. `R/packages/api/Dockerfile:49`. |
| F1: two home views exhaust request pool | OVERSTATED | Root control calls exist but normally perform no SQL. Snapshot/content paths differ and loaders overlap; five API calls do not imply five held DB clients. `F/routes/layout.tsx:59`, `:104`; `F/platform/home.ts:27`, `:79`. |
| F2: PDP product→review waterfall | CONFIRMED | Generic live fallback is sequential; valid snapshot branch bypasses it. `F/platform/product.ts:44`, `:70`, `:78`. |
| F3: SSR loses shopper IP | CONFIRMED | SSR transport omits it. Impact applies to limited endpoints; forwarding must use trusted ingress identity. `F/utils/sellright.ts:129`; `A/auth/rate-limit.ts:150`. |
| F4: every image variant is the same full-size file | OVERSTATED | Generic image URLs request unsupported transformations. RH nginx already attempts generated derivatives; overlay assets also include real formats. Actual missing-derivative coverage needs an artifact check. `F/routes/layout.tsx:150`; `N/rottenhand-sellright.conf:316`, `:323`. |
| F5: purge fires repeatedly without timeout | CONFIRMED | Purge precedes publication and lacks a bounded request deadline. Stock-driven content purges should disappear after the split. `A/manifest/stock-hook.ts:115`; `A/cache/purge-hook.ts:53`. |
| F6: admin retries every failure | OVERSTATED | Query retry is one; mutations are not universally retried. Use status-aware read retries and preserve mutation idempotency. `U/main.tsx:67`. |
| G1: limiter itself exhausts pool | CONFIRMED | Contended advisory locks retain clients; exact “ten logins” threshold is workload-dependent. Merged with A6. `A/auth/rate-limit-backend.ts:129`; `A/auth/rate-limit.ts:90`. |
| G2: unknown-host amplification | CONFIRMED | Merged with C7; production ingress qualification applies. `A/store-context.ts:348`. |
| G3: feed rebuilds complete catalog publicly | CONFIRMED | Full materialization, no-store, no route-specific limiter. Feed includes availability, so caching the whole feed for 15 minutes violates the stock constraint. `A/routes/feeds.ts:157`, `:162`. |
| G4: coupon enumeration amplification | CONFIRMED | Up to 100 codes per request; pricing mode determines locking. Bound code count and charge attempts per code. `A/routes/cart.ts:197`, `:244`, `:586`. |
| G5: webhook signature amplification | CONFIRMED | Merged with C9; distinguish invalid from absent signatures. `A/routes/payment-webhooks.ts:139`. |
| G6: authentication resource abuse | OVERSTATED | Per-pair budgets leave aggregate gaps and verification occurs inside transactions. Legacy async bcrypt still consumes event-loop CPU; “unlimited” ignores Turnstile/ingress controls. `A/routes/auth.ts:105`, `:162`; `A/auth/password.ts:107`. |
| G7: targeted admin account lockout | CONFIRMED | Account budget is consumed before verification across IPs. Preserve brute-force resistance when replacing hard lockout behavior. `A/auth/rate-limit.ts:90`, `:97`. |
| G8: wildcard/offset expensive queries have no timeout | OVERSTATED | Wildcards and unbounded offsets are real; production has statement timeout. `A/routes/catalog.ts:134`, `:446`, `:454`; `I/db-stats-2026-10-24.txt:8`. |
| G9: IPv6 rotation bypasses per-address buckets | CONFIRMED | Keys use complete IP addresses. Prefix normalization needs explicit IPv6/NAT policy. `A/auth/rate-limit.ts:22`, `:139`. |
| G10: owner SMTP settings allow internal probing | CONFIRMED | Owner-only route accepts arbitrary host/port and exposes transport error detail. Apply DNS-pinned outbound policy without weakening supported SMTP. `A/routes/admin-email-settings.ts:51`, `:69`; `A/email/smtp-settings.ts:114`. |
| G11: HSTS/nosniff absent everywhere | WRONG | Generic Caddy lacks HSTS; admin template includes nosniff and RH nginx explicitly supplies both. `R/packages/admin/nginx.conf.template:9`; `N/rottenhand-sellright.conf:302`. |
| G12a: gift-card balance lacks limiter | CONFIRMED | Route-specific protection absent. `A/routes/shop-extra.ts:163`. |
| G12b: arbitrary production tenant header | OVERSTATED | Application accepts it; RH ingress overwrites it. Harden application trust boundaries for other deployments. `A/store-context.ts:393`; `N/rottenhand-sellright.conf:291`. |
| G12c: credentialed CORS too broad | CONFIRMED | Origin host validation is not tightly bound to resolved store/scheme. `A/cors-origins.ts:64`, `:74`. |
| G12d: NMI timestamp freshness unchecked | CONFIRMED | Signature input includes timestamp without the claimed freshness check. Do not impose a window without validating provider retry semantics. `A/routes/disputes.ts:34`. |
| G12e: unbounded email causes exact 2.7KB index failure | OVERSTATED | Missing length bounds verified; precise failure size depends on index encoding/configuration. `A/routes/auth.ts:105`; `A/auth/rate-limit-backend.ts:129`. |
| G12f: unscoped-access lint coverage incomplete | CONFIRMED | Guard targets route imports of `unsafeUnscopedDb`, not every raw database access. `R/packages/api/eslint.config.mjs:31`. |

**Verification: additional gap-report and Dell findings**

References to A–G merge duplicates above. Each row below covers an additional distinct finding or proposal.

| ID / report finding | Verdict | Evidence and disposition |
|---|---|---|
| V1: zero existing DB-free browse paths; only one memory model | WRONG | Snapshot-backed browse already exists; identity/maintenance can perform zero SQL. Additional caches exist. `F/services/browse-catalog.ts:18`; `F/utils/social-sign-in.server.ts:17`; `A/store-context.ts:36`. |
| V2: no production request timing whatsoever | WRONG | Structured API logs already include duration/status/request ID. Missing pieces are percentiles, acquisition/hold timings, and cross-service attribution. `A/lib/request-id.ts:63`; `N/nginx.conf:32`. |
| V3: 10k sessions/$20 and universal framework/database capacity | UNVERIFIABLE | Static estimates without benchmark workload or hardware equivalence. `I/PERFORMANCE-GAP-2026-10-24.md`, sections 1–2; `I/ads-audit-dell/report.html:109`. |
| V4: session-scoped `withStoreRead` is a safe shortcut | WRONG | Current tenant context is transaction-local. Session state plus reset-on-release adds leakage and pooler failure modes. Retain transaction-local RLS. `A/db/client.ts`, `withStore`; `A/db/locks.ts:413`. |
| V5: existing stock trigger feeds a synchronous NOTIFY map | WRONG | Trigger inserts restock events only on nonpositive→positive crossings; it does not notify every change. PostgreSQL NOTIFY is asynchronous. `SQL/0049_restock_notify.sql:86`, `:93`, `:101`. |
| V6: content split means zero total browse DB transactions | OVERSTATED | It can eliminate content SQL, while live availability remains DB-backed. `A/manifest/catalog.ts:209`; `F/services/catalog-snapshot.ts:44`. |
| V7: every document becomes public-cacheable | WRONG | Account, cart, checkout, preview, personalized loader data, cookies, publication/maintenance gates, and CSP require separate handling. `F/routes/layout.tsx:59`, `:88`, `:104`, `:107`. |
| V8: cache pricing rules, credits, and tax indiscriminately | WRONG | Mutable credit balances, usage limits, eligibility, and final prices require authoritative revalidation. `A/money/promotion-resolver.ts:44`; `A/routes/checkout.ts:797`. |
| V9: worker per core per brand; PostgreSQL gets 25%/75% of host RAM | WRONG | This host has many Node services and two PostgreSQL clusters. Multiplying workers/pools and dedicated-DB memory heuristics oversubscribes shared resources. `I/db-stats-2026-10-24.txt:17`; `A/db/client.ts:72`. |
| V10: add PgBouncer transparently | OVERSTATED | Transaction-local RLS is compatible; session advisory locks and LISTEN need separate direct/session connections. `A/db/client.ts:75`; `A/store-context.ts:170`. |
| V11: exact endpoint SQL and journey totals | OVERSTATED | Conditional credentials, sessions, snapshots, plugins, promotions, lines, reconciliation, and retries change counts. Treat the gap tables as call-path hypotheses, not measured constants. Representative branches: `A/routes/shop-config.ts:72`, `F/platform/product.ts:44`, `A/routes/orders.ts:107`. |
| V12: config repeatedly resolves Stripe credentials | CONFIRMED | Up to three resolution transactions; short-circuiting can reduce that. Reuse one resolved credential bundle per request. `A/routes/shop-config.ts:72`; `A/payments/stripe.ts:96`, `:101`, `:110`. |
| V13: secret-table scans prove config route cost | WRONG | One-row table scans are normal and cumulative counts do not identify callers. `I/db-stats-2026-10-24.txt:34`. |
| V14: PDP config ×3 and guest auth request | CONFIRMED | Three config requests appear in the supplied capture; components independently fetch it. Review auth follows review fetch. `F/components/checkout/PayLaterMessaging.tsx:21`, `ExpressBuyNow.tsx:39`; `F/components/product/ProductReviews.tsx:51`. |
| V15: Stripe alone adds 3.3MB | WRONG | Approximately 3.3MiB is total PDP script transfer in the capture, not isolated Stripe cost. Early SDK loading is real. `I/ads-audit-dell/netcap-live.json`; `F/components/checkout/ExpressCheckout.tsx:120`. |
| V16: every color/size click creates an unlimited unprotected cart | OVERSTATED | Eligible variant changes after wallet detection can create carts. Root cart creation already has a limiter. `F/components/checkout/ExpressBuyNow.tsx:47`; `A/routes/cart.ts:215`. |
| V17: home executes unused collections loader | CONFIRMED | Loader remains exported while branded home rendering does not use its result; live tiles/organization work remains. “Five calls” does not mean five sequential transactions. `F/routes/index.tsx:26`; `F/platform/controllers/content.tsx:178`; `F/platform/home.ts:27`. |
| V18: all bot examples cause SSR + IndexNow lookup | OVERSTATED | Unmatched single-segment paths call the key proxy before checking the name. RH already rejects `.env`, `.git`, wp-admin/wp-login examples. `F/routes/[key]/index.tsx:30`; `F/services/sellright-seo.ts:61`; `N/rottenhand-sellright.conf:117`. |
| V19: snapshot files re-read/reparsed; fallback sequentially pages catalog | CONFIRMED | Serial filesystem work and fallback paging verified. Memoize only after removing stock fields. `F/services/catalog-snapshot.ts:31`, `:44`; `F/sellright/catalog.ts:150`. |
| V20: `/shop` serializes full catalog; category search asks for 10k | CONFIRMED | Payload and fallback scale with catalog size. Use bounded page projections. `F/services/browse-catalog.ts:34`; `F/services/search/categories.ts:15`. |
| V21: collection page truncates after 60 | CONFIRMED | Fixed first-page request limits visible products without corresponding full pagination flow. `F/routes/collections/[slug]/index.tsx:20`. |
| V22: PDP discards live stock unnecessarily | WRONG | Discarding inherited detail stock is deliberate fail-closed behavior. Do not restore cached/SSR stock as purchase authority. Combine content and review aggregate while retaining the live check. `F/sellright/catalog.ts:76`; `A/seo/queries.ts:122`. |
| V23: CSP middleware precedes static serving and can stampede | CONFIRMED | Cache misses await API, map lacks single-flight and a size bound. RH nginx bypasses Node for many assets. `F/entry.express.tsx:87`, `:161`, `:214`; `F/utils/social-sign-in.server.ts:17`, `:54`. |
| V24: any cached nonce makes HTML invalid | WRONG | Matching cached header/body can remain functional; nonce reuse weakens the security model. Hash-based CSP needs an inventory of exact inline scripts, including Qwik state. `F/entry.express.tsx:87`. |
| V25: blog waterfall and repeated sanitation | CONFIRMED | Post then 40 summaries, with per-render sanitation. “Most CPU-heavy page” is unmeasured. Cache by content revision and sanitizer version, not publish date alone. `F/platform/blog.ts:32`; `F/platform/blog-content.ts:83`. |
| V26: auth/me always writes; account makes three calls | OVERSTATED | Force-renew requests write renewable sessions subject to guards. Up to three account lookups exist across separate helpers. `A/routes/auth.ts:683`; `A/auth/session.ts:142`; `F/routes/account/layout.tsx:35`, `F/routes/account/index.tsx:37`. |
| V27: cart/checkout duplicate reads and shipping waterfalls | CONFIRMED | Redundant paths exist; exact 450–600 SQL count is not established. Consolidate same-event work without suppressing cart-open, checkout-entry, or pre-submit live checks. `F/routes/checkout/index.tsx:104`, `:142`, `:159`, `:369`. |
| V28: create empty cart then add line | CONFIRMED | Existing seeded creation can remove a round trip. Preserve cart identity and idempotency. `F/components/checkout/ExpressBuyNow.tsx:47`; `A/routes/cart.ts:556`. |
| V29: confirmation always polls nine times | OVERSTATED | Maximum is initial request plus eight retries; successful/nonpending orders stop earlier. A compact state endpoint avoids repeated full projections. `F/services/confirmation-data.ts:103`. |
| V30: prefetch adds loader work; service worker downloads all JS | OVERSTATED | Data prefetch can execute loaders. Qwik’s core preloader and the image-only service worker are different mechanisms. `F/components/products/ProductCard.tsx:156`; `F/service-worker.ts:10`; `F/root.tsx:27`. |
| V31: browser API always opens fresh upstream TCP | OVERSTATED | Generic admin nginx lacks upstream keepalive configuration; supplied RH deployment differs. Confirm reuse with tracing before Unix-socket work. `R/packages/admin/nginx.conf.template:20`; `N/rottenhand-sellright.conf:298`. |
| V32: duplicate image preloads and oversized home cards | CONFIRMED | PDP declares alternative formats; actual duplicate transfer is browser-dependent. Overlay cards use xxl without card srcset. `F/platform/product.ts:126`; `O/brand/views/route.home.tsx:32`, `:202`. |
| V33: root files universally lack caching | OVERSTATED | Express fallback lacks maxAge; build/fonts and RH nginx already have cache handling. `F/entry.express.tsx:214`, `:232`; `N/rottenhand-sellright.conf:459`, `:490`, `:525`. |
| V34: Turnstile mounts before newsletter intent | CONFIRMED | Visibility-triggered component setup can load it before focus. Claimed 680KB attribution is not independently established. `F/platform/controllers/content.tsx:40`; `O/brand/views/route.home.tsx:396`. |
| V35: 25–100KB inline CSS per page | UNVERIFIABLE | Inline imports exist; capture HTML size does not isolate CSS. Measure emitted CSS/state separately. `F/root.tsx`; `I/ads-audit-dell/netcap-live.json`. |
| V36: five fonts on every page | OVERSTATED | Five declarations exist, but Fraunces 500 is limited to home/blog paths. `O/brand/head.json:11`; `F/platform/head-resolve.ts:235`. |
| V37: warm route warms nothing | OVERSTATED | Product request uses invalid limit 500 against max 100; API rejects rather than clamps it. Other warm routes still execute. `F/routes/cache-admin/warm/index.ts:28`, `:45`; `A/routes/catalog.ts:134`. |
| V38: analytics holds request up to three seconds | CONFIRMED | Forwarding is awaited with timeout; this is a separate beacon request, not necessarily HTML blocking. `F/platform/analytics-sink.ts:14`, `:120`. |
| V39: silent fallback on API failures | CONFIRMED | Identity can fail open to static theme and maintenance can default false. Do not preserve these blindly in the cache design. `F/routes/layout.tsx:71`, `:79`, `:104`; `F/utils/sellright.ts:121`. |
| V40: duplicate Organization JSON-LD | UNVERIFIABLE | Both sources exist, but head resolver deduplicates matching `@id`. Need rendered-output comparison. `O/brand/head.json:74`; `F/platform/head-resolve.ts:251`. |
| V41: global/list search lacks debounce/cancellation | CONFIRMED | Global search starts above one character; shared input updates immediately and transport omits AbortSignal. Six characters do not necessarily mean six queries. `U/components/Layout.tsx:125`; `U/components/ui.tsx:284`; `U/api.ts:55`. |
| V42: tracking import holds up to 5,000 rows in one transaction | CONFIRMED | `upper(code)` lookup and per-order locking/work verified. Preserve case-insensitive semantics when indexing/batching. `A/routes/admin-order-ops.ts:291`, `:371`, `:376`. |
| V43: dashboard/order status correlated work | CONFIRMED | Expressions contain multiple subplans. Not every branch executes for every row; 0.3–2s estimate is unverified. Prefer measured query/preaggregation changes before adding authoritative stored money-status columns. `A/orders/status-sql.ts:40`; `A/routes/admin-dashboard.ts:31`, `:42`. |
| V44: product edit waterfall | CONFIRMED | Product save, changed-variant calls, then refetch are sequential. Exact statement/purge totals vary. `U/pages/ProductDetail.tsx:97`, `:119`, `:124`. |
| V45: bulk fulfil causes 100 full rebuilds | OVERSTATED | It invokes the hook per order, but queued publications can merge; purge attempts remain repeated when configured. `A/routes/admin.ts:788`, `:838`; `A/manifest/stock-hook.ts:129`. |
| V46: reports parallel; dashboard trend sequential | CONFIRMED | Three report queries and dependent dashboard trend verified. `U/pages/Reports.tsx:17`; `U/pages/Dashboard.tsx:62`. |
| V47: all 45 admin pages eagerly shipped | OVERSTATED | Route imports are eager; exact page count and delivered initial bytes require bundle measurement. `U/main.tsx:25`. |
| V48: admin auth then work uses sequential pool acquisitions | CONFIRMED | Principal lookup precedes route work; not two clients held simultaneously. Caching auth for ten seconds would change revocation semantics. `A/auth/admin-session.ts:186`; `A/routes/admin.ts:362`. |
| V49: duplicate admin login me request | CONFIRMED | Post-login navigation/reload repeats shell bootstrap. `U/pages/Login.tsx:49`; `U/auth.tsx`. |
| V50: customer detail four parallel calls | OVERSTATED | Two initial queries; loyalty and verification components mount after customer load. Four calls are not all initially parallel. `U/pages/CustomerDetail.tsx:21`, `:116`; `U/components/CustomerLoyalty.tsx:35`; `CustomerVerification.tsx:29`. |
| V51: order detail/edit-context duplication and history N+1 | CONFIRMED | Share projections within a request or a combined authorized endpoint. `A/routes/admin.ts:396`; `A/orders/order-edit-service.ts:1594`. |
| V52: fulfil/cancel/refund transaction amplification | CONFIRMED | Multiple lock/plan/gateway phases exist; exact counts vary. Merged with A7, B5, V45. `A/routes/pay.ts:274`; `A/payments/gateway-payment.ts:264`; `A/routes/admin.ts:838`. |
| V53: SEO page rebuilds sitemap inputs | CONFIRMED | Preview loads catalog-wide sitemap inputs on each request. Cache content preview by revision. `A/routes/admin-seo.ts:187`, `:191`. |
| V54: settings load/save rewrites broad config | CONFIRMED | Multiple settings consumers and whole-row update paths exist. Six requests is screen-dependent. `A/routes/admin-settings.ts:69`, `:166`; B4. |
| V55: activity timestamp index absent | CONFIRMED | Existing entity index does not match store/time listing. `SQL/0007_indexes.sql:18`; `A/routes/admin-reports.ts:168`. |
| V56: missing reverse collection membership index | CONFIRMED | PK/index lead with collection; pricing queries need product lookup. `SQL/0000_conscious_black_widow.sql:120`; `SQL/0022_indexes.sql:10`; `A/routes/catalog.ts:154`. |
| V57: tenant resolver indexes lead with wrong columns | CONFIRMED | Cross-store provider-reference predicates differ from store-leading indexes. Add only after plans and strict tenant-resolution tests. `SQL/0060_gateway_tenant_resolution_strict.sql:67`; `SQL/0055_payment_refund_identity.sql:22`; `SQL/0083_stripe_intent_attempts.sql:23`. |
| V58: published-blog/active-product indexes missing | CONFIRMED | Proposed predicate/order matches are absent. Benefit is unmeasured on the tiny RH dataset. `SQL/0007_indexes.sql:16`; `A/routes/catalog.ts:157`; `SQL/0068_seo_surface.sql:15`. |
| V59: RLS makes trigram indexes unusable | UNVERIFIABLE | Requires actual plans under each application role, parameter shape, and predicate. Zero index scans on two products proves nothing. `SQL/0029_search_trigram.sql`; `I/db-stats-2026-10-24.txt:58`. |
| V60: product edits do not regenerate snapshot, #357 | CONFIRMED | Product-change hook purges but does not schedule content publication. `A/webhooks/catalog.ts:21`; `A/manifest/catalog.ts:344`. |
| V61: rebuild/purge stock only on zero crossings, debounced | WRONG | Still creates asynchronous cached availability and violates the stated constraint. Remove stock from content artifacts instead. `A/manifest/catalog.ts:209`; `A/manifest/stock-hook.ts:115`. |
| V62: webhook throughput permanently capped at 50/store/minute | OVERSTATED | Default batch is 50, maximum configurable limit is higher, admission window is 40s, and delivery latency matters. Backlog growth depends on subscriptions/event rate. `A/webhooks/emit.ts:46`, `:48`, `:228`. |
| V63: no retention; delete everything after 14–30 days | OVERSTATED | Many completed operational rows lack automatic retention; some deletion/reaper paths exist. Financial, stock, audit, and idempotency history cannot receive one blanket policy. `A/jobs/processed-event-reaper.ts:46`; `A/webhooks/emit.ts:85`; `A/routes/admin-settings-advanced.ts:135`. |
| V64: cart maintenance large transaction/event burst | CONFIRMED | Up to 500 carts locked, then per-cart update/emission. Claimed 1,500 round trips is approximate; quoted source line was stale. `A/jobs/cart-maintenance.ts:77`, `:96`. |
| V65: loyalty reads whole ledger into JS | CONFIRMED | Verified; simple SUM replacement would lose expiry/consumption semantics. `A/loyalty/ledger.ts:68`, `:91`. |
| V66: manifest atomic rename is crash-durable | WRONG | Atomic visibility exists; file/directory fsync does not. Reader safety also depends on generation retention and validation. `A/manifest/publish.ts:267`, `:277`, `:291`. |
| V67: old advisory unlock failure returns locked connection | CONFIRMED | Old helper can release a client after failed unlock without destroying it. Main replaces scheduler helper; audit remaining session-lock helpers separately. `D@A/jobs/leader-lock.ts`, unlock/finally path. |
| V68: synchronous access logging is proven bottleneck | UNVERIFIABLE | Pino stdout configuration does not establish blocking time or bottleneck. `A/lib/logger.ts:28`. |
| V69: production builds/tests caused exact 9.7s stalls | UNVERIFIABLE | Supplied process sample shows CPU competition; temporal correlation does not prove the exact request cause. Treat isolation as necessary regardless. `I/db-stats-2026-10-24.txt`, process sample; `I/ads-audit-dell/report.html:286`. |
| V70: nginx 30r/s applies to every request | OVERSTATED | RH applies the cited limiter to `/v1/`; it is not a blanket document/static limit. CGNAT effects still require monitoring. `N/rottenhand-sellright.conf:288`; `N/rate-limit-zones.conf:6`. |
| V71: supplied page request counts/TTFB are repeatable baseline percentiles | WRONG | Single fresh-context captures, load event plus six seconds, request-finished accounting. No percentiles, origin attribution, CPU profile, or complete long-tail request inventory. `I/ads-audit-dell/netcap.mjs`; `netcap-live.json`. |
| V72: all listed dependencies are past advisories | UNVERIFIABLE | Report explicitly did not check an advisory feed; version declarations cannot establish current vulnerability status. `R/packages/api/package.json`; `I/PERFORMANCE-AUDIT-2026-10-24.md:238`. |
| V73: appendix universally proves bounded caches, indexes, RLS, correctness | OVERSTATED | Specific protections exist; social-sign-in map is unbounded, cross-store provider predicates differ from indexes, and privileged global tables deliberately bypass tenant RLS. Static inspection cannot prove no oversells/double charges across all writers. `F/utils/social-sign-in.server.ts:20`; `SQL/0060_gateway_tenant_resolution_strict.sql:67`; `A/orders/stock-reservation.ts:57`. |

**Findings missed or insufficiently addressed**

| ID | Finding | Consequence / required change |
|---|---|---|
| N1 | Main disables statement and lock timeouts on advisory sessions. `A/db/client.ts:52`. | Regression from production role limits. Bound acquisition, SQL lock wait, gateway attempt, and total workflow separately. Never release mutual exclusion while an unfenced old operation can still write. |
| N2 | Lease renewal loss logs but does not stop/fence work. `A/jobs/leader-lock.ts:105`, `:118`. | After expiry another worker can lead while the old worker resumes. Require transaction-level lease fencing and durable item claims; external effects require idempotency and explicit ambiguity handling. |
| N3 | Scheduler deadline returns the semaphore slot while work continues. `A/jobs/scheduler.ts:143`. | Actual active work can exceed `JOBS_CONCURRENCY`. Retain the slot until settlement; abort supported operations, stop new admissions, and alarm on stuck work. |
| N4 | HTTP-triggered manifest work lacks job scope. `A/manifest/stock-hook.ts:110`, `:144`. | Scheduler isolation does not isolate every publication. Route all publication through durable runner work; protect interim HTTP-triggered execution explicitly. |
| N5 | Startup publication bypasses the shared scheduler semaphore. `A/jobs/scheduler.ts:250`. | Startup and scheduled work can exceed intended concurrency. One admission mechanism must cover both. |
| N6 | Readiness timeout does not cancel underlying work. `A/app.ts:431`. | Repeated timed-out probes can consume lease-pool capacity. Use one bounded in-flight probe and explicit cleanup; report request-pool admission separately. |
| N7 | Connection budget omits tenant resolver, webhook pool, dedicated listener. `A/payments/tenant-resolution.ts:43`; `A/webhooks/emit.ts:157`. | Main maximum is **26 connections/process at request pool 10**, or **37 at request pool 20**. Three size-20 processes allow **111**, before RightSites/operations, against max 100. |
| N8 | Snapshot already contains asynchronously refreshed `inStock`. `A/manifest/catalog.ts:209`. | Adding a parsed-generation cache before removing stock preserves or amplifies stale availability. Strip it first from HTML, loader data, JSON-LD, feeds, and all content caches. |
| N9 | Purge occurs before a durable replacement exists. `A/manifest/stock-hook.ts:115`; `A/manifest/publish.ts:291`. | Edge can refill from old content. Publish validated generation first, then invalidate; persist retryable purge work. |
| N10 | Cached documents interact with preview, identity fallback, maintenance and publication. `F/routes/layout.tsx:59`, `:79`, `:104`. | Cache keys and invalidation alone cannot preserve immediate access gates. Preserve a live gate or obtain an explicitly approved alternative before enabling HTML edge hits. |
| N11 | Old advisory leadership and new lease leadership are different protocols. | Old and new runners must not overlap during rollout/rollback. Staggering alone does not prevent duplicate passes. |
| N12 | Sorting an `UPDATE … FROM unnest()` input does not prove PostgreSQL row-lock order. | Lock selected stock rows explicitly in canonical order before modifying them, or use a proven ordered per-row path. Cover all reservation/release/admin writers. |

**Throughput model corrections**

The supplied live capture establishes expensive pages, not capacity:

| Page | Captured TTFB | Finished requests | Captured total transfer |
|---|---:|---:|---:|
| Home | 560ms | 444 | 2,476KiB |
| Shop | 505ms | 392 | 1,561KiB |
| PDP | 461ms | 439 | 3,669KiB |
| Blog | 9,669ms | 383 | 1,488KiB |
| Blog post | 9,843ms | 385 | 1,648KiB |
| About | 9,689ms | 409 | 1,503KiB |
| Contact | 553ms | 421 | 2,348KiB |

Source: `I/ads-audit-dell/netcap-live.json`. These are browser/CDN observations from individual runs. They do not separate edge, network, SSR, API, pool wait, SQL, or competing processes. No supplied evidence establishes the claimed 15–35ms origin timing.

Use these relationships:

| Resource | Correct model | Implication |
|---|---|---|
| Human sessions | Closed workload: `throughput = users / (think time + response time)` | 1,000 sessions at approximately 20s think time approach 50 page views/s only while responses remain short. Concurrent sessions are not concurrent requests. |
| SSR CPU | `page views/s × measured CPU seconds/render` | 50 × 10–40ms is **0.5–2 cores**. The lower bound does not saturate one core; the upper bound does. CPU/render is unmeasured. |
| DB pool | `mean occupied clients = transactions/s × mean client hold seconds` | 300 transactions/s × 7ms = **2.1 clients**, not 1.5. Lock waits and external work can increase hold time by orders of magnitude. |
| Hot row | Maximum completion rate approximately `1 / mean serialized hold time` | Store-wide promotion/counter locks can dominate even when database CPU is low. |
| Payment advisory capacity | `available slots / total advisory occupancy per completed order` | Four slots and two 700ms locked phases imply an ideal ceiling near 2.9 orders/s. Real tails, other jobs, and retry paths reduce it. This does not prove a fixed failure percentage. |
| DB CPU | Query executions × measured CPU/query, plus WAL/vacuum | API-call count is not transaction count, statement count, network round trips, or CPU time. |
| Content edge hits | Hits remove origin content work | Live stock requests still reach the database. “10k visitors with zero DB reads” conflicts with the required stock behavior. |
| Webhook backlog | Arrival rate minus completed deliveries | Subscription count, endpoint latency, retries, and configured batch determine growth; 50/minute is a default admission limit. |

The supplied 99.99% cache-hit ratio and tiny databases make disk reads unlikely to explain every delay. They do not exclude lock waits, WAL, CPU scheduling, connection queues, or slow gateway calls. Sequential scans of one-row tables are expected.

The likely limiting resources differ by workload:

- Browse bursts: one storefront event loop, duplicated work, transferred/executed JavaScript, and shared-host CPU.
- Checkout bursts: promotion/counter/stock serialization, advisory occupancy, gateway latency, and pool admission.
- Hourly/background overlap: deployed shared pool; after #358, job CPU and PostgreSQL contention still remain.
- Admin imports/exports: transaction duration, hot-row locks, synchronous CPU and memory.
- Growth: query plans and retained history become material; RH’s two-product database cannot validate that scale.

A trivial Hono benchmark cannot establish commerce capacity. “Hardware is not the limit” and “the database is the problem” are both unsupported.

**Target architecture**

| Journey | Edge / memory | Live origin / PostgreSQL | Required behavior |
|---|---|---|---|
| Home, collection, search, blog, content pages | Versioned stock-free content; bounded parsed-generation cache; immutable media/build assets. Bounded listing projections. | A batched availability request for displayed purchasable variants when the UI performs its stock check. | No availability field in cached content. Missing/error stock disables purchase. Search/content caches are tenant-scoped. |
| PDP | Product text, images, options, public price presentation, review aggregate and stock-free JSON-LD from one content revision. | Live selected-variant availability. Config fetched once per document; credentials remain server-only. | Never promote snapshot/detail availability into purchase authority. Keep existing required stock triggers. |
| Cart | Static application code only. | Private cart/pricing/stock response with optional shipping options combined for the same event. | Cart-open always reads DB; create with first line; reuse cart identity; preserve mandatory subsequent checks. |
| Checkout | Static code and immutable public configuration only. | Live checkout-entry and pre-submit reads; atomic reservation, promotion/credit usage and order/payment state transitions. | No cached mutable money authority. Gateway call outside ordinary DB transactions; durable idempotency and reconciliation. |
| Confirmation | Static shell. | Compact private state polling with backoff; full order projection once needed. | GET reads DB state; bounded reconciliation runs asynchronously. Payment uncertainty is explicit. |
| Account | Static shell. | Private authorized data; resolve session once per request; renew only within the intended renewal window. | No shared customer-data cache or delayed revocation. |
| Admin | Hashed assets; lazy route chunks; optional revisioned nonauthoritative previews. | Authorized paginated queries and short mutations. Imports/exports run as bounded jobs. | Live money/status authority remains transactional; cancellation and request limits apply. |
| Merchant feed | Cached stock-free projection can supply names/media. | Join live availability when generating the response. | No whole-feed availability TTL; bounded concurrency and access protection. |

Content publication protocol:

1. Content mutation records a durable dirty revision/outbox event in the same transaction.
2. Runner reads tenant-scoped content, excluding stock and private/customer-specific fields.
3. Generate and validate files; fsync files/directory where crash durability is required; atomically publish a generation.
4. Purge affected content URLs only after publication; persist retries.
5. Readers pin a generation and enforce a memory bound. Never mix tenants, currencies, or generations.
6. Recovery rebuilds missing content from authoritative data. It never recovers availability from an old snapshot.

Stock protocol:

- A live endpoint accepts a bounded, deduplicated set of variant IDs, verifies tenant/public-product scope, reads stock using transaction-local RLS, and returns `Cache-Control: private, no-store`.
- CDN rules explicitly bypass it; browser and service worker never retain availability responses.
- A failed/missing response produces unavailable state.
- Cart-open, checkout-entry, pre-submit, and reservation remain separate required DB boundaries.
- No timer, debounce, TTL, sessionStorage guard, cross-request promise reuse, stale-while-revalidate, or stock map.
- An in-flight dedupe must not suppress a separately required check; simplest implementation is no stock-request dedupe.

PostgreSQL NOTIFY is delivered after commit and can be delayed; LISTEN also has registration/reconnection considerations. It cannot prove “never stale positive.” Use it as a wake-up hint for **content**, followed by authoritative reads, never as stock authority. [PostgreSQL NOTIFY](https://www.postgresql.org/docs/17/sql-notify.html), [PostgreSQL LISTEN](https://www.postgresql.org/docs/17/sql-listen.html).

HTML edge policy:

- First cache assets and stock-free content payloads.
- Permit public HTML only after tests prove no customer/cart/preview tokens, private loader state, availability, or mismatched CSP are embedded.
- Preserve live maintenance/publication gating. An edge handler may reuse cached HTML **after** a lightweight origin gate succeeds; unknown gate state fails closed. This retains origin gate traffic and adds its RTT.
- A globally sub-30ms TTFB promise is incompatible with a remote synchronous gate. Removing that round trip requires an explicitly reviewed edge-control protocol and owner decision.
- Authenticated, preview, cart, checkout, account, admin, mutation, and private loader responses remain bypass/no-store.
- Hash-based CSP must cover exact generated inline bytes; otherwise retain the nonce path without shared HTML caching.
- Explicit Cloudflare rules are required; HTML is not cached automatically under normal defaults. [Cloudflare default caching](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/), [cache-control behavior](https://developers.cloudflare.com/cache/concepts/cache-control/).

Checkout locking protocol:

- Quotes take no promotion usage locks.
- Resolve customer and immutable request context once.
- Discover candidate promotions, then lock applied mutable rows in stable order; revalidate eligibility, global/per-customer limits, credits, and policy version under those locks.
- Promotion creation/edit races need a version/conflict protocol; merely locking the previously selected IDs is insufficient.
- Increment usage conditionally in the same transaction as successful order state. Idempotent retries must not increment again.
- Lock stock rows in canonical variant order across every writer; reserve conditionally from live stock.
- Replace store `FOR UPDATE` only where referenced keys cannot change. PostgreSQL documents the compatibility difference with key-share locks. [Explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html).
- Address the order counter separately: short, idempotent allocation before the main transaction, with accepted gaps and tested formatting/reset/import rules. Do not acquire another client while holding the main transaction to allocate it.
- Use a durable payment attempt with stable gateway idempotency key. A timeout after send means unknown outcome; reconcile before another charge attempt.
- Explicit gateway attempt and total-operation deadlines are mandatory. Stripe’s default request timeout is 80,000ms; retries can extend total elapsed time. [Stripe client source](https://github.com/stripe/stripe-node/blob/master/src/stripe.core.ts).

Process and database model:

- Initially retain one API and one storefront process per brand. Move jobs into a dedicated runner with explicit pools and bounded admission.
- Run builds/tests/load generation off production.
- Add a second RH storefront worker only if measured event-loop saturation remains after content improvements and total host CPU has headroom.
- Never multiply every service by four workers.
- Budget **all** pools per PostgreSQL cluster, including dedicated listeners, tenant resolution, delivery workers, RightSites, migrations, exports, and operational access.
- Reserve at least 20 of SellRight’s 100 connections initially; divide the remaining 80 explicitly. Multiple workers divide a service allocation rather than multiply it.
- Example future allocation, requiring independently configurable pools: three commerce services × 20 connections = 60; RightSites ≤12; controlled operational work ≤8; reserve 20. A commerce service could allocate API 16 and runner 4. This is a budget, not a claim that current constructors enforce it.
- Keep production’s 1GB shared buffers, 8MB work_mem and existing role timeouts initially. Measure before changing them. Work_mem multiplies across plan nodes/workers; effective_cache_size is an estimate, not reserved memory.
- Prefer query/index changes and local operation budgets over global timeout increases.
- Defer PgBouncer until measured connection pressure justifies its operational complexity.

Runner protocol:

- Short transaction claims with stable order, `SKIP LOCKED`, lease token, attempt count and `next_attempt_at`.
- Check/fence ownership inside every state-changing transaction. Expired workers cannot commit later work.
- External effects use durable claims and provider idempotency where available. SMTP cannot be made exactly-once merely by adding a lease.
- No release of a concurrency slot until its work settles.
- Bounded HTTP/SMTP/APNs deadlines; slow/failed tenants cannot monopolize the queue.
- Global due checks only on explicitly global tables or a narrowly privileged aggregate. Do not bypass RLS for convenience.
- Retention policies distinguish disposable delivery logs from financial, audit, stock and deduplication records.

**Measurement before optimization**

| Layer | Instrumentation | Destination / baseline |
|---|---|---|
| PostgreSQL | Enable `pg_stat_statements`; record calls, total/mean execution time, rows, shared reads/hits, temp I/O and WAL where available. Capture blocking chains, transaction age, deadlocks and wait events. | Restricted collector; snapshots/deltas by database, role and query ID. No raw parameter/secret logging. |
| API | Extend existing request logs with monotonic duration, route template, status, release, tenant, request ID, queue/admission time, transaction count and downstream spans. | Existing JSON stdout → rotated pm2 logs → metrics collector outside request path. Histograms by bounded route/status labels. |
| Pools | Every pool: total/idle/active/waiting/max, acquisition latency, client hold duration, timeout count, cancellation count. | Private metrics endpoint, sampled every 5–10s; always-on timeout counters. Include tenant and webhook pools. |
| Transactions | Time BEGIN/context setup, SQL execution, lock waits, commit and overall client hold. Count statements separately from round trips. | Sampled spans linked by request/job ID; query fingerprints only. |
| Node | Process CPU, RSS/heap, GC pause, event-loop utilization/delay, active requests and worker count. | Per-service metrics; clone CPU profiles for representative paths. |
| Storefront | Document/loader timings, snapshot generation/hit/miss/parse time, SSR API calls and returned bytes. | Structured SSR logs correlated with API request IDs. |
| nginx | `$request_time`, upstream connect/header/response times, upstream status, route class, release/request ID. | Rotated JSON access logs; sanitize tokens/query strings. |
| Jobs | Queue depth/oldest age, admitted/active passes, claim latency, retries, lease loss, stale claims, publication duration/purge lag. | Structured runner logs and bounded metrics. |
| Browser | Actual LCP, INP, CLS and navigation TTFB; route/release/device/network/region and cache status where observable. | Sampled first-party RUM ingestion with bounded payloads; existing analytics beacon is not a substitute. |
| Cloudflare | Hit/miss/bypass, edge/origin status, origin latency, bytes, 429s and geography. | Dashboard/API exports permitted by current plan; validate plan availability before buying anything. |
| Host | Per-service CPU/cgroup throttling, runnable queue, memory pressure, swap, disk latency, network and both PostgreSQL containers. | Host collector with low overhead. |

`pg_stat_statements` requires preload configuration and a restart when not already preloaded; create the extension in each database where it will be queried. Preserve existing preload entries. Owner sudo/restart approval is required. [PostgreSQL setup](https://www.postgresql.org/docs/17/pgstatstatements.html).

Baseline protocol:

1. Capture exact release/configuration, pool caps, enabled jobs, proxy trust, manifest paths and resource allocations; record presence/value of relevant nonsecret flags.
2. Capture at least 90 minutes of passive production metrics spanning an hourly job boundary. No synthetic production traffic.
3. Compare deployed API and patched #358 on the same isolated clone, dataset and resource allocation.
4. Record cold/warm content, signed-out/signed-in, cart/no-cart, current RH data and scaled fixtures separately.
5. Report sample counts with percentiles. Do not publish p99 for a handful of requests.
6. Preserve metrics, query plans, traces, browser waterfalls and exact commands as release artifacts.

**Isolated load-test plan**

Use k6 for HTTP arrival rates and Playwright for complete browser behavior. HTTP tests must include the API calls triggered by the simulated journey; document-only tests undercount work.

Use an open arrival-rate executor for capacity and a separate closed-user scenario for human journeys. k6 arrival-rate tests require enough allocated VUs; dropped iterations count as failure, not successful throttling. [Arrival-rate executor](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/), [VU allocation](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/arrival-rate-vu-allocation/).

Environment:

- Separate host for capacity testing; separate load generator.
- Sanitized `rh_sellright` clone on PostgreSQL port 55433; API 13340, storefront 14340, admin 14341.
- Private test hostname/TLS with access control and no indexing. Test origin directly first; use a separate Cloudflare test hostname for edge behavior.
- Remove production credentials, subscriber destinations and customer tokens. Deny external egress except explicitly permitted test endpoints.
- Local mail/webhook/APNs sinks; fake payment gateway supporting latency, timeout-after-accept, duplicate responses and retry injection.
- Use real payment sandbox only for small functional checks, not bulk throughput.
- Seed current RH shape plus 10k variants, 100k orders, realistic line/history distributions, large promotion/credit sets and backlogged outboxes.
- Include DD-sized history characteristics; RH alone is insufficient.
- Same-host alternate ports are **not** isolation. If no separate host exists, limit work to functional smoke under hard CPU/memory/I/O caps; do not claim capacity results.

| Scenario | Offered load / fault | Pass criteria |
|---|---|---|
| Browse/PDP | 50 page journeys/s; mix home 25%, shop 15%, PDP 30%, blog 20%, other 10%; include live stock/config requests | Route budgets below; no unexpected 5xx, pool timeouts or dropped iterations. |
| Live stock | 100 requests/s with representative batches up to endpoint cap | p95 ≤40ms, p99 ≤100ms; every required read reaches DB. |
| Cart | 20 operations/s; reads, line changes, coupons, shipping | p95 ≤100ms; no quote promotion usage locks; no lost cart updates. |
| Checkout | 5 completed checkout journeys/s; burst 50 starts over 10s | Checkout commit p95 ≤300ms; simulated payment p95 ≤400ms; no duplicate order/charge. |
| Contended inventory | 100 competing buyers for last 10 units; reversed SKU ordering; concurrent admin adjustments | At most 10 valid reservations; no negative available stock, leaked reservations or inconsistent totals. |
| Coupons/credits | Concurrent final-use coupon and credit exhaustion; retries of same idempotency key | Limits never exceeded; duplicate requests do not consume twice. |
| Admin | Five concurrent list/detail users plus one bounded import/export | Admin list p95 ≤250ms; shopper budgets continue passing. |
| Jobs | 90-minute soak spanning hourly work; preloaded webhook/restock/cart backlog | Concurrency cap holds, no starvation, queue age decreases under stated arrival rate. |
| Failure | DB latency/disconnect, gateway timeout after acceptance, lease expiry, listener disconnect, missing generation, failed purge | Stock fails closed; no cross-tenant data; retries reconcile; stale worker cannot commit. |
| Capacity search | Steps 25, 50, 100, 200, 500 page journeys/s, with corresponding live API work | Record first sustained SLO breach and resource cause; no “10k users” claim without its specified workload. |
| Browser | Cold/warm desktop and throttled mobile, guest/auth/cart; actual clicks | No console/network regressions; live stock boundaries observed; byte/Web Vital budgets pass. |

Keep latency assertions separate from expected business rejections such as sold-out inventory. Expected 409/422 outcomes must be classified, not counted as generic transport failures.

**Latency and payload budgets**

These are final acceptance targets on the isolated reference environment, not measured current performance.

| Route / operation | p50 | p95 | p99 |
|---|---:|---:|---:|
| Stock-free public origin document, warm content | 20ms | 80ms | 150ms |
| Live batch stock | 10ms | 40ms | 100ms |
| Public config | 10ms | 40ms | 100ms |
| Cart including quote | 30ms | 100ms | 200ms |
| Checkout DB commit, excluding gateway HTTP | 100ms | 300ms | 600ms |
| Payment endpoint with deterministic 100ms gateway | 180ms | 400ms | 800ms |
| Compact order-state read | 15ms | 50ms | 100ms |
| Account read | 50ms | 150ms | 300ms |
| Admin order/customer/product list | 80ms | 250ms | 500ms |
| Admin detail/dashboard | 100ms | 300ms | 600ms |

Additional budgets:

- Warm cached edge processing ≤30ms p95, measured separately from network and live gate. Near-edge end-to-end TTFB target ≤100ms for eligible ungated static responses; no global 30ms promise.
- Zero unexpected pool timeouts, uncaught 5xx, cross-tenant responses, oversells or duplicate charges at the reference load.
- Pool acquisition p95 ≤5ms, p99 ≤20ms at reference load.
- Event-loop delay p99 ≤25ms during steady reference load.
- Shopper mutation DB transaction p95 ≤50ms after contention fixes, excluding acquisition; instrument separately from endpoint duration.
- Mobile RUM goals: p75 LCP ≤2s, INP ≤150ms, CLS ≤0.05, segmented by region/device.
- Initial first-party compressed JavaScript ≤200KiB per public route before interaction; no eager payment SDK before its defined trigger.
- Compressed HTML ≤60KiB; no catalog-sized serialized state.
- One relevant image preload; correct derivative dimensions/MIME; no duplicated alternative-format transfer.
- One public-config fetch per document; zero guest auth request when server-provided authenticated state is absent.
- Zero content API calls for a valid stock-free snapshot path; live stock/control calls are tracked separately.

CI enforcement:

- Functional/unit/property tests run on every small main change.
- A pinned isolated performance runner executes k6 thresholds; failures return nonzero. Shared CI runners cannot enforce tight absolute latency reliably. [k6 thresholds](https://grafana.com/docs/k6/latest/using-k6/thresholds/).
- Gate on absolute budgets and >10% regression against the same-run baseline when statistically supported.
- Require sufficient samples: at least 1,000 requests for p95 and 10,000 for p99 gates; use longer scheduled runs for low-rate checkout paths.
- Browser tests enforce request counts, stock boundaries, transferred bytes, CSP, cache headers, tenant isolation and responsive output.
- Full capacity/90-minute job soak is a release gate, not every tiny commit.
- Archive SHA, fixture version, host allocation, seeds, gateway latency profile, raw results and query-plan diffs.
- Never run capacity CI against production or on its unbounded shared CPU.

**Ordered implementation plan**

Effort labels: **quick (hours)** = bounded local change; **medium** = coordinated component changes; **large** = architecture/protocol migration. These are size classes, not completion promises.

Every release: small commits on main → checks → clone-DB dry run → independent review → explicit production deployment authorization → measured canary. No branches or PRs.

| Phase | Findings / changes | Files / components | Effort, risk | Proof and measurable target | Rollback |
|---|---|---|---|---|---|
| P0: baseline and isolation | V2, V3, V69–71; instrument before optimization; move heavy tests/builds off production | `A/lib/request-id.ts`, `A/db/client.ts`, `F/entry.express.tsx`, `N/nginx.conf`; host/collector configuration | Medium; low code risk, operational approval required | Correlated route/pool/DB/CPU baseline across hourly boundary; collector overhead <2% CPU in clone | Disable added sampling/export; retain existing logs; restore prior nginx config |
| P1: make #358 release-safe | A1–4, A7–11, A13; N1–7, N11 | `A/db/client.ts`, `A/jobs/leader-lock.ts`, `A/jobs/scheduler.ts`, `A/manifest/stock-hook.ts`, `A/app.ts`, `A/env.ts`, `A/sdk/create-app.ts`; #358 migrations | Medium–large; high concurrency risk | No request-pool job SQL; actual active passes never exceed cap; expired lease cannot commit; timed-out probes leave no growing waiters; total pool maxima fit budget | Stop new runner before reverting; never overlap leadership protocols; retain additive schema; disable affected jobs while reconciling ambiguous effects |
| P2: remove redundant request work | V12, V14, V16–18, V23, V26–29, V37–39, V49; F1–3, F6 | `A/routes/shop-config.ts`, `A/payments/stripe.ts`, `A/auth/session.ts`, `F/routes/layout.tsx`, checkout/account services and components, `F/utils/social-sign-in.server.ts`, `U/main.tsx`, `U/pages/Login.tsx` | Quick/medium; medium authentication/UI risk | One config request/document; one customer resolution/request; no redundant guest auth; no unnecessary cart creation; required stock checks unchanged | Independent feature switches/reverts; restore old private request paths without caching |
| P3a: quote and lock correctness | B1, B3–5, C4, C6, G4, G6; N12 | `A/money/promotion-resolver.ts`, `A/routes/cart.ts`, `A/routes/checkout.ts`, `A/orders/stock-reservation.ts`, admin stock/settings paths, `A/db/locks.ts`, lock-order guard | Large; highest money/stock risk | Quote takes zero usage locks; concurrency tests prove coupon/credit/stock invariants; mutation transaction p95 ≤50ms | Revert new path behind flag; stop rollout on any mismatch; preserve committed reservations and reconcile rather than reverse blindly |
| P3b: counter/payment boundaries | B2, A7–8, C1; V29, V52 | `A/orders/order-number.ts`, checkout/admin-draft/subscription callers, `A/routes/pay.ts`, `A/payments/gateway-payment.ts`, `A/payments/stripe-reconcile.ts`, order-state route | Large; high payment/idempotency risk | Stable numbers under retries/reset/import; no lock-pool circular wait; timeout-after-charge test creates one charge; endpoint budgets pass | Keep additive allocation/attempt records; switch to compatible previous path only after in-flight reconciliation |
| P4a: content correctness | A5, F5, V19–22, V25, V60–61, V66; N8–10 | `A/manifest/catalog.ts`, `publish.ts`, `stock-hook.ts`, `A/webhooks/catalog.ts`, `A/cache/purge-hook.ts`, `F/services/catalog-snapshot.ts`, browse/PDP/blog loaders, JSON-LD/feed builders | Large; high cache/availability risk | Zero stock fields in content artifacts; content edit visible within 5s p95 on clone; failed purge retried; generation validation/crash tests pass | Disable content cache; use private bounded live content fallback; live stock path remains mandatory |
| P4b: public edge delivery | V6–7, V24; F1; N10 | `F/config/route-cache-policy.ts`, `F/routes/layout.tsx`, `F/entry.express.tsx`, head generation, Cloudflare rules/handler | Large; high privacy/access risk | No private state in cached bodies; preview/auth/maintenance/publication tests pass; cache hit ratio ≥95% on repeat eligible content workload | Bypass HTML cache and purge eligible paths; revert to no-store |
| P5a: query and index work | C3–4, C10, C13; V20–21, V43, V51, V53–59, V65 | Catalog/admin/report/SEO/loyalty queries; new reviewed SQL migrations | Medium; medium plan/write-cost risk | Role-correct `EXPLAIN (ANALYZE, BUFFERS)` on scaled clone; route budgets pass; bounded rows/payloads; no blanket index addition | Revert query changes first; leave harmless indexes until separately approved removal |
| P5b: admin bulk/CPU paths | C2, C5, C8; V41–46, V50–51, V64 | Admin blog/product/order routes, export service, import runner, `U/api.ts`, shared search, ProductDetail/Dashboard | Medium–large; high bulk mutation risk | Search debounce/abort; bounded import transactions ≤100 rows initially and measured shorter if needed; export backpressure; shopper SLO survives concurrent admin work | Stop admissions; resume/reconcile idempotent chunks; previous UI/API path remains compatible |
| P6: job fairness and retained data | A2, A9; D1–11; V62–64, V67 | Scheduler, all affected jobs, webhook/email/APNs transports, due/retention indexes and claim schema | Medium–large; high side-effect risk | Backlog age decreases; no starvation behind backing-off rows; no network I/O inside ordinary DB transaction; crash recovery neither loses work nor blindly repeats payment | Pause affected job; retain durable claims/history; revert worker with compatible schema; no automatic data restoration assumptions |
| P7: browser and media | F4; V15, V30, V32–36, V40, V47 | Image adapter/derivative generation, PDP/home overlay, head/font policy, Stripe/Turnstile components, Qwik prefetch, admin lazy routes | Medium; medium visual/interaction risk | Byte/Web Vital budgets; image MIME/dimensions verified; wallet readiness tested; screenshots/render checks submitted to Adrian | Revert assets/components and purge changed content; Adrian approves visual result |
| P8: generic deployment and bounded abuse | A6, A12; C7, C9, C11–12; E1–9; G1–12 | Compose/Caddy/nginx templates, Dockerfiles, installer/backup scripts, rate limiter, auth/CORS/tenant routing, SMTP, webhook body handling | Medium; medium–high deployment/security risk | Clean clone install serves API/assets correctly; rate limits remain effective across workers; fail-fast bounded queues; proxy/tenant tests pass | Restore prior configuration; feature-level rollback; no blanket switch to weaker memory-only auth limits |
| P9: capacity decision and permanent gates | V3, V9–11, V68–71; all SLOs | Performance fixtures, k6/Playwright suites, CI configuration, operational runbooks, resource allocation | Medium; low code/high operational risk | Repeatable capacity curve and first bottleneck; final route budgets pass during job/admin overlap | Keep proven worker/pool allocation; revert experimental scaling; retain baseline artifacts |

Implementation constraints within phases:

- P1 must not be represented as “deploy #358 unchanged.”
- P2 does not introduce stock debounce or an authenticated module-global promise.
- P3a splits quote optimization from commit authority; public `pricingIntent` cannot request locking privileges.
- P3b accepts number gaps, not duplicates or format regressions.
- P4a precedes any parsed snapshot memo or availability-bearing HTML cache.
- P5 uses cursor/keyset pagination where API/UI semantics permit it; pagination/count contract changes are explicit.
- P5 does not immediately materialize authoritative payment/fulfillment status. First measure set-based query/preaggregation alternatives.
- P6 does not default destructive reapers on without retention/replay analysis and the required dry-run approval.
- P8 retains distributed enforcement for authentication. Memory fast-deny and cheap ingress protection can reduce DB work; memory-only per-worker budgets are not equivalent shared limits.
- Additions to schema/config/dependencies and production builds/deploys require the existing approval workflow. This review authorizes none of them.

**Owner decisions, costs, and risks**

| Decision | Recommendation / cost / expected gain |
|---|---|
| Isolated test host | Approve a temporary host and separate generator. Current official European list examples: CX43 €0.0256/hour, €15.99 monthly cap; CCX23 €0.1378/hour, €85.99 cap; CCX33 €0.2219/hour, €138.49 cap. Confirm region, VAT, IPv4, storage, backups and specifications before purchase. Runtime cost is hourly rate × usage, capped as listed. These SKUs are not asserted to be equivalent to the current box. |
| Production hardware | First remove build/test contention and measure. Dedicated CPU may reduce scheduling variability; more cores help only parallelizable work. Neither fixes a serialized counter or coupon lock. No RPS multiplier is established. |
| Separate runner/build host | Build isolation directly removes competing CPU/I/O. A runner on the same host isolates admission/process failure but not physical CPU/DB contention. Remote runner adds network/operations cost. |
| PostgreSQL restart/sudo | Required for preload changes if not already enabled. Approve a maintenance procedure covering the shared SellRight cluster and affected services. Legacy PostgreSQL is separately budgeted. |
| Pool allocations | Approve a measured per-service connection budget before increasing workers. Current main defaults can exceed max_connections across services. |
| HTML edge access gates | Preserve live checks initially. Any alternative propagation/maintenance semantics requires explicit design approval; stock remains unchanged. |
| Order-number allocation | Confirm accepted gap behavior across retries, year/reset rules, imports, drafts and subscriptions before changing allocation protocol. |
| Retention | Owner supplies retention requirements by data class. No blanket 14–30-day deletion of money, stock, audit or idempotency history. |
| Cloudflare capability/cost | Use existing plan capabilities first. Worker/analytics/purge upgrades require a concrete quote and demonstrated need; no added spend assumed. |
| Visual changes | Adrian approves screenshots for image, font, loading and layout changes. Automated checks establish correctness, not visual approval. |
| Release authorization | Separate explicit approval after clone dry run and independent review. No deploy/restart requested or performed in this pass. |

Pricing source: [Hetzner published price adjustment tables](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/). Prices are infrastructure inputs, not throughput guarantees.

Highest release risks are stale positive stock, tenant leakage from shared caches/session state, double payment after ambiguous gateway outcomes, oversubscribed connection budgets, unfenced expired workers, and cache bypass of maintenance/publication controls. Each has an explicit failing test and rollback requirement above.

STATUS: COMPLETE — read-only verification and implementation plan delivered; no edits, DB access, deployment, or load tests performed.
ERRORS: Runtime query plans, production flag values, sustained capacity, dependency advisory status, and OpenAPI regeneration behavior remain unverified; concurrent working-tree edits were preserved.