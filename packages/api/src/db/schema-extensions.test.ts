import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// drizzle.config.ts lives at the package root (packages/api/drizzle.config.ts),
// not under src/, so it's outside vitest's test discovery — verify the schema
// extension seam by reading its source directly instead. (Kept out of
// src/db/extensions/ itself — drizzle-kit globs *.ts in that directory as
// schema modules, and a .test.ts file there would be harmless but confusing.)
const DRIZZLE_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle.config.ts');

describe('drizzle.config.ts schema extension seam', () => {
  it('globs src/db/extensions/**/*.ts alongside the base schema.ts', () => {
    const source = readFileSync(DRIZZLE_CONFIG_PATH, 'utf8');
    expect(source).toMatch(/schema:\s*\[[^\]]*'\.\/src\/db\/schema\.ts'[^\]]*'\.\/src\/db\/extensions\/\*\*\/\*\.ts'[^\]]*\]/);
  });
});
