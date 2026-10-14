import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateOne } from './generate-placeholder-assets.mjs';

const target = { out: 'public/social-image.jpg', width: 120, height: 63, format: 'jpeg', bg: '#20242b', label: 'SellRight' };

test('an existing brand asset is never overwritten', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ph-'));
  try {
    mkdirSync(path.join(dir, 'public'), { recursive: true });
    writeFileSync(path.join(dir, 'public/social-image.jpg'), 'BRAND');
    assert.equal(await generateOne(target, dir), null);
    assert.equal(readFileSync(path.join(dir, 'public/social-image.jpg'), 'utf8'), 'BRAND');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing asset gets a placeholder', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ph-'));
  try {
    const out = await generateOne(target, dir);
    assert.ok(out && existsSync(out));
    assert.ok(readFileSync(out).length > 100);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
