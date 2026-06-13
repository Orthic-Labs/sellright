import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Image, Tag, Layers } from 'lucide-react';
import { api } from '../api';
import { PageHeader, Spinner, InlineAlert, FormSection, Field } from '../components/ui';

// Slugs are derived from the title unless the user overrides them.
const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export default function ProductCreate() {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [status, setStatus] = useState('draft');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const effectiveSlug = slugEdited ? slug : slugify(name);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const r = await api.post<{ id: string }>('/products', { name, slug: effectiveSlug || undefined, status, description: description || undefined });
      nav(`/products/${r.id}`);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Failed'); setBusy(false);
    }
  }

  return (
    <>
      <Link to="/products" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-ink mb-3"><ArrowLeft size={15} /> Products</Link>
      <PageHeader title="New product" />
      {err && <div className="mb-4"><InlineAlert tone="critical">{err}</InlineAlert></div>}

      <form onSubmit={submit} className="grid lg:grid-cols-[1fr_280px] gap-5 items-start">
        <div className="space-y-5">
          <FormSection title="Product information">
            <Field label="Title" htmlFor="p-name"><input id="p-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Anzu Fixed Blade" /></Field>
            <Field label="URL slug" htmlFor="p-slug" hint="Auto-generated from the title; edit to override.">
              <input id="p-slug" className="input font-mono text-xs" value={effectiveSlug} onChange={(e) => { setSlugEdited(true); setSlug(e.target.value); }} placeholder="anzu-fixed-blade" />
            </Field>
            <Field label="Description" htmlFor="p-desc"><textarea id="p-desc" className="input min-h-[140px]" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
          </FormSection>

          {/* What comes after create — set expectations honestly rather than fake fields. */}
          <div className="panel p-5">
            <div className="text-sm font-semibold mb-3">Next, on the product page</div>
            <ul className="space-y-2 text-sm text-gray-500">
              <li className="flex items-center gap-2"><Image size={15} className="text-gray-300" /> Add media and a featured image</li>
              <li className="flex items-center gap-2"><Tag size={15} className="text-gray-300" /> Set pricing and create variants</li>
              <li className="flex items-center gap-2"><Layers size={15} className="text-gray-300" /> Assign to collections and manage stock</li>
            </ul>
          </div>
        </div>

        <FormSection title="Publishing">
          <Field label="Status" htmlFor="p-status" hint={status === 'active' ? 'Visible on the storefront immediately.' : 'Hidden until you publish.'}>
            <select id="p-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="draft">Draft</option><option value="active">Active</option>
            </select>
          </Field>
          <button className="btn-primary w-full" disabled={busy || !name.trim()}>{busy ? <Spinner className="text-white" /> : 'Create product'}</button>
        </FormSection>
      </form>
    </>
  );
}
