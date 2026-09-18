# PAY-1 E2E — session status (2026-09-06)

Working state of the PAY-1 close-out run. Nothing in this file is committed canon; `docs/plans/REMAINING-WORK.md` remains the governing backlog.

## What was asked

1. Pull `main` and verify the P1/P2 lock + Codex handoff claims — **done, all verified** (canon contents, `04bab42` evidence-head fix, CI `34032045457` + CodeQL `34032045479` green on `2dd6fa2`, branch protection intact).
2. Close **PAY-1** — the sole 0.1.0 blocker — with a real Stripe test-mode E2E:
   `cart → checkout → 3DS-capable confirm → Stripe-signed webhook → Paid → refund → reconciliation`
   via the real storefront/API path, no synthetic webhooks. User decisions: keys already exist somewhere (found in RightSites), full browser UI path, Stripe CLI install approved.

## Done so far

**Credentials & tooling**
- Found Stripe `_TEST` keys (secret/publishable/webhook) in RightSites `packages/api/.env`; copied the three names into SellRight's gitignored `packages/api/.env` — values never printed.
- Stripe CLI `v1.50.10` installed at `~/.local/bin/stripe`.

**Disposable test store (`sellright_test` DB — `sellright_dev` untouched)**
- Migrated as owner role; bootstrapped store `pay1-store` (Stripe test mode) + owner admin (creds in `/tmp/pay1-admin.env`, never displayed); applied repo's own `scripts-deploy/grant-app-role.sh`.
- Seeded product via admin API: `PAY-1 Test Widget` / SKU `PAY1-WIDGET-01`, 1500 minor units, onHand 50, product id `12fba7b3-0221-4a24-a468-ea6b4ed54cf0`.

**Isolated live stack (proven separate from pre-existing servers on :3300 / :4100)**
- API on **:3321** → `sellright_test`. Separation proof: `pay1-store` resolves on :3321, rejected by the :3300 API.
- `stripe listen` forwarding real Stripe-signed webhooks → `:3321/v1/webhooks/stripe`; session `whsec_…` injected into the API env, never echoed.

**Browser E2E — failures diagnosed and worked through**
- pnpm tried to purge `node_modules` (config-hash drift after pull) — bypassed by running vite's store binary directly.
- Port squatters: :3300, :3301, :4100 all pre-existing; moved to :3321/:4107.
- SSR hitting the wrong API port (missing `VITE_SELLRIGHT_API_URL`) — fixed.
- My temp vite middleware broke vite virtual-module URLs — scoped correctly (only bare page paths).
- **Hard blocker:** Qwik **dev-mode-only** HTML validation crashes SSR on the PDP's `div`-inside-`button` markup — the PDP cannot render under `vite dev` at all (prod build unaffected). Any curl of the PDP in dev kills the dev server.
- Cart hydrates on checkout from the `vendure_local_cart` localStorage mirror, not the `sr_cart` cookie — mirror seeded in-driver.

**Pivot (in progress):** switched to the **production express runtime** (`entry.express.tsx`). `vite build` (client) completed cleanly with PAY-1 env baked (`VITE_SELLRIGHT_API_URL=http://127.0.0.1:3321`, `VITE_SELLRIGHT_STORE_SLUG=pay1-store`, `VITE_SERVER_CART=1`, `VITE_SR_CHECKOUT=1`).

## Remaining steps to close PAY-1

1. `build.server` → run express on **:4108** (`PORT=4108 node server/entry.express.js`).
2. Tiny same-origin proxy on **:4109**: `/v1` → :3321, everything else → :4108 (express has no `/v1` proxy; prod relies on nginx).
3. Playwright run (`/tmp/pay1_e2e.py`, adjust BASE to :4109): cart → checkout form → Pay → Stripe Element (4242 card) → confirm → Paid + confirmation page.
4. Admin refund → real Stripe refund webhook → reconciliation verified (order audit + ledger).
5. Capture receipt evidence (PaymentIntent/charge/refund IDs + order states, no secrets).
6. Update `docs/plans/REMAINING-WORK.md` PAY-1 status → PR to `main`; delete temp `vite.config.pay1.mts`.

## Notes / hazards learned

- Never `pkill -f` a pattern that appears in the invoking command itself (self-kill) — use `pgrep -f '[b]racket'` forms.
- Background processes must be launched with `setsid nohup … & disown`; plain `&` children get reaped when the command window ends.
- `:3300` API probes like `/api/cache-events` 404 by design from the storefront — harmless noise.
- Pre-existing servers on this box (damned/rotten/stunning sites, SellRight :3300/:3301 from Sep 5) are Adrian's — do not kill.
