export function parseJson(v: string | null): unknown | null {
  if (v == null || v === '') return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export function parseStrArray(v: string | null): string[] | null {
  const j = parseJson(v);
  return Array.isArray(j) ? j.filter((x): x is string => typeof x === 'string') : null;
}

export function parseDate(v: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
