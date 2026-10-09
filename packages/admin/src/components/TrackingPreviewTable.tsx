import { Badge } from './ui';
import { CARRIER_OPTIONS } from '../lib/carrier';
import { STATUS_LABEL, isImportable, itemsSummary, type PreviewRow } from '../lib/tracking';

/** Per-row dry-run verdicts: status, what ships, carrier override, did-you-mean correction. */
export default function TrackingPreviewTable({ rows, carrierOverrides, onCarrier, onUseSuggestion, disabled }: {
  rows: PreviewRow[];
  carrierOverrides: Record<number, string>;
  onCarrier: (index: number, carrier: string) => void;
  onUseSuggestion: (index: number, code: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth: '50rem' }}>
        <thead>
          <tr>
            <th className="th text-left w-10">#</th>
            <th className="th text-left">Order</th>
            <th className="th text-left">Tracking</th>
            <th className="th text-left w-36">Carrier</th>
            <th className="th text-left">Status</th>
            <th className="th text-left">Will ship</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const def = STATUS_LABEL[r.status];
            const ok = isImportable(r.status);
            const value = carrierOverrides[r.index] ?? '';
            const auto = r.carrierSource === 'detected' ? r.carrier : null;
            return (
              <tr key={r.index} className={ok ? '' : 'bg-surface-2/60'}>
                <td className="td text-gray-400 tnum">{r.index + 1}</td>
                <td className="td font-medium">{r.code || <span className="text-gray-400">(blank)</span>}</td>
                <td className="td font-mono text-xs break-all">{r.tracking || <span className="text-gray-400">(blank)</span>}</td>
                <td className="td">
                  <select aria-label={`Carrier for row ${r.index + 1}`} className="input !py-1 !text-xs" value={value} disabled={disabled || !ok} onChange={(e) => onCarrier(r.index, e.target.value)}>
                    <option value="">{auto ? `Auto: ${auto}` : r.carrierSource === 'given' ? `As given: ${r.carrier}` : 'Auto: unknown'}</option>
                    {CARRIER_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </td>
                <td className="td">
                  <Badge value={r.status} tone={def.tone} label={def.label} />
                  <div className="text-xs text-gray-500 mt-0.5">{r.message}</div>
                  {r.suggestion && (
                    <button className="btn-ghost btn-sm mt-1" disabled={disabled} onClick={() => onUseSuggestion(r.index, r.suggestion!)}>Use {r.suggestion}</button>
                  )}
                </td>
                <td className="td text-xs">{ok && r.items.length ? <span title={r.items.map((i) => `${i.quantity}× ${i.name}`).join('\n')}>{itemsSummary(r.items)}</span> : <span className="text-gray-400">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
