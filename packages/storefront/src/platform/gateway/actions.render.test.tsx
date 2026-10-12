// Gateway plan §7 "Actions": platform actions crossing into presentation code, rendered for real. SSR then resumption (the handler
// runs from serialised QRLs, as in a browser after load), client render, later events, delayed results, a re-render with new data
// (the stand-in for a navigation: real-router navigation needs the e2e suite), argument checks, and the dispatcher's ordering and busy
// admission behind a gateway action.
import { $, component$, useStore, type QRL } from '@qwik.dev/core';
import { domRender, ssrRenderToDom, trigger } from '@qwik.dev/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ACTION_RESULTS, dispatch, type ActionCtl } from '~/platform/controllers/callbacks';
import type { ActionResult } from '~/platform/views';
import { platformAction } from './actions';
import { action, gate } from './gate';
import { bool, num, obj, str } from './schema';

interface Sink {
	results: unknown[];
	errors: string[];
	calls: unknown[][];
	gate: Promise<void> | null;
	release: (() => void) | null;
	implResult: unknown;
	live: unknown;
	bound: QRL<(...a: unknown[]) => Promise<unknown>> | null;
}
const g = globalThis as unknown as { __gw: Sink };
const reset = () => {
	g.__gw = { results: [], errors: [], calls: [], gate: null, release: null, implResult: null, live: null, bound: null };
};
reset();
afterEach(reset);

const hold = () => {
	g.__gw.gate = new Promise<void>((r) => (g.__gw.release = r));
};
const settle = async (until: () => boolean) => {
	for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
};

// ---------------------------------------------------------------------------------------------------- presentation side

/** A brand-like panel: shows its data, calls its action with the arguments it is told to, records what comes back. */
const RawPanel = component$((p: { count: number; label: string; onGo$: QRL<(...a: unknown[]) => Promise<unknown>>; args?: string }) => {
	g.__gw.bound = p.onGo$;
	return (
	<button
		id="go"
		onClick$={async () => {
			try {
				const args = p.args === 'object' ? [{ evil: true }, 'x'] : p.args === 'strings' ? ['a@b.co', ''] : [];
				g.__gw.results.push(await p.onGo$(...args));
			} catch (e) {
				g.__gw.errors.push(String((e as Error).message));
			}
		}}
	>
		{p.label}:{p.count}
	</button>
	);
});
const PanelToggle = gate('Panel', RawPanel, { data: obj({ count: num, label: str }), actions: { onGo$: action('shell.cart-toggle') } });
const PanelSubscribe = gate('Panel', RawPanel, { data: obj({ count: num, label: str, args: str }), actions: { onGo$: action('home.subscribe') } });
const PanelPress = gate('Panel', RawPanel, { data: obj({ count: num, label: str }), actions: { onGo$: action('ui.press') } });
const RawPage = component$((p: { title: string; open: boolean }) => <h1 id="page">{p.title}{p.open ? '+' : '-'}</h1>);
const PageView = gate('Page', RawPage, { data: obj({ title: str, open: bool }) });

// ---------------------------------------------------------------------------------------------------- L1 side

const IMPL_RESULT = { ok: true as const };

const ToggleHost = component$(() => {
	const state = useStore({ n: 0, lines: [{ sku: 'A' }] });
	const run = $(async () => {
		if (g.__gw.gate) await g.__gw.gate;
		state.n++;
		g.__gw.live = state;
		return g.__gw.implResult ?? IMPL_RESULT;
	});
	return <PanelToggle count={state.n} label="toggle" onGo$={platformAction('shell.cart-toggle', run as never)} />;
});

const SubscribeHost = component$((props: { args: string }) => {
	const run = $(async (email: string, honeypot: string) => {
		g.__gw.calls.push([email, honeypot]);
		return { ok: true as const };
	});
	return <PanelSubscribe count={0} label="subscribe" args={props.args} onGo$={platformAction('home.subscribe', run)} />;
});

const PressHost = component$(() => {
	const state = useStore({ secret: { token: 's3cret' } });
	// a void action whose implementation happens to return live state: presentation must get nothing
	const run = $(() => state);
	return <PanelPress count={0} label="press" onGo$={platformAction('ui.press', run)} />;
});

const GuardedHost = component$(() => {
	const ctl = useStore<ActionCtl>({ disposed: false, admitted: [] });
	const state = useStore({ n: 0 });
	const run = $(() =>
		dispatch<ActionResult>(ctl, 'submit', ACTION_RESULTS, async () => {
			g.__gw.calls.push(['start', state.n]);
			if (g.__gw.gate) await g.__gw.gate;
			state.n++;
			return { ok: true as const };
		}),
	);
	return <PanelToggle count={state.n} label="guarded" onGo$={platformAction('shell.cart-toggle', run)} />;
});

const NavHost = component$(() => {
	const route = useStore({ page: 'home', open: false });
	const run = $(() => {
		route.page = 'about';
		route.open = true;
		return { ok: true as const };
	});
	return (
		<div>
			<PageView title={route.page} open={route.open} />
			<PanelToggle count={0} label="nav" onGo$={platformAction('shell.cart-toggle', run)} />
		</div>
	);
});

// ---------------------------------------------------------------------------------------------------- tests

describe('platform actions after SSR and resumption', () => {
	it('a delayed result reaches presentation as a new frozen object, never the implementation’s own', async () => {
		hold();
		const { document } = await ssrRenderToDom(<ToggleHost />, {});
		const click = trigger(document.body, '#go', 'click');
		await new Promise((r) => setTimeout(r, 20));
		expect(g.__gw.results).toEqual([]); // still waiting on the platform
		g.__gw.release!();
		await click;
		await settle(() => g.__gw.results.length > 0);
		expect(g.__gw.results).toEqual([{ ok: true }]);
		expect(g.__gw.results[0]).not.toBe(IMPL_RESULT);
		expect(Object.isFrozen(g.__gw.results[0])).toBe(true);
	});

	it('later events: each call runs again, each result is fresh, and the re-rendered data is validated again', async () => {
		const { document } = await ssrRenderToDom(<ToggleHost />, {});
		await trigger(document.body, '#go', 'click');
		await settle(() => g.__gw.results.length === 1);
		await trigger(document.body, '#go', 'click');
		await settle(() => g.__gw.results.length === 2);
		expect(g.__gw.results).toEqual([{ ok: true }, { ok: true }]);
		expect(g.__gw.results[0]).not.toBe(g.__gw.results[1]);
		await settle(() => document.querySelector('#go')?.textContent === 'toggle:2');
		expect(document.querySelector('#go')?.textContent).toBe('toggle:2');
	});

	it('a widened result carrying live state is rejected: presentation gets an error, never the state', async () => {
		g.__gw.implResult = { ok: true, leaked: { sku: 'A' } };
		const { document } = await ssrRenderToDom(<ToggleHost />, {});
		await trigger(document.body, '#go', 'click');
		await settle(() => g.__gw.errors.length > 0);
		expect(g.__gw.results).toEqual([]);
		expect(g.__gw.errors[0]).toMatch(/shell\.cart-toggle result/);
	});

	it('a void action returns nothing to presentation, whatever the implementation returned', async () => {
		const { document } = await ssrRenderToDom(<PressHost />, {});
		await trigger(document.body, '#go', 'click');
		await settle(() => g.__gw.results.length > 0);
		expect(g.__gw.results).toEqual([undefined]);
	});

	it('arguments: primitives reach the platform; an object argument is rejected before the platform runs', async () => {
		const ok = await ssrRenderToDom(<SubscribeHost args="strings" />, {});
		await trigger(ok.document.body, '#go', 'click');
		await settle(() => g.__gw.results.length > 0);
		expect(g.__gw.calls).toEqual([['a@b.co', '']]);
		expect(g.__gw.results).toEqual([{ ok: true }]);

		reset();
		const bad = await ssrRenderToDom(<SubscribeHost args="object" />, {});
		await trigger(bad.document.body, '#go', 'click');
		await settle(() => g.__gw.errors.length > 0);
		expect(g.__gw.calls).toEqual([]);
		expect(g.__gw.errors[0]).toMatch(/home\.subscribe argument 1/);
	});

	it('dispatcher behind a gateway action: a second call while the first is pending is busy and runs nothing', async () => {
		// Called through the bound QRL presentation received, in a client render (the test DOM delivers one event at a time, so two
		// overlapping clicks cannot be simulated there).
		hold();
		await domRender(<GuardedHost />);
		const bound = g.__gw.bound!;
		const first = bound();
		await settle(() => g.__gw.calls.length === 1);
		const second = await bound();
		expect(second).toEqual({ ok: false, reason: 'busy' });
		expect(Object.isFrozen(second)).toBe(true);
		g.__gw.release!();
		expect(await first).toEqual({ ok: true });
		expect(await bound()).toEqual({ ok: true });
		expect(g.__gw.calls).toEqual([['start', 0], ['start', 1]]);
	});

	it('re-render with new data (navigation stand-in): the new page data goes through the handle again', async () => {
		const { document } = await ssrRenderToDom(<NavHost />, {});
		expect(document.querySelector('#page')?.textContent).toBe('home-');
		await trigger(document.body, '#go', 'click');
		await settle(() => document.querySelector('#page')?.textContent === 'about+');
		expect(document.querySelector('#page')?.textContent).toBe('about+');
	});
});

describe('platform actions in a client render', () => {
	it('a client-rendered handle binds the action the same way', async () => {
		const { document } = await domRender(<ToggleHost />);
		await trigger(document.body, '#go', 'click');
		await settle(() => g.__gw.results.length > 0);
		expect(g.__gw.results).toEqual([{ ok: true }]);
		expect(g.__gw.results[0]).not.toBe(IMPL_RESULT);
	});
});
