import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Page, type ProductRow } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { ErrorState, Field, FormSection, InlineAlert, KpiCard, Loading, PageHeader, Spinner } from '../components/ui';
import { money } from '../lib/format';
import { toLoyaltyForm as toForm, validateLoyaltyForm, type LoyaltyForm as Form, type LoyaltySettings } from '../lib/loyalty-form';

interface Summary {
  enabled: boolean; currency: string; pointsPerDollarOff: number;
  issued: number; redeemed: number; restored: number; expired: number; removed: number;
  outstanding: number; liabilityCents: number; customersWithBalance: number;
  byKind: Array<{ kind: string; points: number; entries: number }>;
  last30Days: { issued: number; redeemed: number };
}

const KIND_LABEL: Record<string, string> = {
  earn: 'Earned on orders', bonus: 'Bonuses', adjust: 'Manual adjustments', import: 'Imported balances',
  redeem: 'Redeemed', reverse: 'Reversals and restores', expire: 'Expired',
};

function ProgramDashboard({ cur }: { cur: string }) {
  const { store } = useAuth();
  const { data, error } = useQuery({ queryKey: ['loyalty-summary', store?.slug], queryFn: () => api.get<Summary>('/loyalty/summary') });
  if (error) return <InlineAlert tone="critical">{(error as Error).message}</InlineAlert>;
  if (!data) return <Loading />;
  const n = (v: number) => v.toLocaleString();
  return (
    <div className="mb-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard label="Points issued" value={n(data.issued)} hint={`${n(data.last30Days.issued)} in the last 30 days`} />
        <KpiCard label="Points redeemed" value={n(data.redeemed)} hint={`${n(data.last30Days.redeemed)} in the last 30 days`} />
        <KpiCard label="Outstanding points" value={n(data.outstanding)} hint={`${n(data.customersWithBalance)} customers hold a balance`} />
        <KpiCard label="Liability" value={money(data.liabilityCents, cur)} hint={`${data.pointsPerDollarOff} points = ${money(100, cur)} off`} />
      </div>
      {data.byKind.length > 0 && (
        <table className="w-full text-sm mt-4">
          <thead><tr><th className="th">Source</th><th className="th text-right">Entries</th><th className="th text-right">Points</th></tr></thead>
          <tbody>
            {data.byKind.map((k) => (
              <tr key={k.kind} className="border-t border-gray-100">
                <td className="td">{KIND_LABEL[k.kind] ?? k.kind}</td>
                <td className="td text-right tnum">{n(k.entries)}</td>
                <td className={`td text-right tnum ${k.points < 0 ? 'text-critical' : ''}`}>{n(k.points)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-xs text-gray-500 mt-2">Liability is the cash value of every outstanding point at the current redemption rate. Expired points not yet written off are included until their next use.</p>
    </div>
  );
}

function MultiplierEditor({ form, setForm }: { form: Form; setForm: (f: Form) => void }) {
  const [q, setQ] = useState('');
  const { data: found } = useQuery({
    queryKey: ['loyalty-product-search', q], enabled: q.trim().length >= 2,
    queryFn: () => api.get<Page<ProductRow>>(`/products?${new URLSearchParams({ q, status: 'all', page: '1', pageSize: '6' })}`),
  });
  const { data: known } = useQuery({
    queryKey: ['loyalty-product-names'], enabled: form.productMultipliers.length > 0,
    queryFn: () => api.get<Page<ProductRow>>(`/products?${new URLSearchParams({ q: '', status: 'all', page: '1', pageSize: '100' })}`),
  });
  const nameOf = (id: string) => known?.items.find((p) => p.id === id)?.name ?? found?.items.find((p) => p.id === id)?.name ?? id;
  return (
    <div className="mt-2">
      {form.productMultipliers.length === 0 && <p className="text-sm text-gray-500">No multipliers set.</p>}
      {form.productMultipliers.map((m, i) => (
        <div key={m.productId} className="flex items-center gap-2 py-1">
          <span className="flex-1 text-sm truncate">{nameOf(m.productId)}</span>
          <input className="input w-20" inputMode="decimal" aria-label="Multiplier" value={m.multiplier}
            onChange={(e) => setForm({ ...form, productMultipliers: form.productMultipliers.map((x, j) => (j === i ? { ...x, multiplier: e.target.value } : x)) })} />
          <span className="text-sm text-gray-500">x points</span>
          <button type="button" className="btn-ghost text-xs" onClick={() => setForm({ ...form, productMultipliers: form.productMultipliers.filter((_, j) => j !== i) })}>Remove</button>
        </div>
      ))}
      <div className="mt-2">
        <input className="input" placeholder="Search a product to add" value={q} onChange={(e) => setQ(e.target.value)} />
        {found && q.trim().length >= 2 && (
          <ul className="border border-gray-200 rounded mt-1 divide-y divide-gray-100">
            {found.items.length === 0 && <li className="px-3 py-2 text-sm text-gray-500">No matches</li>}
            {found.items.filter((p) => !form.productMultipliers.some((m) => m.productId === p.id)).map((p) => (
              <li key={p.id}>
                <button type="button" className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                  onClick={() => { setForm({ ...form, productMultipliers: [...form.productMultipliers, { productId: p.id, multiplier: '2' }] }); setQ(''); }}>
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function LoyaltyPage() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const cur = store?.currency ?? 'USD';
  const key = ['loyalty-settings', store?.slug];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api.get<LoyaltySettings>('/loyalty/settings') });
  const [form, setForm] = useState<Form | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  useEffect(() => { if (data) setForm(toForm(data)); }, [data]);

  const save = useMutation({
    mutationFn: (settings: LoyaltySettings) => api.put<LoyaltySettings>('/loyalty/settings', settings),
    onSuccess: (next) => { qc.setQueryData(key, next); setForm(toForm(next)); qc.invalidateQueries({ queryKey: ['loyalty-summary'] }); toast.success('Points program saved'); },
    onError: (e) => toast.error('Save failed', (e as Error).message),
  });

  if (isLoading || (!form && !error)) return <Loading />;
  if (error) return <ErrorState title="Couldn't load the points program" message={(error as Error).message} onRetry={() => qc.invalidateQueries({ queryKey: key })} />;
  if (!form) return null;

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const preview = validateLoyaltyForm(form).settings;
  const example = preview ? {
    earned: Math.floor(10000 * preview.earnRatePerDollar / 100),
    worth: Math.floor(Math.floor(10000 * preview.earnRatePerDollar / 100) * 100 / preview.pointsPerDollarOff),
  } : null;
  const bonusField = (k: 'reviewBonusPoints' | 'signupBonusPoints' | 'firstOrderBonusPoints' | 'birthdayBonusPoints', label: string, hint: string) => (
    <Field label={label} hint={hint}>
      <input className="input" inputMode="numeric" value={form[k]} onChange={set(k)} />
    </Field>
  );

  return (
    <>
      <PageHeader title="Points & rewards" subtitle="Customers earn points on paid orders and spend them for money off at checkout." />
      <ProgramDashboard cur={cur} />
      <form onSubmit={(e) => {
        e.preventDefault();
        const v = validateLoyaltyForm(form);
        if (v.error) { setFormErr(v.error); return; }
        setFormErr(null);
        save.mutate(v.settings!);
      }}>
        <FormSection title="Program" description="Off by default. Turning it off stops new earning and redemption; existing balances are kept.">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.enabled} onChange={set('enabled')} /> Enable points program
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            <Field label="Points earned per $1" hint="On the order subtotal after discounts — never shipping or tax. Registered customers only; posted when the order is paid.">
              <input className="input" inputMode="numeric" value={form.earnRatePerDollar} onChange={set('earnRatePerDollar')} />
            </Field>
            <Field label="Points needed for $1 off" hint="Redemption is a discount applied before tax.">
              <input className="input" inputMode="numeric" value={form.pointsPerDollarOff} onChange={set('pointsPerDollarOff')} />
            </Field>
            <Field label="Minimum points per redemption">
              <input className="input" inputMode="numeric" value={form.minRedeemPoints} onChange={set('minRedeemPoints')} />
            </Field>
            <Field label="Maximum discount (% of subtotal)" hint="Blank = no cap.">
              <input className="input" inputMode="numeric" placeholder="No cap" value={form.maxRedeemPercentOfSubtotal} onChange={set('maxRedeemPercentOfSubtotal')} />
            </Field>
            <Field label="Points expire after (days)" hint="Blank = never. Applies to points earned after this is set.">
              <input className="input" inputMode="numeric" placeholder="Never" value={form.expiryDays} onChange={set('expiryDays')} />
            </Field>
          </div>
          {example && (
            <p className="text-sm text-gray-500 mt-3">
              Example: a {money(10000, cur)} order earns <span className="tnum font-medium text-ink">{example.earned}</span> points,
              worth {money(example.worth, cur)} off a later order.
            </p>
          )}
        </FormSection>

        <FormSection title="Bonus rules" description="Each bonus is granted once per trigger and can be reversed from the customer's page. Set a rule to 0 to turn it off. Bonuses only pay while the program is enabled.">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {bonusField('reviewBonusPoints', 'Review approved', 'Points when a product review is approved. Registered customers only.')}
            {bonusField('signupBonusPoints', 'Sign-up (verified email)', 'Paid once to customers who create an account after this is switched on.')}
            {bonusField('firstOrderBonusPoints', 'First paid order', 'Paid once, on a customer\'s first paid order. Customers with earlier orders never qualify.')}
            {bonusField('birthdayBonusPoints', 'Birthday', 'Paid once a year. Customers add their birthday (month and day) on their account page; it can\'t be changed by the customer.')}
          </div>
          <label className="flex items-center gap-2 text-sm mt-3">
            <input type="checkbox" checked={form.reviewBonusVerifiedOnly} onChange={set('reviewBonusVerifiedOnly')} /> Review bonus for verified buyers only
          </label>
        </FormSection>

        <FormSection title="Product multipliers" description="Earn extra points on chosen products. A 2x product earns double points on that product's share of the order (after discounts).">
          <MultiplierEditor form={form} setForm={setForm} />
        </FormSection>

        {formErr && <InlineAlert tone="critical">{formErr}</InlineAlert>}
        <div className="mt-3">
          <button className="btn-primary" disabled={save.isPending}>{save.isPending ? <Spinner className="text-white" /> : 'Save'}</button>
        </div>
      </form>
    </>
  );
}
