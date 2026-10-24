# Accounts, associated domains, StoreKit and devices: point-in-time review

Point-in-time snapshot of 8760e14, 2026-10-24. Read-only; nothing was built or run. Paths are
repo-relative. Facts about the Hetzner deployment live in the rightsites/sites checkout, not here,
and are marked **unverified**.

## Charter

Adrian's direction (2026-10-24): HeardRight is the only app in daily use. On Apple devices it uses
CloudKit for transcripts and StoreKit for the Pro entitlement, so the shop account is optional
there. Windows and Android users still need an account or a device-link path; Google sign-in is
optional; cross-device goes over the Pulse mesh. SellRight is the account and licence backend for
the suite (`heardright.app/v1/shop/*`, `coderight.cc/v1/*`). This review checks the backend side of
that direction, plus the associated-domains plan reviewed the same day. Companion reviews of the
same date live in each product repo.

## What is true today

| Axis | State | Evidence |
|---|---|---|
| StoreKit bridge | Implemented and tested. App Store Server Notifications v2 at `POST /v1/webhooks/apple/storekit`; `POST /v1/shop/pro/link-storekit` turns a customer session plus an Apple JWS into a licence (`source: 'storekit'`, key `SK-<sha256>`) bound to the customer, with a device activation. Refund and revoke cascade; renew and expire handled. Verification uses `@apple/app-store-server-library`, Production then Sandbox per config. Per-(store, app) config lives only in `storekit_app` rows with no admin route or script to insert them. HeardRight has only a test-only policy kit; CodeRight has nothing. | `packages/api/src/routes/storekit-webhooks.ts:75-216,244-356`, `src/app.ts:511`, `src/licensing/storekit-verify.ts:50,120-128,264-295`, `src/licensing/storekit-license.ts:25-34,74-93,135-158,201-309,353-425`, `src/licensing/storekit-notifications.ts:21-37`, `src/db/schema-storekit.ts:38-60`, `src/licensing/storekit/fork-reference-policy.kit.ts:1,24-30`, `src/licensing/storekit/default-policy.ts:85-139` |
| Sign in with Apple and Google | Implemented. Apple: JWKS verify, audience from store config or env; match by `apple_user_id`, link by email only when Apple is authoritative, else a mailed confirm link. Google: tokeninfo verify, link only for gmail and Workspace emails. Tests exist for both. | `src/auth/apple.ts:60-71,77-125,131-141`, `src/routes/auth.ts:341-391,400-432,504-567`, `src/auth/federated-link.ts`, `src/auth/google.ts:163-187`, `src/auth/apple.db.test.ts:83-510` |
| Licence and device model | Legacy key activate, refresh, deactivate and trial routes. A lease engine (issue, renew, remote revoke, offline remove, 7-day TTL, 14-day grace, per-pool caps) is exported only; the `/v1/pro/{appKey}/devices/lease` routes are plugin-owned. No customer-facing device list or remove route in core; `revokeDeviceRemote` is called only by account erasure. Admin revoke and restore routes exist but are not mounted. Windows link codes: nothing beyond a policy path id. Mesh, relay, iroh: no hits. | `src/routes/apps.ts:89,146,216,268,312`, `src/licensing/device-leases.ts:108,283,359,379`, `src/licensing/device-policy.ts:26-72`, `src/exports/licensing.ts:5`, `docs/policies/ENTITLEMENTS.md` §2, `src/routes/account.ts:189-247,648-662`, `src/routes/admin-license-revocation.ts:1-4`, `src/licensing/entitlement-policy.ts:16,46` |
| AASA | `well-known.ts` reads `process.env.AASA_APP_IDS` directly (not in the zod env schema) and 404s when unset. Nothing in this repo's deploy sets it: not `deploy/compose.yaml`, `deploy/.env.example`, `packages/api/.env.example` or `deploy/install.sh`. The admin container's nginx proxies only `/v1/` to the API and serves the SPA for everything else, so `/.well-known/apple-app-site-association` on an admin host returns the SPA. The Hetzner `rightsites.conf` is **unverified** from here; the associated-domains plan's own wording ("fixed so the file comes through instead of the admin page") implies the same shape. | `src/routes/well-known.ts:56-61`, `deploy/compose.yaml:98-150`, `deploy/Caddyfile:11-21`, `packages/admin/nginx.conf.template:20-27,54` |
| Admin hosts | Live RightSites API and admin moved to `api.orthiclabs.com` and `admin.orthiclabs.com` on 2026-10-23 (#331). `api.spoares.com`, `api.sellright.cc`, `admin.spoares.com` and `admin.sellright.cc` stay as aliases until the retire step; old release routes must keep returning 200 until installed apps drain. The iOS entitlement carries all four `webcredentials` entries with `?mode=developer`; the project file itself says release builds need plain entries. No host inventory says which hosts sit behind Cloudflare Access. | `ios/project.yml:72-78`, `ios/CHANGELOG.md:30`, commit `cbd7338`, Orthic-Labs/sellright#331 (comments of 23 and 24 Oct), `docs/plans/2026-10-10-agent-role.md:32`, `docs/ADMIN-AGENTS.md:17-18` |
| iOS admin app | Server URL forced to https (http only for local), saved to UserDefaults before login succeeds; unparsable URL falls back to a file URL. Session token in Keychain via RightKit `SecretsStore`, deleted on logout. Bootstrap revalidates `/v1/admin/me`; any error, including offline, shows the login screen while the token stays. 2FA in two steps; passkey-only accounts fall back to a recovery code. Challenge-exhausted detection is a substring match on server text, not the error code. No global 401 sign-out. | `ios/SellRightAdmin/App/AppSession.swift:36,57-64,78-79,94-124,130`, `ios/SellRightAdmin/Core/Keychain.swift:8`, `ios/SellRightAdmin/Features/Auth/LoginView.swift:138,158`, `src/routes/admin.ts:63,164` |

## Findings, ranked

1. **Sign in with Apple with Hide My Email forks the account.** A relay address counts as
   authoritative, no `apple_user_id` row matches, no email matches, so a new customer row is
   inserted. A person who first used a magic link and later Sign in with Apple ends up with two
   accounts and split licences. There is no signed-in "link Apple to this account" endpoint
   (`src/routes/auth.ts:456-463` acknowledges it). This breaks "the account is optional and the
   licence follows the person" for HeardRight. Do: add `POST /v1/shop/account/apple` that links an
   Apple identity to the current session, treating the signed-in session as the mailbox proof;
   and stop minting `apple-<sub>@no-email.invalid` rows that no magic link can reach
   (`auth.ts:476-489`).
2. **Password AutoFill has never worked in any deployment this repo describes.** Three independent
   causes: `AASA_APP_IDS` is unset everywhere outside tests; the admin nginx never forwards the
   `.well-known` path; the entitlement entries carry `?mode=developer` in a TestFlight build. Do:
   add `AASA_APP_IDS` to `deploy/.env.example` and `deploy/compose.yaml` and to the env schema in
   `env.ts`; add an exact-path proxy for `/.well-known/apple-app-site-association` in
   `packages/admin/nginx.conf.template`; ship plain `webcredentials:` entries for the two
   orthiclabs.com hosts, keeping `?mode=developer` twins only if dev builds need them; verify once
   through Apple's CDN before the next TestFlight build.
3. **Customers cannot list or remove devices; admin revocation is unmounted.** HeardRight's
   account screen promises lost-device removal and web device management; the core API has no
   customer device list or remove route, the lease routes are plugin-owned, and
   `admin-license-revocation.ts` is not mounted. Windows link codes do not exist here. Do: decide
   whether these live in core or in the RightSites plugin, then mount the admin routes and add
   `GET/DELETE /v1/shop/account/devices`.
4. **The StoreKit link is generic with no operator path.** The default policy accepts any
   platform, returns an unsigned lease (`signature: null, generation: 0`), seats default to
   unlimited, and nothing inserts `storekit_app` rows. HeardRight's rules exist only as a test
   kit; CodeRight has none. Do: register the HeardRight `storekit_app` row and policy where the
   product actually runs (core or RightSites), sign the lease, and set seats.
5. **iOS admin robustness, low severity.** Substring error coupling (`LoginView.swift:158`), a
   stale Keychain token after a failed `/v1/admin/me` (`AppSession.swift:57-64`), the server URL
   saved before login (`:78-79`), no global 401 sign-out. Do: match on the
   `LOGIN_CHALLENGE_EXHAUSTED` code, keep the token only when `/me` says 401, save the URL after
   success.
6. **Docs drift.** `ios/CHANGELOG.md:30` omits the orthiclabs.com entries added in `cbd7338`;
   `ios/README.md:93-95` says the AASA is "served by `AASA_APP_IDS`" without saying nothing sets
   it; `docs/guides/customer-social-sign-in.md:16-23` skips the confirm-link flow and the relay
   duplicate; `docs/FEATURES.md` has no StoreKit, Sign in with Apple or magic-link rows; no host
   inventory lists which admin and API hosts are live and which sit behind Cloudflare Access.

## Decisions needed

- Does HeardRight's cross-platform entitlement go through SellRight's StoreKit link (account
  required on Windows) or through device-to-device proof over the Pulse mesh (no account)? This
  decides whether findings 1, 3 and 4 block HeardRight or only CodeRight later.
- Where the HeardRight entitlement policy and `storekit_app` row live: SellRight core or the
  RightSites plugin.
- `admin.sellright.cc` in the iOS entitlement: keep it with a Cloudflare Access bypass for the
  exact `.well-known` path while it is an alias, or drop it now as the associated-domains plan
  says. #331 says keep until the retire step; the plan says drop.

## Related

Tracking issue: Orthic-Labs/sellright#343. Orthic-Labs/sellright#331 (host move), #333 (admin login and passkey autofill), #300 (Google and
Apple sign-in per store), #315 (magic-link follow-ups); bogusyogi/heardright#181 (paid account,
device lease, StoreKit and Windows link qualification). Companion reviews of 2026-10-24 in
heardright, coderight, scraperight, pulse, ember, genright, postright and CutRight.
