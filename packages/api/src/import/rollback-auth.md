# Isolated auth rollback export

`--export-auth-rollback` creates private `sellright.rollback-auth/v1` JSON from one target read-only snapshot. It connects only to target database. Source adapter applies pack to named isolated clone; its verified receipt always keeps `readyToReopen: false`.

Forward import records `rollbackAuthBaseline` for every imported customer, including customers without sessions. Baseline contains exact source customer/user IDs, source account digests & explicit blockers. Missing channel membership, mismatched native identifiers, shared/administrator identities or unsupported source providers leave import parity blocked. Older manifests without full baseline cannot export auth rollback packs.

Pack includes baseline & final native accounts, deleted account states, unchanged supported password hashes, verified email & exact provider subjects. Original grants get either validated aliases or tombstones. Imported aliases require matching immutable grants, current target bindings & frozen source sessions; earliest expiry wins. Native sessions retain target expiry. Expired/revoked capabilities remain denied.

Operator inputs:

- Original immutable import manifest. `originalImportDigest` hashes canonical full manifest, including baseline; `sourceDigest` retains forward import meaning.
- Frozen source snapshot `{scope, accounts, sessions}` using exported `SourceAccountStateV1` & `SourceSessionHashStateV1`. Include soft-deleted customers plus expired/invalidated authenticated source sessions.
- Private rollback config `{cloneId, issuedAt, expiresAt, pins, configuredAuthMethods, providerConfigurationDigest}`. `pins` has every wire pin except computed `finalTargetAuthDigest`. Declare enabled target methods from frozen deployment configuration, including environment defaults. Export also derives required methods from accounts & active artifacts.
- Trusted admin/store tree manifests matching sealed tree pins. Hash complete prepared source artifacts; runtime verification additionally hashes emitted/served files.
- Fresh output path. Pack contains account PII & credential hashes; exclusive creation uses mode `0600`. Store config, source snapshots & original manifests remain private.

From admitted clone runtime with target `DATABASE_URL` already configured:

```sh
node dist/import/restore.js --export-auth-rollback \
  --manifest /private/original-import.json \
  --rollback-config /private/rollback-config.json \
  --frozen-source /private/frozen-source-auth.json \
  --output /private/rollback-auth.json
```

Frozen `email_outbox` federated-link issuances are inspected in private memory using existing signature verifier. Any active issuance blocks export, including unlinked or consumed-marked rows; malformed/unverifiable expiry also blocks. Proven expired issuances pass without redemption or writes. Refreeze & export after outstanding issuances expire. Diagnostics contain outbox ID & code only. Stable other-session inventory binds presence, deadlines & SHA256 fingerprint of current hash without time-derived flags.

Success output reports digests & counts. It never prints pack/account/session contents. Export rejects `--apply` & `--plan-session-rollback` combinations. Existing restore & read-only legacy planner remain separate operations.

Source adapter must independently verify original evidence, frozen snapshot, capabilities, runtime/commit/tree pins, account/session coverage & pack expiry before mutation. Active auth artifacts require implemented adapters. Clone verification must cover identity, expiry, revocation, replay & browser carriers before `readyForCloneReopen` can become true.

Focused fixtures are `rollback-auth.test.ts`; public repository tests run through owning integration lane in GitHub CI.
