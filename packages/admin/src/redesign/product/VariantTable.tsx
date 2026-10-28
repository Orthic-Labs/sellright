import { Fragment, useState, type ReactNode } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import type { ProductDetail, VariantRow } from '../../api';
import { date as fmtDate } from '../../lib/format';
import { RowMenu } from './RowMenu';
import {
  availableOf, curField, curPre, curStock, dateToIso, fmt2, hasEdit, isInt, isMoney, missingCombos, orderedVariants, plural,
  type EditVal, type Edits, type Grid, type VariantErrors,
} from './model';

type Props = {
  p: ProductDetail;
  /** Effective edits only (differ from the server copy). */
  edits: Edits;
  grid: Grid | null;
  currencySymbol: string;
  errorsOf: (v: VariantRow) => VariantErrors;
  onEdit: (updates: [string, EditVal | undefined][]) => void;
  expanded: Set<string>;
  setExpanded: (next: Set<string>) => void;
  onDelete: (v: VariantRow) => void;
  onOffer: (aId: string, bId: string) => void;
  headerExtra?: ReactNode;
  footer?: ReactNode;
};

type Bulk = null | 'price' | 'sale' | 'stock';

export function VariantTable({ p, edits, grid, currencySymbol, errorsOf, onEdit, expanded, setExpanded, onDelete, onOffer, headerExtra, footer }: Props) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<Bulk>(null);
  const [bulkVal, setBulkVal] = useState('');
  const [bulkErr, setBulkErr] = useState('');

  const vars = orderedVariants(p, grid);
  const grouped = !!grid?.grouped;
  const set = (v: VariantRow, f: string, val: EditVal) => onEdit([[`${v.id}.${f}`, val]]);
  const nameOf = (v: VariantRow) => { const c = grid?.cells.get(v.id); return c ? `${c.a} · ${c.b}` : v.name; };
  const shortName = (v: VariantRow) => { const c = grid?.cells.get(v.id); return c ? (grouped ? c.b : `${c.a} · ${c.b}`) : v.name; };
  const toggleSel = (ids: string[], on: boolean) => { const n = new Set(sel); ids.forEach((i) => (on ? n.add(i) : n.delete(i))); setSel(n); };
  const picked = vars.filter((v) => sel.has(v.id));

  const totOnHand = vars.reduce((s, v) => s + curStock(p, edits, v), 0);
  const totHeld = vars.reduce((s, v) => s + v.allocated, 0);

  const applyBulk = () => {
    const v = bulkVal.trim();
    let msg = '';
    if (bulk === 'price' && (!isMoney(v) || !(Number(v) > 0))) msg = 'Enter a price above 0, like 40.00.';
    if (bulk === 'sale' && v !== '' && (!isMoney(v) || !(Number(v) > 0))) msg = 'Enter an amount, or leave empty to remove the sale price.';
    if (bulk === 'stock' && !isInt(v)) msg = 'Whole number, 0 or more.';
    if (msg) { setBulkErr(msg); return; }
    const f = bulk === 'price' ? 'price' : bulk === 'sale' ? 'sale' : 'oh';
    onEdit(picked.map((x) => [`${x.id}.${f}`, bulk === 'price' ? Number(v).toFixed(2) : v] as [string, EditVal]));
    setBulk(null); setBulkVal(''); setBulkErr('');
  };

  const mcell = (v: VariantRow, f: 'price' | 'sale', e: VariantErrors, label: string, ph?: string) => {
    const k = `${v.id}.${f}`;
    return (
      <div className={hasEdit(edits, k) ? 'chg' : undefined}>
        <div className="fx"><i>{currencySymbol}</i>
          <input className={`inp money${e[f] ? ' bad' : ''}`} value={curField(p, edits, v.id, f)} placeholder={ph} inputMode="decimal"
            aria-label={`${label}, ${nameOf(v)}`} aria-invalid={!!e[f]} aria-describedby={`e-${v.id}-${f}`} onChange={(ev) => set(v, f, ev.target.value)} />
        </div>
        <div className="err" id={`e-${v.id}-${f}`}>{e[f]}</div>
      </div>
    );
  };

  const row = (v: VariantRow) => {
    const e = errorsOf(v);
    const active = curField(p, edits, v.id, 'active');
    const pr = curPre(v, edits);
    const av = availableOf(p, edits, v);
    const full = nameOf(v);
    const shipLabel = pr?.date ? fmtDate(dateToIso(pr.date)) : null;
    const showPre = !!pr && (!grouped || expanded.has(grid!.cells.get(v.id)!.a));
    return (
      <Fragment key={v.id}>
        <tr data-vid={v.id} className={`${grouped ? 'child' : ''}${active ? '' : ' off'}`.trim() || undefined}>
          <td><input type="checkbox" className="cb" checked={sel.has(v.id)} aria-label={`Select ${full}`} onChange={(ev) => toggleSel([v.id], ev.target.checked)} /></td>
          <td className="vname">
            <b>{shortName(v)}</b>
            <span className="vsub">
              <span className="mono muted">{v.sku}</span>
              {pr && <span className="pill info">Pre-order{shipLabel ? ` · ships ${shipLabel}` : ''}</span>}
              {av <= 0 && !pr && <span className="pill bad">Out of stock</span>}
              {!active && <span className="pill neu">Hidden</span>}
            </span>
          </td>
          <td>{mcell(v, 'price', e, 'Price')}</td>
          <td>{mcell(v, 'sale', e, 'Sale price', 'None')}</td>
          <td>
            <div className={hasEdit(edits, `${v.id}.oh`) ? 'chg' : undefined}>
              <input className={`inp num${e.oh ? ' bad' : ''}`} style={{ width: 62 }} value={curField(p, edits, v.id, 'oh')} inputMode="numeric"
                aria-label={`On hand, ${full}`} aria-invalid={!!e.oh} aria-describedby={`e-${v.id}-oh`} onChange={(ev) => set(v, 'oh', ev.target.value)} />
              <div className="err" id={`e-${v.id}-oh`}>{e.oh}</div>
            </div>
          </td>
          <td className="num"><span className="avc"><b>{av}</b>{v.allocated > 0 && <small>{v.allocated} held</small>}</span></td>
          <td>
            <div className={hasEdit(edits, `${v.id}.active`) ? 'chg' : undefined}>
              <button type="button" role="switch" className={`stt${active ? ' on' : ''}`} aria-checked={active} onClick={() => set(v, 'active', !active)}><span className="sr-only">For sale, {full}: </span>{active ? 'Active' : 'Inactive'}</button>
            </div>
          </td>
          <td>
            <RowMenu label={`More for ${full}`} items={[
              pr
                ? { label: 'End pre-order', onClick: () => onEdit([[`${v.id}.pre`, null], [`${v.id}.pre_price`, undefined], [`${v.id}.pre_label`, undefined], [`${v.id}.pre_date`, undefined]]) }
                : { label: 'Start pre-order', onClick: () => { onEdit([[`${v.id}.pre`, { price: curField(p, edits, v.id, 'price'), label: '', date: '' }]]); if (grid?.grouped) setExpanded(new Set(expanded).add(grid.cells.get(v.id)!.a)); } },
              'sep',
              { label: 'Delete variant…', danger: true, onClick: () => onDelete(v) },
            ]} />
          </td>
        </tr>
        {showPre && pr && (
          <tr className="exp" data-pre={v.id}>
            <td />
            <td colSpan={7}>
              <div style={{ display: 'grid', gridTemplateColumns: '110px minmax(120px,1fr) 190px auto', gap: 10, alignItems: 'start' }}>
                <div className="fld">
                  <label htmlFor={`pp-${v.id}`}>Pre-order price</label>
                  <div className={hasEdit(edits, `${v.id}.pre_price`) ? 'chg' : undefined}>
                    <div className="fx"><i>{currencySymbol}</i><input id={`pp-${v.id}`} className={`inp money${e.pre_price ? ' bad' : ''}`} value={pr.price} inputMode="decimal" aria-invalid={!!e.pre_price} aria-describedby={`e-${v.id}-pre_price`} onChange={(ev) => set(v, 'pre_price', ev.target.value)} /></div>
                    <div className="err" id={`e-${v.id}-pre_price`}>{e.pre_price}</div>
                  </div>
                </div>
                <div className="fld">
                  <label htmlFor={`pl-${v.id}`}>Label on product page</label>
                  <div className={hasEdit(edits, `${v.id}.pre_label`) ? 'chg' : undefined}>
                    <input id={`pl-${v.id}`} className={`inp${e.pre_label ? ' bad' : ''}`} maxLength={255} value={pr.label} aria-invalid={!!e.pre_label} aria-describedby={`e-${v.id}-pre_label`} onChange={(ev) => set(v, 'pre_label', ev.target.value)} />
                    <div className="err" id={`e-${v.id}-pre_label`}>{e.pre_label}</div>
                  </div>
                </div>
                <div className="fld">
                  <label htmlFor={`pd-${v.id}`}>Ships on <span style={{ fontWeight: 400 }}>(UTC)</span></label>
                  <div className={hasEdit(edits, `${v.id}.pre_date`) ? 'chg' : undefined}>
                    <input id={`pd-${v.id}`} type="datetime-local" className={`inp${e.pre_date ? ' bad' : ''}`} value={pr.date} aria-invalid={!!e.pre_date} aria-describedby={`e-${v.id}-pre_date`} onChange={(ev) => set(v, 'pre_date', ev.target.value)} />
                    <div className="err" id={`e-${v.id}-pre_date`}>{e.pre_date}</div>
                  </div>
                </div>
                <button type="button" className="btn ghost sm" style={{ marginTop: 22 }}
                  onClick={() => onEdit([[`${v.id}.pre`, null], [`${v.id}.pre_price`, undefined], [`${v.id}.pre_label`, undefined], [`${v.id}.pre_date`, undefined]])}>End pre-order</button>
              </div>
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  const offRows = (onlyFirstId?: string) => {
    if (!grid) return null;
    return missingCombos(grid, vars, onlyFirstId).map(({ a, b }) => (
      <tr key={`off-${a.id}-${b.id}`} className="off">
        <td />
        <td colSpan={7}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {grouped ? b.value : `${a.value} · ${b.value}`} <span className="muted">· not offered</span>
            <button type="button" className="btn ghost sm" aria-label={`Offer ${a.value} · ${b.value}`} onClick={() => onOffer(a.id, b.id)}><Plus aria-hidden="true" />Offer</button>
          </span>
        </td>
      </tr>
    ));
  };

  const groupRow = (a: Grid['first']['options'][number]) => {
    const vs = vars.filter((v) => grid!.cells.get(v.id)!.aId === a.id);
    const open = expanded.has(a.value);
    const prices = [...new Set(vs.map((v) => curField(p, edits, v.id, 'price')))];
    const oh = vs.reduce((s, v) => s + curStock(p, edits, v), 0);
    const held = vs.reduce((s, v) => s + v.allocated, 0);
    const act = vs.filter((v) => curField(p, edits, v.id, 'active')).length;
    const dirtyG = vs.some((v) => Object.keys(edits).some((k) => k.startsWith(`${v.id}.`)));
    const err = vs.some((v) => Object.keys(errorsOf(v)).length > 0);
    const hasPre = vs.some((v) => !!curPre(v, edits));
    return (
      <tr key={`g-${a.id}`} className="grow" data-g={a.value}>
        <td><input type="checkbox" className="cb" aria-label={`Select all ${a.value}`} checked={vs.length > 0 && vs.every((v) => sel.has(v.id))} onChange={(ev) => toggleSel(vs.map((v) => v.id), ev.target.checked)} /></td>
        <td>
          <button type="button" className="gtog" aria-expanded={open} onClick={() => { const n = new Set(expanded); if (open) n.delete(a.value); else n.add(a.value); setExpanded(n); }}>
            <ChevronDown size={12} aria-hidden="true" />{a.value}<span className="muted">{plural(vs.length, grid!.second.name.toLowerCase())}</span>
            {hasPre && <span className="pill info">Pre-order</span>}
            {err && <span className="pill bad">Has errors</span>}
            {dirtyG && <span className="dirty" title="Has unsaved changes"><span className="sr" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Has unsaved changes</span></span>}
          </button>
        </td>
        <td className="muted">{prices.length > 1 ? 'Mixed' : prices[0] && isMoney(prices[0]) ? `${currencySymbol}${fmt2(Math.round(Number(prices[0]) * 100))}` : ''}</td>
        <td />
        <td className="num">{oh}</td>
        <td className="num"><span className="avc"><b>{oh - held}</b>{held > 0 && <small>{held} held</small>}</span></td>
        <td className="muted" style={{ fontSize: 12 }}>{act === vs.length ? 'All active' : `${act} of ${vs.length} active`}</td>
        <td />
      </tr>
    );
  };

  const body = grouped && grid
    ? grid.first.options.map((a) => (
      <Fragment key={a.id}>
        {groupRow(a)}
        {expanded.has(a.value) && <>{vars.filter((v) => grid.cells.get(v.id)!.aId === a.id).map(row)}{offRows(a.id)}</>}
      </Fragment>
    ))
    : <>{vars.map(row)}{offRows()}</>;

  return (
    <div className="card">
      <div className="ch">
        <h2>Variants</h2>
        <span className="muted" style={{ fontSize: 12 }} role="status">
          {plural(vars.length, 'variant')} · {totOnHand} on hand · {totHeld} held · <b style={{ color: 'rgb(var(--text))' }}>{totOnHand - totHeld} available</b>
        </span>
        <span className="sp" />
        {headerExtra}
      </div>
      {picked.length > 0 && (
        <div className="bulk" style={{ padding: '0 16px', flexWrap: 'wrap', height: 'auto', minHeight: 44 }} role="toolbar" aria-label="Bulk edit selected variants">
          <span>{picked.length} selected</span>
          <span className="sp" />
          {bulk ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <label htmlFor="bulk-val" style={{ fontWeight: 500 }}>{bulk === 'price' ? 'Price' : bulk === 'sale' ? 'Sale price (empty removes)' : 'On hand'}</label>
              <input id="bulk-val" className={`inp${bulkErr ? ' bad' : ''}`} style={{ width: 90, height: 26 }} value={bulkVal} autoFocus inputMode={bulk === 'stock' ? 'numeric' : 'decimal'} aria-invalid={!!bulkErr} aria-describedby="bulk-err"
                onChange={(e) => { setBulkVal(e.target.value); setBulkErr(''); }} onKeyDown={(e) => { if (e.key === 'Enter') applyBulk(); if (e.key === 'Escape') { setBulk(null); setBulkErr(''); } }} />
              <button type="button" className="btn sm pri" onClick={applyBulk}>Apply</button>
              <button type="button" className="btn ghost sm" onClick={() => { setBulk(null); setBulkErr(''); }}>Cancel</button>
              <span className="err" id="bulk-err" role="alert">{bulkErr}</span>
            </span>
          ) : (
            <>
              <button type="button" className="btn sm" onClick={() => { setBulk('price'); setBulkVal(''); }}>Set price…</button>
              <button type="button" className="btn sm" onClick={() => { setBulk('sale'); setBulkVal(''); }}>Set sale price…</button>
              <button type="button" className="btn sm" onClick={() => { setBulk('stock'); setBulkVal(''); }}>Set stock…</button>
              <button type="button" className="btn sm" onClick={() => onEdit(picked.map((x) => [`${x.id}.active`, false] as [string, EditVal]))}>Set inactive</button>
              <button type="button" className="btn ghost sm" onClick={() => setSel(new Set())}>Clear</button>
            </>
          )}
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table className="vt">
          <thead>
            <tr>
              <th style={{ width: 34 }}><input type="checkbox" className="cb" aria-label="Select all variants" checked={vars.length > 0 && vars.every((v) => sel.has(v.id))} onChange={(e) => toggleSel(vars.map((v) => v.id), e.target.checked)} /></th>
              <th>{grid ? `${grid.first.name} / ${grid.second.name}` : 'Variant'}</th>
              <th style={{ width: 96 }}>Price</th>
              <th style={{ width: 96 }}>Sale price</th>
              <th style={{ width: 78 }}>On hand</th>
              <th className="num" style={{ width: 76 }} title="On hand minus units held for paid orders not yet shipped">Available</th>
              <th style={{ width: 84 }}>Status</th>
              <th style={{ width: 34 }}><span hidden>Actions</span></th>
            </tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
      {footer}
      <div className="cfoot"><span className="muted">Available = on hand − units held for paid orders not yet shipped. Edited fields are tinted until you save; pre-order changes too. Variant SKUs cannot be changed after creation.</span></div>
    </div>
  );
}
