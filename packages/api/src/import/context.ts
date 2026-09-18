import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Tx } from '../db/client.js';

export function migrationId(storeId: string, sourceKey: string, entity: string, sourceId: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify([storeId, sourceKey, entity, String(sourceId)])).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join('-');
}
/** A record type that could not be mapped faithfully into the target schema.
 * Entries land on the manifest `exclusions` list — a reviewed decision, never
 * a silent drop. */
export interface ManifestExclusion {
  type: 'source-extension-absent' | 'unmapped-source-field' | 'unmappable-source-row' | 'merged-duplicate' | 'not-imported';
  table: string;
  detail: string;
  count?: number;
}

export interface ImportContext {
  tx: Tx;
  source: PoolClient;
  storeId: string;
  sourceKey: string;
  channelId: number;
  currency: string;
  id(entity: string, sourceId: unknown): string;
  q(sql: string, values?: unknown[]): Promise<QueryResultRow[]>;
  gatewayAccounts: Record<string, { accountId: string; mode?: 'test' | 'live' }>;
  /** Source-schema preflight result (SR-08): table -> actual column names. */
  sourceColumns: ReadonlyMap<string, ReadonlySet<string>>;
  /** Business records that could not be mapped faithfully (SR-09). */
  exclusions: ManifestExclusion[];
}
