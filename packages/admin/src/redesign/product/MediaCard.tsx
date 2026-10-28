import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, X } from 'lucide-react';
import { api, assetUrl, uploadAsset, type ProductDetail } from '../../api';
import { useToast } from '../../components/Toast';
import { RowMenu } from './RowMenu';
import { plural } from './model';

type Tile = { assetId: string; path: string; main: boolean };
type Failed = { key: string; name: string; reason: string; file: File };

/**
 * Media actions save immediately (they are not staged with Save changes). The product PATCH for the main image
 * carries expectedUpdatedAt so it cannot silently overwrite someone else's save.
 */
export function MediaCard({ p, storeSlug, getExpected, onUpdated, isCurrent }: {
  p: ProductDetail; storeSlug?: string; getExpected: () => string | null; onUpdated: (iso: string) => void; isCurrent: () => boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Failed[]>([]);
  const pick = useRef<HTMLInputElement>(null);
  const replacing = useRef<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['product', storeSlug, p.id], refetchType: isCurrent() ? 'active' : 'none' });
  const patchMain = async (assetId: string | null) => {
    const r = await api.patch<{ id: string; updatedAt?: string }>(`/products/${p.id}`, { featuredAssetId: assetId, expectedUpdatedAt: getExpected() ?? undefined });
    if (r.updatedAt) onUpdated(r.updatedAt);
  };
  /** A store switch can land mid-request: stop before the next write or toast for the previous store. */
  const guard = () => { if (!isCurrent()) throw new Error('Store changed'); };
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { if (isCurrent()) toast.error(`${what} failed`, (e as Error).message); }
    finally { if (isCurrent()) setBusy(false); void refresh(); }
  };

  const inGallery = new Set(p.images.map((i) => i.assetId));
  const tiles: Tile[] = [];
  if (p.featuredAssetId) {
    const path = p.images.find((i) => i.assetId === p.featuredAssetId)?.path ?? p.assetPath;
    if (path) tiles.push({ assetId: p.featuredAssetId, path, main: true });
  }
  for (const i of p.images) if (i.assetId !== p.featuredAssetId) tiles.push({ assetId: i.assetId, path: i.path, main: false });

  const makeMain = (t: Tile) => run('Update', async () => { await patchMain(t.assetId); guard(); toast.success('Main image updated.'); });
  const remove = (t: Tile) => run('Remove', async () => {
    const wasGallery = inGallery.has(t.assetId);
    const position = p.images.find((i) => i.assetId === t.assetId)?.position;
    if (wasGallery) await api.del(`/products/${p.id}/assets/${t.assetId}`);
    guard();
    if (t.main) await patchMain(null);
    guard();
    toast.push({
      tone: 'info', title: 'Image removed.', ttl: 10000,
      action: {
        label: 'Undo',
        onClick: () => void run('Undo', async () => {
          if (wasGallery) await api.post(`/products/${p.id}/assets`, { assetId: t.assetId, position });
          guard();
          if (t.main) await patchMain(t.assetId);
        }),
      },
    });
  });

  const upload = async (file: File, replaceKey?: string) => {
    setBusy(true);
    try {
      const a = await uploadAsset(file);
      guard();
      await api.post(`/products/${p.id}/assets`, { assetId: a.id });
      guard();
      if (!p.featuredAssetId && tiles.length === 0) await patchMain(a.id);
      guard();
      if (replaceKey) setFailed((f) => f.filter((x) => x.key !== replaceKey));
      toast.success('Image added.');
    } catch (e) {
      if (!isCurrent()) return;
      const reason = (e as Error).message;
      setFailed((f) => (replaceKey ? f.map((x) => (x.key === replaceKey ? { ...x, reason, file } : x)) : [...f, { key: `${Date.now()}-${file.name}`, name: file.name, reason, file }]));
    } finally { if (isCurrent()) setBusy(false); void refresh(); }
  };

  return (
    <div className="card">
      <div className="ch"><h2>Media</h2><span className="muted" style={{ fontSize: 12 }}>{plural(tiles.length, 'image')}</span></div>
      <div className="cb-body">
        <div className="media" aria-busy={busy}>
          {tiles.map((t, i) => (
            <div key={t.assetId} className={`tile${i === 0 ? ' big' : ''}`} role="group" aria-label={`Image ${i + 1}${t.main ? ', main image' : ''}`}>
              <img src={assetUrl(t.path) ?? `/assets/${t.path}`} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
              {t.main && <span className="badge">Main</span>}
              <RowMenu label={`Actions for image ${i + 1}`}
                style={{ position: 'absolute', right: 4, top: 4, width: 24, height: 24, background: 'rgb(var(--surface))', border: '1px solid rgb(var(--text-subtle))' }}
                items={[{ label: 'Make main image', disabled: t.main || busy, onClick: () => void makeMain(t) }, 'sep', { label: 'Remove image', danger: true, disabled: busy, onClick: () => void remove(t) }]} />
            </div>
          ))}
          <button type="button" className="tile add" disabled={busy} onClick={() => { replacing.current = null; pick.current?.click(); }}>
            <Plus size={16} aria-hidden="true" /><span>Add</span>
          </button>
        </div>
        <input ref={pick} type="file" accept="image/*" hidden aria-label="Choose an image to upload"
          onChange={(e) => { const f = e.target.files?.[0]; const key = replacing.current; e.currentTarget.value = ''; replacing.current = null; if (f) void upload(f, key ?? undefined); }} />
        {failed.map((f) => (
          <div key={f.key} className="note w" style={{ marginTop: 8 }} role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            <span style={{ flex: 1 }}><b>{f.name} didn't upload.</b> {f.reason}</span>
            <button type="button" className="btn sm" disabled={busy} onClick={() => { replacing.current = f.key; pick.current?.click(); }}>Replace</button>
            <button type="button" className="iconbtn" style={{ width: 26, height: 26 }} aria-label={`Dismiss failed upload ${f.name}`} onClick={() => setFailed((x) => x.filter((y) => y.key !== f.key))}><X size={12} aria-hidden="true" /></button>
          </div>
        ))}
        <div className="hint" style={{ marginTop: 8 }}>The main image is the one customers see in lists and search. Media changes save straight away, not with Save changes.</div>
      </div>
    </div>
  );
}
