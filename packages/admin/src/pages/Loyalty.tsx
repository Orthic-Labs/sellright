import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { ErrorState, Field, FormSection, InlineAlert, Loading, PageHeader, Spinner } from '../components/ui';
import { money } from '../lib/format';
import { toLoyaltyForm as toForm, validateLoyaltyForm, type LoyaltyForm as Form, type LoyaltySettings } from '../lib/loyalty-form';

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
    onSuccess: (next) => { qc.setQueryData(key, next); setForm(toForm(next)); toast.success('Points program saved'); },
    onError: (e) => toast.error('Save failed', (e as Error).message),
  });

  if (isLoading || (!form && !error)) return <Loading />;
  if (error) return <ErrorState title="Couldn't load the points program" message={(error as Error).message} onRetry={() => qc.invalidateQueries({ queryKey: key })} />;
  if (!form) return null;

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: k === 'enabled' ? e.target.checked : e.target.value });
  const preview = validateLoyaltyForm(form).settings;
  const example = preview ? {
    earned: Math.floor(10000 * preview.earnRatePerDollar / 100),
    worth: Math.floor(Math.floor(10000 * preview.earnRatePerDollar / 100) * 100 / preview.pointsPerDollarOff),
  } : null;

  return (
    <>
      <PageHeader title="Points & rewards" subtitle="Customers earn points on paid orders and spend them for money off at checkout." />
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
          {formErr && <InlineAlert tone="critical">{formErr}</InlineAlert>}
          <div className="mt-3">
            <button className="btn-primary" disabled={save.isPending}>{save.isPending ? <Spinner className="text-white" /> : 'Save'}</button>
          </div>
        </FormSection>
      </form>
    </>
  );
}
