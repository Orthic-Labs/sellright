import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PACKAGE_ROOT, loadLayers } from './check-imports.mjs';
import { checkEjectBoundary, checkL2Boundary } from './check-l2-boundary.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-l2-boundary.mjs');
const layers = loadLayers();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-l2-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

// A self-contained mini project: Qwik-shaped hooks, a context module, an L2 component and L1 routes.
write('tsconfig.json', JSON.stringify({ compilerOptions: { jsx: 'preserve', strict: true, moduleResolution: 'bundler', module: 'ESNext', target: 'ES2022', noEmit: true, skipLibCheck: true, types: [], paths: { '~/*': ['./src/*'] } }, include: ['src'] }));
write('src/jsx.d.ts', 'declare namespace JSX { interface IntrinsicElements { [name: string]: any } interface Element {} interface ElementChildrenAttribute { children: {} } }\n');
write('src/qwik.ts', `export interface Signal<T> { value: T }
export interface ReadonlySignal<T> { readonly value: T }
export type QRL<T> = T & { __qrl: true };
export declare const useSignal: <T>(v: T) => Signal<T>;
export declare const useStore: <T extends object>(v: T) => T;
export declare const useContext: <T>(id: string) => T;
export declare const useComputed$: <T>(fn: () => T) => ReadonlySignal<T>;
export declare const component$: <P>(fn: (props: P) => unknown) => (props: P) => unknown;
export declare const $: <T>(fn: T) => QRL<T>;
`);
// The line type lives OUTSIDE ~/contexts, like the real CartLine: a plain data shape with no Signal in it.
write('src/sellright/types/live.ts', `export declare const LIVE: unique symbol;
export interface Live { readonly [LIVE]?: true }
export type Detached<T> = T extends Live ? Omit<T, typeof LIVE> : T;
`);
write('src/sellright/cart-types.ts', "import type { Live } from '~/sellright/types/live';\nexport type CartLine = { sku: string; quantity: number } & Live;\nexport type Account = Live & { email: string; orders: { code: string }[] };\nexport declare const peekLine: () => CartLine;\nexport declare const lineTable: Record<string, CartLine>;\n");
write('src/contexts/CartContext.ts', `import type { CartLine } from '~/sellright/cart-types';
import type { Live } from '~/sellright/types/live';
export interface CartContextState extends Live { cart: { lines: CartLine[] }; isLoading: boolean }
export declare const useCart: () => CartContextState;
`);
write('src/constants.ts', "export const APP_STATE = 'app_state';\n");
write('src/platform/controllers/project.ts', `export const projectFacets = (v: unknown): { id: string }[] => [];
export const projectQuantityOptions = (max: number): number[] => [max];
import type { Live, Detached } from '~/sellright/types/live';
export type Addr = Live & { city: string };
export type Country = { code: string };
export interface AppState extends Live { shippingAddress: Addr; flag: boolean; availableCountries: Country[] }
export declare const projectLine: (l: { sku: string }) => Detached<{ sku: string }>;
export declare const projectLineOf: (l: CartLine) => Detached<CartLine>;
export declare const projectOrder: (a: Account) => Readonly<Detached<Account>>;
import type { CartLine, Account } from '~/sellright/cart-types';
`);
write('src/components/ui/Card.tsx', `import { component$ } from '~/qwik';
import type { QRL } from '~/qwik';
export interface CardProps { title?: string; count?: number; facets?: { id: string }[]; address?: { city: string }; onGo$?: QRL<() => void>; data?: unknown; anything?: any; options?: number[]; getter?: () => unknown }
export default component$((p: CardProps) => p.title);
`);
write('src/platform/controllers/callbacks.ts', `import type { AppState } from '~/platform/controllers/project';
export const dispatch = <R,>(ctl: object, guard: string | null, method: () => R): Promise<R> => Promise.resolve(method());
export const makeAction = (ctl: AppState): (() => Promise<{ ok: boolean }>) => async () => ({ ok: !!ctl });
`);
write('src/routes/loader.ts', "export declare const useThingLoader: () => { value: { city: string; name: string } };\n");
const route = (name, body, imports = '') => write(`src/routes/${name}.tsx`, `import Card from '~/components/ui/Card';
import { component$, useSignal, useStore, useContext, useComputed$, $ } from '~/qwik';
import { useCart } from '~/contexts/CartContext';
import { useThingLoader } from './loader';
import { projectFacets, projectQuantityOptions, projectLine, projectLineOf, projectOrder } from '~/platform/controllers/project';
import type { AppState } from '~/platform/controllers/project';
import type { CartLine, Account } from '~/sellright/cart-types';
import { peekLine, lineTable } from '~/sellright/cart-types';
import { dispatch, makeAction } from '~/platform/controllers/callbacks';
${imports}
export default component$((props: { localCart: { sku: string }; label: string; facets: { id: string }[] }) => {
  const appState = useContext<AppState>('app_state');
  const open = useSignal(false);
  const store = useStore({ facets: [{ id: 'a' }], address: { city: 'x' } });
  const cart = useCart();
  const loaded = useThingLoader();
  const total = useComputed$(() => 1);
${body}
});
`);

const NEG = {
  'neg-store-property': '<Card address={appState.shippingAddress} />',
  'neg-props-object': '<Card data={props.localCart} />',
  'neg-props-array': '<Card facets={props.facets} />',
  'neg-use-signal': '<Card data={open} />',
  'neg-signal-value-object': '<Card data={{ s: open }} />',
  'neg-use-store': '<Card facets={store.facets} />',
  'neg-loader-value': '<Card address={loaded.value} />',
  'neg-use-cart': '<Card data={cart.cart.lines} />',
  'neg-computed': '<Card data={total} />',
  'neg-derived-binding': 'const lines = cart.cart.lines.map((l) => l); return <Card facets={lines as any} data={lines} />;',
  'neg-any': 'const x: any = props; return <Card anything={x} />;',
  // collection callbacks: the mapper parameter is the live object itself (no casts, no any)
  'neg-map-param': 'return <div>{cart.cart.lines.map((line) => <Card key={line.sku} data={line} />)}</div>;',
  'neg-map-rest': 'return <div>{cart.cart.lines.map(({ sku, ...rest }) => <Card key={sku} data={rest} />)}</div>;',
  'neg-filter-param': 'return <div>{store.facets.filter((f) => f.id).map((f) => <Card key={f.id} data={f} />)}</div>;',
  'neg-for-of': 'const items = []; for (const line of cart.cart.lines) items.push(<Card key={line.sku} data={line} />); return <div>{items}</div>;',
  // wrappers: a literal, a spread or a binding of either carries the live object it holds
  'neg-obj-literal': '<Card data={{ line: cart.cart.lines[0] }} />',
  'neg-arr-literal': '<Card data={[cart.cart.lines[0]]} />',
  'neg-obj-shorthand': 'const line = cart.cart.lines[0]; return <Card data={{ line }} />;',
  'neg-nested-literal': '<Card data={{ a: { b: [cart.cart.lines[0]] } }} />',
  'neg-spread-obj': '<Card data={{ ...cart.cart.lines[0] }} />',
  'neg-spread-arr': '<Card data={[...cart.cart.lines]} />',
  'neg-spread-store': '<Card data={{ ...store }} />',
  'neg-bound-obj': 'const w = { line: cart.cart.lines[0] }; return <Card data={w} />;',
  'neg-bound-arr': 'const w = [cart.cart.lines[0]]; return <Card data={w} />;',
  'neg-bound-spread': 'const w = { ...cart.cart.lines[0] }; return <Card data={w} />;',
  'neg-bound-twice': 'const a = { line: cart.cart.lines[0] }; const b = [a]; return <Card data={b} />;',
  'neg-literal-props': '<Card data={{ local: props.localCart }} />',
  // other expression forms
  'neg-element-access': '<Card data={cart.cart.lines[0]} />',
  'neg-conditional': '<Card data={open.value ? cart.cart.lines[0] : undefined} />',
  'neg-conditional-else': '<Card data={open.value ? undefined : cart.cart.lines[0]} />',
  'neg-logical-or': '<Card data={undefined || cart.cart.lines[0]} />',
  'neg-logical-and': '<Card data={open.value && cart.cart.lines[0]} />',
  'neg-nullish': '<Card data={undefined ?? cart.cart.lines[0]} />',
  'neg-comma': '<Card data={(0, cart.cart.lines[0])} />',
  'neg-tagged-template': 'const pass = (_s: TemplateStringsArray, v: { sku: string }) => v; return <Card data={pass`${cart.cart.lines[0]}`} />;',
  'neg-call-argument': 'const same = <T,>(v: T) => v; return <Card data={same(cart.cart.lines[0])} />;',
  'neg-call-argument-literal': 'const wrap = (v: unknown) => ({ v }); return <Card data={wrap({ line: cart.cart.lines[0] })} />;',
  'neg-local-fn-return': 'const first = () => cart.cart.lines[0]; return <Card data={first()} />;',
  'neg-local-fn-block': 'function first() { return cart.cart.lines[0]; } return <Card data={first()} />;',
  'neg-method-call': '<Card data={cart.cart.lines.slice(0, 1)} />',
  'neg-method-call-argument': 'const box = { get: (v: unknown) => v }; return <Card data={box.get(cart.cart.lines[0])} />;',
  'neg-new': '<Card data={new Map([["a", cart.cart.lines[0]]])} />',
  'neg-reassigned': 'let l: { sku: string } | undefined; l = cart.cart.lines[0]; return <Card data={l} />;',
  'neg-push': 'const a: { sku: string }[] = []; a.push(cart.cart.lines[0]); return <Card data={a} />;',
  'neg-property-write': 'const o: { line?: { sku: string } } = {}; o.line = cart.cart.lines[0]; return <Card data={o} />;',
  'neg-object-assign': 'const o: { line?: { sku: string } } = {}; Object.assign(o, { line: cart.cart.lines[0] }); return <Card data={o} />;',
  'neg-member-of-literal': '<Card data={{ a: cart.cart.lines[0] }.a} />',
  // round 3: named helpers, accessor wrappers, generic identity functions; the TYPE carries the live object
  'neg-named-render-helper': 'const renderLine = (line: CartLine) => <Card key={line.sku} data={line} />; return <div>{cart.cart.lines.map(renderLine)}</div>;',
  'neg-named-helper-direct': 'const renderLine = (line: CartLine) => <Card data={line} />; return renderLine(cart.cart.lines[0]);',
  'neg-named-helper-function': 'function renderLine(line: CartLine) { return <Card data={line} />; } return <div>{cart.cart.lines.map(renderLine)}</div>;',
  'neg-named-helper-unbranded': 'const renderFacet = (f: { id: string }) => <Card data={f} />; return <div>{store.facets.map(renderFacet)}</div>;',
  'neg-named-helper-unbranded-direct': 'const renderFacet = (f: { id: string }) => <Card data={f} />; return renderFacet(store.facets[0]);',
  'neg-accessor-bound': 'const data = { get line() { return cart.cart.lines[0]; } }; return <Card data={data} />;',
  'neg-accessor-nested': 'return <Card data={{ inner: { get line() { return cart.cart.lines[0]; } } }} />;',
  'neg-accessor-bound-unbranded': 'const data = { get f() { return store.facets[0]; } }; return <Card data={data} />;',
  'neg-accessor-wrapper-fn': 'return <Card getter={() => cart.cart.lines[0]} />;',
  'neg-accessor-wrapper-fn-bound': 'const get = () => cart.cart.lines[0]; return <Card getter={get} />;',
  'neg-accessor-wrapper-method': 'return <Card data={{ get() { return cart.cart.lines[0]; } }} />;',
  'neg-generic-identity': 'const id = <T,>(v: T): T => v; return <Card data={id(cart.cart.lines[0])} />;',
  'neg-generic-identity-array': 'const id = <T,>(v: T): T => v; return <Card data={id([cart.cart.lines[0]])} />;',
  'neg-generic-wrapper': 'const wrap = <T,>(v: T) => ({ v }); return <Card data={wrap(cart.cart.lines[0])} />;',
  'neg-generic-unresolved': 'const render = <T,>(v: T) => <Card data={v} />; return render(1);',
  'neg-generic-chain': 'const id = <T,>(v: T): T => v; const id2 = <U,>(v: U): U => id(v); return <Card data={id2(cart.cart.lines[0])} />;',
  // type-only reach: nothing in the file mentions a hook
  'neg-type-imported-fn': '<Card data={peekLine()} />',
  'neg-type-imported-table': '<Card data={lineTable} />',
  'neg-type-record-member': '<Card data={lineTable.x} />',
  'neg-type-map': 'const m = new Map<string, CartLine>(); return <Card data={m} />;',
  'neg-type-tuple': 'const t: [string, CartLine] = ["a", peekLine()]; return <Card data={t} />;',
  'neg-type-promise': 'const p = Promise.resolve(peekLine()); return <Card data={p} />;',
  'neg-type-union': 'const v: CartLine | undefined = peekLine(); return <Card data={v} />;',
  'neg-type-partial': 'const v: Partial<CartLine> = peekLine(); return <Card data={v} />;',
  'neg-type-param-line': 'const view = (l: CartLine) => <Card data={l} />; return view(peekLine());',
  'neg-type-param-spread': 'const view = (l: CartLine) => <Card data={{ ...l }} />; return view(peekLine());',
  'neg-type-param-rest': 'const view = ({ sku, ...rest }: CartLine) => <Card data={rest} />; return view(peekLine());',
  'neg-type-account': 'declare const acct: Account; return <Card data={acct} />;',
  'neg-type-account-nested': 'declare const acct: Account; return <Card data={{ first: acct.orders }} title={acct.email} />;',
  'neg-type-appstate-address': '<Card address={appState} />',
  'neg-type-callback-return': 'return <Card getter={$(() => peekLine())} />;',
  'neg-type-project-wrapped': 'return <Card data={[projectLine(cart.cart.lines[0]), cart.cart.lines[0]]} />;',
  'neg-type-method-chain': '<Card data={cart.cart.lines.filter((l) => l.quantity > 0)} />',
  'neg-type-find': '<Card data={cart.cart.lines.find((l) => l.sku === "a")} />',
  'neg-type-reduce': '<Card data={cart.cart.lines.reduce((a, l) => l, cart.cart.lines[0])} />',
  'neg-type-object-values': '<Card data={Object.values(lineTable)} />',
  'neg-type-entries': '<Card data={Object.entries(lineTable)} />',
  'neg-type-cast-primitive-key': 'const v = peekLine() as unknown as { sku: string }; return <Card data={v} />;',
  // round 4: liveness is deep; a method call on a live receiver never clears it
  'neg-deep-slice': 'return <Card data={appState.availableCountries.slice()} />;',
  'neg-deep-slice-bound': 'const c = appState.availableCountries; return <Card data={c.slice(1)} />;',
  'neg-deep-filter': 'return <Card data={appState.availableCountries.filter((c) => c.code)} />;',
  'neg-deep-find': 'return <Card data={appState.availableCountries.find((c) => c.code === "a")} />;',
  'neg-deep-concat': 'return <Card data={appState.availableCountries.concat([])} />;',
  'neg-deep-chain': 'return <Card data={appState.availableCountries.slice().reverse()} />;',
  'neg-deep-at': 'return <Card data={cart.cart.lines.at(0)} />;',
  'neg-deep-spread-array': 'return <Card data={[...cart.cart.lines]} />;',
  'neg-deep-object-values': 'return <Card data={Object.values(appState)} />;',
  'neg-deep-structured-clone': 'return <Card data={structuredClone(appState.availableCountries)} />;',
  'neg-deep-map-identity': 'return <Card data={appState.availableCountries.map((c) => c)} />;',
  'neg-deep-destructure': 'const { availableCountries } = appState; return <Card data={{ c: availableCountries }} />;',
  'neg-deep-destructure-element': 'const [first] = appState.availableCountries; return <Card data={{ first }} />;',
  'neg-deep-method-on-unmarked-local': 'const list = appState.availableCountries; const copy = list.slice(); return <Card data={copy} />;',
  // round 5: a callback is judged by what it returns; the live child need not carry the marker
  'neg-cb-getter-qrl': 'return <Card getter={$(() => appState.availableCountries)} />;',
  'neg-cb-getter-arrow': 'return <Card getter={() => appState.availableCountries} />;',
  'neg-cb-getter-block': 'return <Card getter={() => { const c = appState.availableCountries; return c; }} />;',
  'neg-cb-getter-function-expr': 'return <Card getter={function () { return appState.availableCountries[0]; }} />;',
  'neg-cb-widened-return': 'return <Card getter={(): { sku: string } => cart.cart.lines[0]} />;',
  'neg-cb-widened-return-qrl': 'return <Card getter={$((): { sku: string } => cart.cart.lines[0])} />;',
  'neg-cb-async': 'return <Card getter={$(async () => appState.availableCountries)} />;',
  'neg-cb-stored-const': 'const g = () => appState.availableCountries; return <Card getter={g} />;',
  'neg-cb-stored-qrl': 'const g = $(() => appState.availableCountries); return <Card getter={g} />;',
  'neg-cb-stored-function': 'function g() { return appState.availableCountries; } return <Card getter={g} />;',
  'neg-cb-stored-twice': 'const g = () => appState.availableCountries; const h = g; return <Card getter={h} />;',
  'neg-cb-method-ref': 'return <Card getter={cart.cart.lines.at} />;',
  'neg-cb-method-ref-deep': 'return <Card getter={appState.availableCountries.at} />;',
  'neg-cb-method-bound': 'return <Card getter={appState.availableCountries.at.bind(appState.availableCountries)} />;',
  'neg-cb-method-bound-lines': 'return <Card getter={cart.cart.lines.at.bind(cart.cart.lines)} />;',
  'neg-cb-method-in-literal': 'return <Card data={{ get() { return appState.availableCountries; } }} />;',
  'neg-cb-in-wrapper': 'const w = { get: () => appState.availableCountries }; return <Card data={w} />;',
  'neg-cb-nested-fn': 'return <Card getter={() => () => appState.availableCountries} />;',
  'neg-cb-calls-helper': 'const pick = () => appState.availableCountries; return <Card getter={() => pick()} />;',
  'neg-cb-local-array-copy': 'return <Card getter={() => [...appState.availableCountries]} />;',
  'neg-props-map': 'return <div>{props.facets.map((f) => <Card key={f.id} data={f} />)}</div>;',
};
const POS = {
  'pos-primitives': '<Card title="t" count={3} />',
  'pos-primitive-from-store': '<Card title={store.address.city} count={cart.cart.lines.length} />',
  'pos-qrl': '<Card onGo$={$(() => { open.value = true; })} />',
  'pos-literal': '<Card address={{ city: store.address.city }} facets={[{ id: "a" }]} />',
  'pos-project': '<Card facets={projectFacets(store.facets)} options={projectQuantityOptions(5)} />',
  'pos-label': '<Card title={props.label} />',
  'pos-bound-literal': 'const w = { sku: cart.cart.lines[0].sku, n: cart.cart.lines.length }; return <Card data={w} />;',
  'pos-literal-spread-project': '<Card data={{ ...projectFacets(store.facets)[0], extra: 1 }} />',
  'pos-array-of-projected': '<Card data={[...projectFacets(store.facets)]} />',
  'pos-conditional-primitive': '<Card data={open.value ? "a" : 2} title={cart.cart.lines[0]?.sku ?? "none"} />',
  'pos-local-fn-primitive': 'const mk = (n: number) => ({ n }); return <Card data={mk(1)} />;',
  'pos-local-fn-projected': 'const mk = () => projectFacets(store.facets); return <Card data={mk()} />;',
  'pos-push-primitive': 'const a: string[] = []; a.push(cart.cart.lines[0].sku); return <Card data={a} />;',
  'pos-literal-closure': '<Card data={{ go: () => { open.value = true; }, n: 1 }} />',
  'pos-map-projected': 'return <div>{projectFacets(store.facets).map((f) => <Card key={f.id} data={f} />)}</div>;',
  'pos-map-primitives': 'return <div>{cart.cart.lines.map((line) => <Card key={line.sku} title={line.sku} count={cart.cart.lines.length} />)}</div>;',
  'pos-type-detached-projection': 'return <Card data={projectLine(cart.cart.lines[0])} />;',
  'pos-type-detached-array': 'return <Card data={cart.cart.lines.map((l) => projectLine(l))} />;',
  'pos-type-primitives-from-account': 'declare const acct: Account; return <Card title={acct.email} count={acct.orders.length} />;',
  'pos-type-named-helper-primitives': 'const row = (l: CartLine) => <Card title={l.sku} count={l.quantity} />; return <div>{cart.cart.lines.map(row)}</div>;',
  'pos-type-named-helper-detached': 'const row = (l: { sku: string }) => <Card data={l} />; return <div>{[{ sku: "a" }].map(row)}</div>;',
  'pos-type-generic-primitive': 'const id = <T,>(v: T): T => v; return <Card title={id(cart.cart.lines[0].sku)} />;',
  'pos-type-generic-detached': 'const id = <T,>(v: T): T => v; return <Card data={id({ n: 1 })} />;',
  'pos-type-closure-void': 'return <Card getter={() => { open.value = true; }} />;',
  'pos-type-getter-primitive-fn': 'return <Card getter={() => cart.cart.lines.length} />;',
  // round 4: detached projections (alias type arguments are not walked)
  'pos-detached-cartline': 'return <Card data={projectLineOf(cart.cart.lines[0])} />;',
  'pos-detached-cartline-mapped': 'return <Card data={cart.cart.lines.map((l) => projectLineOf(l))} />;',
  'pos-detached-order': 'declare const acct: Account; return <Card data={projectOrder(acct)} />;',
  'pos-detached-type-annotation': 'const d: import("~/sellright/types/live").Detached<CartLine> = projectLineOf(cart.cart.lines[0]); return <Card data={d} />;',
  'pos-map-block-projected': 'return <Card data={appState.availableCountries.map((c) => { return { code: c.code }; })} />;',
  // round 5: platform factories and callbacks that capture only plain values
  'pos-cb-factory': 'return <Card onGo$={makeAction(appState)} />;',
  'pos-cb-factory-dispatch': 'return <Card onGo$={$(() => dispatch(store, "submit", () => ({ ok: true })))} />;',
  'pos-cb-plain-capture': 'const n = 3; const label = props.label; return <Card getter={() => ({ n, label })} />;',
  'pos-cb-plain-qrl': 'const n = 3; return <Card getter={$(() => n + 1)} />;',
  'pos-cb-stored-plain': 'const n = [1, 2]; const g = () => n; return <Card getter={g} />;',
  'pos-cb-projected-return': 'return <Card getter={$(() => projectLineOf(cart.cart.lines[0]))} />;',
  'pos-cb-projected-return-stored': 'const g = () => projectFacets(store.facets); return <Card getter={g} />;',
  'pos-cb-primitive-return': 'return <Card getter={() => appState.availableCountries.length} />;',
  'pos-cb-void-action': 'return <Card onGo$={$(async () => { open.value = !open.value; })} />;',
  'pos-map-literal-receiver': 'return <div>{[1, 2].map((n) => <Card key={n} count={n} data={{ n }} />)}</div>;',
};
for (const [n, b] of Object.entries(NEG)) route(n, b.includes('return') ? b : `  return ${b};`);
for (const [n, b] of Object.entries(POS)) route(n, b.includes('return') ? b : `  return ${b};`);

// L2 files
write('src/components/ui/BadImport.tsx', "import { useCart } from '~/contexts/CartContext';\nexport const B = () => useCart();\n");
write('src/components/ui/BadAppState.tsx', "import { APP_STATE } from '~/constants';\nexport const B = () => APP_STATE;\n");
write('src/components/ui/BadController.tsx', "import { projectFacets } from '~/platform/controllers/project';\nexport const B = projectFacets;\n");
write('src/components/ui/BadSignalProp.tsx', "import type { Signal } from '~/qwik';\nexport interface P { open: Signal<boolean> }\nexport const B = (p: P) => p.open;\n");
write('src/components/ui/PrivateHelper.tsx', `import { component$, useSignal } from '~/qwik';
import type { Signal } from '~/qwik';
const clear = (s: Signal<string>) => { s.value = ''; };
interface Local { label: string }
export default component$((p: Local) => { const text = useSignal(p.label); clear(text); return text.value; });
`);
write('src/components/ui/SignalComponentProp.tsx', `import { component$ } from '~/qwik';
import type { Signal } from '~/qwik';
export default component$((p: { open: Signal<boolean> }) => p.open.value);
`);
write('src/components/ui/SignalReachedProp.tsx', `import { component$ } from '~/qwik';
import type { Signal } from '~/qwik';
interface Base { open: Signal<boolean> }
interface Props extends Base { label: string }
type Alias = { inner: Props };
export default component$<Alias>((p) => p.inner.label);
`);
write('src/components/ui/SignalExportedFn.tsx', `import type { ReadonlySignal } from '~/qwik';
export function Panel(p: { v: ReadonlySignal<number> }) { return p.v.value; }
`);
write('src/components/ui/GoodPure.tsx', "import { fmt } from '~/utils/fmt';\nexport interface P { n: number; onGo$?: () => void }\nexport const B = (p: P) => fmt(p.n);\n");
write('src/utils/fmt.ts', 'export const fmt = (n: number) => String(n);\n');

// Gateway plan §6: the call-site analysis (a) is advisory (`advisories`); (b)/(c) still block (`findings`).
const { findings: blocking, advisories } = checkL2Boundary({ root, layers });
const findings = [...blocking, ...advisories];
const rulesAt = (file) => findings.filter((f) => f.file === file).map((f) => f.rule);

test('call-site (a) results are advisories, never blocking findings', () => {
  assert.ok(advisories.length > 0);
  assert.ok(advisories.every((f) => f.rule === 'l2-live-prop'));
  assert.ok(blocking.every((f) => f.rule !== 'l2-live-prop'));
});

for (const name of Object.keys(NEG)) {
  test(`${name}: L1 passes live state to an L2 component -> l2-live-prop`, () => {
    assert.ok(rulesAt(`src/routes/${name}.tsx`).includes('l2-live-prop'), JSON.stringify(findings.filter((f) => f.file.includes(name))));
  });
}
for (const name of Object.keys(POS)) {
  test(`${name}: allowed call-site shape`, () => {
    assert.deepEqual(findings.filter((f) => f.file === `src/routes/${name}.tsx`), []);
  });
}

for (const [file, rule] of [
  ['src/components/ui/BadImport.tsx', 'l2-forbidden-import'],
  ['src/components/ui/BadAppState.tsx', 'l2-forbidden-import'],
  ['src/components/ui/BadController.tsx', 'l2-forbidden-import'],
  ['src/components/ui/BadSignalProp.tsx', 'l2-live-prop-type'],
]) {
  test(`${file}: ${rule}`, () => assert.ok(rulesAt(file).includes(rule)));
}
test('a pure L2 file and the Card component are clean', () => {
  assert.deepEqual(findings.filter((f) => f.file === 'src/components/ui/GoodPure.tsx' || f.file === 'src/components/ui/Card.tsx'), []);
});
test('l2-live-prop-type covers component props only: a private helper taking a local signal passes', () => {
  assert.deepEqual(findings.filter((f) => f.file === 'src/components/ui/PrivateHelper.tsx'), []);
});
for (const f of ['SignalComponentProp', 'SignalReachedProp', 'SignalExportedFn']) {
  test(`${f}: a Signal-valued component prop (inline, through local types and heritage, exported function) is flagged`, () => assert.ok(rulesAt(`src/components/ui/${f}.tsx`).includes('l2-live-prop-type')));
}

test('(c) ejects: an eject of an L2 file is held to the same import and prop-type rules; an L3 file is not (r1-r13 cover it)', () => {
  const ej = checkEjectBoundary({ root, layers, files: ['src/components/ui/BadImport.tsx', 'src/components/ui/BadSignalProp.tsx', 'src/components/ui/GoodPure.tsx', 'src/components/ui/PrivateHelper.tsx', 'src/brand/x.tsx'] });
  assert.deepEqual(ej.findings.map((f) => `${f.file} ${f.rule}`).sort(), ['src/components/ui/BadImport.tsx l2-forbidden-import', 'src/components/ui/BadSignalProp.tsx l2-live-prop-type']);
  assert.equal(ej.checked, 4);
});

test('the real tree passes the boundary check with no advisory either (CLI, --strict): no L1 file renders an L2 component directly', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', PACKAGE_ROOT, '--strict'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /clean .*0 advisory warning/);
});

test('CLI: advisories print as warnings and fail only with --strict', () => {
  const only = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-l2-adv-'));
  try {
    // The fixture project without the files that carry blocking (b) findings: only advisories remain.
    fs.cpSync(root, only, { recursive: true });
    for (const f of new Set(blocking.map((x) => x.file))) fs.rmSync(path.join(only, f));
    const lax = spawnSync(process.execPath, [SCRIPT, '--root', only, '--layers', path.join(PACKAGE_ROOT, 'layers.json')], { encoding: 'utf8' });
    assert.equal(lax.status, 0, lax.stderr);
    assert.match(lax.stderr, /^warning: .*l2-live-prop/m);
    const strict = spawnSync(process.execPath, [SCRIPT, '--root', only, '--layers', path.join(PACKAGE_ROOT, 'layers.json'), '--strict'], { encoding: 'utf8' });
    assert.equal(strict.status, 1);
  } finally {
    fs.rmSync(only, { recursive: true, force: true });
  }
});

test('CLI: the fixture project fails', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, '--layers', path.join(PACKAGE_ROOT, 'layers.json')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /l2-live-prop/);
});
