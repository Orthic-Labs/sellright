# Upstream Phase 5: generic licence and runtime-artifact primitives

Scope: the three generic pieces the RightSites fork needs upstream (de-fork plan Phase 5). Suite policy, signing authority, R2 layout, host routing and entitlement tiers stay in the RightSites plugin.

## 1. Runtime artifact identity

- `packages/api/drizzle/0092_runtime_artifact_identity.sql` (journal idx 83, when 1790000012000): adds nullable `runtime_artifact_promotion.artifact_id`; replaces the current-pointer unique key with `(store_id, app_key, artifact_kind, artifact_id, target_os, target_arch) NULLS NOT DISTINCT`.
- Relaxation note: the old key is dropped. Legacy rows (`artifact_id` NULL) keep exactly the old uniqueness under the new key. No FK is added or changed. No delete path is affected.
- `licensing/runtime-artifact-manifest.ts`: optional `artifactId` (slug, exported `RuntimeArtifactId`); pointer key gains an `{artifactId}/` segment only when present; `target.os`/`target.arch` accept `any`, which must be paired as `any/any`.
- `licensing/runtime-artifact-resolve.ts` (`resolveRuntimeArtifactPromotion`): selection only. Identity selector or legacy selector (id, exact pointer key, row UUID); exact target preferred over any/any; ambiguous match fails closed; lanes limited by entitlement tier (`pro` → private-r2, public-r2; `public` → public-r2). Envelope signature checks, entitlement appKey/tier matching and download URL construction stay in the caller.

## 2. Licence lifecycle

- `licensing/license-revocation.ts`: `revokeLicenseInTx`, `restoreLicenseInTx`, and the store-scoped `licenseLifecycle` wrappers.
  - Revoke: `license.status` → `revoked`; every `license_activation` with `state='active'` for the licence → `state='revoked'`, `revoked_at`, `generation + 1`. Idempotent (no mutation, no audit row when already revoked). Writes one `audit_log` row.
  - Restore: `revoked` → `active` only. Refused (`expired`) when the hard `expires_at` has passed. Cascaded activations are not reactivated; devices must activate again. Restoring an active licence is a no-op.
  - Licence row locked `FOR UPDATE` inside the store-scoped transaction; cross-tenant ids return `notfound`.
- Permission key: `license_revocation` (`LICENSE_REVOCATION_PERMISSION`). Owner and manager pass by role; other staff need the key in their `permissions` map.
- `routes/admin-license-revocation.ts`: `POST /v1/admin/licenses/{id}/revoke` and `/restore`. Exported but NOT mounted in `app.ts`; default SellRight behaviour is unchanged. A consumer mounts it explicitly.

## 3. Tenant-bound revocation feed

- `licensing/revocation-feed.ts` (`createLicenseRevocationFeed({ resolveTenant })`): `GET /v1/pro/revocations`, unauthenticated, read-only.
  - Tenant comes only from the resolver (never request input); query carries an explicit `store_id` predicate on top of per-store RLS.
  - Body (frozen for shipped Workers): `{"ids":[...],"updatedAt":"<ISO>"}`, keys in that order, `cache-control: public, max-age=60`.
  - Path defaults to `/v1/pro/revocations`; the compat URL is the default. The RightSites plugin passes `resolveTenant` backed by `RIGHTSITES_STORE_SLUG`.
  - Not mounted in `app.ts` (default unchanged).

## Tests

- `licensing/runtime-artifact-identity.test.ts` (unit): legacy pointer kept, identity-scoped pointer, identity/pointer mismatch rejected, any/any and half-wildcard, slug validation.
- `licensing/revocation-feed.test.ts` (unit): body bytes, cache header, tenant from resolver, POST 404, credentials ignored.
- `licensing/license-lifecycle.db.test.ts` (db, `*_test` guard): cascade and generation bump, idempotence and single audit row, restore keeps activations revoked, expired refusal, cross-tenant notfound, tenant-bound feed, artifact selection (identity, exact over any/any, ambiguity, lane by tier, legacy selectors).

## Open items

- Migration 0092 drops and recreates one unique constraint (see note in section 1). Owner to confirm this is acceptable under R0.
- The admin revocation routes are not mounted; the RightSites plugin must mount them and must delete its fork copies (`RuntimeArtifactId`, `license-revocations.ts`, `license-admin-routes.ts`) once it imports these modules.
- Route-level tests for the admin revoke/restore routes (permission gate, 409 on expired) are not written.
