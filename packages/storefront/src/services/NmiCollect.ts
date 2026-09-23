/**
 * NMI Collect.js — the only supported client-side tokenization for the
 * SellRight gateway path. Collect.js swaps the card inputs for hosted iframes
 * and returns a `payment_token`; raw PAN never reaches this app (the API
 * contract requires the token, which is also the correct PCI posture — the
 * retired Vendure plugin charged raw card fields server-side).
 *
 * Docs: https://secure.nmi.com/merchants/resources/integration/download.php?document=collectjs
 * The account environment selects the host independently of payment mode;
 * the tokenization key comes from GET /v1/shop/config (gateways.nmi).
 */

declare global {
  interface Window { CollectJS?: NmiCollectJs }
}

/** Field selectors Collect.js replaces with hosted iframes. */
export interface NmiCollectFields {
  ccnumber: string;
  ccexp: string;
  cvv: string;
}

export interface NmiCollectJs {
  configure(opts: {
    variant?: 'inline' | 'lightbox';
    fields?: Record<string, { selector: string; title?: string }>;
    styleSniffer?: boolean;
    customCss?: Record<string, string>;
    validationCallback?: (field: string, valid: boolean, message: string) => void;
    timeoutCallback?: () => void;
    fieldsAvailableCallback?: () => void;
    callback?: (response: { token: string } | null) => void;
  }): void;
  startPaymentRequest(): void;
  completePaymentResponse?(resp: { token?: string }): void;
}

export const collectJsSrc = (mode: 'test' | 'live', environment?: 'sandbox' | 'production'): string =>
  ((environment ?? (mode === 'test' ? 'sandbox' : 'production')) === 'sandbox'
    ? 'https://sandbox.nmi.com' : 'https://secure.nmi.com') + '/token/Collect.js';

let inflight: { key: string; promise: Promise<NmiCollectJs> } | null = null;

/** Load the Collect.js script once per tokenization key. */
export function loadCollectJs(tokenizationKey: string, mode: 'test' | 'live', doc?: Document, environment?: 'sandbox' | 'production'): Promise<NmiCollectJs> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Collect.js is browser-only'));
  const src = collectJsSrc(mode, environment);
  const key = `${src}:${tokenizationKey}`;
  if (inflight && inflight.key === key) return inflight.promise;
  const documentRef = doc ?? document;
  inflight = {
    key,
    promise: new Promise<NmiCollectJs>((resolve, reject) => {
      const script = documentRef.createElement('script');
      script.src = src;
      script.setAttribute('data-tokenization-key', tokenizationKey);
      script.async = true;
      script.onload = () => {
        if (window.CollectJS) resolve(window.CollectJS);
        else reject(new Error('Collect.js failed to initialise'));
      };
      script.onerror = () => reject(new Error('Collect.js failed to load'));
      documentRef.head.appendChild(script);
    }),
  };
  return inflight.promise;
}

/** Configure before card entry; reconfiguring on Pay redraws the hosted fields. */
export function prepareCardTokenization(collect: NmiCollectJs, fields: NmiCollectFields, onReady?: () => void): () => Promise<string> {
  let pending: { resolve: (token: string) => void; reject: (error: Error) => void } | null = null;
  const done = (token: string | null, error?: string) => {
    const request = pending;
    pending = null;
    if (!request) return;
    if (token) request.resolve(token);
    else request.reject(new Error(error ?? 'Card validation failed — check the details and try again.'));
  };
  collect.configure({
      variant: 'inline',
      fields: {
        ccnumber: { selector: fields.ccnumber, title: 'Card Number' },
        ccexp: { selector: fields.ccexp, title: 'Expiration' },
        cvv: { selector: fields.cvv, title: 'Security Code' },
      },
      timeoutCallback: () => done(null, 'Card validation timed out — try again.'),
      callback: (response) => done(response?.token ?? null),
      fieldsAvailableCallback: onReady,
  });
  return () => new Promise<string>((resolve, reject) => {
    if (pending) { reject(new Error('Card validation is already in progress')); return; }
    pending = { resolve, reject };
    try { collect.startPaymentRequest(); }
    catch { done(null, 'Card validation could not start — try again.'); }
  });
}
