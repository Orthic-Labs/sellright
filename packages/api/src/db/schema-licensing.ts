import { pgTable, uuid, text, timestamp, jsonb, unique } from 'drizzle-orm/pg-core';
import { store, ts } from './schema-core.js';

// Licensing-engine tables that are new relations (column deltas on the
// existing license/license_activation tables live in schema-orders.ts).

/** Current signed runtime/model artifact registration. One row per
 *  app/kind/OS/arch is replaced only after the API verifies the configured
 *  Ed25519 authority, exact digest/provenance, and lane scope (see
 *  licensing/runtime-artifact-manifest.ts). Store-scoped, FORCE RLS. */
export const runtimeArtifactPromotion = pgTable(
  'runtime_artifact_promotion',
  {
    id: uuid().primaryKey().defaultRandom(),
    storeId: uuid().notNull().references(() => store.id),
    appKey: text().notNull(),
    artifactKind: text().notNull(),
    targetOs: text().notNull(),
    targetArch: text().notNull(),
    delivery: text().notNull(),
    pointerKey: text(),
    objectSha256: text().notNull(),
    envelopeSha256: text().notNull(),
    signingKeyId: text().notNull(),
    promotionId: text().notNull(),
    envelope: jsonb().notNull(),
    promotedAt: timestamp({ withTimezone: true }).notNull(),
    registeredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('runtime_artifact_promotion_current').on(
    t.storeId, t.appKey, t.artifactKind, t.targetOs, t.targetArch,
  )],
);

export type RuntimeArtifactPromotion = typeof runtimeArtifactPromotion.$inferSelect;
