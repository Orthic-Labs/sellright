import { useState } from 'react';
import { api } from '../../api';
import { useToast } from '../../components/Toast';
import { Dlg } from './Dlg';
import { wireMode, type FieldDef, type KeyMode, type ProviderDef, type VerifyResult } from './model';

/**
 * Add or replace one credential. The key is tested with the provider first; only a pass is saved. A rejection
 * leaves the saved key untouched and shows the reason inline. The typed value is never echoed back.
 */
export function KeyDialog({ def, mode, field, replacing, invalidate, onClose }: {
  def: ProviderDef; mode: KeyMode; field: FieldDef; replacing: boolean; invalidate: () => void; onClose: () => void;
}) {
  const toast = useToast();
  const [value, setValue] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const wire = wireMode(def.id, mode);

  const go = async () => {
    const v = value.trim();
    if (!v) { setErr('Paste the key first.'); return; }
    setBusy(true); setErr('');
    try {
      if (field.tested) {
        const r = await api.post<VerifyResult>(`/payments/settings/${def.id}/${wire}/verify`, { fields: { [field.key]: v } });
        if (r.tested !== 'candidate') {
          setErr(`This server can't test a key before saving it, so nothing was saved.${replacing ? ' Your current key is still in use.' : ''}`);
          return;
        }
        if (!r.ok) {
          setErr(`${def.name} rejected this key${r.error ? ` (${r.error})` : ''}.${replacing ? ' Your current key is still in use.' : ''} Check you copied all of it.`);
          return;
        }
      }
      await api.put(`/payments/settings/${def.id}/${wire}`, { fields: { [field.key]: v } });
      setValue('');
      invalidate();
      toast.success(`${field.label} saved`, `Ends in ${v.slice(-4)}.`);
      onClose();
    } catch (e) {
      setErr(`Couldn't ${field.tested ? 'test and ' : ''}save: ${(e as Error).message}${replacing ? ' Your current key is still in use.' : ''}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dlg open title={`${replacing ? 'Replace' : 'Add'} ${field.label.toLowerCase()}`} sub={`${def.name} · ${def.modeLabel[mode]}`} onClose={onClose} footer={
      <>
        <span className="sp" />
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn pri" onClick={() => void go()} disabled={busy}>{busy ? 'Testing…' : field.tested ? 'Test and save' : 'Save'}</button>
      </>
    }>
      <div className="fld">
        <label htmlFor="key-in">New {field.label.toLowerCase()}</label>
        <input id="key-in" className={`inp mono${err ? ' bad' : ''}`} type="password" autoComplete="off" spellCheck={false} autoFocus
          value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={!!err} aria-describedby="key-err key-hint"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void go(); } }} />
        <span className="err" id="key-err" role="alert">{err}</span>
        <span className="hint" id="key-hint">
          {field.tested ? `We test the key with ${def.name} before saving.` : 'Saved as entered. The connection test checks the other keys.'}
          {replacing ? ' Your current key stays in use until the new one is saved.' : ''}
        </span>
      </div>
    </Dlg>
  );
}
