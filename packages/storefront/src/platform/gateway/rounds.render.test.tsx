// Gateway plan §7 "Six review rounds through the gateway". Every live-reference shape the PR1 reviews raised against the old call-site
// checker (brand-views-pr1.astra1.json … astra6.json) is rendered here through a gateway handle with REAL Qwik state (useStore), SSR.
// Each case ends in one of two outcomes: the gateway rejects it (GatewayError: accessor, method, function, undeclared field), or the
// presentation component receives a copy whose objects are all new (recursively disjoint from the source's targets and proxies) and
// whose mutation never reaches the source (dev/test: frozen; production: an unfrozen private copy).
import { $, component$, useStore, type Component, type JSXOutput } from '@qwik.dev/core';
import { ssrRenderToDom } from '@qwik.dev/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { action, gate, optionalAction } from './gate';
import { platformAction } from './actions';
import { anyOf, arr, num, obj, opt, str } from './schema';

// ---------------------------------------------------------------------------------------------------- the presentation side

const received: unknown[] = [];
const RawCard = component$((p: { data?: unknown; onGo$?: unknown }) => {
	received.push(p.data);
	return <span class="card">card</span>;
});
const RawOther = component$((p: { data?: unknown }) => {
	received.push(p.data);
	return <span class="other">other</span>;
});

const LINE = obj({ sku: str, quantity: num, meta: obj({ tag: str }) });
const COUNTRY = obj({ code: str, name: str });
const CARD_DATA = opt(anyOf(LINE, arr(LINE), obj({ line: LINE }), arr(COUNTRY)));
const CardView = gate('Card', RawCard, { data: obj({ data: CARD_DATA }), actions: { onGo$: optionalAction('shell.cart-toggle') } });
const OtherView = gate('Other', RawOther, { data: obj({ data: CARD_DATA }) });
void action;

// ---------------------------------------------------------------------------------------------------- the L1 side: real live state

interface Sources {
	cartTarget: { cart: { lines: { sku: string; quantity: number; meta: { tag: string } }[] } };
	appTarget: { availableCountries: { code: string; name: string }[] };
	cart: Sources['cartTarget'];
	appState: Sources['appTarget'];
}
const sources: Sources[] = [];
const useLive = () => {
	const cartTarget = { cart: { lines: [{ sku: 'A', quantity: 1, meta: { tag: 'live' } }, { sku: 'B', quantity: 2, meta: { tag: 'live' } }] } };
	const appTarget = { availableCountries: [{ code: 'US', name: 'United States' }, { code: 'PR', name: 'Puerto Rico' }] };
	const cart = useStore(cartTarget);
	const appState = useStore(appTarget);
	sources.push({ cartTarget, appTarget, cart, appState });
	return { cart, appState };
};

/** One host per review shape. Each renders the live value through the handle the way an L1 author could have written it. */
const SHAPES: Record<string, Component> = {
	// round 1: a collection callback parameter (the per-item case)
	'r1 map callback line': component$(() => {
		const { cart } = useLive();
		return <div>{cart.cart.lines.map((line) => <CardView key={line.sku} data={line} />)}</div>;
	}),
	// round 2: object / array / spread / bound wrappers
	'r2 object wrapper': component$(() => {
		const { cart } = useLive();
		return <CardView data={{ line: cart.cart.lines[0] }} />;
	}),
	'r2 array wrapper': component$(() => {
		const { cart } = useLive();
		return <CardView data={[cart.cart.lines[0]]} />;
	}),
	'r2 spread (shallow copy keeps the nested live object)': component$(() => {
		const { cart } = useLive();
		return <CardView data={{ ...cart.cart.lines[0] }} />;
	}),
	'r2 bound wrapper': component$(() => {
		const { cart } = useLive();
		const wrapper = { line: cart.cart.lines[0] };
		return <CardView data={wrapper} />;
	}),
	// round 3: named render helper
	'r3 named render helper': component$(() => {
		const { cart } = useLive();
		const renderLine = (line: (typeof cart.cart.lines)[number]) => <CardView key={line.sku} data={line} />;
		return <div>{cart.cart.lines.map(renderLine)}</div>;
	}),
	// round 4: methods that keep element references (unmarked children of a shallow-marked parent)
	'r4 slice of countries': component$(() => {
		const { appState } = useLive();
		return <CardView data={appState.availableCountries.slice()} />;
	}),
	'r4 filter of countries': component$(() => {
		const { appState } = useLive();
		return <CardView data={appState.availableCountries.filter(() => true)} />;
	}),
	'r4 find of a line': component$(() => {
		const { cart } = useLive();
		return <CardView data={cart.cart.lines.find((l) => l.sku === 'A')} />;
	}),
	'r4 field-by-field projection (positive)': component$(() => {
		const { cart } = useLive();
		const l = cart.cart.lines[0];
		return <CardView data={{ sku: l.sku, quantity: l.quantity, meta: { tag: l.meta.tag } }} />;
	}),
	// round 6: local alias and conditional component selection
	'r6 local alias': component$(() => {
		const { cart } = useLive();
		const View = CardView;
		return <View data={cart.cart.lines[0]} />;
	}),
	'r6 conditional selection': component$(() => {
		const { cart } = useLive();
		const View = cart.cart.lines.length > 1 ? CardView : OtherView;
		return <View data={cart.cart.lines[1]} />;
	}),
	'r6 conditional selection (other branch)': component$(() => {
		const { cart } = useLive();
		const View = cart.cart.lines.length > 5 ? CardView : OtherView;
		return <View data={cart.cart.lines} />;
	}),
};

/** Shapes the gateway must reject outright. */
const REJECTED: Record<string, { host: Component; reason: RegExp }> = {
	'r3 bound accessor wrapper': {
		host: component$(() => {
			const { cart } = useLive();
			const data = {
				get line() {
					return cart.cart.lines[0];
				},
			};
			return <CardView data={data} />;
		}),
		reason: /accessor/,
	},
	'r3 nested accessor wrapper': {
		host: component$(() => {
			const { cart } = useLive();
			return (
				<CardView
					data={[
						Object.defineProperty({ sku: 'A', quantity: 1 }, 'meta', {
							get: () => cart.cart.lines[0].meta,
							enumerable: true,
						}),
					] as never}
				/>
			);
		}),
		reason: /accessor/,
	},
	'r5 callback returning unmarked live children (data)': {
		host: component$(() => {
			const { appState } = useLive();
			return <CardView data={$(() => appState.availableCountries) as never} />;
		}),
		reason: /matches no alternative|expected/,
	},
	'r5 plain getter function as data': {
		host: component$(() => {
			const { appState } = useLive();
			const getter = () => appState.availableCountries;
			return <CardView data={getter as never} />;
		}),
		reason: /matches no alternative|expected/,
	},
	'r6 bound object method': {
		host: component$(() => {
			const { appState } = useLive();
			const data = {
				get() {
					return appState.availableCountries;
				},
			};
			return <CardView data={data as never} />;
		}),
		reason: /matches no alternative|not a declared field|expected/,
	},
	'r1 a whole live line with an undeclared field': {
		host: component$(() => {
			const store = useStore({ lines: [{ sku: 'A', quantity: 1, meta: { tag: 'x' }, internal: { reserved: 3 } }] });
			return <CardView data={store.lines[0] as never} />;
		}),
		reason: /not a declared field|matches no alternative/,
	},
	'a bare QRL as an action (not a platform action)': {
		host: component$(() => {
			const { cart } = useLive();
			return <CardView onGo$={$(() => cart.cart.lines) as never} />;
		}),
		reason: /bare QRL is not a platform action/,
	},
	'a forged action handle': {
		host: component$(() => {
			const forged = Object.freeze({ kind: 'sr-' + 'action', name: 'shell.cart-toggle', run: $(() => undefined), extra: 1 });
			return <CardView onGo$={forged as never} />;
		}),
		reason: /expected a platform action/,
	},
	'a platform action not allowed for this prop': {
		host: component$(() => <CardView onGo$={platformAction('ui.press', $(() => undefined)) as never} />),
		reason: /not allowed here/,
	},
	'L1 children handed to presentation': {
		host: component$(() => {
			const { cart } = useLive();
			const Any = CardView as unknown as (p: { children?: unknown }) => JSXOutput;
			return <Any>{cart.cart.lines.map((l) => <b key={l.sku}>{l.sku}</b>)}</Any>;
		}),
		reason: /L1 markup is not handed to presentation code/,
	},
};

// ---------------------------------------------------------------------------------------------------- assertions

function objectsOf(root: unknown, out = new Set<object>()): Set<object> {
	if (root && typeof root === 'object' && !out.has(root)) {
		out.add(root);
		for (const v of Object.values(root)) objectsOf(v, out);
	}
	return out;
}

function sourceObjects(src: Sources): Set<object> {
	const all = new Set<object>();
	for (const root of [src.cartTarget, src.appTarget, src.cart, src.appState]) objectsOf(root, all);
	// the store proxies of every nested object, as L1 code would read them
	for (const line of src.cart.cart.lines) all.add(line).add(line.meta);
	all.add(src.cart.cart).add(src.cart.cart.lines).add(src.appState.availableCountries);
	for (const c of src.appState.availableCountries) all.add(c);
	return all;
}

const snapshot = (src: Sources) => JSON.stringify([src.cartTarget, src.appTarget]);

function mutateDeep(value: unknown): void {
	if (!value || typeof value !== 'object') return;
	for (const [k, v] of Object.entries(value)) {
		if (v && typeof v === 'object') mutateDeep(v);
		else (value as Record<string, unknown>)[k] = typeof v === 'number' ? 999 : 'mutated';
	}
	if (Array.isArray(value)) value.push({ injected: true });
}

afterEach(() => {
	received.length = 0;
	sources.length = 0;
	vi.unstubAllEnvs();
});

describe('review-round shapes through the gateway: accepted shapes are recursively disjoint and frozen (dev/test)', () => {
	for (const [name, Host] of Object.entries(SHAPES)) {
		it(name, async () => {
			const H = Host as unknown as () => JSXOutput;
			await ssrRenderToDom(<H />, {});
			expect(received.length).toBeGreaterThan(0);
			const before = snapshot(sources[0]);
			const live = sourceObjects(sources[0]);
			for (const got of received) {
				for (const o of objectsOf(got)) {
					expect(live.has(o)).toBe(false);
					expect(Object.isFrozen(o)).toBe(true);
				}
				expect(() => mutateDeep(got)).toThrow(TypeError);
			}
			expect(snapshot(sources[0])).toBe(before);
		});
	}
});

describe('review-round shapes through the gateway: production copies are private (mutation never reaches the source)', () => {
	for (const [name, Host] of Object.entries(SHAPES)) {
		it(name, async () => {
			vi.stubEnv('DEV', false);
			vi.stubEnv('MODE', 'production');
			const H = Host as unknown as () => JSXOutput;
			await ssrRenderToDom(<H />, {});
			const before = snapshot(sources[0]);
			const live = sourceObjects(sources[0]);
			for (const got of received) {
				for (const o of objectsOf(got)) {
					expect(live.has(o)).toBe(false);
					expect(Object.isFrozen(o)).toBe(false);
				}
				mutateDeep(got);
			}
			expect(snapshot(sources[0])).toBe(before);
			expect(sources[0].cart.cart.lines[0].meta.tag).toBe('live');
		});
	}
});

describe('review-round shapes the gateway rejects', () => {
	for (const [name, { host, reason }] of Object.entries(REJECTED)) {
		it(name, async () => {
			const H = host as unknown as () => JSXOutput;
			await expect(ssrRenderToDom(<H />, {})).rejects.toThrow(reason);
			expect(received).toEqual([]);
		});
	}
});
