import { pgTable, uuid, text, integer, jsonb, unique } from 'drizzle-orm/pg-core';
import { store, ts } from './schema-core.js';

// ── WS-A: encrypted per-store settings (migration 0071) ─────────────────────
// Non-secret settings already live in store.config (JSONB). This table holds
// ONLY owner-entered secrets (Stripe/NMI/Sezzle keys, SMTP password, ...) —
// each value sealed by packages/api/src/security/secret-crypto.ts before it
// reaches this table. Never write plaintext here.
//
// One row per (store, provider, mode, field): `provider` is 'stripe' | 'nmi' |
// 'sezzle' | 'smtp'; `mode` is the provider's own mode discriminator
// ('test'/'live', 'sandbox'/'production', or 'default' for mode-less
// providers like SMTP); `field` is the credential name within that
// provider+mode (e.g. 'secretKey', 'webhookSecret', 'securityKey', 'authCredential').
//
// `keyVersion`/`iv`/`ciphertext`/`authTag` are the EncryptedSecret envelope
// (see secret-crypto.ts) — base64 strings, opaque to SQL. `last4` is a
// plaintext display fragment ONLY (never enough to reconstruct the secret),
// shown by the admin UI so an owner can recognize which key is configured
// without ever re-displaying it.
export const storeSecret = pgTable(
  'store_secret',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    provider: text().notNull(),
    mode: text().notNull(),
    field: text().notNull(),
    keyVersion: integer().notNull(),
    iv: text().notNull(),
    ciphertext: text().notNull(),
    authTag: text().notNull(),
    last4: text(),
    metadata: jsonb(), // e.g. { webhookEndpointId, url } for Stripe's auto-created webhook
    updatedBy: text(), // admin_user email/id at time of write (denormalized for audit convenience)
    createdAt: ts(),
    updatedAt: ts(),
  },
  (t) => [unique('store_secret_scope_unique').on(t.storeId, t.provider, t.mode, t.field)],
);
