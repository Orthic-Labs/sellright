// Regression: Qwik drops null-valued props that arrive through a JSX spread or a dynamic expression, so the checkout's
// `<LoyaltyRedemptionView {...view} />` (applied: null) reached the gateway without `applied` and threw: the loyalty control vanished.
import { $, component$, useSignal } from '@qwik.dev/core';
import { QwikRouterMockProvider } from '@qwik.dev/router';
import { ssrRenderToDom } from '@qwik.dev/core/testing';
import { describe, expect, it } from 'vitest';
import * as G from './index';
import { enter } from './gate';
import { platformAction } from './actions';
import { anyOf, nil, num, obj, str } from './schema';

const view = { balance: 48, minRedeemPoints: 0, offer: { points: 48, discountCents: 480 }, applied: null, discountableCents: 2500, currencyCode: 'USD' };

const Spread = component$(() => {
	const v = useSignal(view);
	return <G.LoyaltyRedemptionView {...v.value} onRedeemToggle$={platformAction('loyalty.redeem-toggle', $(() => ({ ok: true as const })))} />;
});
const Dynamic = component$(() => {
	const v = useSignal<string | null>(null);
	return <G.FreeShippingProgressView currencyCode="USD" subtotalCents={1} lineCount={1} isCheckoutView={false} countryCode={v.value} discountedSubtotalCents={1} />;
});

const render = async (C: typeof Spread) => (await ssrRenderToDom(<QwikRouterMockProvider><C /></QwikRouterMockProvider>, {})).document.body.innerHTML;

describe('null-valued props through a spread', () => {
	it('the loyalty control renders when the view is spread with applied: null', async () => {
		expect(await render(Spread)).toContain('data-testid="loyalty-redeem"');
	});
	it('a dynamic nullable prop does not throw', async () => {
		await expect(render(Dynamic)).resolves.toBeTypeOf('string');
	});
	it('enter() reads a missing nullable key as null, still rejects a missing non-nullable key', () => {
		const def = { data: obj({ a: anyOf(nil, str), b: num }) };
		expect(enter('t', def, { b: 1 }).props).toEqual({ a: null, b: 1 });
		expect(() => enter('t', def, { a: 'x' })).toThrow(/gateway/);
	});
});
