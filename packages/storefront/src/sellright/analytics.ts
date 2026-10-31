/**
 * Typed, consent-gated storefront analytics event bus.
 *
 * No vendor is wired up here — this module only defines the event contract
 * and a subscribe/publish bus, gated on consent. A future integration (GA4,
 * Meta Pixel, a first-party collector, whatever gets chosen) subscribes via
 * `onAnalyticsEvent` and forwards events to its own transport; it never
 * needs to touch the call sites that `track()` this module.
 *
 * Consent: `setAnalyticsConsent(false)` (the default) makes `track()` a
 * no-op — nothing is queued, nothing is retained, no subscriber is called.
 * Consent must be explicitly granted (e.g. from a cookie-consent banner)
 * before any event reaches a listener. This module has no knowledge of
 * *how* consent is obtained (that's a UI/legal concern outside this file);
 * it only enforces the gate once told.
 */

export interface ViewItemEvent {
	name: 'view_item';
	sku: string;
	productName: string;
	price: number;
	currency: string;
}

export interface AddToCartEvent {
	name: 'add_to_cart';
	sku: string;
	productName: string;
	price: number;
	currency: string;
	quantity: number;
}

/** One order or cart line in minor units (unit price), for begin_checkout and purchase. */
export interface AnalyticsLine {
	sku: string;
	name: string;
	price: number;
	quantity: number;
}

export interface BeginCheckoutEvent {
	name: 'begin_checkout';
	currency: string;
	value: number;
	itemCount: number;
	/** At most 20 cart lines (minor units). */
	items?: AnalyticsLine[];
}

export interface PurchaseEvent {
	name: 'purchase';
	orderCode: string;
	currency: string;
	value: number;
	itemCount: number;
	/** At most 20 order lines (minor units), for the dataLayer purchase. */
	items?: AnalyticsLine[];
	/** SHA-256 hex of the normalised email / E.164 phone (never raw), for ad platforms' enhanced matching. */
	userData?: { sha256EmailAddress?: string; sha256PhoneNumber?: string };
}

export type AnalyticsEvent = ViewItemEvent | AddToCartEvent | BeginCheckoutEvent | PurchaseEvent;

type AnalyticsListener = (event: AnalyticsEvent) => void;

const listeners = new Set<AnalyticsListener>();

// Module-level state, browser-only: analytics consent/events never apply
// during SSR (there is no visitor to consent yet), and this module is never
// imported for its side effects on the server render path.
let consentGranted = false;
// #425: events tracked before the page's subscriber starts (the conversion subscriber mounts at document-idle, but the product view
// starts its stock read at qinit, so `view_item` came first and was dropped). Held, bounded, until the first subscriber registers:
// delivered to it only if consent is granted at that moment (implied-consent brands grant it just before subscribing), otherwise
// discarded, so nothing tracked before an explicit consent is ever sent. No storage: a page's held events die with the page.
const MAX_HELD = 20;
let held: AnalyticsEvent[] = [];

/** Grant or revoke consent. Revoking does not retroactively un-fire past
 *  events (there is no retention here to undo) — it only gates future
 *  `track()` calls. */
export function setAnalyticsConsent(granted: boolean): void {
	consentGranted = granted;
	if (!granted) held = [];
	// #375: revoking consent forgets the stored hashed user data (platform/controllers/user-data.ts USER_DATA_STORAGE_KEY).
	if (!granted && typeof window !== 'undefined') {
		try {
			window.localStorage.removeItem('sr-user-data');
		} catch {
			// storage blocked: nothing was stored
		}
	}
}

export function hasAnalyticsConsent(): boolean {
	return consentGranted;
}

/** Subscribe to every tracked event once consent is granted. Returns an
 *  unsubscribe function. This is the ONE integration point a future vendor
 *  adapter needs — it never has to be threaded through call sites. */
export function onAnalyticsEvent(listener: AnalyticsListener): () => void {
	listeners.add(listener);
	const early = held;
	held = [];
	if (consentGranted) for (const event of early) deliver(listener, event);
	return () => listeners.delete(listener);
}

/** Emit an event. No-op (silently) without consent — callers don't need to
 *  check `hasAnalyticsConsent()` themselves before every `track()` call. */
export function track(event: AnalyticsEvent): void {
	if (listeners.size === 0) {
		// No subscriber yet (it may still be starting): hold, decided at subscription (consent then).
		if (typeof window !== 'undefined' && held.length < MAX_HELD) held.push(event);
		return;
	}
	if (!consentGranted) return;
	for (const listener of listeners) deliver(listener, event);
}

function deliver(listener: AnalyticsListener, event: AnalyticsEvent): void {
	try {
		listener(event);
	} catch (err) {
		// A misbehaving subscriber must never break the page it's
		// instrumenting.
		console.error('analytics listener failed:', err);
	}
}

/** Test-only: drops every subscriber and resets consent. Not exported from
 *  any public entry point other than this module itself — import it
 *  directly in tests (`~/sellright/analytics`), never from app code. */
export function __resetAnalyticsForTests(): void {
	listeners.clear();
	consentGranted = false;
}
