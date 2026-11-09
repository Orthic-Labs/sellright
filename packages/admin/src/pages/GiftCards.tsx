import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Loading, ErrorNote, PageHeader, EmptyState, Badge, Spinner } from '../components/ui';
import { useToast } from '../components/Toast';
import { useConfirmDialog } from '../components/ConfirmDialog';
import { parseMoney } from '../redesign/order-model';
import { parseSignedMoney } from './page-parsers';
import { money, date } from '../lib/format';

interface GiftCard {
  id: string;
  code: string;
  initialBalance: number;
  balance: number;
  enabled: boolean;
  expiresAt: string | null;
}

export default function GiftCardsPage() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const cur = store?.currency ?? 'USD';
  const toast = useToast();
  const { confirm, dialog: confirmDialog } = useConfirmDialog();

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ amount: '', code: '' });
  const [adjusting, setAdjusting] = useState<{ id: string; delta: string } | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [adjustErr, setAdjustErr] = useState<string | null>(null);

  const key = ['gift-cards', store?.slug];
  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ items: GiftCard[] }>('/gift-cards'),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: key });

  const issue = useMutation({
    mutationFn: () => {
      const cents = parseMoney(form.amount);
      if (cents === null || cents <= 0) return Promise.reject(new Error('Enter the amount as a plain number such as 25 or 25.00 (no commas or symbols).'));
      const body: { balance: number; code?: string } = { balance: cents };
      if (form.code.trim()) body.code = form.code.trim().toUpperCase();
      return api.post<{ id: string; code: string }>('/gift-cards', body);
    },
    onSuccess: (d) => { setForm({ amount: '', code: '' }); setShowForm(false); setFormErr(null); invalidate(); toast.success('Gift card issued', d.code); },
    onError: (e: Error) => { setFormErr(e.message); toast.error('Could not issue gift card', e.message); },
  });

  const toggle = useMutation({
    mutationFn: (gc: GiftCard) => api.patch<{ id: string; balance: number }>(`/gift-cards/${gc.id}`, { enabled: !gc.enabled }),
    onSuccess: (_d, gc) => { invalidate(); toast.success(gc.enabled ? 'Gift card disabled' : 'Gift card enabled', gc.code); },
    onError: (e: Error) => toast.error('Could not update gift card', e.message),
  });

  const adjust = useMutation({
    mutationFn: (delta: number) => {
      if (!adjusting) return Promise.reject(new Error('no card'));
      return api.patch<{ id: string; balance: number }>(`/gift-cards/${adjusting.id}`, { adjust: delta });
    },
    onSuccess: (d) => { setAdjusting(null); setAdjustErr(null); invalidate(); toast.success('Balance adjusted', `New balance ${money(d.balance, cur)}`); },
    onError: (e: Error) => { setAdjustErr(e.message); toast.error('Could not adjust balance', e.message); },
  });

  /** Validate, show the resulting balance and ask before the adjustment is sent. */
  const applyAdjust = async (gc: GiftCard) => {
    const delta = parseSignedMoney(adjusting?.delta ?? '');
    if (delta === null) { setAdjustErr('Enter the change as a plain amount such as +5.00 or -5.00 (no commas or symbols).'); return; }
    const next = gc.balance + delta;
    if (next < 0) { setAdjustErr(`That would take the balance below zero (${money(gc.balance, cur)} now).`); return; }
    setAdjustErr(null);
    const ok = await confirm({
      title: `Adjust balance of ${gc.code}?`,
      description: `${money(gc.balance, cur)} ${delta < 0 ? '-' : '+'} ${money(Math.abs(delta), cur)} = ${money(next, cur)}`,
      confirmLabel: 'Adjust balance',
    });
    if (ok) adjust.mutate(delta);
  };

  return (
    <>
      {confirmDialog}
      <PageHeader
        title="Gift Cards"
        subtitle="Issue and manage store gift cards."
        actions={
          <button className="btn-primary" onClick={() => { setShowForm((v) => !v); setFormErr(null); }}>
            <Plus size={16} /> Issue gift card
          </button>
        }
      />

      {showForm && (
        <form
          className="card p-4 mb-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); issue.mutate(); }}
        >
          <div>
            <label className="label">Amount</label>
            <input
              className="input w-28"
              inputMode="decimal"
              placeholder="25.00"
              value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              required
            />
          </div>
          <div>
            <label className="label">Code (optional)</label>
            <input
              className="input w-40"
              placeholder="Auto-generated"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          </div>
          <button
            className="btn-primary"
            disabled={parseMoney(form.amount) === null || !form.amount.trim() || issue.isPending}
          >
            {issue.isPending ? <Spinner className="text-white" /> : 'Issue'}
          </button>
        </form>
      )}
      {formErr && <div className="mb-4"><ErrorNote message={formErr} /></div>}

      <div className="card overflow-hidden">
        {isLoading ? (
          <Loading />
        ) : error ? (
          <ErrorNote message={(error as Error).message} />
        ) : !data || data.items.length === 0 ? (
          <EmptyState title="No gift cards yet" />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Code</th>
                <th className="th">Initial</th>
                <th className="th">Balance</th>
                <th className="th">Expires</th>
                <th className="th">Status</th>
                <th className="th">Adjust</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((gc) => (
                <tr key={gc.id} className="border-t border-gray-100">
                  <td className="td font-mono font-medium">{gc.code}</td>
                  <td className="td text-gray-500">{money(gc.initialBalance, cur)}</td>
                  <td className="td font-medium">{money(gc.balance, cur)}</td>
                  <td className="td text-gray-500">{date(gc.expiresAt)}</td>
                  <td className="td">
                    <button onClick={() => toggle.mutate(gc)} disabled={toggle.isPending} title="Toggle enabled" aria-label={`Gift card ${gc.code}: ${gc.enabled ? 'enabled' : 'disabled'}. Click to ${gc.enabled ? 'disable' : 'enable'}`} aria-pressed={gc.enabled}>
                      <Badge value={gc.enabled ? 'active' : 'draft'} />
                    </button>
                  </td>
                  <td className="td">
                    {adjusting?.id === gc.id ? (
                      <form
                        className="flex items-center gap-1"
                        onSubmit={(e) => { e.preventDefault(); void applyAdjust(gc); }}
                      >
                        <input
                          className="input w-24 text-sm"
                          inputMode="decimal"
                          placeholder="+5.00 or -5.00"
                          value={adjusting.delta}
                          onChange={(e) => setAdjusting({ id: gc.id, delta: e.target.value })}
                          autoFocus
                          aria-label={`Balance change for ${gc.code}`}
                        />
                        {(() => { const d = parseSignedMoney(adjusting.delta); return d !== null && <span className="text-xs text-gray-500 whitespace-nowrap">Balance after: {money(gc.balance + d, cur)}</span>; })()}
                        <button className="btn-primary text-xs px-2 py-1" disabled={adjust.isPending}>
                          {adjust.isPending ? <Spinner className="text-white" /> : 'Apply'}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost text-xs px-2 py-1"
                          onClick={() => { setAdjusting(null); setAdjustErr(null); }}
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <button
                        className="btn-ghost text-xs"
                        onClick={() => { setAdjusting({ id: gc.id, delta: '' }); setAdjustErr(null); }}
                      >
                        Adjust
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adjustErr && <div className="mt-2"><ErrorNote message={adjustErr} /></div>}
    </>
  );
}
