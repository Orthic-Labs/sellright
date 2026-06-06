/**
 * Tax-rate resolution by destination. The shipping-country's matching zone
 * overrides the store's flat `taxRate`; no match falls back to it. Pure — the
 * caller loads the zones and passes the ship-to country. Inclusive vs exclusive
 * application lives in totals.ts; this only chooses the RATE (basis points).
 */
export type TaxZoneRule = {
  countries: string[]; // ISO-3166 alpha-2
  rate: number; // basis points
  priority: number;
};

export function resolveTaxRate(zones: TaxZoneRule[], country: string | null | undefined, fallbackRate: number): number {
  const c = country?.trim().toUpperCase() ?? '';
  if (c === '') return fallbackRate;
  const match = zones
    .filter((z) => z.countries.some((x) => x.trim().toUpperCase() === c))
    .sort((a, b) => b.priority - a.priority)[0];
  return match ? match.rate : fallbackRate;
}
