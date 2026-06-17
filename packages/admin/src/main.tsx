import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { AuthProvider, useAuth } from './auth';
import { Loading } from './components/ui';
import { ToastProvider } from './components/Toast';
import { CommandPalette } from './components/CommandPalette';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Orders from './pages/Orders';
import OrderDetail from './pages/OrderDetail';
import Products from './pages/Products';
import ProductDetail from './pages/ProductDetail';
import ProductCreate from './pages/ProductCreate';
import Collections from './pages/Collections';
import CollectionDetail from './pages/CollectionDetail';
import Inventory from './pages/Inventory';
import Customers from './pages/Customers';
import CustomerDetail from './pages/CustomerDetail';
import DraftOrder from './pages/DraftOrder';
import ImportTracking from './pages/ImportTracking';
import AbandonedCarts from './pages/AbandonedCarts';
import Affiliates from './pages/Affiliates';
import AffiliateDetail from './pages/AffiliateDetail';
import Discounts from './pages/Discounts';
import Marketing from './pages/Marketing';
import Blog from './pages/Blog';
import Reports from './pages/Reports';
import Activity from './pages/Activity';
import SettingsPage from './pages/Settings';
import Returns from './pages/Returns';
import GiftCards from './pages/GiftCards';
import Webhooks from './pages/Webhooks';
import Locations from './pages/Locations';
import TaxZones from './pages/TaxZones';
import CurrencyRates from './pages/CurrencyRates';
import Staff from './pages/Staff';

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } } });

function Protected() {
  const { loading, me } = useAuth();
  if (loading) return <div className="h-full grid place-items-center"><Loading label="Starting up" /></div>;
  if (!me) return <Navigate to="/login" replace />;
  return (
    <>
      <Layout />
      {/* Global command palette — mounted outside Layout so it overlays
          everything and uses the same router context. */}
      <CommandPalette />
    </>
  );
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Protected />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/orders/new" element={<DraftOrder />} />
        <Route path="/orders/import-tracking" element={<ImportTracking />} />
        <Route path="/orders/:code" element={<OrderDetail />} />
        <Route path="/abandoned-carts" element={<AbandonedCarts />} />
        <Route path="/affiliates" element={<Affiliates />} />
        <Route path="/affiliates/:id" element={<AffiliateDetail />} />
        <Route path="/products" element={<Products />} />
        <Route path="/products/new" element={<ProductCreate />} />
        <Route path="/products/:id" element={<ProductDetail />} />
        <Route path="/collections" element={<Collections />} />
        <Route path="/collections/:id" element={<CollectionDetail />} />
        <Route path="/inventory" element={<Inventory />} />
        <Route path="/customers" element={<Customers />} />
        <Route path="/customers/:id" element={<CustomerDetail />} />
        <Route path="/discounts" element={<Discounts />} />
        <Route path="/marketing" element={<Marketing />} />
        <Route path="/blog" element={<Blog />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/activity" element={<Activity />} />
        <Route path="/returns" element={<Returns />} />
        <Route path="/gift-cards" element={<GiftCards />} />
        <Route path="/locations" element={<Locations />} />
        <Route path="/tax-zones" element={<TaxZones />} />
        <Route path="/currency-rates" element={<CurrencyRates />} />
        <Route path="/webhooks" element={<Webhooks />} />
        <Route path="/staff" element={<Staff />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <BrowserRouter>
          <ToastProvider>
            <App />
          </ToastProvider>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
