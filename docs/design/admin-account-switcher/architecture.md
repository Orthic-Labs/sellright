# SellRight web-admin saved accounts & permitted-store switching

## Frame

- **Request:** issue #355 — save multiple separately authenticated admin accounts, switch from a web-admin dropdown without sign-out/sign-in or extra tabs, while retaining permitted-store switching. This is distinct from RightSites' five public app sites.
- **Significance:** D2 / `best_shape`, standard rigor. Auth/data authority, cross-origin deployment, tenant isolation, durable browser contract, and security quality are material.
- **Scope:** current SellRight web admin/API, native account-switching precedent, deployed SellRight & RightSites topology, generic architecture, migration, security, cache/UX, and acceptance scenarios. Read-only; no product edits.
- **Shared capability decision:** reuse existing API admin session + CSRF + `resolveAdmin`/`requireStore`, React `AuthProvider`/`QueryClient`, and browser storage already used by admin. `rightkit owns --compact` names native credential/settings owners (`rightkit-credentials`, `rightkit-app-settings`); no new dependency is justified for browser account slots.

## Current reality

### Web admin: one authenticated identity, many permitted stores

1. `POST /v1/admin/login` creates an admin session; browser success sets `sr_admin` (HttpOnly) plus `sr_csrf`, while the bearer token is returned only when an explicit API client asks for it (`packages/api/src/routes/admin.ts:66-75`, `packages/api/src/auth/cookies.ts:79-99`). The SPA sends `credentials: include`, reads only the CSRF cookie, and keeps one selected store slug in `localStorage` (`packages/admin/src/api.ts:4-13,52-60`).
2. Sessions are global to `adminUser`, not bound to a store. `resolveAdmin` joins `session → admin_user → admin_user_store → store`, then checks expiry/idle timeout (`packages/api/src/auth/admin-session.ts:67-71,180-253`). `requireStore` authorizes the selected `x-store-slug` against that principal's `stores[]` (`packages/api/src/routes/admin-helpers.ts:50-70`).
3. `admin_user_store` is the authority for account-to-store membership and role/permissions (`packages/api/src/db/schema-core.ts:91-142`). Store-scoped commerce remains behind `withStore`/RLS; the admin principal/ACL/session registry is intentionally global (`docs/ARCHITECTURE.md:39-50,69-86`).
4. Existing `StoreSwitcher` lists only `me.stores`, writes `sr_admin_store`, and calls `location.reload()` (`packages/admin/src/components/Layout.tsx:152-179`). `AuthProvider` restores the remembered slug, calls `/me`, and otherwise falls back to the first permitted store (`packages/admin/src/auth.tsx:17-50`). There is no account/profile selector. The account menu currently exposes email + sign-out only (`packages/admin/src/components/Layout.tsx:182-201`).
5. Browser cookie policy is host-only (no `Domain`), `Path=/`, `SameSite=Lax`, and production `Secure`; the auth value is HttpOnly and server stores only a hash (`packages/api/src/auth/cookies.ts:1-10,71-90`; `packages/api/src/auth/admin-session.ts:68-81`). A second login on the same origin overwrites the single `sr_admin` cookie, so separate live accounts cannot currently coexist.
6. Shared admin middleware currently chooses bearer over the browser cookie, resolves the principal, then applies agent policy plus human TOTP/passkey-review gates before handlers run (`packages/api/src/routes/admin-agent-guard.ts:58-75`). `requireAdmin` reuses that guarded principal (`packages/api/src/routes/admin-helpers.ts:50-63`). Slot auth must join this path; resolving slots directly through `admin-session` would bypass those gates.

### Native precedent

- Native `StoreProfile` persists non-secret metadata (`serverURLString`, email, selected store, `requiresLogin`) and derives a distinct Keychain credential key per profile; it never serializes the token into profile metadata (`ios/SellRightAdmin/App/StoreProfile.swift:3-14`).
- `AppSession` restores one profile, validates `/v1/admin/me` email before applying it, invalidates only that profile on 401, and resets account/store UI identity on switch (`ios/SellRightAdmin/App/AppSession.swift:53-84,99-110,142-198,222-266`). Native requests use bearer tokens, disable cookie handling, and send `x-store-slug` (`ios/SellRightAdmin/Core/APIClient.swift:24-30,81-119`).
- Native UX separates **Accounts** from **Store**: account rows show server/account identity, “Add account” does not sign out current account, and store picker is a separate section (`ios/SellRightAdmin/Features/Settings/SettingsView.swift:26-83`; saved-login cards at `ios/SellRightAdmin/Features/Auth/LoginView.swift:147-168`). This is the model to mirror, not a reason to make each store hostname an account.

### Actual RightSites production topology

The Hetzner checkouts were read at SellRight `3964432c7c66cee5c62f32c5d5009e1ea9da7dd3` and RightSites `05b57a199fefdbad930da97c7f4fa153dea934d1`; both had unrelated uncommitted files, so those changes were left untouched.

- RightSites deployment source declares one composed executable/API on host port `3301`, one `rightsites` database, and one runtime role; its README says five public app hosts are `store.config.hostnames` on that composed runtime (`/home/vendure/sites/rightsites/deploy/rightsites/README.md:1-30`). This is deployment configuration evidence, not live DB readback.
- The authoritative host-mapping source declares exactly `heardright.app`, `viewright.cc`, `mailright.cc`, `coderight.cc`, and `scraperight.cc` under its historical `RIGHTSITES_STORE_SLUG` configuration comment (`/home/vendure/sites/rightsites/deploy/rightsites/store-hostnames.mjs:1-24`). Deployment README/overlay also describe one suite catalog, with deployment defaults invoking `--store default rightsites` (`/home/vendure/sites/rightsites/deploy/rightsites/store-hostnames.mjs:69`). This is source-configured topology evidence; no live DB readback was performed, so current database association is not claimed as independently verified.
- Live nginx routes `api.orthiclabs.com`, `api.sellright.cc`, and `api.spoares.com` to the same `3301` API (`/home/vendure/sites/nginx/rightsites.conf:24-30,62-148`). `admin.orthiclabs.com` and `admin.sellright.cc` serve the same mounted admin SPA and proxy `/v1/` to that same API (`/home/vendure/sites/nginx/rightsites.conf:150-187,267-287`). The five app vhosts proxy `/v1/` to `3301` and their storefronts to separate PM2 ports (`/home/vendure/sites/nginx/heardright.conf:1-7,45-61`; equivalent `viewright.conf`, `mailright.conf`, `coderight.conf`, `scraperight.conf`).
- Therefore: **source configuration presents five app domains as host-routed storefront presentations of one configured suite catalog/store mapping; it does not establish five account identities.** Do not pre-seed five account profiles, one per app host. Generic SellRight installations may have unrelated admin origins and genuine separate accounts; those are profile slots only after explicit sign-in.

## Decision

Implement a browser **account slot** as `(canonical target server origin, target admin identity, one target session)` and keep permitted stores as a nested selection under that slot. RH and DD are separate observed API runtimes on `:3340` and `:3350`, not canonical browser origins: browser origin is scheme + host + port, while cookies do not scope by port. Each runtime must map to a registered HTTPS admin origin before handoff; origin-local storage alone does not satisfy request for one dropdown.

### Recommended shape: central admin client + server-side session broker

Deploy one generic admin-client origin with a BFF/session broker. Browser keeps only hub session cookies; broker stores each target SellRight bearer/session credential in an encrypted server-side vault. Saved-account switching then works across unrelated SellRight installations without extra tabs or repeated sign-in after initial account enrollment, while target server remains auth/ACL authority.

1. **Browser metadata:** hub `localStorage` may hold opaque slot id, canonical server label/origin, verified email/display label, selected store, and `requiresLogin`; `sessionStorage` may hold active slot per tab. Never store target bearer/session token, password, target cookie, or CSRF secret in web storage. Email alone is not identity: bind slot to canonical server origin plus target principal fingerprint/id when available.
2. **Hub session/vault:** hub sets host-only HttpOnly `sr_hub` plus hub CSRF cookie (`Secure`, `SameSite=Lax`, narrow path). Vault record is keyed by hub subject/session + slot id and contains canonical target origin, encrypted target credential, target expiry/idle metadata, verified identity, and selected-store metadata. Encrypt at rest with deployment-managed key/KMS; decrypt only in request memory; never log credential material. Vault outage, slot mismatch, or missing record fails closed.
3. **Account enrollment:** user chooses an operator-registered target server. Hub creates server-side pending transaction with expected target origin, exact registered hub callback, opaque state, PKCE verifier, and slot id, then same-tab navigates to target admin login. Target registers exact hub client/callback; target origin performs password + TOTP/recovery/passkey ceremony using its own current routes. Target adds a new code-issuer/exchange endpoint (the existing `returnToken:true` login contract is precedent only, not this exchange): it issues one-time opaque code bound to issuer, target client/callback, authenticated principal/session, PKCE challenge, and short expiry. Hub callback accepts only expected state, issuer, target origin, and exact callback; broker redeems code server-to-server at expected target endpoint, verifies issuer/audience/session/PKCE, then stores target API credential in vault. No caller-selected redirect or target URL is trusted, preventing mix-up/open-redirect. Existing saved accounts switch in-place; only enrollment/reconnect navigates ([RFC 9700 §§2.1, 4.1, 4.4](https://www.rfc-editor.org/rfc/rfc9700.html)).
4. **Request binding:** browser sends hub cookie + opaque slot id to BFF. BFF resolves slot only from server-side vault, never caller-supplied URL, forwards fixed `/v1/admin` calls with target bearer and `x-store-slug`, and returns sanitized responses. Target `admin-agent-guard` must consume bearer before target `requireAdmin`, preserving agent, MFA, and passkey-review gates; BFF is a router, not replacement auth authority. Target 401/expiry marks only selected slot reconnect-required; no fallback to another slot.
5. **Switching:** dropdown selects slot, aborts old requests, clears/remounts account-scoped state, probes target `/me`, restores slot's last valid store, then renders. Existing store dropdown remains nested under active target identity. “Sign out this account” revokes target session through target API, deletes vault record, and clears metadata; “sign out all accounts” is explicit.
6. **Target registry & SSRF boundary:** arbitrary browser-provided URLs must not become outbound destinations. Prefer operator-registered HTTPS target origins; each registered origin is full scheme + host + port and maps explicitly to one runtime. If generic first-use URLs are required, canonicalize and validate scheme/port, DNS/IP (deny loopback, link-local, private, multicast, metadata ranges), certificate, redirect target, method/path, response size, and timeouts. BFF must not reflect target headers or proxy arbitrary paths. Never merge `admin.orthiclabs.com` and `admin.sellright.cc` without deployment-declared canonicalization.

### Passkey and origin constraint

WebAuthn credentials bind to registered target RP ID/origin. Central hub cannot reuse one passkey assertion across unrelated target origins. Enrollment/reconnect therefore runs on each target origin, with target's RP configuration and target `admin-agent-guard` enforcing MFA/passkey policy, then uses one-time handoff to broker. WebAuthn Related Origins is a separate explicit opt-in requiring target RP configuration, `.well-known/webauthn` declarations, exact related origins, and browser support; it must not be assumed for generic independent runtimes ([W3C WebAuthn Related Origins](https://www.w3.org/TR/webauthn-3/#sctn-related-origins)).

### Why account slots, not stores or five sites

`admin_user_store` already models one target admin identity with many stores. A profile must represent target server + authenticated identity; store slug is only authorization context. RightSites source configuration presents five app domains as one configured suite catalog/store mapping, not five account identities. Generic RH/DD installations remain separate slots because their server origins and auth authorities differ.

## Alternatives and trade-offs

| Candidate | Benefit | Material drawback | Decision |
|---|---|---|---|
| One hosted admin origin per account + local slots | Minimal server change; current host-only cookie posture | RH/DD metadata and cookies cannot appear in one dropdown; requires navigation/tabs and does not meet full request | Partial same-origin phase only |
| Direct browser CORS to every target with HttpOnly target cookies | No BFF vault; target remains cookie authority | Exact allowlist + credentials CORS, cross-site cookie (`SameSite=None`/partitioning) support, CSRF token plumbing, browser privacy, and target WebAuthn origin config become deployment obligations | Reject as generic default |
| Direct bearer token per target in IndexedDB/WebCrypto | Simple cross-origin routing; aligns native API contract | Page code/active XSS can reach persistent credentials; CSRF exemption; reload/key lifecycle/recovery complexity | Reject; never put target bearer in web storage |
| **Central admin client + BFF encrypted target-session vault** | One dropdown across unrelated origins; browser holds only hub HttpOnly session; target keeps auth/ACL/MFA authority | New broker, vault, one-time handoff, target registration, SSRF controls, and per-target revocation paths | **Recommend** |
| Five RightSites host profiles | Matches visible domains | Source configuration routes five hosts through one suite catalog/store mapping; creates false account/store boundaries | Reject |

## Invariants & security limits

- **Authority split:** target server's admin session, `admin_user`/`admin_user_store`, `resolveAdmin`, `requireAdmin`, MFA, passkey review, and RLS remain authoritative. Hub metadata and vault routing grant no target permissions; BFF cannot elevate or choose a store outside target `stores[]`.
- **Guard path:** target bearer resolution must enter `admin-agent-guard` before `requireAdmin`; invalid bearer, malformed/unknown slot, missing vault record, target 401, or target `/me` identity mismatch fails closed without trying another credential or slot.
- **No browser target credential:** no target bearer, password, target cookie, vault key, or target CSRF secret in localStorage/sessionStorage/IndexedDB. Hub cookie is the only browser credential for brokered API calls.
- **Broker CSRF/session binding:** hub mutations require hub CSRF + same-site checks; every request binds hub session, slot id, target origin, and target store. Target bearer is sent only server-to-server over TLS.
- **Vault lifecycle:** encrypt at rest, restrict service access, rotate key, bound slot count, scrub logs/traces, delete on sign-out, and revoke target session where supported. Target idle/absolute expiry, password reset, TOTP/passkey changes, and password change can invalidate one or all slots.
- **Passkey boundary:** each target origin/RP ID performs its own WebAuthn ceremony. Handoff codes are one-use, short-lived, state/PKCE-bound, audience-bound to hub, and never substitute for target MFA.
- **Handoff issuer authority:** target registers exact hub client/callback and is sole code issuer; hub keeps originating transaction server-side, accepts only its expected target/issuer/state, redeems only at that target's fixed exchange endpoint, and rejects issuer/target/callback mix-up, replay, open redirect, or unsolicited code.
- **SSRF boundary:** target destinations come from registry or strict URL/IP policy; no private-network/metadata access, arbitrary redirect, header reflection, or arbitrary target path.
- **Cache/tab safety:** active slot is per tab; capture `{slotId, targetOrigin, storeSlug}` per request, abort old requests, and key/remount cache/query state by all three. Old responses never populate new identity views.
- **Unsaved work:** account/store switch prompts dirty forms/orders; cancel preserves, confirm discards/remounts. Do not rely only on reload.

## Migration & rollout

1. **Same-origin compatibility (optional partial phase):** namespaced HttpOnly slots may support multiple accounts on one existing admin origin, with selector consumed by `admin-agent-guard` + `requireAdmin`. Label this as same-origin only; it is not complete RH/DD support.
2. **Central hub foundation:** configure generic hub origin, target registry, vault encryption, hub session/CSRF, slot metadata, fixed proxy routes, SSRF controls, and account/store/cache isolation. Do not use personal domains as defaults.
3. **Target handoff:** add target-origin one-time handoff/session exchange, preserving target login, TOTP, passkey RP, agent policy, MFA, and `/me` identity checks. Existing `returnToken:true` remains server-to-server only.
4. **UI + migration:** account menu shows server/email/store; add-account uses same-tab target login then returns hub; migrate legacy current-origin session through explicit handoff. Existing store picker remains nested. Do not pre-seed five RightSites app hosts.
5. **Revocation/operations:** target 401 marks only selected slot; hub sign-out deletes vault + invokes target revoke; vault key rotation, bounded slot count, audit, outage behavior, and all-account sign-out are acceptance-gated before calling multi-server shape complete.

## UI contract

- Account menu is current top-right identity area. Each row shows target server hostname, account email, selected store, active check, and “Sign in again” state. Switching saved rows stays in same hub page; no sign-out, extra tab, or repeated sign-in.
- “Add account” creates slot, performs same-tab target-origin login/MFA/passkey, then returns to hub. Target origin is shown before credential entry; no arbitrary URL is silently trusted.
- Store switcher remains separate and lists only target `stores[]` for active slot, with role labels. RightSites app hostnames do not appear as five accounts.
- On switch: close menu, show loading, reset route/query/pending order context, restore slot's last valid store, and announce account/server/store. On failure, keep prior slot active and show reconnect state.

## Acceptance fingerprint

1. Map RH `:3340` and DD `:3350` runtimes to registered HTTPS admin origins, then add independent accounts through their target-origin login; after enrollment dropdown switches A ↔ B without sign-out, extra tab, or repeated sign-in.
2. `/me`, roles, permitted stores, and mutations follow selected target slot; overlapping store slugs never cross account/origin/cache boundaries.
3. One target identity with multiple permitted stores still uses existing store dropdown; store change cannot change account/server identity.
4. RightSites source configuration declares five public hosts on one suite catalog/store mapping; no live DB claim is made and no five-profile assumption appears.
5. Browser inspection shows no target token/password/cookie in web storage; only hub HttpOnly session is sent by browser. Vault records are encrypted, access-controlled, and scrubbed from logs.
6. Target bearer calls pass target `admin-agent-guard` + `requireAdmin`; agent, MFA enrollment, passkey review, TOTP, and target 401 behavior remain enforced.
7. Passkey enrollment/reconnect runs at exact target RP/origin; target-issued handoff code is bound to expected issuer, target, client/callback, principal/session, state, PKCE, and short expiry, and cannot be replayed, cross-bound, or used as target credential.
8. BFF rejects unregistered/private/redirected target URLs, arbitrary paths, oversized responses, and timeouts; no SSRF or header reflection.
9. Expire/revoke B: B alone becomes “Sign in again”; A remains usable. Password reset/revocation of all target sessions marks every affected slot.
10. Dirty form blocks switch; confirmed switch clears query cache, pending requests, navigation/order context, and stale responses.
11. Legacy same-origin users migrate through explicit hub/target handoff; no target credential disclosure, and current/all-account logout has exact scoped effects.
12. Keyboard/mobile account menu, focus return, escape/outside-click, disabled in-flight rows, and screen-reader active/expired announcements pass admin conventions.

## Evidence index

- Issue: `https://github.com/Orthic-Labs/sellright/issues/355` (read 2026-10-24).
- SellRight browser auth/session: `packages/admin/src/api.ts:4-60`; `packages/admin/src/auth.tsx:17-50`; `packages/admin/src/components/Layout.tsx:152-201`; `packages/api/src/auth/cookies.ts:71-99`; `packages/api/src/auth/admin-session.ts:67-71,180-270`; `packages/api/src/routes/admin-agent-guard.ts:58-75`; `packages/api/src/routes/admin-helpers.ts:50-70`; `packages/api/src/db/schema-core.ts:91-142,237-258`.
- Native precedent: `ios/SellRightAdmin/App/StoreProfile.swift:3-14`; `ios/SellRightAdmin/App/AppSession.swift:53-84,142-198,222-294`; `ios/SellRightAdmin/Core/APIClient.swift:24-30,81-119`; `ios/SellRightAdmin/Features/Settings/SettingsView.swift:26-103`.
- Native server contract & passkey/account binding: `ios/README.md:82-111`; `docs/plans/2026-10-21-passkeys-implementation.md:6-8,39-48`.
- SellRight deployment/security context: `README.md:1-40`; `docs/ARCHITECTURE.md:39-50,69-86,152-177`; `packages/admin/nginx.conf.template:14-27`.
- RightSites overlay/topology: remote `/home/vendure/sites/rightsites/docs/agent-rules.md:1-29`, `/home/vendure/sites/rightsites/README.md:1-22`, `/home/vendure/sites/rightsites/deploy/rightsites/README.md:1-30`, `/home/vendure/sites/rightsites/deploy/rightsites/store-hostnames.mjs:1-24,69`, and `/home/vendure/sites/nginx/rightsites.conf:24-30,150-187,267-287` plus five app-vhost configs.

