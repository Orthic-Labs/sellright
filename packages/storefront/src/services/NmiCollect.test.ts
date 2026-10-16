/**
 * NMI Collect.js consumer contract: the script src is mode-derived, the
 * tokenization key is a script data-attribute (never a body field), and
 * Tokenization resolves only the payment_token — raw PAN never exists in this
 * app (the gateway-payment route accepts the token alone).
 */
import { describe, expect, it, vi } from 'vitest';
import { collectJsSrc, loadCollectJs, prepareCardTokenization, type NmiCollectJs } from './NmiCollect';

describe('collectJsSrc', () => {
  it('uses the merchant host for existing-account test mode', () => {
    expect(collectJsSrc('test', 'production')).toBe('https://secure.nmi.com/token/Collect.js');
  });
	it('test mode loads from the sandbox host', () => {
		expect(collectJsSrc('test')).toBe('https://sandbox.nmi.com/token/Collect.js');
	});
	it('live mode loads from the production host', () => {
		expect(collectJsSrc('live')).toBe('https://secure.nmi.com/token/Collect.js');
	});
});

describe('loadCollectJs', () => {
	it('injects a script carrying the tokenization key', async () => {
		const appended: HTMLScriptElement[] = [];
		const doc = {
			createElement: (_tag: string) => {
				const el = { src: '', async: false, attrs: {} as Record<string, string>,
					setAttribute(k: string, v: string) { this.attrs[k] = v; },
					onload: null as null | (() => void), onerror: null as null | (() => void) };
				appended.push(el as unknown as HTMLScriptElement);
				return el as unknown as HTMLScriptElement;
			},
			head: { appendChild(el: HTMLScriptElement) { queueMicrotask(() => (el as any).onload?.()); } },
		} as unknown as Document;
		vi.stubGlobal('window', { CollectJS: { configure: () => {}, startPaymentRequest: () => {} } });
		const collect = await loadCollectJs('pub_key_1', 'test', doc);
		expect(appended).toHaveLength(1);
		expect(appended[0].src).toBe('https://sandbox.nmi.com/token/Collect.js');
		expect((appended[0] as any).attrs['data-tokenization-key']).toBe('pub_key_1');
		expect(collect).toBeDefined();
		vi.unstubAllGlobals();
	});
});

describe('loadCollectJs failure and retry', () => {
	it('a failed load is not cached: the retry requests the script again and can succeed', async () => {
		const scripts: any[] = [];
		const removed: any[] = [];
		const doc = {
			createElement: () => {
				const el: any = { attrs: {}, setAttribute(k: string, v: string) { this.attrs[k] = v; }, remove() { removed.push(this); } };
				scripts.push(el);
				return el;
			},
			head: { appendChild: vi.fn() },
		} as unknown as Document;
		vi.stubGlobal('window', {});
		const first = loadCollectJs('retry_key', 'test', doc);
		scripts[0].onerror();
		await expect(first).rejects.toThrow('failed to load');
		expect(removed).toContain(scripts[0]);

		vi.stubGlobal('window', { CollectJS: { configure: () => {}, startPaymentRequest: () => {} } });
		const second = loadCollectJs('retry_key', 'test', doc);
		expect(scripts).toHaveLength(2);
		scripts[1].onload();
		await expect(second).resolves.toBeDefined();
		// a successful load stays cached
		expect(await loadCollectJs('retry_key', 'test', doc)).toBeDefined();
		expect(scripts).toHaveLength(2);
		vi.unstubAllGlobals();
	});

	it('a script that loads without CollectJS also clears the cache', async () => {
		const scripts: any[] = [];
		const doc = {
			createElement: () => { const el: any = { setAttribute() {}, remove() {} }; scripts.push(el); return el; },
			head: { appendChild: vi.fn() },
		} as unknown as Document;
		vi.stubGlobal('window', {});
		const first = loadCollectJs('init_key', 'test', doc);
		scripts[0].onload();
		await expect(first).rejects.toThrow('failed to initialise');
		void loadCollectJs('init_key', 'test', doc).catch(() => {});
		expect(scripts).toHaveLength(2);
		vi.unstubAllGlobals();
	});
});

describe('prepareCardTokenization hosted-field initialisation', () => {
	it('a timeout with no tokenization pending reports an initialisation failure', () => {
		let options: any;
		const collect = { configure: (opts: any) => { options = opts; }, startPaymentRequest: vi.fn() };
		const onInitError = vi.fn();
		prepareCardTokenization(collect, { ccnumber: '#a', ccexp: '#b', cvv: '#c' }, undefined, onInitError);
		options.timeoutCallback();
		expect(onInitError).toHaveBeenCalledWith('Card fields timed out loading.');
	});

	it('a timeout during a tokenization is a card error, not an initialisation failure', async () => {
		const onInitError = vi.fn();
		let options: any;
		const collect = { configure: (opts: any) => { options = opts; }, startPaymentRequest: () => options.timeoutCallback() };
		await expect(prepareCardTokenization(collect, { ccnumber: '#a', ccexp: '#b', cvv: '#c' }, undefined, onInitError)()).rejects.toThrow('timed out');
		expect(onInitError).not.toHaveBeenCalled();
	});
});

describe('prepareCardTokenization', () => {
	const collectWith = (impl: (opts: any) => void): NmiCollectJs => {
    let options: any;
    return { configure: (opts) => { options = opts; }, startPaymentRequest: () => impl(options) };
  };

  it('mounts fields before payment and never redraws them on submission', async () => {
    let options: any;
    const ready = vi.fn();
    const collect = {
      configure: vi.fn((opts) => { options = opts; }),
      startPaymentRequest: vi.fn(() => options.callback({ token: 'token' })),
    };
    const tokenize = prepareCardTokenization(collect, { ccnumber: '#a', ccexp: '#b', cvv: '#c' }, ready);
    expect(collect.configure).toHaveBeenCalledOnce();
    expect(collect.startPaymentRequest).not.toHaveBeenCalled();
    options.fieldsAvailableCallback();
    expect(ready).toHaveBeenCalledOnce();
    expect(await tokenize()).toBe('token');
    expect(collect.configure).toHaveBeenCalledOnce();
  });

	it('configures inline hosted fields and resolves the payment_token', async () => {
		let configured: any;
		const collect = collectWith((opts) => {
			configured = opts;
			opts.callback({ token: 'tok_nmi_1' });
		});
		const token = await prepareCardTokenization(collect, { ccnumber: '#cc-num', ccexp: '#cc-exp', cvv: '#cc-cvv' })();
		expect(token).toBe('tok_nmi_1');
		expect(configured.variant).toBe('inline');
		expect(configured.fields.ccnumber.selector).toBe('#cc-num');
	});

	it('rejects with a shopper-safe message when no token is returned', async () => {
		const collect = collectWith((opts) => opts.callback(null));
		await expect(
			prepareCardTokenization(collect, { ccnumber: '#a', ccexp: '#b', cvv: '#c' })(),
		).rejects.toThrow('Card validation failed');
	});

	it('timeout produces a retryable error', async () => {
		const collect = collectWith((opts) => opts.timeoutCallback());
		await expect(
			prepareCardTokenization(collect, { ccnumber: '#a', ccexp: '#b', cvv: '#c' })(),
		).rejects.toThrow('timed out');
	});
});
