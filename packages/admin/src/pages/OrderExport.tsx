// #381: Order Export, a 1:1 port of the previous admin's order-tools OrderExportPage (same flow, controls, order and copy;
// this admin's colours and fonts), with what Adrian asked for on top: one row per line item (default) or per order
// (line items kept as an Items column, never greyed out), XLSX (default) or CSV, column choice and order, and every
// setting remembered per admin on the server, with named presets.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { api, downloadExport } from '../api';
import { PageHeader } from '../components/ui';
import {
  DEFAULT_SETTINGS, DEFAULT_STATUSES, EXPORT_COLUMNS, EXPORT_STATUSES, LINE_ITEM_KEYS, exportQuery, moveColumn, normalizePresets, normalizeSettings,
  type ExportPreset, type ExportSettings,
} from '../lib/order-export';

const LAST_KEY = 'order-export.last';
const PRESETS_KEY = 'order-export.presets';
const LABEL = new Map<string, string>(EXPORT_COLUMNS.map((c) => [c.key, c.label]));

const SectionLabel = ({ children }: { children: string }) => <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-500 mb-2">{children}</div>;
const Divider = () => <hr className="my-[18px] border-gray-100" />;
const smallBtn = 'text-xs px-2 py-[3px] rounded border border-gray-300 bg-surface text-gray-600 hover:bg-surface-2';

export default function OrderExport() {
  const [s, setS] = useState<ExportSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [presets, setPresets] = useState<ExportPreset[]>([]);
  const [orderCount, setOrderCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [lastExport, setLastExport] = useState<{ filename: string; orders: number | null; rows: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshCount = useCallback(async (settings: ExportSettings) => {
    setCounting(true); setOrderCount(null);
    try {
      const r = await api.get<{ totalOrders: number }>(`/order-export/count?${exportQuery(settings, false)}`);
      setOrderCount(r.totalOrders);
    } catch (e) { setError((e as Error).message); } finally { setCounting(false); }
  }, []);

  // Restore what this admin last used (server-side), then count like the previous page did on load.
  useEffect(() => {
    void (async () => {
      let restored = DEFAULT_SETTINGS;
      try {
        const [last, saved] = await Promise.all([
          api.get<{ value: unknown }>(`/preferences/${LAST_KEY}`),
          api.get<{ value: unknown }>(`/preferences/${PRESETS_KEY}`),
        ]);
        if (last.value) restored = normalizeSettings(last.value);
        setPresets(normalizePresets(saved.value));
      } catch { /* defaults */ }
      setS(restored); setLoaded(true);
      void refreshCount(restored);
    })();
  }, [refreshCount]);

  // Remember every change for this admin (debounced; never blocks the page).
  useEffect(() => {
    if (!loaded) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void api.put(`/preferences/${LAST_KEY}`, { value: s }).catch(() => undefined); }, 600);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [s, loaded]);

  const update = (patch: Partial<ExportSettings>, resetCount = true) => { setS((prev) => ({ ...prev, ...patch })); if (resetCount) setOrderCount(null); };
  const toggleStatus = (val: string) => update({ statuses: s.statuses.includes(val) ? s.statuses.filter((x) => x !== val) : [...s.statuses, val] });

  async function handleExport() {
    setExporting(true); setError(null);
    try { setLastExport(await downloadExport(`/order-export?${exportQuery(s, true)}`)); }
    catch (e) { setError((e as Error).message); }
    finally { setExporting(false); }
  }

  async function savePresets(next: ExportPreset[]) {
    setPresets(next);
    try { await api.put(`/preferences/${PRESETS_KEY}`, { value: next }); } catch (e) { setError((e as Error).message); }
  }
  function saveAsPreset() {
    const name = window.prompt('Preset name:')?.trim();
    if (!name) return;
    void savePresets([...presets.filter((p) => p.name !== name), { name, settings: s }]);
  }

  const noColumns = !s.columns.some((c) => c.on);
  const canExport = s.statuses.length > 0 && !noColumns && !exporting;

  return (
    <div className="max-w-[1040px]">
      <PageHeader title="Order Export" subtitle="Export orders to Excel (XLSX) with optional date range and status filters." />

      <div className="card p-6 mb-4 text-sm">
        <SectionLabel>Date Range</SectionLabel>
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="text-sm font-medium text-gray-700 min-w-[36px]" htmlFor="ex-from">From</label>
          <input id="ex-from" type="date" className="input py-1.5! text-sm w-auto" value={s.fromDate} onChange={(e) => update({ fromDate: e.target.value })} />
          <label className="text-sm font-medium text-gray-700 min-w-[36px]" htmlFor="ex-to">To</label>
          <input id="ex-to" type="date" className="input py-1.5! text-sm w-auto" value={s.toDate} onChange={(e) => update({ toDate: e.target.value })} />
          <button className="btn-ghost" onClick={() => update({ fromDate: '', toDate: '' })}>Clear</button>
        </div>
        <Divider />

        <SectionLabel>Statuses</SectionLabel>
        <div className="flex gap-1.5 mb-2.5">
          <button className={smallBtn} onClick={() => update({ statuses: [...DEFAULT_STATUSES] })}>Open orders</button>
          <button className={smallBtn} onClick={() => update({ statuses: EXPORT_STATUSES.map((x) => x.value) })}>All</button>
          <button className={smallBtn} onClick={() => update({ statuses: [] })}>None</button>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-4 gap-y-1.5">
          {EXPORT_STATUSES.map(({ value, label }) => (
            <label key={value} className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" className="h-4 w-4 accent-brand" checked={s.statuses.includes(value)} onChange={() => toggleStatus(value)} />
              {label}
            </label>
          ))}
        </div>
        <Divider />

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <SectionLabel>Rows</SectionLabel>
            <label className="flex items-center gap-1.5 cursor-pointer mb-1"><input type="radio" name="ex-rows" className="accent-brand" checked={s.rows === 'line'} onChange={() => update({ rows: 'line' }, false)} /> One row per line item</label>
            <label className="flex items-center gap-1.5 cursor-pointer"><input type="radio" name="ex-rows" className="accent-brand" checked={s.rows === 'order'} onChange={() => update({ rows: 'order' }, false)} /> One row per order (items in one column)</label>
          </div>
          <div>
            <SectionLabel>Format</SectionLabel>
            <label className="flex items-center gap-1.5 cursor-pointer mb-1"><input type="radio" name="ex-fmt" className="accent-brand" checked={s.format === 'xlsx'} onChange={() => update({ format: 'xlsx' }, false)} /> Excel (XLSX)</label>
            <label className="flex items-center gap-1.5 cursor-pointer"><input type="radio" name="ex-fmt" className="accent-brand" checked={s.format === 'csv'} onChange={() => update({ format: 'csv' }, false)} /> CSV</label>
          </div>
        </div>
        <Divider />

        <SectionLabel>Columns</SectionLabel>
        <div className="flex gap-1.5 mb-2.5">
          <button className={smallBtn} onClick={() => update({ columns: s.columns.map((c) => ({ ...c, on: true })) }, false)}>All</button>
          <button className={smallBtn} onClick={() => update({ columns: s.columns.map((c) => ({ ...c, on: false })) }, false)}>None</button>
          <button className={smallBtn} onClick={() => update({ columns: DEFAULT_SETTINGS.columns }, false)}>Reset order</button>
        </div>
        <ol className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-x-4 gap-y-1">
          {s.columns.map((c, i) => (
            <li key={c.key} className="flex items-center gap-1.5">
              <input type="checkbox" className="h-4 w-4 accent-brand" id={`col-${c.key}`} checked={c.on}
                onChange={() => update({ columns: s.columns.map((x) => (x.key === c.key ? { ...x, on: !x.on } : x)) }, false)} />
              <label htmlFor={`col-${c.key}`} className="cursor-pointer flex-1 truncate">
                {LABEL.get(c.key)}{s.rows === 'order' && LINE_ITEM_KEYS.has(c.key) && <span className="text-xs text-gray-400"> (in Items)</span>}
              </label>
              <button className="p-0.5 text-gray-400 hover:text-ink disabled:opacity-30" aria-label={`Move ${LABEL.get(c.key)} up`} disabled={i === 0} onClick={() => update({ columns: moveColumn(s.columns, i, -1) }, false)}><ArrowUp size={13} /></button>
              <button className="p-0.5 text-gray-400 hover:text-ink disabled:opacity-30" aria-label={`Move ${LABEL.get(c.key)} down`} disabled={i === s.columns.length - 1} onClick={() => update({ columns: moveColumn(s.columns, i, 1) }, false)}><ArrowDown size={13} /></button>
            </li>
          ))}
        </ol>
        <Divider />

        <SectionLabel>Presets</SectionLabel>
        <div className="flex flex-wrap items-center gap-2.5">
          <select className="input py-1.5! text-sm w-auto" aria-label="Preset" value="" onChange={(e) => {
            const p = presets.find((x) => x.name === e.target.value); if (p) { setS(p.settings); setOrderCount(null); }
          }}>
            <option value="">{presets.length ? 'Apply a preset…' : 'No presets yet'}</option>
            {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
          <button className="btn-ghost" onClick={saveAsPreset}>Save as preset…</button>
          {presets.length > 0 && (
            <select className="input py-1.5! text-sm w-auto" aria-label="Delete preset" value="" onChange={(e) => { if (e.target.value) void savePresets(presets.filter((p) => p.name !== e.target.value)); }}>
              <option value="">Delete a preset…</option>
              {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          )}
          <span className="text-xs text-gray-400">Your settings are remembered for next time.</span>
        </div>
        <Divider />

        <div className="flex flex-wrap items-center gap-2.5 mb-3.5">
          <button className="btn-ghost" onClick={() => void refreshCount(s)} disabled={counting}>{counting ? 'Counting...' : 'Preview count'}</button>
          {orderCount !== null && <span className="text-sm text-gray-500"><span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-surface-2 text-gray-700">{orderCount}</span>{` order${orderCount !== 1 ? 's' : ''} match`}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button className="btn-primary" onClick={() => void handleExport()} disabled={!canExport}>{exporting ? 'Exporting...' : s.format === 'csv' ? 'Export CSV' : 'Export XLSX'}</button>
          {s.statuses.length === 0 && <span className="text-sm text-danger">Select at least one status</span>}
          {s.statuses.length > 0 && noColumns && <span className="text-sm text-danger">Select at least one column</span>}
        </div>
        {lastExport && <div className="border border-gray-200 rounded-lg p-3.5 mt-3 text-sm text-gray-600">{`Downloaded: ${lastExport.filename}${lastExport.orders !== null && lastExport.rows !== null ? ` — ${lastExport.orders} orders, ${lastExport.rows} rows` : ''}`}</div>}
        {error && <p role="alert" className="text-sm text-danger font-medium mt-3">{error}</p>}
      </div>
    </div>
  );
}
