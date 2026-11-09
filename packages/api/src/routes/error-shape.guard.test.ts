import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// API-M4: every route error is the structured envelope (errJson / HttpError), never a bare string body.
const dir = dirname(fileURLToPath(import.meta.url));
const STRING_ERROR = /\bc\.json\(\s*\{\s*error:\s*['"`]/g;

describe('route error bodies', () => {
  it('no route (webhook receivers excepted) answers c.json({ error: "..." }) with a string-shaped body', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || /\.(test|testkit)\.ts$/.test(file) || /\.test\./.test(file) || file.toLowerCase().includes('webhook')) continue;
      const src = readFileSync(join(dir, file), 'utf8');
      for (const m of src.matchAll(STRING_ERROR)) offenders.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the pattern catches the shapes it guards against', () => {
    expect("c.json({ error: 'x' }, 400)".match(STRING_ERROR)).toHaveLength(1);
    expect('c.json({ error: `x ${y}` }, 400)'.match(STRING_ERROR)).toHaveLength(1);
    expect("c.json(\n  { error: 'x' }, 400)".match(STRING_ERROR)).toHaveLength(1);
    expect("c.json({ error: { code: 'X' } }, 400)".match(STRING_ERROR)).toBeNull();
  });
});
