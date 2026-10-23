import { component$, useStore, useSignal, useVisibleTask$, $, noSerialize, type NoSerialize } from '@qwik.dev/core';
import { routeLoader$, useNavigate, type DocumentHead } from '@qwik.dev/router';
import { BRAND_LICENSE } from '~/platform/brand-data';
import { apiErrorCode, checkout, createPaymentIntent, payOrder, getProduct, getCollection, getUpgradeEligibility, type ApiError, type VariantDetail, type CheckoutBody, type UpgradeEligibility } from '../../api';
import { getStripe } from '../../stripe';
import { confirmCheckoutPayment, type CheckoutPaymentRuntime } from '../../checkout-payment';
import { checkoutLegalContract, isCheckoutPaused, legalLinks, sellerLine, supportEmailFor, type CheckoutEligibilityBasis } from '../../legal';
import { fmtMoney as fmt } from '../../variant';
import { useHostVariant } from '../layout';

interface CheckoutItem {
  sku: string;
  productName: string;
  variantName: string;
  price: number;
  compareAtPrice: number | null;
  fulfillmentType: VariantDetail['fulfillmentType'];
  appKey: string | null;
}

/**
 * The variant being purchased (?sku=), found by scanning the host variant's collection. An app whose checkout is paused
 * (src/brand/license.json pausedAppKeys: nothing deliverable yet) resolves to nothing: a direct, bookmarked or indexed checkout
 * link must not take payment for an undeliverable product.
 */

export const useItem = routeLoader$<CheckoutItem | null>(async ({ url, resolveValue }) => {
  const sku = url.searchParams.get('sku');
  if (!sku) return null;
  const variant = await resolveValue(useHostVariant);
  const feed = await getCollection(variant.collection);
  for (const p of feed.products) {
    const detail = await getProduct(p.slug);
    // Licenses and other unshipped goods only: this flow has no stock or shipping, so a physical variant is never sellable here.
    const v = detail.variants.find((x) => x.sku === sku && x.fulfillmentType !== 'physical');
    if (v) {
      if (isCheckoutPaused(v.appKey)) return null;
      return {
        sku: v.sku,
      productName: detail.name,
      variantName: v.name,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
      fulfillmentType: v.fulfillmentType,
      appKey: v.appKey,
    };
    }
  }
  return null;
}, { search: ['sku'] });

/** `?upgrade=mobile`: the app-store purchase credit (src/brand/license.json upgradeCredit), linked from the account page and the app. */
export const useMobileUpgrade = routeLoader$<boolean>(({ url }) => url.searchParams.get('upgrade') === 'mobile', { search: ['upgrade'] });

const UPGRADE = BRAND_LICENSE?.upgradeCredit;
const SOURCE = UPGRADE?.sourceName ?? '';
const TARGET = UPGRADE?.targetName ?? '';
const COUNTRIES: [string, string][] = [
  ['US', 'United States'], ['CA', 'Canada'], ['GB', 'United Kingdom'], ['AU', 'Australia'],
  ['DE', 'Germany'], ['FR', 'France'], ['NL', 'Netherlands'], ['IE', 'Ireland'], ['IN', 'India'],
  ['SG', 'Singapore'], ['AE', 'United Arab Emirates'], ['NZ', 'New Zealand'], ['', 'Other'],
];

export default component$(() => {
  const nav = useNavigate();
  const store = useHostVariant();
  const item = useItem();
  const mobileUpgrade = useMobileUpgrade();
  const containerRef = useSignal<HTMLElement>();
  const paymentRuntime = useSignal<NoSerialize<CheckoutPaymentRuntime>>();
  const f = useStore({ email: '', firstName: '', lastName: '', address: '', city: '', province: '', postal: '', country: 'US', phone: '', legalAccepted: false, eligibilityBasis: '' as CheckoutEligibilityBasis | '', upgradeConsent: false });
  const state = useStore({ ready: false, paymentReady: false, inert: false, starting: false, reserved: false, resuming: false, orderCode: '', receiptToken: '', grandTotal: 0, clientSecret: '', paying: false, error: '', idemKey: '' });
  const upgrade = useStore({ checked: !(mobileUpgrade.value && !!UPGRADE && item.value?.sku === UPGRADE.sku && item.value?.appKey === UPGRADE.appKey), offer: null as UpgradeEligibility | null, error: '' });

  const billingValid = $(() =>
    f.email.includes('@') && !!f.firstName && !!f.lastName && !!f.address && !!f.city && !!f.postal && !!f.country);

  const requiresLegal = Boolean(item.value && ['license', 'update_pass'].includes(item.value.fulfillmentType));
  const legalContract = checkoutLegalContract(item.value?.appKey);
  // The credit applies only to its configured app and SKU; an offer counts only when it is for the SKU on this page.
  const requiresUpgradeConsent = mobileUpgrade.value && !!UPGRADE && item.value?.sku === UPGRADE.sku && item.value?.appKey === UPGRADE.appKey;
  const upgradeSku = item.value?.sku ?? '';
  // After this page reserves the order the details that went into it cannot change: what is paid is what was submitted. A pending
  // upgrade order found on load is continued exactly as it was placed (its billing details, legal acceptance and credit terms
  // are already on the order), so the form is not shown for it at all.
  const locked = state.reserved;

  // When the billing details are complete, create the order + Stripe
  // PaymentIntent and reveal the Payment Element (RH's reveal-on-valid pattern).
  const reveal = $(async () => {
    if (state.ready || state.inert || state.starting || state.clientSecret || !item.value) return;
    if (!state.resuming) {
      if (!(await billingValid())) return;
      if (requiresUpgradeConsent && (!upgrade.checked || !upgrade.offer?.eligible || !f.upgradeConsent)) return;
      if (requiresLegal && (!f.legalAccepted || !f.eligibilityBasis)) return;
    }
    if (!state.resuming && requiresLegal && !legalContract) {
      state.error = `${store.value.name} checkout is paused until its product-specific legal schedule is configured.`;
      return;
    }
    state.error = '';
    // One idempotency key per checkout attempt: a retry after a transient
    // failure replays the SAME order server-side instead of creating a
    // duplicate. The key is rotated only on a 409 'payload_mismatch' — the
    // backend proves the key was used with different fields (e.g. the shopper
    // edited the form after an invisible commit), so a fresh attempt under a
    // new key is the correct recovery.
    if (!state.idemKey) state.idemKey = crypto.randomUUID();
    const buildBody = (): CheckoutBody => ({
        items: [{ sku: item.value!.sku, quantity: 1 }],
        ...(requiresUpgradeConsent && upgrade.offer?.eligible ? {
          mobileUpgradeSourceId: upgrade.offer.sourceLicenseId,
          upgradeCreditTerms: { version: UPGRADE?.creditTermsVersion ?? '', accepted: true as const },
        } : {}),
        email: f.email,
        billingAddress: { firstName: f.firstName, lastName: f.lastName, line1: f.address, city: f.city, province: f.province, postalCode: f.postal, country: f.country, phone: f.phone },
        legalAcceptance: requiresLegal && legalContract && f.eligibilityBasis ? {
          acceptanceVersion: legalContract.acceptanceVersion,
          eligibilityBasis: f.eligibilityBasis,
          authorityConfirmed: true,
          agreementStatement: legalContract.agreementStatement,
          documents: legalContract.documents,
        } : undefined,
    });
    state.starting = true;
    try {
      let order;
      const pending = upgrade.offer?.eligible ? upgrade.offer.pendingOrder : undefined;
      if (pending) {
        order = {
          code: pending.code,
          state: 'PendingPayment',
          grandTotal: pending.grandTotal,
          discountTotal: 0,
          currency: 'USD',
          receiptToken: pending.receiptToken ?? undefined,
        };
      } else {
        try {
          order = await checkout(buildBody(), state.idemKey);
        } catch (e) {
          const err = e as Error & { status?: number; body?: string };
          const reason = (() => { try { return JSON.parse(err.body ?? '').reason as string | undefined; } catch { return undefined; } })();
          if (err.status !== 409 || reason !== 'payload_mismatch') throw e;
          state.idemKey = crypto.randomUUID();
          order = await checkout(buildBody(), state.idemKey);
        }
      }
      state.orderCode = order.code;
      state.reserved = true;
      state.receiptToken = order.receiptToken ?? '';
      state.grandTotal = order.grandTotal;
      try {
        const pi = await createPaymentIntent(order.code, state.receiptToken || undefined);
        state.clientSecret = pi.clientSecret;
        state.ready = true;
      } catch (e) {
        const s = (e as ApiError).status;
        const code = apiErrorCode(e);
        // Payments switched off (no usable Stripe keys, or the method disabled): the order stays reserved, nothing to pay yet.
        if (s === 503 || (s === 409 && code === 'PAYMENT_METHOD_DISABLED')) state.inert = true;
        else if (s === 409 && code === 'ORDER_NOT_PAYABLE' && (() => { try { return JSON.parse((e as ApiError).body ?? '').state === 'Paid'; } catch { return false; } })()) {
          await nav(`/checkout/confirmation/${encodeURIComponent(order.code)}/${state.receiptToken ? `?rt=${encodeURIComponent(state.receiptToken)}` : ''}`);
        } else throw e;
      }
    } catch (e) {
      state.error = (e as Error).message || 'Could not start checkout.';
      if (!state.resuming) state.orderCode = '';
      state.reserved = false;
    } finally {
      state.starting = false;
    }
  });

  useVisibleTask$(async ({ track }) => {
    const requested = track(() => requiresUpgradeConsent);
    if (!requested || upgrade.checked) return;
    try {
      const offer = await getUpgradeEligibility();
      // An offer for another SKU is not an offer for this page.
      upgrade.offer = offer.eligible && offer.sku !== upgradeSku ? { eligible: false } : offer;
      if (upgrade.offer.eligible && upgrade.offer.pendingOrder) {
        state.resuming = true;
        state.orderCode = upgrade.offer.pendingOrder.code;
        state.receiptToken = upgrade.offer.pendingOrder.receiptToken ?? '';
        state.grandTotal = upgrade.offer.pendingOrder.grandTotal;
      }
    } catch (e) {
      upgrade.error = (e as Error).message || `Could not check ${SOURCE} eligibility.`;
    } finally {
      upgrade.checked = true;
      void reveal();
    }
  });

  // A pending upgrade order needs no input: continue it as soon as it is known.
  useVisibleTask$(({ track }) => {
    if (track(() => state.resuming)) void reveal();
  });

  useVisibleTask$(({ track, cleanup }) => {
    const cs = track(() => state.clientSecret);
    const el = track(() => containerRef.value);
    if (!cs || !el) return;
    let disposed = false;
    let destroy: (() => void) | undefined;
    state.paymentReady = false;
    cleanup(() => { disposed = true; destroy?.(); paymentRuntime.value = undefined; });
    void (async () => {
      const stripe = await getStripe();
      if (disposed) return;
      if (!stripe) { state.error = 'Payment could not load. Please reload and try again.'; return; }
      const elements = stripe.elements({ clientSecret: cs });
      const payment = elements.create('payment', { layout: 'tabs' });
      destroy = () => payment.destroy();
      paymentRuntime.value = noSerialize({ stripe, elements });
      payment.on('ready', () => { if (!disposed) state.paymentReady = true; });
      payment.on('loaderror', () => { if (!disposed) state.error = 'Payment could not load. Please reload and try again.'; });
      payment.mount(el);
    })().catch(() => { if (!disposed) state.error = 'Payment could not load. Please reload and try again.'; });
  });

  const pay = $(async () => {
    if (state.paying) return;
    if (!state.resuming && requiresUpgradeConsent && (!upgrade.offer?.eligible || !f.upgradeConsent)) {
      state.error = `Accept the ${SOURCE} credit terms before payment.`;
      return;
    }
    if (!state.resuming && requiresLegal && (!f.legalAccepted || !f.eligibilityBasis)) {
      state.error = 'Accept the license terms and select an eligibility basis before payment.';
      return;
    }
    const runtime = paymentRuntime.value;
    if (!runtime || !state.paymentReady) {
      state.error = 'Payment is still loading. Please wait and try again.';
      return;
    }
    state.paying = true; state.error = '';
    try {
      // The receipt token lets the confirmation page read this order's real state (a guest has no session).
      const receipt = state.receiptToken ? `?rt=${encodeURIComponent(state.receiptToken)}` : '';
      await confirmCheckoutPayment(runtime, `${window.location.origin}/checkout/confirmation/${encodeURIComponent(state.orderCode)}/${receipt}`,
        intentId => payOrder(state.orderCode, intentId, state.receiptToken || undefined));
      await nav(`/checkout/confirmation/${encodeURIComponent(state.orderCode)}${receipt}`);
    } catch (error) {
      state.error = `${error instanceof Error ? error.message : 'Payment could not be completed. Please try again.'} Order ${state.orderCode}.`;
    } finally { state.paying = false; }
  });

  const supportEmail = supportEmailFor(store.value.domain);
  const seller = sellerLine();
  // Point-of-sale links on the app's canonical domain; the acceptance links are the contract's own documents (what is recorded).
  const legal = legalLinks(store.value.domain);
  const docUrl = (role: string, fallback: string) => legalContract?.documents.find((d) => d.role === role)?.url ?? fallback;
  const accept = {
    eula: docUrl('eula', legal.eula), license: docUrl('license', legal.license), acceptableUse: docUrl('acceptable_use', legal.acceptableUse),
    productSchedule: docUrl('product_schedule', legal.productSchedule), privacy: docUrl('privacy_notice', legal.privacy),
  };

  if (!item.value) {
    return (
      <div class="ck">
        <main class="wrap section">
          <h1>Nothing to check out</h1>
          <p class="lead">No license selected. <a href="/">Back to pricing →</a></p>
        </main>
        <div class="wrap" style="display:flex;gap:16px;justify-content:space-between;align-items:center;flex-wrap:wrap;padding:18px 24px 28px;color:#6E665F;font-size:12px">
          <div>{seller} · <a href={`mailto:${supportEmail}`}>{supportEmail}</a></div>
          <div style="display:flex;gap:14px;flex-wrap:wrap">
            <a href={legal.privacy}>Privacy</a>
            <a href={legal.terms}>Terms</a>
            <a href={legal.refund}>Refunds</a>
            <a href={legal.contact}>Contact</a>
          </div>
        </div>
      </div>
    );
  }

  const upgradeOffer = upgrade.offer?.eligible ? upgrade.offer : null;
  const total = state.grandTotal || upgradeOffer?.upgradePrice || item.value.price;
  const ctaText = requiresUpgradeConsent
    ? (upgradeOffer ? `Complete purchase — ${fmt(total)}` : upgrade.checked ? 'Upgrade unavailable' : 'Checking upgrade eligibility…')
    : `Complete purchase — ${fmt(total)}`;
  return (
    <div class="ck">
      <div class="ck-cols">
        {/* ── LEFT: order summary (dark) ── */}
        <div class="ck-left">
          <div class="ck-sum">
            <span class="ck-eyebrow">Your Order</span>
            <div class="ck-total">{requiresUpgradeConsent && !upgradeOffer ? '—' : fmt(total)}</div>
            {upgradeOffer ? (
              <div class="ck-standard-price"><span>{fmt(upgradeOffer.fullPrice)}</span> {TARGET} · {fmt(upgradeOffer.credit)} {SOURCE} credit</div>
            ) : item.value.compareAtPrice && item.value.compareAtPrice > item.value.price && (
              <div class="ck-standard-price"><span>{fmt(item.value.compareAtPrice)}</span> standard</div>
            )}
            <div class="ck-rule" />
            <div class="ck-item">
              <div>
                <div class="ck-item-name">{item.value.productName}</div>
                <div class="ck-item-sub">{item.value.variantName} · {store.value.name} license</div>
              </div>
              <div class="ck-item-price">{upgradeOffer ? fmt(upgradeOffer.upgradePrice) : requiresUpgradeConsent ? '—' : fmt(item.value.price)}</div>
            </div>
            <div class="ck-rule" />
            <div class="ck-foot">One-time charge · license key delivered instantly · secured by Stripe</div>
            <div class="ck-foot" style="margin-top:10px">{seller}</div>
          </div>
        </div>

        {/* ── RIGHT: details + payment (light) ── */}
        <div class="ck-right">
          <div class="ck-right-inner">
            <div class="ck-steps">
              <span class="ck-step ck-step-on"><b>1</b> Your details</span>
              <span class="ck-step"><b>2</b> Payment</span>
            </div>
            {requiresUpgradeConsent && (
              <div class="ck-upgrade-card" role="status">
                <span class="ck-eyebrow ck-eyebrow-light">{SOURCE} upgrade</span>
                {!upgrade.checked ? (
                  <p class="note">Checking your verified {UPGRADE?.storeName} purchase…</p>
                ) : upgrade.error ? (
                  <p class="ck-err"><a href="/account/">{upgrade.error} Open your account to sign in.</a></p>
                ) : upgrade.offer?.eligible ? (
                  <>
                    <p class="ck-upgrade-title">{TARGET} for {fmt(upgrade.offer.upgradePrice)}</p>
                    <p class="note">{TARGET} {fmt(upgrade.offer.fullPrice)} less your {fmt(upgrade.offer.credit)} {SOURCE} credit.</p>
                    {upgrade.offer.pendingOrder && <p class="note">Your pending upgrade order is ready to continue.</p>}
                  </>
                ) : (
                  <p class="note">A verified Production {UPGRADE?.storeName} {SOURCE} purchase linked to this account is required.</p>
                )}
              </div>
            )}
            {state.resuming ? (
              <p class="note" style="margin-top:0">
                Order {state.orderCode} continues as you placed it: its billing details and the terms you accepted apply.
              </p>
            ) : (<>
            <div class="ck-grid">
              <input class="ck-input" disabled={locked} type="email" placeholder="Email address" value={f.email} onInput$={(e) => (f.email = (e.target as HTMLInputElement).value)} onBlur$={reveal} />
              <input class="ck-input" disabled={locked} type="tel" placeholder="Phone (optional)" value={f.phone} onInput$={(e) => (f.phone = (e.target as HTMLInputElement).value)} />
            </div>
            <div class="ck-grid ck-mt">
              <input class="ck-input" disabled={locked} placeholder="First name" value={f.firstName} onInput$={(e) => (f.firstName = (e.target as HTMLInputElement).value)} onBlur$={reveal} />
              <input class="ck-input" disabled={locked} placeholder="Last name" value={f.lastName} onInput$={(e) => (f.lastName = (e.target as HTMLInputElement).value)} onBlur$={reveal} />
            </div>
            <input class="ck-input ck-mt" disabled={locked} placeholder="Billing address" value={f.address} onInput$={(e) => (f.address = (e.target as HTMLInputElement).value)} onBlur$={reveal} />
            <div class="ck-grid ck-mt">
              <input class="ck-input" disabled={locked} placeholder="City" value={f.city} onInput$={(e) => (f.city = (e.target as HTMLInputElement).value)} onBlur$={reveal} />
              <input class="ck-input" disabled={locked} placeholder="State / Province" value={f.province} onInput$={(e) => (f.province = (e.target as HTMLInputElement).value)} />
            </div>
            <div class="ck-grid ck-mt">
              <input class="ck-input" disabled={locked} placeholder="Postal code" value={f.postal} onInput$={(e) => (f.postal = (e.target as HTMLInputElement).value)} onBlur$={reveal} />
              <select class="ck-input" disabled={locked} value={f.country} onChange$={(e) => { f.country = (e.target as HTMLSelectElement).value; }} onBlur$={reveal}>
                {COUNTRIES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}
              </select>
            </div>
            </>)}

            <div class="ck-pay">
              <span class="ck-eyebrow ck-eyebrow-light">Payment</span>
              {state.ready ? (
                <div class="payment-reveal"><div class="ck-stripe" ref={containerRef} /></div>
              ) : state.inert ? (
                <div class="ck-placeholder">Online payment isn't switched on yet (pre-launch). Order {state.orderCode} is reserved — checkout goes live the moment payments are enabled.</div>
              ) : (
                <div class="ck-placeholder">Enter your details above to continue to payment.</div>
              )}
            </div>

            {requiresLegal && !state.resuming ? (
              <div class="ck-legal" style="margin-top:18px;padding:16px;border:1px solid #D8D0C8;border-radius:10px;background:#F7F3EE">
                <label style="display:block;font-size:12px;font-weight:700;margin-bottom:8px" for="legal-eligibility">License eligibility</label>
                <select
                  id="legal-eligibility"
                  disabled={locked}
                  class="ck-input"
                  value={f.eligibilityBasis}
                  onChange$={(event) => { f.eligibilityBasis = (event.target as HTMLSelectElement).value as CheckoutEligibilityBasis | ''; void reveal(); }}
                >
                  <option value="">Select one…</option>
                  <option value="individual">Individual — my own use, on my own devices</option>
                  <option value="enterprise">Enterprise — used at or for a company, or on company devices</option>
                </select>
                <label style="display:flex;align-items:flex-start;gap:10px;margin-top:12px;font-size:12px;line-height:1.55;cursor:pointer">
                  <input
                    type="checkbox"
                    disabled={locked}
                    checked={f.legalAccepted}
                    onChange$={(event) => { f.legalAccepted = (event.target as HTMLInputElement).checked; void reveal(); }}
                    style="margin-top:3px"
                  />
                  <span>
                    I agree to the <a href={accept.eula}>EULA</a>, <a href={accept.license}>Ownership Notice</a>,{' '}
                    <a href={accept.acceptableUse}>Acceptable Use Policy</a>, and <a href={accept.productSchedule}>Product Schedule</a>.{' '}
                    I have authority to accept them for the selected user or organization. I acknowledge the{' '}
                    <a href={accept.privacy}>Privacy Notice</a>; this is not consent to optional processing.
                  </span>
                </label>
                {BRAND_LICENSE?.legalNotice && (
                  <p style="margin:10px 0 0;font-size:11px;line-height:1.5;color:#6E665F">
                    {BRAND_LICENSE.legalNotice}
                  </p>
                )}
                {requiresUpgradeConsent && (
                  <label class="ck-upgrade-consent">
                    <input
                      type="checkbox"
                      disabled={locked}
                      checked={f.upgradeConsent}
                      onChange$={(event) => { f.upgradeConsent = (event.target as HTMLInputElement).checked; void reveal(); }}
                    />
                    <span>{SOURCE} credit is available once per purchase. Refunding or revoking the credited {SOURCE} purchase invalidates the {TARGET} license purchased with this credit.</span>
                  </label>
                )}
              </div>
            ) : null}

            <button class={`ck-cta${state.paymentReady && !state.paying ? '' : ' ck-cta-off'}`} disabled={!state.paymentReady || state.paying || (!state.resuming && ((requiresLegal && (!f.legalAccepted || !f.eligibilityBasis)) || (requiresUpgradeConsent && (!upgrade.offer?.eligible || !f.upgradeConsent))))} onClick$={pay}>
              {state.paying ? 'Processing…' : ctaText}
            </button>
            <p style="margin-top:14px;font-size:12px;line-height:1.6;color:#6E665F">
              Website use is covered by the <a href={legal.terms}>Website Terms</a>. Purchases are subject to the <a href={legal.refund}>Refund Policy</a>. Support: <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
            </p>
            {state.error && <p class="ck-err">{state.error}</p>}
          </div>
        </div>
      </div>
      <div class="wrap" style="display:flex;gap:16px;justify-content:space-between;align-items:center;flex-wrap:wrap;padding:18px 24px 28px;color:#6E665F;font-size:12px">
        <div>{seller} · <a href={`mailto:${supportEmail}`}>{supportEmail}</a></div>
        <div style="display:flex;gap:14px;flex-wrap:wrap">
          <a href={legal.privacy}>Privacy</a>
          <a href={legal.terms}>Terms</a>
          <a href={legal.refund}>Refunds</a>
          <a href={legal.contact}>Contact</a>
        </div>
      </div>
    </div>
  );
});

export const head: DocumentHead = ({ resolveValue }) => ({ title: `Checkout — ${resolveValue(useHostVariant).name}` });
