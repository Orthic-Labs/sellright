import { sql, type SQLWrapper } from 'drizzle-orm';

/** Preserve display copy exactly; a label never participates in date arithmetic. */
export function shippingLabel(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function variantShippingLabel(metafields: unknown): string | null {
  if (!metafields || typeof metafields !== 'object' || Array.isArray(metafields)) return null;
  return shippingLabel((metafields as Record<string, unknown>).shipDateLabel);
}

/** Only JSON strings are labels: do not stringify numbers, arrays or objects. */
export function shippingLabelSql(metafields: SQLWrapper) {
  return sql<string | null>`case when jsonb_typeof(${metafields}->'shipDateLabel') = 'string'
    then nullif(${metafields}->>'shipDateLabel', '') else null end`;
}
