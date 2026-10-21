# Passkeys (WebAuthn) for admin and storefront, Google + Apple sign-in on the brand storefronts

Design, revision 14, final (2026-10-21; revision 7 plus the verbatim replacement text from review rounds 7–13; the remaining review findings from round 7 onward were pre-existing engine lock-order and proof-freshness paths that the implementation plan carries as tasks). Six adversarial review rounds (14, 10, 7, 5, 4, 3 findings) showed every finding
falling into two classes: (1) a pending or standing authorization outliving a security-relevant change of its owner,
(2) lock order between the new transactions and existing ones. Revisions 2–6 fixed the reported instances one at a
time. This revision closes the classes: **one security epoch per owner, bumped by database triggers, stamped into
every artifact, compared under the owner lock at every use** (§4, with the complete event × artifact matrix), and
**one lock discipline** derived from every existing transaction that touches the same rows (§5). Everything else
is kept from the earlier revisions. Repo: SellRight engine `packages/api` (Hono + Drizzle + zod-openapi), admin SPA
`packages/admin` (React), storefront `packages/storefront` (Qwik).

## 1. What exists today (verified in code)

- Admin: `POST /v1/admin/login` (password, optional TOTP; generic 401; matrix outcome `PUBLIC` with a genuine body
  credential per principal cell proving one session). `session` rows (`token_hash`, `step_up_at`, idle + absolute
  TTL, `last_seen_at` touched for admins only). MFA policy `auth/mfa-policy.ts`, enrolment-only sessions in
  `routes/admin-agent-guard.ts`. Second factor `auth/second-factor.ts` (replay guard per admin). Native step-up
  `POST /v1/admin/step-up` (password + factor) writes `session.step_up_at` (`auth/admin-session.ts:232`) without an
  owner lock; `requireStepUp` compares the cached principal's timestamp to a 5-minute window. Factor mutations
  `auth/admin-staff.ts`: advisory lock per admin, `admin_user` `FOR UPDATE` with credential snapshot check, calling
  session `FOR UPDATE` with expiry/idle revalidation; enable keeps the calling session (and its `step_up_at`),
  revokes the others; disable sets `totp_secret = NULL` and deletes recovery codes; `setAdminTotpSecret` /
  `clearAdminTotpSecret` / `setAdminPasswordHash` write the columns directly for other flows. TOTP secrets are sealed
  with prefix `enc1:` (`auth/totp-secret.ts`); startup sealing (`ADMIN_TOTP_SEAL_EXISTING=1`) and rollback unsealing
  rewrite the stored value without changing the logical secret; a 2FA enable refuses to overwrite an existing secret,
  so a secret only ever changes through NULL. Admin password change (`changeAdminPassword`) locks `admin_user` then
  the kept session, keeps that session, revokes the others. Session revocation by staff management
  (`revokeAllSessionsForAdmin`, `admin-settings-advanced.ts`) and agent seat removal delete sessions.
- Admission (`app.ts`): credential required on `/v1/admin/*` except the exact pre-session list (`login`, `logout`,
  `staff/accept`); CSRF with the same exemptions. `admin-agent-guard.ts`: `PUBLIC` returns before resolution. Agent
  policy (`auth/agent-policy.ts`): GET/HEAD/OPTIONS bypass; `scripts/assert-agent-boundary.mjs` invariants (every
  `AGENT_DENIED` key registered, every admin DELETE denied, every `IRREVERSIBLE_PATH` mutation denied or excepted,
  every denied non-DELETE covered by `IRREVERSIBLE_PATH`); `requireHuman` answers agents "agents cannot perform this
  action".
- Rate limits: `rateLimitBackend().consume(bucket, key, windowMs, max)` on **its own pool connection** (never inside
  a transaction); `reserveAdminAuthAttempt` (per IP + per account + pair); `attemptRetryAfter` (`ip|identifier`,
  8/15 min).
- Database: `withStore` sets `app.current_store`; tenant tables forced RLS with `tenant_isolation` on
  `nullif(current_setting('app.current_store', true), '')::uuid`; `unsafeUnscopedDb` is the same NOBYPASSRLS role;
  `EXEMPT` inventories in `db/assert-force-rls.ts` / `db/rls-tables.test.ts`. Triggers exist (`0049_restock_notify`
  style: plpgsql function + `CREATE TRIGGER ... FOR EACH ROW EXECUTE FUNCTION`). `customer_token.kind` CHECK (0061)
  + enum; `mintMagicLink` stores a hash only.
- Customers: registration issues a session while unverified; native login refuses unverified accounts after the
  password check and **rehashes** an outdated verified hash in place (`routes/auth.ts:170-175`); password reset
  (`customer-tokens.ts`) locks the customer first, claims the token, changes the hash, revokes sessions; signed-in
  password change (`account.ts:382-393`) resolves the session via `me()` (renewal may update/lock the session row),
  hashes, updates the customer, keeps the calling session, deletes the others; profile update and address creation
  call `me()` (possible renewal lock) then update/insert against the customer; email change burns all pending
  tokens, sets the new address verified, revokes sessions; account erasure deletes tokens and sessions, then the
  customer; Google/Apple linking sets `google_sub`/`apple_sub` and `email_verified`; magic link consumption may set
  `email_verified`; nothing ever sets `email_verified` back to false. `me(tx, token, forceRenew)` exists.
- Storefront UI: Google button gated by `VITE_GOOGLE_CLIENT_ID` + `VITE_SELLRIGHT_STORE_SLUG` + host in
  `SELLRIGHT_GOOGLE_SIGNIN_HOSTS`; no Apple button; `GET /v1/shop/config` exposes `auth.magicLink`. Admin UI:
  `pages/Login.tsx`, `pages/Settings.tsx`, `api.ts`.
- Authorization gate: eight principals; customer routes = denial cells + genuine controls; public auth routes =
  `PublicAuthControl`s; two CI lanes. Migrations hand-written, journaled, guard-listed, additive for image rollback.
- No WebAuthn anywhere. Node 24.

## 2. Decision (ADR)

**Product outcome.** Owners sign in and step up with a touch; customers get passwordless sign-in. Success: passkey
sign-ins and step-ups in the audit log; no new account-takeover path, proven by §8. Non-goals: passkey-only
accounts, removing TOTP, passkey-first customer registration.

**Decision.** Passkeys as an additional primary credential on both surfaces with `@simplewebauthn/server` 14.0.3
(Node ≥ 20) and `@simplewebauthn/browser` 14.0.0, governed by a per-owner **security epoch** (§4): every credential,
pending ceremony, management grant, mailbox token and step-up carries the owner's epoch at issuance and is valid only
while it equals the owner's current epoch; database triggers bump the epoch on every recovery-relevant change, on
any engine image. Admins keep TOTP + recovery codes while any passkey exists; customers add passkeys to a verified
account through a single-use management grant.

**Alternatives rejected.** Google/Apple SSO for the admin; hand-rolled WebAuthn; `@passwordless-id/webauthn`;
passkey-first customer registration; per-event invalidation rules (revisions 2–6: every review found the next event).

**Riskiest assumption.** One registrable domain per brand covers storefront and sub-path admin (RightSites:
`admin.spoares.com`); admin and customer credentials are separate rows in separate tables. Smallest test: one
browser profile registers an admin passkey at `rottenhand.com/admin` and a customer passkey at `rottenhand.com`;
each works on its own surface and bare/www twin and is refused on the other.

**Blast radius.** Four new tables, three new columns on existing tables, two triggers, one widened CHECK, new
routes, new UI; existing paths change only where §5/§7 say. **Rollback:** additive migration stays applied; rollback
= previous image or `PASSKEYS_ENABLED=0`; the triggers keep bumping epochs under the previous image, so its password
resets, TOTP disables/enables and password changes invalidate exactly what they should (§4 matrix, rehearsed in
§10). **Hidden coupling:** matrix inventory, agent-policy inventories and `IRREVERSIBLE_PATH`, storefront client
regeneration, force-RLS inventory, `app.ts` allowlists, limiter outside transactions, the rehash path setting a
transaction-local flag for the customer trigger.

## 3. Relying party identity and origins

`rpName`: store name / "SellRight Admin". `rpID`: registrable host of the surface (hostname of `ADMIN_PUBLIC_URL`,
fallback `STOREFRONT_URL`, `www.` stripped; shop: the store's resolved host, `www.` stripped). `expectedOrigin`:
explicit array (configured origin + www/bare twin); `expectedRPID`: the rpID. Never from request headers.
Credentials are looked up only in their own table.

## 4. The security epoch

Columns (additive): `admin_user.security_epoch integer NOT NULL DEFAULT 0`, `customer.security_epoch integer NOT
NULL DEFAULT 0`, `session.step_up_epoch integer` (NULL = step-up not usable for passkey management).

Triggers (plpgsql, `0049` style, owned by the migration role, run as the invoker; the runtime role holds UPDATE on
`session`, which is all the admin trigger writes besides `NEW`):

```sql
CREATE FUNCTION admin_user_security_epoch() RETURNS trigger AS $$
DECLARE old_totp text := OLD.totp_secret; new_totp text := NEW.totp_secret;
        old_sealed boolean := old_totp LIKE 'enc1:%'; new_sealed boolean := new_totp LIKE 'enc1:%';
        totp_changed boolean; password_changed boolean;
BEGIN
  -- A seal (plain -> enc1:) or unseal (enc1: -> plain) rewrites the representation of the same logical secret:
  -- totp-secret.ts only ever converts in place, and a 2FA enable refuses to overwrite an existing secret, so a
  -- cross-representation transition with both sides non-null is never a new secret.
  totp_changed := (old_totp IS DISTINCT FROM new_totp)
                  AND NOT (old_totp IS NOT NULL AND new_totp IS NOT NULL AND old_sealed <> new_sealed);
  password_changed := OLD.password_hash IS DISTINCT FROM NEW.password_hash;
  IF totp_changed THEN NEW.security_epoch := OLD.security_epoch + 1; END IF;
  IF totp_changed OR password_changed THEN
    UPDATE session SET step_up_at = NULL, step_up_epoch = NULL WHERE admin_user_id = OLD.id AND step_up_at IS NOT NULL;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "admin_user_security_epoch_trg" BEFORE UPDATE OF "totp_secret", "password_hash" ON "admin_user"
  FOR EACH ROW EXECUTE FUNCTION admin_user_security_epoch();--> statement-breakpoint
CREATE FUNCTION customer_security_epoch() RETURNS trigger AS $$
BEGIN
  -- The engine's verified rehash (routes/auth.ts) sets app.passkey_rehash='1' for its transaction: same password,
  -- new representation, no bump. Every other password_hash write (reset, change, previous image's rehash) bumps.
  IF OLD.password_hash IS DISTINCT FROM NEW.password_hash
     AND coalesce(current_setting('app.passkey_rehash', true), '') <> '1' THEN
    NEW.security_epoch := OLD.security_epoch + 1;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "customer_security_epoch_trg" BEFORE UPDATE OF "password_hash" ON "customer"
  FOR EACH ROW EXECUTE FUNCTION customer_security_epoch();
```

**Rule.** Every artifact row stores `epoch` = the owner's `security_epoch` when it was issued. Every use re-reads the owner row under the owner lock and requires `artifact.epoch = owner.security_epoch`; on mismatch the artifact is deleted (credentials: audited `passkey_invalidated`) and the request fails generically. In the new image, every step-up consumer requires a live calling session, fresh `step_up_at`, and `session.step_up_epoch = owner.security_epoch`, re-read under `admin_user FOR UPDATE` followed by the calling session `FOR UPDATE`; the cached principal is never sufficient. This includes passkey management, admin password change, `GET /v1/admin/system/recovery-kit`, and `PATCH /v1/admin/settings/security`. Hold these locks through the authorized operation: construct the recovery-kit result and record its download in the transaction, or acquire the store lock and commit the security-policy change and audit in that transaction. Use transaction-aware helpers on the same connection; do not call helpers that open another transaction while these locks are held. Preserve installation-admin, human, store-owner, absolute-expiry and idle-expiry checks. Native and passkey step-up both write `step_up_at` and `step_up_epoch` under the owner lock (§5); a NULL epoch requires a new step-up. Add deterministic real-route tests pausing both existing consumers after principal resolution, committing passkey deletion or credential invalidation, and then resuming: no recovery key is returned and no policy change or success audit is committed. Cover both lock interleavings without retries or sleeps.

**Event × artifact matrix** (C = credential, P = pending ceremony challenge, G = management grant, M = mailbox
token `passkey_manage`, S = step-up usable for passkey management; "epoch" = invalidated by the epoch rule, "del" =
also deleted explicitly by the new image, "—" = unaffected by design, "n/a" = cannot exist):

| Event (any image unless noted) | Admin C | Admin P | Admin S | Customer C | Customer P / G / M | Customer S |
|---|---|---|---|---|---|---|
| Admin TOTP disable (`totp_secret` → NULL) | epoch + del | epoch + del | trigger clears | n/a | n/a | n/a |
| Admin TOTP enable (NULL → secret), incl. re-enable with the same secret | epoch (C already gone) | epoch | trigger clears | n/a | n/a | n/a |
| TOTP seal / unseal (`enc1:` flip) | — | — | — | n/a | n/a | n/a |
| Admin password change (kept session) / rehash on login / staff-management reset | — (not password-derived) | — | trigger clears | n/a | n/a | n/a |
| Admin passkey deleted (new image) | that row | del (all of the admin's) | cleared on all sessions (`step_up_at`, `step_up_epoch` NULL) | n/a | n/a | n/a |
| Admin sessions revoked (staff management, agent removal, logout, password change, TOTP enable) | — | orphaned: the session re-read at verify fails; expires | gone with the session | n/a | n/a | n/a |
| Admin removed (`admin_user` delete) | FK cascade | FK cascade | gone | n/a | n/a | n/a |
| Customer password reset (mailbox) | n/a | n/a | n/a | epoch + del | epoch + del; the new image explicitly deletes this customer's `passkey_manage` tokens in the same owner-locked reset transaction, alongside C/P/G deletion. The existing reset only burns `password_reset` and `email_change` tokens. During previous-image rollback, M remains stored but is unusable because its epoch differs and its bound session is revoked; test that distinction. | sessions revoked |
| Customer signed-in password change (kept session), or a first password set on a passwordless account (`set_password`, NULL → hash: bumps too, because the previous image's reset on such an account takes the same shape and is a recovery) | n/a | n/a | n/a | epoch + del | epoch + del | n/a (customers have no step-up; G is the step-up) |
| Customer verified rehash on login — new image (Argon2 work-factor upgrade and the Vendure legacy-hash upgrade: every in-place rehash sets `app.passkey_rehash`) | n/a | n/a | n/a | — | — | n/a |
| Customer verified rehash on login — previous image during rollback | n/a | n/a | n/a | epoch (documented edge: re-add) | epoch | n/a |
| Customer email change | n/a | n/a | n/a | — (bound to the account) | M burned by the existing "all tokens used" rule; P/G orphaned (sessions revoked) | n/a |
| Email verified / Google or Apple linked | n/a | n/a | n/a | — | — | n/a |
| Customer passkey registered (new image) | n/a | n/a | n/a | + row | del all unconsumed M; when registration changes the owner from zero to one current-epoch credential, also delete all of that customer's P/G in the same owner-locked transaction, including outstanding registration challenges and previously confirmed mailbox grants. This ends every pending bootstrap authorization without invalidating the newly inserted credential or changing the owner epoch. Test two mailbox grants confirmed before first registration, with one already exchanged for a registration challenge: after first registration commits, neither the remaining grant nor the outstanding challenge may authorize another enrollment or deletion. | n/a |
| Customer passkey deleted (new image) | n/a | n/a | n/a | that row | del all P/G/M of the customer (passkey-sourced also FK-cascade) | n/a |
| Account erasure | n/a | n/a | n/a | FK cascade | FK cascade / existing token delete | n/a |
| Session revoked / expired (any path) | — | orphaned; expires | gone | — | orphaned; expires | — |
| Artifact expiry (P/G 5 min, M 15 min, pruned) | — | gone | — | — | gone | — |

Every "del" runs inside the transaction of the event, after the owner lock; "orphaned" needs no code: the artifact's `session_hash` no longer resolves to a live session at use, which every branch checks before the claim. Pending artifacts are short-lived
(5–15 min); an image rollback takes longer than that, so the triggers only need to be durable for credentials and
step-ups, which they are.

## 5. Lock discipline

Order for every new passkey transaction: **owner row `FOR UPDATE` → (admin only) calling session row `FOR UPDATE` → artifact claim → credential row `FOR UPDATE` → writes.** Customer passkey transactions never lock or delete a session row: they re-read the session with a plain `SELECT` under the customer lock, requiring the same customer and store, `expires_at > clock_timestamp()` and the legacy-expiry rule, without idle checks or renewal. Every customer-session revocation must therefore acquire that same customer lock before deleting sessions. Restructure `POST /v1/shop/auth/logout` and `deleteSession`: identify the customer using a non-renewing lookup constrained by token hash and resolved store, lock that customer `FOR UPDATE`, then delete only the session matching that token hash, customer and store on the same connection. Preserve CSRF validation, cookie clearing and idempotent success for an absent session. Password reset, password change, email-change consumption and erasure retain their customer-first revocation order. Hold the customer lock through each artifact claim and authorized effect. Add deterministic real-route races between customer logout and management-grant issuance, mailbox confirmation, grant consumption and registration verification: when logout wins, no artifact is consumed and no credential mutation succeeds; when the authenticated operation wins, logout cannot commit until that operation finishes. Cover both lock interleavings without retries or sleeps.

Existing transactions and how they interact:

| Existing path | Its order today | Change |
|---|---|---|
| Password reset (`customer-tokens.ts`) | customer `FOR UPDATE` → token claim → customer update → session delete | + delete C/P/G (M already burned). Same order as ours; a passkey tx waiting on the customer sees the new epoch |
| Signed-in password change (`account.ts`) | `me()` (renewal may lock session) → verify → customer update → delete other sessions | **restructured**: verify the password and compute the replacement hash outside the mutation transaction using an explicitly non-renewing credential read. In one mutation transaction: customer `FOR UPDATE` → non-renewing live-session re-read → hash snapshot re-check (`password_hash` unchanged since verification, else 409 `CREDENTIAL_CHANGED`) → password update and trigger-driven epoch bump → delete C/P/G/M → delete every other session for this customer and store. Keep the calling session. Commit the password change, artifact invalidation and session revocation atomically; any failure rolls back all three. Apply the resolver restructuring in the following row before retaining this customer-to-session order. Add a failure-injection test through the real password-change route proving that failure during session revocation leaves the password, epoch and artifacts unchanged. |
| Customer session resolution and subsequent business mutations (`auth/session.ts` and its callers, including profile/address operations in `account.ts`, birthday updates in `loyalty.ts`, and verification operations in `sheerid.ts`) | `resolveCustomer()` can renew and lock a session before a later customer update or customer-FK check; reset, email-change consumption and erasure acquire the customer before deleting sessions | **restructured**: add an explicit non-renewing mode to `resolveCustomer` and its wrappers; the existing `forceRenew = false` does not disable automatic renewal. Business transactions use non-renewing resolution and revalidate the live session inside their own transaction. Preserve automatic renewal in a separate resolver transaction that commits before business locks are acquired; do not open that transaction from inside another transaction. Keep existing commerce-lock ordering before customer locks. Add deterministic tests through the real profile, address, birthday and SheerID paths against password reset, signed-in password change, email-change consumption and erasure, with renewal eligible and both lock interleavings; verify that none deadlocks. |
| Native admin step-up (`admin-system.ts` → `admin-session.ts:232`) | session update, no owner lock | **restructured**: read `security_epoch`, `password_hash` and the stored TOTP version together in `getAdminCredentialsById` before verifying the password and second factor. Carry that verified snapshot into the mutation transaction: `admin_user` `FOR UPDATE` → require both the captured epoch and the hash/TOTP snapshot to equal the locked row, otherwise reject with 409 `CREDENTIAL_CHANGED` → calling session `FOR UPDATE` with owner, expiry and idle revalidation → write `step_up_at` and the captured, still-current `step_up_epoch`. Never assign the current epoch to proof obtained under a different epoch. Add a deterministic real-route test that pauses native step-up after credential verification, disables and re-enables the same plaintext TOTP secret while keeping the calling session, then resumes step-up and proves that no usable step-up is written. |
| Admin factor mutations and standalone TOTP verification (`admin-staff.ts`, `second-factor.ts`) | Factor mutation: credential advisory → admin `FOR UPDATE` → session `FOR UPDATE` → replay advisory; standalone TOTP verification: replay advisory → replay-row insert → implicit admin FK `KEY SHARE` | **restructured**: capture `security_epoch`, `password_hash` and the stored TOTP version together before password or factor verification for enable, disable and recovery-code regeneration. Pass the captured epoch explicitly through every `mutateAdminSecondFactor` caller, including the enable caller's explicit argument object. After the credential advisory lock and admin `FOR UPDATE`, require the captured epoch and both credential snapshots to equal the locked row before locking the calling session or performing any mutation; otherwise return 409 `CREDENTIAL_CHANGED`. Retain session owner, expiry and idle revalidation. Standalone `verifyTotpOnce` acquires the existing admin row `FOR SHARE` in its own transaction before acquiring the `totp-step` advisory lock or touching replay rows, and refuses a missing owner. Transactional factor verification uses the caller's already-held admin `FOR UPDATE` lock before the replay advisory lock; never acquire the owner after the replay advisory lock. Keep standalone verification committed before subsequent mutation transactions, which must re-check their captured epochs and credential snapshots. Add the TOTP invariant check (passkeys exist → 409 `PASSKEYS_ENROLLED` on disable); the trigger performs epoch/step-up invalidation. Add deterministic real-route races between TOTP disable and standalone verification through login, native step-up, enrolment and recovery-code regeneration. Also pause regeneration after successful factor verification, disable and re-enable the same plaintext secret using the retained calling session, then prove the pending regeneration cannot replace recovery codes; pause enrolment across a NULL → secret → NULL cycle and prove it cannot install its previously verified secret. Cover both lock interleavings without retries or sleeps. |
| Admin password change (`admin-security.ts` → `admin-session.ts`) | Cached `requireStepUp` → password verification and hashing → `admin_user` `FOR UPDATE` → kept session `FOR UPDATE`; the mutation currently checks only the password hash and session absolute expiry | **restructured**: before password verification, read the owner's `security_epoch`, `password_hash` and stored TOTP version together with the calling session's `step_up_at` and `step_up_epoch`, and require a fresh step-up for that snapshot. Carry these captured values into `changeAdminPassword`. In its mutation transaction: `admin_user` `FOR UPDATE` → require the captured epoch and credential snapshot to match → calling session `FOR UPDATE` → revalidate owner, absolute expiry, idle expiry, step-up freshness, `step_up_epoch = security_epoch`, and equality of both step-up fields to the captured proof. Reject changed proof with 409 `CREDENTIAL_CHANGED` before any password update or revocation. Only then update the password and revoke other sessions atomically; the trigger clears step-ups. Add deterministic real-route tests that pause password change after verification, delete the authorizing passkey or disable and re-enable TOTP while retaining the calling session, then resume and prove the password and remaining sessions are unchanged. Cover both lock interleavings without retries or sleeps. |
| Native admin login (`routes/admin.ts` → `createAdminSessionIfCredential`) | Password/factor verification and conditional rehash occur before the session-creation transaction; the rehash checks only the password hash | **restructured**: `findAdminByEmail` reads `security_epoch`, `password_hash` and the stored TOTP version together before password/factor verification. Compute any optional replacement hash outside the transaction, without writing it. In one mutation transaction, acquire `admin_user FOR UPDATE` and require the captured epoch, password hash and stored TOTP version to equal the locked row before any rehash or session insertion; reject a changed snapshot with the generic login failure. Only after this check may this request apply its verified rehash and insert the session, atomically. Remove the standalone pre-transaction rehash write from login. If SQL rehash remains best-effort, isolate it in a savepoint on this same connection so failure rolls back both the hash update and trigger effects before continuing with the unchanged hash. A boolean `secondFactorVerified` alone is insufficient. Add deterministic real-route tests pausing login after successful factor verification, disabling and re-enabling TOTP with both the same and a different secret, then resuming login and proving that no session is created. Include an outdated password hash and a fresh step-up earned after the TOTP cycle: the rejected login must leave both the password hash and all session step-up fields unchanged. |
| Session revocations (staff management, agent lifecycle, logout) | Human bulk revocation deletes sessions without an owner lock; agent lifecycle also holds grant/token locks | **restructured**: every human multi-session revocation takes the target `admin_user` row `FOR UPDATE` before locking or deleting any session rows. Apply this to the direct staff revoke-sessions transaction in `admin-settings-advanced.ts`, `revokeAllSessionsForAdmin` and `revokeOtherAdminSessions`; preserve the existing authorization checks and atomic audit. Password and factor mutations already hold this owner lock. Single-session logout and agent-only lifecycle operations remain unchanged. Session-bound artifacts are orphaned and expire. Add deterministic real-route races with at least two live sessions between bulk revocation and passkey deletion, password change and TOTP-triggered invalidation, covering the interleaving where revocation would otherwise lock a different session before reaching the calling session; require completion without deadlock retries. |
| Email change (`customer-tokens.ts`) | customer `FOR UPDATE` → token claim → customer update → session delete | unchanged (M burned by the existing rule; P/G orphaned) |
| Account erasure | customer `FOR UPDATE` → ... → customer delete | FK cascades |

Existing-account staff-invite acceptance (`admin-settings-advanced.ts` → `findAdminCredentialsByEmail`) is also restructured. The credential branch reads `security_epoch`, `password_hash` and the stored TOTP version together before password/factor verification and carries that snapshot into acceptance. Preserve the existing store-membership advisory lock first; then lock the existing `admin_user` row `FOR UPDATE`, require the same human identity and invite email, and require the captured epoch, password hash and stored TOTP version to match before claiming the invite or writing membership. Reject changed credential proof with 401 `INVITE_AUTH_FAILED`. The authenticated-session branch preserves CSRF validation and, after the owner lock, locks the exact authorizing session `FOR UPDATE` and revalidates its owner, absolute expiry and idle expiry; a cached `sessionHuman` result is insufficient. Keep invite claim, membership insertion and audit atomic, preserve the existing new-account and existing-membership guards, and perform no nested database calls while holding these locks. Add deterministic real-route tests pausing credential-based acceptance after verification across password replacement and TOTP disable/re-enable, and session-based acceptance after resolution across session revocation; rejection leaves the invite unconsumed and membership unchanged.

Recovery-code proof additionally carries a server-internal receipt containing the consumed `admin_recovery_code.id`, its `admin_user_id` and the persisted `used_at` returned by the successful atomic consumption. Native login, native step-up, existing-account credential-based staff-invite acceptance and recovery-code regeneration carry this receipt alongside the captured epoch/password/TOTP snapshot. Under the final `admin_user FOR UPDATE` lock, before any rehash, session insertion, step-up write, invite claim or recovery-code replacement, require that exact consumed recovery-code row and timestamp still exist for the locked owner. A missing or changed receipt rejects the pending operation using its existing credential-failure response. Never accept this receipt from the client. Recovery-code replacement and deletion, including standalone helpers, acquire the owner lock before touching recovery-code rows; when the credential advisory lock is used, acquire it before the owner lock. Transactional factor consumption remains inside its caller's owner-locked transaction. Regeneration need not invalidate independent passkeys, TOTP proof or already-completed step-ups. Add deterministic real-route tests pausing each recovery-code-authenticated consumer after consumption, regenerating the codes through another session, then resuming: no session, step-up, membership or replacement recovery-code set may be committed. In the regeneration case, the newer returned codes must remain usable. Cover both lock interleavings without retries or sleeps.

Admin device registration (`POST /v1/admin/devices`, `routes/admin-push.ts`) is also restructured. In its existing store-scoped transaction, acquire the existing `admin_user` row `FOR SHARE` before acquiring any membership, session or device-token lock, and reject a missing owner. Then retain the membership `FOR SHARE` check, the exact calling-session `FOR SHARE` check and the device-token upsert on the same connection. Hold the owner lock through commit so the upsert's implicit admin foreign-key check cannot introduce a session-to-owner lock inversion. Preserve tenant scoping, session ownership and expiry checks, membership revocation protection, token rebinding and session-delete cascades. Add deterministic real-route races between device registration and admin passkey registration, passkey step-up, passkey deletion, password change and bulk session revocation; cover both lock interleavings without retries or sleeps and require completion without deadlocks.

Deterministic concurrency controls (§8) race each new transaction against each row above, staff-invite acceptance and admin device registration in both orders.

Existing mailbox-token consumption is also restructured. `POST /v1/shop/auth/magic-link/consume` and `POST /v1/shop/auth/verify-email` first identify the token's customer without locking or consuming the token. In their mutation transaction, acquire the existing `lockCustomerLoyalty` advisory lock before the customer row, then acquire that customer `FOR NO KEY UPDATE`, constrained by customer and store, and reject a missing owner. This owner lock conflicts with recovery, email change, erasure and passkey operations while remaining compatible with commerce's customer foreign-key `KEY SHARE` locks. Only then atomically claim the exact token with hash, customer, store, kind, unused and `expires_at > clock_timestamp()` predicates. Preserve token consumption, email verification, signup bonus and, for magic links, session creation in the same transaction; failed claims perform none of those effects. `consumeMagicLink` must require this caller-held lock discipline. Both routes acquire the loyalty lock before the customer lock so neither retains the reverse customer-to-loyalty order through `grantSignupBonus`. Add deterministic real-route races against email-change consumption and erasure, with verified and unverified customers and signup bonuses enabled and disabled, plus concurrent loyalty checkout. Cover both lock interleavings without retries or sleeps: invalidation winning prevents token consumption and session issuance; consumption winning completes before invalidation proceeds; no deadlock occurs.

Deterministic concurrency controls (§8) race each new transaction against each row above and staff-invite acceptance in both orders.

## 6. Schema (migration `0108_passkeys.sql`, hand-written, journaled, guard-listed)

Global admin tables (no `store_id`; `unsafeUnscopedDb`; `EXEMPT` in both inventories) and tenant customer tables
(forced RLS; `withStore` only). Columns are those of revision 6 with `bound_fingerprint` replaced by `epoch integer
NOT NULL`; the three columns and two triggers of §4; `customer_passkey_challenge.authorizing_credential_id` with FK
cascade for passkey-sourced grants and the register challenges they mint; `customer_token.kind` gains
`passkey_manage` (CHECK re-created in place, enum extended; `payload = { sessionHash, nonceHash, epoch }`).

```sql
-- HAND-WRITTEN: see docs/runbooks/migrations.md — do NOT regenerate via drizzle-kit.
ALTER TABLE "admin_user" ADD COLUMN "security_epoch" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "security_epoch" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "step_up_epoch" integer;--> statement-breakpoint
CREATE TABLE "admin_passkey_credential" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "admin_user_id" uuid NOT NULL REFERENCES "admin_user"("id") ON DELETE CASCADE,
  "rp_id" text NOT NULL, "credential_id" text NOT NULL, "public_key" bytea NOT NULL,
  "counter" bigint NOT NULL DEFAULT 0, "transports" text[] NOT NULL DEFAULT '{}',
  "device_type" text NOT NULL, "backed_up" boolean NOT NULL, "aaguid" text, "label" text NOT NULL,
  "epoch" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(), "last_used_at" timestamptz,
  CONSTRAINT "admin_passkey_credential_rp_cred" UNIQUE ("rp_id", "credential_id")
);--> statement-breakpoint
CREATE INDEX "admin_passkey_credential_admin" ON "admin_passkey_credential"("admin_user_id");--> statement-breakpoint
CREATE TABLE "admin_passkey_challenge" (
  "challenge_hash" text PRIMARY KEY,
  "kind" text NOT NULL CHECK ("kind" IN ('register','login','step_up')),
  "rp_id" text NOT NULL,
  "admin_user_id" uuid REFERENCES "admin_user"("id") ON DELETE CASCADE,
  "session_hash" text, "nonce_hash" text NOT NULL, "epoch" integer,
  "expires_at" timestamptz NOT NULL, "consumed_at" timestamptz,
  CONSTRAINT "admin_passkey_challenge_shape" CHECK (
    ("kind" = 'login' AND "admin_user_id" IS NULL AND "session_hash" IS NULL AND "epoch" IS NULL) OR
    ("kind" <> 'login' AND "admin_user_id" IS NOT NULL AND "session_hash" IS NOT NULL AND "epoch" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX "admin_passkey_challenge_expires" ON "admin_passkey_challenge"("expires_at");--> statement-breakpoint
CREATE TABLE "customer_passkey_credential" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "store_id" uuid NOT NULL REFERENCES "store"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customer"("id") ON DELETE CASCADE,
  "rp_id" text NOT NULL, "credential_id" text NOT NULL, "public_key" bytea NOT NULL,
  "counter" bigint NOT NULL DEFAULT 0, "transports" text[] NOT NULL DEFAULT '{}',
  "device_type" text NOT NULL, "backed_up" boolean NOT NULL, "aaguid" text, "label" text NOT NULL,
  "epoch" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(), "last_used_at" timestamptz,
  CONSTRAINT "customer_passkey_credential_rp_cred" UNIQUE ("store_id", "rp_id", "credential_id")
);--> statement-breakpoint
CREATE INDEX "customer_passkey_credential_customer" ON "customer_passkey_credential"("store_id", "customer_id");--> statement-breakpoint
ALTER TABLE "customer_passkey_credential" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_passkey_credential" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_passkey_credential"
  USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid)
  WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint
CREATE TABLE "customer_passkey_challenge" (
  "challenge_hash" text PRIMARY KEY,
  "store_id" uuid NOT NULL REFERENCES "store"("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('register','login','manage','grant')),
  "rp_id" text NOT NULL,
  "customer_id" uuid REFERENCES "customer"("id") ON DELETE CASCADE,
  "session_hash" text, "nonce_hash" text NOT NULL,
  "grant_source" text CHECK ("grant_source" IN ('password','passkey','mailbox')),
  "authorizing_credential_id" uuid REFERENCES "customer_passkey_credential"("id") ON DELETE CASCADE,
  "epoch" integer,
  "expires_at" timestamptz NOT NULL, "consumed_at" timestamptz,
  CONSTRAINT "customer_passkey_challenge_shape" CHECK (
    ("kind" = 'login' AND "customer_id" IS NULL AND "session_hash" IS NULL AND "grant_source" IS NULL AND "epoch" IS NULL) OR
    ("kind" IN ('register','manage') AND "customer_id" IS NOT NULL AND "session_hash" IS NOT NULL AND "grant_source" IS NULL AND "epoch" IS NOT NULL) OR
    ("kind" = 'grant' AND "customer_id" IS NOT NULL AND "session_hash" IS NOT NULL AND "grant_source" IS NOT NULL AND "epoch" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX "customer_passkey_challenge_expires" ON "customer_passkey_challenge"("store_id", "expires_at");--> statement-breakpoint
ALTER TABLE "customer_passkey_challenge" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_passkey_challenge" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "customer_passkey_challenge"
  USING ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid)
  WITH CHECK ("store_id" = nullif(current_setting('app.current_store', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "customer_token" DROP CONSTRAINT IF EXISTS "customer_token_kind_check";--> statement-breakpoint
ALTER TABLE "customer_token" ADD CONSTRAINT "customer_token_kind_check"
  CHECK (kind IN ('password_reset', 'email_verify', 'set_password', 'email_change', 'magic_link', 'passkey_manage'));--> statement-breakpoint
-- (the two trigger functions and triggers of §4 follow here)
-- DOWN (never run automatically): drop triggers/functions, the four tables, the three columns; restore the 0061 CHECK.
```

Drizzle: admin tables + `adminUser.securityEpoch` in `schema-core.ts`, customer tables + `customer.securityEpoch`
and the enum value in `schema-content.ts`, `session.stepUpEpoch` in `schema-core.ts`. Expired challenge rows
pruned by the stale-allocations job.

## 7. Contract branches, routes, policies

The five branches of revision 6 are unchanged except that every claim predicate compares `epoch` instead of a
fingerprint, every registration/step-up/management route re-reads `step_up_epoch`/`security_epoch` under the owner
lock, and the invalidations of §4 run inside the event transactions. For reference:

- **A. Assertion** (admin `login`/`step_up`, customer `login`/`manage`): options → challenge row (kind, rp_id,
  owner/session/epoch for authenticated kinds, nonce always, 5 min); verify → unlocked identification of the
  credential's owner → per-credential budget (§8) → tx: owner lock → session re-read (admin: `FOR UPDATE` +
  idle/expiry; customer: plain read, verified email) → atomic claim with every binding including `kind` → credential
  `FOR UPDATE`, owner check, `userHandle` (login), `epoch = owner.security_epoch` (else delete + audit + fail) →
  `verifyAuthenticationResponse` (`requireUserVerification: true`) → conditional counter update → effect (admin
  session with second factor satisfied / `step_up_at` + `step_up_epoch` / grant row / customer session). Customer
  login refuses an unverified account after verification with native login's generic 401.
- **B. Registration**: admin requires `step_up_epoch = security_epoch` and fresh `step_up_at` under the lock and
  `totp_secret IS NOT NULL`; customer requires a grant (E). Atomic registration-only claim (`kind = 'register'` and
  every binding; a `manage` challenge can never satisfy it — negative control); `verifyRegistrationResponse`; insert
  with `epoch`; customer registration deletes the customer's unconsumed mailbox tokens.
- **C. Password proof** → grant (source `password`, epoch), verified outside the tx, hash snapshot re-checked
  inside under the customer lock.
- **D. Mailbox proof**: request (verified email, no password, no passkey; `customer_token` `passkey_manage` with
  `{ sessionHash, nonceHash, epoch }`, 15 min, outbox mail, nonce cookie, identical 202) → confirm (customer lock,
  live session, verified email, **eligibility re-checked: still no password and no passkey**, atomic claim on hash +
  kind + store + customer + unused + unexpired + `payload.sessionHash` + `payload.nonceHash` + `payload.epoch =
  security_epoch`) → grant (source `mailbox`).
- **E. Grant consumption** (`register/options`, `DELETE`): customer lock, live session, verified email, claim with
  every binding + `epoch` + (passkey-sourced) `authorizing_credential_id` present; then the register challenge
  (inherits `authorizing_credential_id`) or the deletion with the last-credential guard (409 `NO_RECOVERY_PATH` when
  no password, no `google_sub`/`apple_sub`, magic link disabled) and the §4 deletions.

Admin routes, admission, agent policy and matrix modelling are exactly those of revision 6: pre-session
`capabilities`, `login/options`, `login/verify` treated like `/v1/admin/login` (allowlist, CSRF exemption, `PUBLIC`,
`AGENT_DENY_EXCEPTIONS` for the two POSTs, `PUBLIC` matrix outcomes with a genuine assertion per principal cell on
`login/verify`); the five authenticated mutations `AGENT_DENIED` group `credentials` with `requireHuman`,
`IRREVERSIBLE_PATH` extended to `/passkeys/` and `/step-up/passkey/`; `GET /v1/admin/passkeys` its own `HUMAN`
contract (direct `requireHuman` denial); TOTP invariant (`PASSKEYS_ENROLLED`); feature flag `PASSKEYS_ENABLED` with
routes always registered (404 `FEATURE_DISABLED` when off; `capabilities` and `/v1/shop/config` report it); at most
10 passkeys per owner. Storefront routes as in revision 6.

## 8. Rate limits, tests, matrix

Buckets (all consumed before any transaction; no admin account bucket; no `clearAdminAuthFailures`; no refunds):
`pk-admin-options` ip 60/15 min; `pk-admin-verify` ip 30/15 min; `pk-admin-cred` sha256(credentialId) 10/h;
`pk-admin-session` session_hash 20/15 min; `pk-shop-options` `storeId|ip` 60/15 min; `pk-shop-verify` `storeId|ip`
30/15 min; `pk-shop-cred` `storeId|sha256(credentialId)` 10/h; `pk-shop-session` session_hash 20/15 min;
`pk-shop-mail` `storeId|customerId` 3/h. Identical options bodies; generic failures with the `x-request-id`
envelope.

Tests: software authenticator (`sdk/webauthn.testkit.ts`); **one test per cell of the §4 matrix** (the event is
performed through its real route or, for previous-image rows, by executing the previous image's SQL shape directly
against the triggers) proving the stated outcome for each artifact; **one test per row of the §5 table in both
interleavings** (two sessions, deterministic ordering with advisory barriers) proving no deadlock and the stated
winner; every binding negated per branch; concurrent claim and assertion races; rehash keeps passkeys on the new
image and invalidates on the simulated previous image; seal/unseal keeps admin passkeys and step-ups; disable →
re-enable with the same secret removes passkeys and step-ups; a step-up written by the previous image
(`step_up_epoch` NULL) cannot start a registration; mailbox token survives nothing it must not (registration,
deletion, password change, email change); stale-cookie and enrolment-only-cookie success on pre-session routes;
unverified customer refused at grant and at login; `PASSKEYS_ENABLED=0` makes every passkey route 404 with no row
written; denied requests leave all artifacts unchanged. Matrix contracts and controls as in revision 6;
`assert-agent-boundary`, force-RLS inventory, hand-written-migration guard, `assert-no-vendure` green; storefront
client regenerated.

## 9. UI flows and brand rollout

As in revision 6 (admin login/step-up/security page; storefront sign-in and account security; Apple button;
Google/Apple gating via `VITE_*_CLIENT_ID` + store pin + `SELLRIGHT_*_SIGNIN_HOSTS`; API `GOOGLE_CLIENT_ID`,
`APPLE_CLIENT_IDS`).

## 10. Delivery order (before the Damned cutover)

1. PR A (engine): migration (§6 incl. §4 triggers), schema, `auth/passkeys.ts`, routes, allowlist / CSRF / `PUBLIC`
   / agent-policy entries, buckets, the §5 restructurings (signed-in password change, native step-up), the §4
   deletions in the event routes, rehash flag, capabilities, software authenticator, matrix contracts, the §4-matrix
   and §5-table test suites, docs. Both matrix lanes green.
2. PR B (admin SPA). 3. PR C (storefront: passkeys UI, Apple button, Google/Apple gating, regenerated client).
4. Engine release; Rotten, RightSites and Damned staged move to it. Damned rehearsal: migrate the live dump, enrol
   an admin and a customer credential and earn a step-up, roll the API back to the previous release, perform there a
   password reset, a password login with an outdated hash, a TOTP disable followed by a re-enable with the same
   secret (keeping the calling session), and an admin password change; re-upgrade; prove: reset and TOTP-cycled
   credentials refused, the rehashed-on-old-image customer's passkeys refused (documented edge), the retained
   sessions have no usable step-up, untouched credentials still work. Browser acceptance on production rpIDs/origins
   for both surfaces including password + TOTP and customer recovery fallbacks.
5. Brand envs get the Google/Apple client IDs; storefront layers rebuilt; owner enrols a passkey per admin with TOTP
   kept.
