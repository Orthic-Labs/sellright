/**
 * NMI Collect.js — the only supported client-side tokenization for the
 * SellRight gateway path. Collect.js swaps the card inputs for hosted iframes
 * and returns a `payment_token`; raw PAN never reaches this app (the API
 * contract requires the token, which is also the correct PCI posture — the
 * retired legacy plugin charged raw card fields server-side).
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
    fields?: Record<string, { selector: string; title?: string; placeholder?: string }>;
    styleSniffer?: boolean;
    customCss?: Record<string, string>;
    placeholderCss?: Record<string, string>;
    invalidCss?: Record<string, string>;
    timeoutDuration?: number;
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
  const promise = new Promise<NmiCollectJs>((resolve, reject) => {
    const script = documentRef.createElement('script');
    script.src = src;
    script.setAttribute('data-tokenization-key', tokenizationKey);
    script.async = true;
    // A failed load must not stay cached: the next call (the retry) has to request the script again, and the dead
    // script element must not linger in the head.
    const fail = (message: string) => {
      if (inflight?.promise === promise) inflight = null;
      script.remove();
      reject(new Error(message));
    };
    script.onload = () => {
      if (window.CollectJS) resolve(window.CollectJS);
      else fail('Collect.js failed to initialise');
    };
    script.onerror = () => fail('Collect.js failed to load');
    documentRef.head.appendChild(script);
  });
  inflight = { key, promise };
  return inflight.promise;
}

const FIELD_NAMES: Record<string, string> = { ccnumber: 'card number', ccexp: 'expiry date (MM / YY)', cvv: 'security code' };
const invalidMessage = (field: string): string => `Check the ${FIELD_NAMES[field] ?? 'card details'} and try again.`;
/** True for the card-field messages above: raised before any charge, so no order-state check is needed to show them. */
export const isCardFieldMessage = (message: string): boolean => /^Check the .+ and try again\.$/.test(message);

/** Collect.js internals (verified in the live secure.nmi.com/token/Collect.js, 2026-10-25): startPaymentRequest
 *  sets inSubmission and arms responseTimeout; only a token or that timer clears them, never an invalid field. */
type CollectInternals = { inSubmission?: boolean; responseTimeout?: ReturnType<typeof setTimeout> };
const resetSubmission = (collect: NmiCollectJs): boolean => {
  const c = collect as NmiCollectJs & CollectInternals;
  if (typeof c.inSubmission !== 'boolean') return false;
  if (c.responseTimeout !== undefined) clearTimeout(c.responseTimeout);
  c.inSubmission = false;
  return true;
};

/** Hosted fields that never report ready within this long count as failed to load. */
export const FIELDS_INIT_TIMEOUT_MS = 30000;

/** Configure before card entry; reconfiguring on Pay redraws the hosted fields. */
export function prepareCardTokenization(collect: NmiCollectJs, fields: NmiCollectFields, onReady?: () => void, onInitError?: (message: string) => void): () => Promise<string> {
  let pending: { resolve: (token: string) => void; reject: (error: Error) => void } | null = null;
  // Collect.js never calls `callback` while a hosted field is invalid: it reports each field through
  // validationCallback instead. Without handling that, Pay on a bad expiry or card number did nothing at all.
  const invalid = new Map<string, string>();
  const done = (token: string | null, error?: string) => {
    const request = pending;
    pending = null;
    if (!request) return;
    if (token) request.resolve(token);
    else request.reject(new Error(error ?? 'Card validation failed — check the details and try again.'));
  };
  // Field loading has its own timer as well: not every Collect.js failure to load ends in timeoutCallback.
  let ready = false;
  const initTimer = setTimeout(() => { if (!ready) onInitError?.('Card fields timed out loading.'); }, FIELDS_INIT_TIMEOUT_MS);
  collect.configure({
      variant: 'inline',
      fields: {
        ccnumber: { selector: fields.ccnumber, title: 'Card Number', placeholder: 'Card number' },
        ccexp: { selector: fields.ccexp, title: 'Expiration', placeholder: 'MM / YY' },
        cvv: { selector: fields.cvv, title: 'Security Code', placeholder: 'CVC' },
      },
      // 16px keeps iOS Safari from zooming into the hosted inputs.
      customCss: { 'font-size': '16px', color: '#111110', 'background-color': 'transparent' },
      placeholderCss: { color: '#8a8178' },
      invalidCss: { color: '#b3261e' },
      // A tokenization that never answers ends in timeoutCallback (a retryable error), not an endless "Processing".
      timeoutDuration: 20000,
      validationCallback: (field, valid, message) => {
        if (valid) { invalid.delete(field); return; }
        invalid.set(field, message);
        // During a submission: fail now when Collect can be returned to idle (so the corrected retry starts a fresh
        // request); otherwise its timeout ends this attempt with the same message.
        if (pending && resetSubmission(collect)) done(null, invalidMessage(field));
      },
      timeoutCallback: () => {
        // Before the fields ever reported available and with no submission open, Collect timing out means the hosted
        // fields failed to load: surface the recoverable init error now instead of waiting for our own timer.
        if (!ready && !pending) { clearTimeout(initTimer); onInitError?.('Card fields timed out loading.'); return; }
        const first = invalid.keys().next();
        done(null, first.done ? 'Card validation timed out — try again.' : invalidMessage(first.value));
      },
      callback: (response) => done(response?.token ?? null),
      fieldsAvailableCallback: () => { ready = true; clearTimeout(initTimer); onReady?.(); },
  });
  return () => new Promise<string>((resolve, reject) => {
    if (pending) { reject(new Error('Card validation is already in progress')); return; }
    // Always let Collect re-check the fields: a cached invalid state can be stale (autofill without a blur), so
    // only what this submission reports names the field in an error.
    invalid.clear();
    pending = { resolve, reject };
    try { collect.startPaymentRequest(); }
    catch { done(null, 'Card validation could not start — try again.'); }
  });
}
