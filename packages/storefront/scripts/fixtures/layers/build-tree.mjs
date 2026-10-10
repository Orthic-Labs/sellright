// Test helper for check-imports.test.mjs and check-code-shape.test.mjs (not a test itself, not matched by test:scripts).
// Builds a temp project root from fixtures/layers/tree and places every snippet TWICE: as an L3 file and as an L2 eject
// (an L2 path inside the overlay list), so each rule is proven in both overlay file kinds.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));

// Snippets that must sit in src/brand-slots/ as L3 (a slot). Everything else sits in src/brand/x/ (same depth as the eject dir).
const SLOT_SNIPPETS = new Set(['payment-in-slot']);
export const l3Path = (id) => (SLOT_SNIPPETS.has(id) ? `src/brand-slots/${id}.tsx` : `src/brand/x/${id}.tsx`);
export const l2EjectPath = (id) => `src/components/eject/${id}.tsx`;

export function loadSnippets(kind) {
  const dir = path.join(FIXTURE_DIR, 'snippets', kind);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.tsx')).sort().map((file) => {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const expect = { imports: [], shape: [] };
    for (const m of text.matchAll(/^\/\/ expect-(imports|shape): (.+)$/gm)) expect[m[1]].push(...m[2].split(/[\s,]+/).filter(Boolean));
    return { id: file.replace(/\.tsx$/, ''), kind, text, expect };
  });
}

/** @returns {{root: string, overlay: Array<{id: string, kind: string, as: 'L3'|'L2-eject', rel: string}>, cleanup: () => void}} */
export function buildTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-layers-'));
  fs.cpSync(path.join(FIXTURE_DIR, 'tree'), root, { recursive: true });
  const overlay = [];
  for (const sn of [...loadSnippets('negative'), ...loadSnippets('positive')]) {
    for (const [as, rel] of [['L3', l3Path(sn.id)], ['L2-eject', l2EjectPath(sn.id)]]) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), sn.text);
      overlay.push({ id: sn.id, kind: sn.kind, as, rel });
    }
  }
  fs.writeFileSync(path.join(root, '.compose-overlay-files.txt'), `${overlay.map((o) => o.rel).join('\n')}\n`);
  return { root, overlay, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
