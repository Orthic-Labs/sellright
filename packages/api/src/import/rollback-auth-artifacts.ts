import { verifyFederatedLink } from '../auth/federated-link.js';
import { rollbackId } from './rollback-auth-schema.js';

export class RollbackAuthBlocked extends Error {
  constructor(readonly code: string, readonly entityId: string | null) { super(code); }
}
type Verify = (token: string, storeId: string, now: number) => { exp: number } | null;

/** Inspect only; calling the existing verifier never redeems a link or sends mail. */
export function assertFederatedIssuanceCoverage(input: {
  storeId: string; rows: Array<{ id: unknown; payload: unknown }>; now: number;
}, verify: Verify = verifyFederatedLink): void {
  for (const row of input.rows) {
    const id = rollbackId.parse(row.id);
    let body: string | undefined;
    try { body = JSON.stringify(row.payload); } catch { throw new RollbackAuthBlocked('federated_issuance_unparseable', id); }
    if (!body || body.length > 1_048_576) throw new RollbackAuthBlocked('federated_issuance_unparseable', id);
    const tokens = new Set([...body.matchAll(/\/sign-in\/confirm\?token=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g)].map(match => match[1]!));
    if (!tokens.size) throw new RollbackAuthBlocked('federated_issuance_unparseable', id);
    for (const token of tokens) {
      // Signature & claims still pass through the installed verifier. A zero
      // inspection clock lets it authenticate the expiry of old issuances.
      let claims: { exp: number } | null;
      try { claims = verify(token, input.storeId, 0); } catch { claims = null; }
      if (!claims || !Number.isSafeInteger(claims.exp) || claims.exp <= 0) throw new RollbackAuthBlocked('federated_issuance_expiry_unproven', id);
      if (claims.exp > input.now) throw new RollbackAuthBlocked('federated_issuance_active', id);
    }
  }
}
