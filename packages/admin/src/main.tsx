import { StrictMode, lazy, useEffect, useState } from 'react';
import EnrollSecondFactor from './pages/EnrollSecondFactor';
import ReviewPasskeys from './pages/ReviewPasskeys';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { retryRead } from './lib/query-retry';
import './index.css';
import './redesign/redesign.css';
import { AuthProvider, useAuth } from './auth';
import { Loading } from './components/ui';
import { ToastProvider } from './components/Toast';
import { CommandPalette } from './components/CommandPalette';

// QA-only a11y helper (ra-014). Side-effect import: attaches
// window.__runA11yAudit() so a devtools session (or future Playwright suite)
// can run an axe-core pass against the live DOM. Vite strips this in
// production builds because the conditional is statically evaluated.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if ((import.meta as any).env?.MODE === 'qa') {
  void import('./qa-a11y.js');
}
import Layout from './components/Layout';
import { AppErrorBoundary } from './components/ErrorBoundary';
import Login from './pages/Login';
import Setup from './pages/Setup';
import AcceptInvite from './pages/AcceptInvite';

// Route pages load on first visit, not in the first bundle (#362): signed-out screens and the shell stay eager.
const Onboarding = lazy(() => import('./pages/Onboarding'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Orders = lazy(() => import('./pages/Orders'));
const OrderDetail = lazy(() => import('./pages/OrderDetail'));
const Subscriptions = lazy(() => import('./pages/Subscriptions'));
const Products = lazy(() => import('./pages/Products'));
const ProductDetail = lazy(() => import('./pages/ProductDetail'));
const ProductCreate = lazy(() => import('./pages/ProductCreate'));
const Collections = lazy(() => import('./pages/Collections'));
const CollectionDetail = lazy(() => import('./pages/CollectionDetail'));
const Inventory = lazy(() => import('./pages/Inventory'));
const Customers = lazy(() => import('./pages/Customers'));
const CustomerDetail = lazy(() => import('./pages/CustomerDetail'));
const DraftOrder = lazy(() => import('./pages/DraftOrder'));
const ImportTracking = lazy(() => import('./pages/ImportTracking'));
const TrackingGrid = lazy(() => import('./pages/TrackingGrid'));
const OrderExport = lazy(() => import('./pages/OrderExport'));
const SheerIdSettings = lazy(() => import('./pages/SheerIdSettings'));
const BulkStock = lazy(() => import('./pages/BulkStock'));
const AccountCredit = lazy(() => import('./pages/AccountCredit'));
const AbandonedCarts = lazy(() => import('./pages/AbandonedCarts'));
const Affiliates = lazy(() => import('./pages/Affiliates'));
const AffiliateDetail = lazy(() => import('./pages/AffiliateDetail'));
const Discounts = lazy(() => import('./pages/Discounts'));
const DiscountEditor = lazy(() => import('./pages/Discounts').then((m) => ({ default: m.DiscountEditor })));
const Marketing = lazy(() => import('./pages/Marketing'));
const Blog = lazy(() => import('./pages/Blog'));
const Reports = lazy(() => import('./pages/Reports'));
const Waitlist = lazy(() => import('./pages/Waitlist'));
const Seo = lazy(() => import('./pages/Seo'));
const Activity = lazy(() => import('./pages/Activity'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const PaymentsSettings = lazy(() => import('./pages/PaymentsSettings'));
const EmailSettings = lazy(() => import('./pages/EmailSettings'));
const Returns = lazy(() => import('./pages/Returns'));
const GiftCards = lazy(() => import('./pages/GiftCards'));
const Loyalty = lazy(() => import('./pages/Loyalty'));
const Reviews = lazy(() => import('./pages/Reviews'));
const Webhooks = lazy(() => import('./pages/Webhooks'));
const Locations = lazy(() => import('./pages/Locations'));
const TaxZones = lazy(() => import('./pages/TaxZones'));
const CurrencyRates = lazy(() => import('./pages/CurrencyRates'));
const Staff = lazy(() => import('./pages/Staff'));

const qc = new QueryClient({ defaultOptions: { queries: { retry: retryRead, refetchOnWindowFocus: false, staleTime: 15_000 } } });

function Protected() {
  const { loading, me } = useAuth();
  if (loading) return <div className="h-full grid place-items-center"><Loading label="Starting up" /></div>;
  if (!me) return <Navigate to="/login" replace />;
  // P1b: policy requires 2FA and none is enrolled — the API only lets this session enrol, so the whole app is
  // replaced by the enrolment screen until it is done.
  if (me.totpEnrollmentRequired) return <EnrollSecondFactor />;
  // #333 review: after a password reset, confirm which passkeys to keep (the API allows nothing else until then).
  if (me.passkeyReviewRequired) return <ReviewPasskeys />;
  return (
    <>
      <Layout />
      {/* Global command palette — mounted outside Layout so it overlays
          everything and uses the same router context. */}
      <CommandPalette />
    </>
  );
}

/**
 * Plan §1.4: "while unclaimed, the admin UI shows only the claim screen."
 * Checked once per load via GET /v1/setup/status (pre-auth, cheap): 200 means
 * still unclaimed (every route — including /login — renders Setup instead).
 * ANY other outcome — 404 (claimed), 401/403 (a front door such as the public
 * demo's policy that refuses installation routes), 5xx, network error — fails
 * OPEN to the normal app rather than locking out an already-claimed install.
 * Only a positive "unclaimed" answer may show the claim screen. Setup.tsx
 * flips this cache entry to `true` right after a successful claim, before
 * navigating, so the very next render already sees the normal app — no extra
 * round-trip.
 */
function useIsClaimed(): { loading: boolean; claimed: boolean } {
  const [state, setState] = useState<{ loading: boolean; claimed: boolean }>({ loading: true, claimed: true });
  useEffect(() => {
    let cancelled = false;
    fetch('/v1/setup/status', { credentials: 'include' })
      .then((res) => { if (!cancelled) setState({ loading: false, claimed: res.status !== 200 }); })
      .catch(() => { if (!cancelled) setState({ loading: false, claimed: true }); });
    return () => { cancelled = true; };
  }, []);
  return state;
}

function App() {
  const { loading: statusLoading, claimed } = useIsClaimed();
  if (statusLoading) return <div className="h-full grid place-items-center"><Loading label="Starting up" /></div>;
  if (!claimed) {
    return (
      <Routes>
        <Route path="*" element={<Setup />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/setup" element={<Setup />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route element={<Protected />}>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/" element={<Dashboard />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/orders/new" element={<DraftOrder />} />
        <Route path="/orders/import-tracking" element={<ImportTracking />} />
        <Route path="/orders/tracking-grid" element={<TrackingGrid />} />
        <Route path="/fulfilment/upload" element={<ImportTracking />} />
        <Route path="/fulfilment/manual" element={<TrackingGrid />} />
        <Route path="/fulfilment/export" element={<OrderExport />} />
        <Route path="/orders/:code" element={<OrderDetail />} />
        <Route path="/subscriptions" element={<Subscriptions />} />
        <Route path="/abandoned-carts" element={<AbandonedCarts />} />
        <Route path="/affiliates" element={<Affiliates />} />
        <Route path="/affiliates/:id" element={<AffiliateDetail />} />
        <Route path="/products" element={<Products />} />
        <Route path="/products/new" element={<ProductCreate />} />
        <Route path="/products/:id" element={<ProductDetail />} />
        <Route path="/collections" element={<Collections />} />
        <Route path="/collections/:id" element={<CollectionDetail />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/bulk-stock" element={<BulkStock />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/customers/:id" element={<CustomerDetail />} />
        <Route path="/discounts" element={<Discounts />} />
        <Route path="/discounts/new" element={<DiscountEditor />} />
        <Route path="/discounts/:id" element={<DiscountEditor />} />
        <Route path="/marketing" element={<Marketing />} />
        <Route path="/blog" element={<Blog />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/waitlist" element={<Waitlist />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/returns" element={<Returns />} />
        <Route path="/gift-cards" element={<GiftCards />} />
        <Route path="/account-credit" element={<AccountCredit />} />
        <Route path="/loyalty" element={<Loyalty />} />
        <Route path="/reviews" element={<Reviews />} />
        <Route path="/locations" element={<Locations />} />
        <Route path="/tax-zones" element={<TaxZones />} />
        <Route path="/currency-rates" element={<CurrencyRates />} />
        <Route path="/webhooks" element={<Webhooks />} />
        <Route path="/staff" element={<Staff />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/payments" element={<PaymentsSettings />} />
        <Route path="/settings/email" element={<EmailSettings />} />
        <Route path="/settings/sheerid" element={<SheerIdSettings />} />
        <Route path="/settings/seo" element={<Seo />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

// Sub-path mount (the isolated demo hosts this SPA at /admin, since / and
// most of its own top-level paths — /shop, /products, /collections, /blog —
// belong to the generic Qwik storefront there; see deploy/demo/README.md and
// interactive-server.mjs). basename covers every <Link>/<NavLink>/navigate()
// call in this app automatically — there is no equivalent hardcoded-href
// landmine here the way there is in the storefront's codebase. Empty for
// every normal deployment, so BrowserRouter keeps mounting at '/'.
const basename = (import.meta.env.VITE_ADMIN_BASE_PATH as string | undefined)?.replace(/\/+$/, '') || undefined;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <BrowserRouter basename={basename}>
          <ToastProvider>
            {/* Root boundary — last-resort catch-all. Any error not isolated by
                a section boundary surfaces here so the user still sees the
                chrome (header, nav) and a Reload button instead of a blank tab. */}
            <AppErrorBoundary>
              <App />
            </AppErrorBoundary>
          </ToastProvider>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
