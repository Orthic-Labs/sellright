import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, Spinner, InlineAlert } from '../components/ui';

// Small, deliberately incomplete country → currency default map (plan §1.5
// screen 2: "confirm country, currency and timezone — defaults come from the
// country"). Store has no country/timezone column (nothing in this codebase
// reads either), so this is a client-side convenience default for the
// currency field only — the owner can still change it, and can always revisit
// Settings later. Extend this list as real installs need more countries.
const COUNTRY_CURRENCY: Array<{ code: string; label: string; currency: string }> = [
  { code: 'US', label: 'United States', currency: 'USD' },
  { code: 'CA', label: 'Canada', currency: 'CAD' },
  { code: 'GB', label: 'United Kingdom', currency: 'GBP' },
  { code: 'AU', label: 'Australia', currency: 'AUD' },
  { code: 'DE', label: 'Germany', currency: 'EUR' },
  { code: 'FR', label: 'France', currency: 'EUR' },
  { code: 'IN', label: 'India', currency: 'INR' },
];

type Step = 'basics' | 'preview';

/**
 * Authenticated onboarding (plan §1.5), screens 2–3. Screen 1 (claim) is
 * Setup.tsx, which hands off here. Resumable: nothing here is required to
 * reach the dashboard — Layout always links here, and the dashboard
 * checklist covers everything else — so refreshing or leaving mid-flow loses
 * nothing.
 */
export default function Onboarding() {
  const { store, refresh } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('basics');

  const [name, setName] = useState(store?.name ?? '');
  const [country, setCountry] = useState('US');
  const [currency, setCurrency] = useState(store?.currency ?? 'USD');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ['onboarding-preview-token'],
    queryFn: () => api.post<{ token: string; previewUrl: string }>('/settings/preview-token'),
    enabled: step === 'preview',
  });

  if (!store) return <div className="h-full grid place-items-center"><Loading /></div>;

  async function saveBasics(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setSaving(true);
    try {
      await api.patch('/settings/store', { name, currency });
      await refresh();
      setStep('preview');
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-full grid place-items-center bg-[#f1f1f1] p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center gap-2 mb-6">
          <div className="h-7 w-7 rounded bg-brand" />
          <span className="text-lg font-semibold tracking-tight">SellRight</span>
        </div>
        <div className="card p-6">
          {step === 'basics' && (
            <form onSubmit={saveBasics} className="space-y-4">
              <div>
                <h1 className="text-base font-semibold">Name your store</h1>
                <p className="text-sm text-gray-500">You can change any of this later in Settings.</p>
              </div>
              {err && <div className="rounded-lg bg-danger-soft text-danger text-sm px-3 py-2 border border-danger/30">{err}</div>}
              <div>
                <label className="label">Store name</label>
                <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div>
                <label className="label">Country</label>
                <select
                  className="input"
                  value={country}
                  onChange={(e) => {
                    const code = e.target.value;
                    setCountry(code);
                    const match = COUNTRY_CURRENCY.find((c) => c.code === code);
                    if (match) setCurrency(match.currency);
                  }}
                >
                  {COUNTRY_CURRENCY.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Currency</label>
                <input className="input" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} required />
                <p className="text-xs text-gray-400 mt-1">Defaulted from country — change it if it's wrong.</p>
              </div>
              <button className="btn-primary w-full" disabled={saving}>
                {saving ? <Spinner className="text-white" /> : 'Continue'}
              </button>
            </form>
          )}

          {step === 'preview' && (
            <div className="space-y-4">
              <div>
                <h1 className="text-base font-semibold">Your storefront preview</h1>
                <p className="text-sm text-gray-500">Private until you publish — only people with this link can see it.</p>
              </div>
              {preview.isLoading && <Loading />}
              {preview.isError && <InlineAlert tone="critical">Couldn't issue a preview link: {(preview.error as Error).message}</InlineAlert>}
              {preview.data && (
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm break-all font-mono">
                  <a href={preview.data.previewUrl} target="_blank" rel="noreferrer" className="text-brand underline">{preview.data.previewUrl}</a>
                </div>
              )}
              <InlineAlert tone="info">
                The setup checklist on your dashboard covers everything else — products, domain, payments, email, shipping, tax, the recovery kit, and off-site backup. Publish once you're ready.
              </InlineAlert>
              <button className="btn-primary w-full" onClick={() => navigate('/', { replace: true })}>
                Go to dashboard
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
