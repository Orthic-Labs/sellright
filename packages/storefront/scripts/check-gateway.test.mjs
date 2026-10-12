// Gateway plan §5/§7: the import-graph rule. A throwaway project laid out like the storefront (classified by the real layers.json).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PACKAGE_ROOT, loadLayers } from './check-imports.mjs';
import { checkGateway } from './check-gateway.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-gateway.mjs');
const layers = loadLayers();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-gateway-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

write('tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'preserve', moduleResolution: 'bundler', module: 'ESNext', paths: { '~/*': ['./src/*'] } }, include: ['src'] }));
// presentation
write('src/components/ui/Card.tsx', 'export interface CardProps { title: string }\nexport default function Card(p: CardProps) { return p.title; }\nexport const helper = (n: number) => n;\n');
write('src/components/ui/Panel.tsx', "import Card from '~/components/ui/Card';\nimport { useSignal } from '@qwik.dev/core';\nexport const Panel = () => { const open = useSignal(false); return [Card, open]; };\n");
write('src/brand-slots/route.home.tsx', 'export default function Home() { return null; }\n');
// slot lookup + virtual module
write('src/components/slots/index.ts', "import { brandSlots } from 'virtual:sellright-brand-slots';\nexport const getSlot = (n: string) => (brandSlots as Record<string, unknown>)[n];\n");
// gateway
write('src/platform/gateway/gate.tsx', "import { getSlot } from '~/components/slots';\nexport const gate = (n: string, raw: unknown, d: unknown) => () => [n, raw, d];\nexport const slotGate = (s: string) => () => getSlot(s);\nexport const gateValue = (n: string, v: unknown) => v;\n");
write('src/platform/gateway/actions.ts', "export const platformAction = (name: string, run: unknown) => Object.freeze({ kind: 'sr-action', name, run });\n");
write('src/platform/gateway/index.tsx', "import Card, { helper } from '~/components/ui/Card';\nimport type { CardProps } from '~/components/ui/Card';\nimport { gate, gateValue } from './gate';\nexport { platformAction } from './actions';\nexport const CardView = gate('Card', Card, {});\nexport const helperValue = gateValue('helper', helper);\nexport type { CardProps };\nconst obj = { Card: 1 };\nexport const n = obj.Card;\n");
// gateway negatives
write('src/platform/gateway/escape.tsx', "import Card from '~/components/ui/Card';\nimport { gate } from './gate';\nexport const Leak = Card;\nexport const Wrapped = gate('x', () => Card, {});\nexport function give() { return Card; }\nexport const Rendered = () => <Card title=\"t\" />;\nexport { Card };\n");
write('src/platform/gateway/reexport.ts', "export { default as RawCard } from '~/components/ui/Card';\n");
write('src/platform/gateway/dynamic.ts', "export const load = () => import('~/components/ui/Card');\n");
write('src/platform/gateway/lookup.ts', "import { getSlot } from '~/components/slots';\nexport const s = getSlot('x');\n");

const NEG = {
  'src/routes/neg-direct.tsx': ["import Card from '~/components/ui/Card';\nexport default Card;\n", 'gateway-import'],
  'src/routes/neg-relative.tsx': ["import { helper } from '../components/ui/Card';\nexport const h = helper;\n", 'gateway-import'],
  'src/routes/neg-mixed-type-value.tsx': ["import Card, { type CardProps } from '~/components/ui/Card';\nexport const c: CardProps | typeof Card = Card;\n", 'gateway-import'],
  'src/routes/neg-named-reexport.ts': ["export { default as Card } from '~/components/ui/Card';\n", 'gateway-import'],
  'src/routes/neg-star-reexport.ts': ["export * from '~/components/ui/Card';\n", 'gateway-import'],
  'src/utils/neg-chain-helper.ts': ["import Card from '~/components/ui/Card';\nexport const Wrapped = Card;\n", 'gateway-import'],
  'src/routes/neg-dynamic-literal.tsx': ["export const load = () => import('~/components/ui/Card');\n", 'gateway-import'],
  'src/routes/neg-dynamic-nonliteral.tsx': ["const where = '~/components/ui/' + 'Card';\nexport const load = () => import(where);\n", 'gateway-dynamic-import'],
  'src/routes/neg-require.ts': ["// eslint-disable-next-line\nexport const m = require('~/components/ui/Card');\n", 'gateway-import'],
  'src/routes/neg-glob.ts': ["export const all = import.meta.glob('../components/**/*.tsx');\n", 'gateway-import'],
  'src/routes/neg-slot-lookup.tsx': ["import { getSlot } from '~/components/slots';\nexport const V = getSlot('route.home');\n", 'gateway-import'],
  'src/routes/neg-virtual.tsx': ["import { brandSlots } from 'virtual:sellright-brand-slots';\nexport const s = brandSlots;\n", 'gateway-import'],
  'src/routes/neg-brand-slot.tsx': ["import Home from '~/brand-slots/route.home';\nexport default Home;\n", 'gateway-import'],
  'src/platform/neg-platform-file.ts': ["import Card from '~/components/ui/Card';\nexport const c = Card;\n", 'gateway-import'],
  'src/routes/neg-action-literal.tsx': ["export const h = Object.freeze({ kind: 'sr-action', name: 'ui.press', run: null });\n", 'gateway-action-literal'],
  'src/components/ui/neg-action-literal-l2.tsx': ["export const h = { 'kind': 'sr-action', name: 'shell.login', run: null };\n", 'gateway-action-literal'],
};
const POS = {
  'src/routes/pos-type-only.tsx': "import type { CardProps } from '~/components/ui/Card';\nimport { type CardProps as P2 } from '~/components/ui/Card';\nexport type Both = CardProps | P2;\nexport type Imp = import('~/components/ui/Card').CardProps;\n",
  'src/routes/pos-handle.tsx': "import { CardView, platformAction } from '~/platform/gateway';\nexport const page = () => [CardView, platformAction('ui.press', null)];\n",
  'src/routes/pos-chain-user.tsx': "import { Wrapped } from '~/utils/neg-chain-helper';\nexport const w = Wrapped;\n",
  'src/routes/pos-l1-import.tsx': "import { platformAction } from '~/platform/gateway/actions';\nexport const p = platformAction;\n",
  'src/routes/pos-package.tsx': "import { component$ } from '@qwik.dev/core';\nexport const c = component$;\n",
  'src/routes/pos-other-kind.tsx': "export const h = { kind: 'other', name: 'x' };\n",
  'src/routes/pos-a.test.tsx': "import Card from '~/components/ui/Card';\nexport const c = Card;\n",
};
for (const [rel, [text]] of Object.entries(NEG)) write(rel, text);
for (const [rel, text] of Object.entries(POS)) write(rel, text);

const { findings } = checkGateway({ root, layers });
const at = (file) => findings.filter((f) => f.file === file);

for (const [rel, [, rule]] of Object.entries(NEG)) {
  test(`negative ${rel} -> ${rule}`, () => assert.ok(at(rel).some((f) => f.rule === rule), JSON.stringify(at(rel))));
}
for (const rel of Object.keys(POS)) {
  test(`positive ${rel}: clean`, () => assert.deepEqual(at(rel), []));
}

test('presentation files import each other freely (L2 -> L2, local presentation state)', () => {
  assert.deepEqual(at('src/components/ui/Panel.tsx'), []);
  assert.deepEqual(at('src/components/ui/Card.tsx'), []);
});
test('the gateway may hand raw implementations to its factories, import types, and build action handles in actions.ts', () => {
  assert.deepEqual(at('src/platform/gateway/index.tsx'), []);
  assert.deepEqual(at('src/platform/gateway/actions.ts'), []);
  assert.deepEqual(at('src/platform/gateway/gate.tsx'), []);
  assert.deepEqual(at('src/components/slots/index.ts'), []);
});
test('gateway escapes: export, alias, closure, return, render and re-export of a raw binding are all flagged', () => {
  const lines = at('src/platform/gateway/escape.tsx').filter((f) => f.rule === 'gateway-raw-escape').map((f) => f.line).sort((a, b) => a - b);
  assert.deepEqual(lines, [3, 4, 5, 6, 7]);
  assert.ok(at('src/platform/gateway/reexport.ts').some((f) => f.rule === 'gateway-raw-escape'));
  assert.ok(at('src/platform/gateway/dynamic.ts').some((f) => f.rule === 'gateway-raw-escape'));
});
test('the slot lookup inside the gateway is reserved for gate.tsx', () => {
  assert.ok(at('src/platform/gateway/lookup.ts').some((f) => f.rule === 'gateway-import'));
});
test('a chain is cut at its first edge: the L1 helper that re-exports a raw component is the flagged file', () => {
  assert.ok(at('src/utils/neg-chain-helper.ts').length > 0);
  assert.deepEqual(at('src/routes/pos-chain-user.tsx'), []);
});

test('CLI: the fixture fails, the real tree is clean', () => {
  const bad = spawnSync(process.execPath, [SCRIPT, '--root', root, '--layers', path.join(PACKAGE_ROOT, 'layers.json')], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /gateway-import/);
  const real = spawnSync(process.execPath, [SCRIPT, '--root', PACKAGE_ROOT], { encoding: 'utf8' });
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /clean/);
});
