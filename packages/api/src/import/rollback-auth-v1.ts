// Sealed Sage contract, 2026-10-16; mandatory Addendum A included.
// JSON wire contract. Every field required; absent values use null.
// ID = exact nonempty opaque string; no numeric coercion.
// Digest = lowercase SHA-256 hex; UTC = YYYY-MM-DDTHH:mm:ss.sssZ.
// Commit = full Git SHA. No raw session, reset, verification, OAuth or API tokens.
export type ID = string;
export type Digest = string;
export type UTC = string;
export type Commit = string;
export type AuthMethod = "password" | "google" | "apple" | "email_magic_link";
export type Password = {
  format: "none" | "bcrypt" | "argon2id-phc" | "sellright-scrypt";
  value: string | null; // none <=> null; copy supported hashes unchanged
};
export type ProviderIdentity = {
  provider: "google" | "apple";
  subject: ID; // exact, case-sensitive; never link by email
};
export type AccountState = {
  email: string; // target canonical email
  emailVerified: boolean;
  firstName: string;
  lastName: string;
  phone: string | null;
  password: Password;
  providers: ProviderIdentity[]; // sorted provider, subject
};
export type SourceAccountStateV1 = {
  sourceCustomerId: ID;
  sourceUserId: ID | null;
  channelIds: ID[]; // sorted
  hasAdministratorIdentity: boolean;
  deleted: boolean;
  account: AccountState | null;
};
export type SourceSessionHashStateV1 = {
  sourceSessionId: ID;
  sourceUserId: ID;
  sourceCustomerId: ID;
  sourceChannelId: ID;
  tokenHash: Digest;
  invalidated: boolean;
  expiresAt: UTC;
};
export type IdentityMapRow = {
  targetCustomerId: ID;
  origin: "imported" | "target_native";
  sourceCustomerId: ID | null;
  sourceUserId: ID | null;
  expectedSourceAccountDigest: Digest | null;
};
export type AccountRow = {
  targetCustomerId: ID;
  state: "active" | "deleted";
  account: AccountState | null; // active requires account; deleted requires null
};
export type AliasRow = {
  targetSessionId: ID;
  targetCustomerId: ID;
  tokenHash: Digest; // SHA256(UTF8(exact opaque token)); no normalization
  expiresAt: UTC;
  imported: {
    sourceSessionId: ID;
    sourceUserId: ID;
    sourceCustomerId: ID;
    originalExpiresAt: UTC;
  } | null;
};
export type Tombstone = {
  targetCustomerId: ID | null;
  targetSessionId: ID | null;
  sourceSessionId: ID | null;
  tokenHash: Digest | null;
  reason: "logout" | "missing" | "expired" | "identity_changed"
        | "account_deleted" | "source_invalidated";
}; // requires sourceSessionId or tokenHash
export type PendingAuthArtifact = {
  id: ID;
  targetCustomerId: ID;
  kind: "password_reset" | "email_verify" | "email_change"
      | "magic_link" | "federated_link";
  tokenHash: Digest;
  expiresAt: UTC;
}; // inventory only; V1 rejects active artifacts without existing method adapter
export type RollbackPackV1 = {
  schema: "sellright.rollback-auth/v1";
  mode: "isolated-clone";
  cloneId: ID;
  issuedAt: UTC;
  expiresAt: UTC;
  scope: { sourceKey: ID; sourceChannelId: ID; targetStoreId: ID };
  pins: {
    originalImportDigest: Digest;
    finalTargetAuthDigest: Digest;
    frozenSourceAuthBeforeDigest: Digest;
    engineCommit: Commit;
    sourceAdminCommit: Commit;
    sourceStoreCommit: Commit;
    sourceAdminTreeDigest: Digest;
    sourceStoreTreeDigest: Digest;
    adapterCapabilitiesDigest: Digest;
    sourceNode: "24.20.0";
    sourceVendure: "3.7.3";
  };
  requiredAuthMethods: AuthMethod[]; // sorted
  providerConfigurationDigest: Digest; // nonsecret issuer/audience config
  identityMap: IdentityMapRow[]; // every baseline imported + final native customer
  accounts: AccountRow[]; // same targetCustomerId set as identityMap
  aliases: AliasRow[]; // every final surviving authenticated customer session
  tombstones: Tombstone[]; // complete imported-grant non-survivor disposition
  pendingAuthArtifacts: PendingAuthArtifact[];
  otherSessionInventoryDigest: Digest; // binds anonymous/admin/API inventory
  packDigest: Digest;
};
export type MappingResult = {
  targetCustomerId: ID;
  sourceCustomerId: ID;
  sourceUserId: ID | null;
};
export type AliasResult = {
  targetSessionId: ID;
  tokenHash: Digest;
  sourceSessionId: ID;
  expiresAt: UTC;
};
export type ApplyReceiptV1 = {
  schema: "sellright.rollback-auth-receipt/v1";
  mode: "isolated-clone";
  cloneId: ID;
  packDigest: Digest;
  targetAuthDigest: Digest;
  sourceAuthBeforeDigest: Digest;
  sourceAuthAfterDigest: Digest | null;
  identityMapDigest: Digest;
  adapterCapabilitiesDigest: Digest;
  sourceAdminTreeDigest: Digest;
  sourceStoreTreeDigest: Digest;
  appliedAt: UTC | null;
  verifiedAt: UTC | null;
  expiresAt: UTC;
  mappings: MappingResult[];
  aliases: AliasResult[];
  revokedSourceSessionsDigest: Digest | null;
  tombstonesDigest: Digest;
  proofDigest: Digest | null;
  blockers: { code: string; entityId: ID | null }[];
  status: "blocked" | "applied" | "verified";
  readyForCloneReopen: boolean;
  readyToReopen: false;
};
// Private, operator-only adapter functions; never Shop/Admin API mutations:
// inspectFrozenSource(scope): Promise<{ sourceAuthDigest: Digest }>;
// applyRollbackPack(pack: RollbackPackV1): Promise<ApplyReceiptV1>;
// verifyRollbackApply(receipt: ApplyReceiptV1, proofDigest: Digest): Promise<ApplyReceiptV1>;
