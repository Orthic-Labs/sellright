/**
 * Plan A9 scenario 9 (static half): the manifest publisher derives `inStock` from the stock rows (`onHand - allocated`,
 * catalog.ts) and never from a search index (locked stock rule layer 1: "NEVER search_index_item.inStock — it lags").
 * Publisher output only: this says nothing about the storefront reader (that is scenario 17 of the e2e suite).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('./', import.meta.url);
const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !/\.test\.ts$/.test(f));

describe('manifest publisher source', () => {
  it('has publisher sources to scan', () => {
    expect(sources).toEqual(expect.arrayContaining(['catalog.ts', 'publish.ts', 'stock-hook.ts']));
  });
  it.each(sources)('%s never reads a search index', (file) => {
    const code = readFileSync(new URL(file, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/search[_-]?index/i);
  });
});
