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
    /** Inline variant: fires once the card number validates, with the card details Collect.js looked up for it. */
    lookUpCallback?: (card: { type?: string } | null | undefined) => void;
    timeoutCallback?: () => void;
    fieldsAvailableCallback?: () => void;
    callback?: (response: { token: string; card?: { number?: string; type?: string } } | null) => void;
  }): void;
  startPaymentRequest(): void;
  completePaymentResponse?(resp: { token?: string }): void;
}

export const collectJsSrc = (mode: 'test' | 'live', environment?: 'sandbox' | 'production'): string =>
  ((environment ?? (mode === 'test' ? 'sandbox' : 'production')) === 'sandbox'
    ? 'https://sandbox.nmi.com' : 'https://secure.nmi.com') + '/token/Collect.js';

let inflight: { key: string; promise: Promise<NmiCollectJs> } | null = null;

/** A script request that hangs fires neither onload nor onerror: past this it counts as failed (#372, Ads live pass
 *  2026-10-26: a fresh desktop load had no Collect.js and no error, so PLACE ORDER did nothing). */
export const COLLECT_LOAD_TIMEOUT_MS = 15000;

/** Load the Collect.js script once per tokenization key. */
export function loadCollectJs(tokenizationKey: string, mode: 'test' | 'live', doc?: Document, environment?: 'sandbox' | 'production', timeoutMs = COLLECT_LOAD_TIMEOUT_MS): Promise<NmiCollectJs> {
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
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (inflight?.promise === promise) inflight = null;
      script.remove();
      reject(new Error(message));
    };
    // A hung request clears `inflight` like any failure, so the retry requests the script afresh.
    const timer = setTimeout(() => fail('Collect.js timed out loading'), timeoutMs);
    script.onload = () => {
      if (settled) return;
      if (window.CollectJS) {
        settled = true;
        clearTimeout(timer);
        resolve(window.CollectJS);
      } else fail('Collect.js failed to initialise');
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

/** The hosted fields, by the names Collect.js reports them under. */
export type CardField = 'ccnumber' | 'ccexp' | 'cvv';
const CARD_FIELDS: readonly string[] = ['ccnumber', 'ccexp', 'cvv'];

/** What the shopper sees under a hosted field. Collect.js reports "Field is empty" for a field left blank and its own
 *  wording otherwise; the form speaks in one voice either way. */
export function cardFieldHint(field: CardField, message: string): string {
  const empty = /empty/i.test(message);
  switch (field) {
    case 'ccnumber': return empty ? 'Enter your card number.' : 'Check the card number.';
    case 'ccexp': return empty ? 'Enter the expiry date.' : 'Check the expiry date (MM / YY).';
    default: return empty ? 'Enter the security code.' : 'Check the security code.';
  }
}

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'maestro' | 'diners' | 'jcb';

/** Collect.js's card `type` (from the number lookup) as a brand the form has an icon for; anything else is no brand. */
export function normalizeCardBrand(type: unknown): CardBrand | null {
  if (typeof type !== 'string') return null;
  const t = type.toLowerCase().replace(/[^a-z]/g, '');
  if (t === 'visa') return 'visa';
  if (t === 'mastercard' || t === 'mc') return 'mastercard';
  if (t === 'amex' || t === 'americanexpress') return 'amex';
  if (t === 'maestro') return 'maestro';
  if (t === 'diners' || t === 'dinersclub' || t === 'dinersclubinternational') return 'diners';
  if (t === 'jcb') return 'jcb';
  return null;
}

/** Live feedback from the hosted fields. The card number itself never leaves the iframe: the brand comes from
 *  Collect.js's own lookup, and arrives only after the number validates (never while typing). */
export interface CardFieldListeners {
  onFieldValidation?: (field: CardField, valid: boolean, message: string) => void;
  onCardBrand?: (brand: CardBrand | null) => void;
  /** #393: brand + last 4 of the tokenized card (for the receipt), reported just before the token resolves; null when unknown. */
  onTokenCard?: (card: TokenCard | null) => void;
}

export interface TokenCard { brand: string; last4: string }
const BRAND_NAME: Record<CardBrand, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', maestro: 'Maestro', diners: 'Diners Club', jcb: 'JCB' };

/** Brand + last 4 from Collect.js's callback card (number is masked, e.g. 411111******1111). Never more of the card. */
export function tokenCardFacts(card: { number?: unknown; type?: unknown } | null | undefined): TokenCard | null {
  const last4 = typeof card?.number === 'string' ? /(\d{4})$/.exec(card.number.trim())?.[1] : undefined;
  const known = normalizeCardBrand(card?.type);
  const raw = typeof card?.type === 'string' && /^[A-Za-z][A-Za-z ]{0,19}$/.test(card.type.trim()) ? card.type.trim() : null;
  const brand = known ? BRAND_NAME[known] : raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : null;
  return last4 && brand ? { brand, last4 } : null;
}

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
export function prepareCardTokenization(collect: NmiCollectJs, fields: NmiCollectFields, onReady?: () => void, onInitError?: (message: string) => void, listeners?: CardFieldListeners): () => Promise<string> {
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
      // The lookup runs only when a listener wants the brand: it is an extra request to the gateway per validated number.
      ...(listeners?.onCardBrand ? { lookUpCallback: (card: { type?: string } | null | undefined) => listeners.onCardBrand?.(normalizeCardBrand(card?.type)) } : {}),
      validationCallback: (field, valid, message) => {
        if (CARD_FIELDS.includes(field)) listeners?.onFieldValidation?.(field as CardField, valid, message);
        // An edited number is no longer the one that was looked up.
        if (field === 'ccnumber' && !valid) listeners?.onCardBrand?.(null);
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
      callback: (response) => {
        if (response?.token) listeners?.onTokenCard?.(tokenCardFacts(response.card));
        done(response?.token ?? null);
      },
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
