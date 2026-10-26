import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, ExternalLink, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { dateTime } from '../lib/format';
import { describeRefresh, maskKey, seoSettingsPatch, validateIndexNowKey, validateSiteUrl, type RefreshResult } from '../lib/seo';
import { EmptyState, ErrorState, Field, FormSection, InlineAlert, KpiCard, Loading, PageHeader, Spinner } from '../components/ui';
import { seoDetailsForm, seoDetailsPatch, type SeoDetailsConfig, type SeoDetailsForm } from '../lib/seo-details';

interface SitemapFile { name: string; url: string; kind: string; count: number; urls: { loc: string; lastmod: string | null }[]; truncated: boolean }
interface Sitemaps { configured: boolean; siteUrl: string | null; indexUrl: string | null; totalUrls: number; files: SitemapFile[]; indexNowConfigured: boolean; cloudflareConfigured: boolean }

interface SeoConfig { siteUrl: string | null; indexNowKey: string | null; indexNowConfigured: boolean }

const KIND_LABEL: Record<string, string> = { main: 'Static pages', products: 'Products', collections: 'Collections', blog: 'Blog posts' };

/** Edit the two settings sitemaps depend on: the public site URL and the IndexNow key. */
function SeoSettingsCard({ onSaved }: { onSaved: () => void }) {
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const cfgKey = ['seo-config', store?.slug];
  const { data, isLoading, error } = useQuery({ queryKey: cfgKey, queryFn: () => api.get<SeoConfig>('/seo/config') });
  const [siteUrl, setSiteUrl] = useState('');
  const [indexNowKey, setIndexNowKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (data) { setSiteUrl(data.siteUrl ?? ''); setIndexNowKey(data.indexNowKey ?? ''); }
  }, [data]);

  const urlError = touched ? validateSiteUrl(siteUrl) : null;
  const keyError = touched ? validateIndexNowKey(indexNowKey) : null;
  const patch = data ? seoSettingsPatch(data, { siteUrl, indexNowKey }) : {};
  const dirty = Object.keys(patch).length > 0;
  const save = useMutation({
    mutationFn: () => api.patch<SeoConfig>('/seo/config', patch),
    onSuccess: (r) => { qc.setQueryData(cfgKey, r); onSaved(); toast.success('SEO settings saved'); },
    onError: (e) => toast.error('Could not save SEO settings', (e as Error).message),
  });

  return (
    <FormSection title="Site settings" description="The public address crawlers see, and the key that lets you notify search engines (IndexNow) when pages change."
      actions={<button className="btn-primary" form="seo-settings" disabled={!dirty || save.isPending || isLoading}>{save.isPending ? <Spinner className="text-white" /> : null} Save settings</button>}>
      {error ? <InlineAlert tone="critical" title="Could not load SEO settings">{(error as Error).message}</InlineAlert> : (
        <form id="seo-settings" className="stack-y-4" data-testid="seo-settings-form"
          onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!validateSiteUrl(siteUrl) && !validateIndexNowKey(indexNowKey)) save.mutate(); }}>
          <Field label="Site URL" htmlFor="seo-site-url" error={urlError} hint="Your storefront's public address, e.g. https://example.com. Leave blank to clear.">
            <input id="seo-site-url" data-testid="seo-site-url" className={`input ${urlError ? 'input-invalid' : ''}`} value={siteUrl} disabled={isLoading}
              onChange={(e) => setSiteUrl(e.target.value)} onBlur={() => setTouched(true)} placeholder="https://example.com" inputMode="url" />
          </Field>
          <Field label="IndexNow key" htmlFor="seo-indexnow-key" error={keyError} hint="8-128 hexadecimal characters. Search engines fetch it from /<key>.txt on your site. Leave blank to turn IndexNow off.">
            <div className="flex gap-2">
              {reveal
                ? <input id="seo-indexnow-key" data-testid="seo-indexnow-key" className={`input font-mono ${keyError ? 'input-invalid' : ''}`} value={indexNowKey} disabled={isLoading}
                    onChange={(e) => setIndexNowKey(e.target.value)} onBlur={() => setTouched(true)} autoComplete="off" spellCheck={false} />
                : <input id="seo-indexnow-key" data-testid="seo-indexnow-key" className="input font-mono" readOnly value={maskKey(indexNowKey)} placeholder="Not set" />}
              <button type="button" className="btn-ghost" aria-pressed={reveal} aria-label={reveal ? 'Hide IndexNow key' : 'Reveal IndexNow key to view or edit'} onClick={() => setReveal((v) => !v)}>
                {reveal ? <EyeOff size={15} /> : <Eye size={15} />} {reveal ? 'Hide' : 'Reveal'}
              </button>
            </div>
          </Field>
        </form>
      )}
    </FormSection>
  );
}

/** #388: the business facts behind search-result data (Organization, site search, shipping + returns on products). */
function SeoDetailsCard() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const cfgKey = ['seo-config', store?.slug];
  const { data, isLoading, error } = useQuery({ queryKey: cfgKey, queryFn: () => api.get<SeoDetailsConfig & SeoConfig>('/seo/config') });
  const [f, setF] = useState<SeoDetailsForm | null>(null);
  useEffect(() => { if (data) setF(seoDetailsForm(data)); }, [data]);
  const save = useMutation({
    mutationFn: () => api.patch<SeoDetailsConfig & SeoConfig>('/seo/config', seoDetailsPatch(f!)),
    onSuccess: (r) => { qc.setQueryData(cfgKey, r); toast.success('Business details saved'); },
    onError: (e) => toast.error('Could not save business details', (e as Error).message),
  });
  const set = (k: keyof SeoDetailsForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF((p) => (p ? { ...p, [k]: e.target.value } : p));
  const input = (k: keyof SeoDetailsForm, label: string, hint?: string, placeholder?: string) => (
    <Field label={label} htmlFor={`seo-${k}`} hint={hint}>
      <input id={`seo-${k}`} className="input" value={f ? String(f[k]) : ''} onChange={set(k)} disabled={!f} placeholder={placeholder} />
    </Field>
  );
  return (
    <FormSection title="Business details for search results" description="What search engines show about your store: who you are, how to reach you, and the shipping and return policy on product results."
      actions={<button className="btn-primary" form="seo-details" disabled={!f || save.isPending || isLoading}>{save.isPending ? <Spinner className="text-white" /> : null} Save details</button>}>
      {error ? <InlineAlert tone="critical" title="Could not load SEO settings">{(error as Error).message}</InlineAlert> : (
        <form id="seo-details" className="stack-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <div className="grid gap-4 sm:grid-cols-2">
            {input('name', 'Business name')}
            {input('telephone', 'Phone', undefined, '+1 555 0100')}
            {input('logo', 'Logo URL', 'An absolute https:// address.')}
            {input('image', 'Brand image URL', 'Shown when your site is shared; an absolute https:// address.')}
          </div>
          <Field label="Description" htmlFor="seo-description"><textarea id="seo-description" className="input min-h-[72px]" value={f?.description ?? ''} onChange={set('description')} disabled={!f} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            {input('founderName', 'Founder name')}
            {input('founderUrl', 'Founder page URL', 'Optional, e.g. your about page.')}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {input('street', 'Street address')}
            {input('city', 'City')}
            {input('region', 'State / region')}
            {input('postalCode', 'Postal code')}
            {input('country', 'Country', 'Two letters, e.g. US.')}
          </div>
          <Field label="Social profiles" htmlFor="seo-sameAs" hint="One https:// link per line (Instagram, Facebook, YouTube...).">
            <textarea id="seo-sameAs" className="input min-h-[72px] font-mono text-xs" value={f?.sameAs ?? ''} onChange={set('sameAs')} disabled={!f} />
          </Field>
          {input('searchPath', 'Search page path', 'The storefront page that searches products with ?q=, e.g. /shop. Leave blank if there is none.', '/shop')}
          <div className="grid gap-4 sm:grid-cols-3">
            {input('shipRate', 'Shipping price', 'e.g. 8.00 (0.00 = free). Leave blank to leave shipping out.', '8.00')}
            {input('shipCountry', 'Ships to (country)', 'Two letters, e.g. US.', 'US')}
            <div className="grid grid-cols-2 gap-2">{input('handlingMin', 'Handling min days')}{input('handlingMax', 'max')}</div>
            <div className="grid grid-cols-2 gap-2 sm:col-start-3">{input('transitMin', 'Transit min days')}{input('transitMax', 'max')}</div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {input('returnDays', 'Return window (days)', 'Leave blank to leave the return policy out.', '30')}
            {input('returnCountry', 'Returns from (country)', 'Two letters, e.g. US.', 'US')}
            <Field label="Return shipping paid by" htmlFor="seo-returnFees">
              <select id="seo-returnFees" className="input" value={f?.returnFees ?? 'customer'} onChange={set('returnFees')} disabled={!f}>
                <option value="customer">Customer</option><option value="free">Store (free returns)</option>
              </select>
            </Field>
          </div>
        </form>
      )}
    </FormSection>
  );
}

/** SEO: preview the generated sitemaps, then refresh the CDN copies / ping IndexNow (G11). */
export default function SeoPage() {
  const { store } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [indexNow, setIndexNow] = useState(false);
  const [result, setResult] = useState<RefreshResult | null>(null);

  const key = ['seo-sitemaps', store?.slug];
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: key, queryFn: () => api.get<Sitemaps>('/seo/sitemaps') });
  const refresh = useMutation({
    mutationFn: () => api.post<RefreshResult>('/seo/sitemaps/refresh', { indexNow }),
    onSuccess: (r) => { setResult(r); qc.invalidateQueries({ queryKey: key }); toast.success('Sitemaps refreshed'); },
    onError: (e) => toast.error('Refresh failed', (e as Error).message),
  });

  return (
    <>
      <PageHeader title="SEO" subtitle="Sitemaps are built live from your catalog, so crawlers always get current URLs"
        actions={
          <div className="flex items-center gap-3">
            <label className={`flex items-center gap-2 text-sm ${data?.indexNowConfigured ? '' : 'text-gray-400'}`} title={data?.indexNowConfigured ? undefined : 'Add an IndexNow key under Site settings to enable this'}>
              <input type="checkbox" checked={indexNow} disabled={!data?.indexNowConfigured} onChange={(e) => setIndexNow(e.target.checked)} /> Notify search engines (IndexNow)
            </label>
            <button className="btn-primary" disabled={!data?.configured || refresh.isPending} onClick={() => refresh.mutate()}>
              {refresh.isPending ? <Spinner className="text-white" /> : <RefreshCw size={15} />} Refresh sitemaps
            </button>
          </div>
        } />

      {isLoading ? <Loading /> : error ? <div className="card overflow-hidden"><ErrorState message={(error as Error).message} onRetry={() => refetch()} /></div> : data && (
        <div className="stack-y-5">
          <SeoSettingsCard onSaved={() => qc.invalidateQueries({ queryKey: key })} />
          <SeoDetailsCard />
          {!data.configured && <InlineAlert tone="attention" title="Site URL not set">Sitemaps need the store's public address. Enter it under Site settings below and this page will list every sitemap.</InlineAlert>}
          {result && <InlineAlert tone={result.indexNow.attempted && !result.indexNow.ok ? 'attention' : 'positive'} title="Refresh finished">{describeRefresh(result).map((l) => <div key={l}>{l}</div>)}</InlineAlert>}

          {data.configured && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <KpiCard label="Total URLs" value={<span className="tnum">{data.totalUrls}</span>} hint={`${data.files.length} sitemap file${data.files.length === 1 ? '' : 's'}`} />
                <KpiCard label="Index" value={<a className="inline-flex items-center gap-1 text-sm underline" href={data.indexUrl ?? '#'} target="_blank" rel="noreferrer">sitemap.xml <ExternalLink size={13} /></a>} hint={data.siteUrl ?? undefined} />
                <KpiCard label="CDN purge" value={data.cloudflareConfigured ? 'Configured' : 'Not configured'} hint="Cloudflare" />
                <KpiCard label="IndexNow" value={data.indexNowConfigured ? 'Configured' : 'Not configured'} />
              </div>
              {data.files.map((f) => (
                <FormSection key={f.name} title={`${KIND_LABEL[f.kind] ?? f.kind} · ${f.count} URL${f.count === 1 ? '' : 's'}`}
                  description={<a className="inline-flex items-center gap-1 underline" href={f.url} target="_blank" rel="noreferrer">{f.url} <ExternalLink size={11} /></a>}>
                  {f.urls.length === 0 ? <EmptyState title="No URLs" /> : (
                    <details>
                      <summary className="cursor-pointer text-sm text-gray-600">Show URLs{f.truncated ? ` (first ${f.urls.length} of ${f.count})` : ''}</summary>
                      <div className="mt-3 max-h-80 overflow-auto">
                        <table className="w-full"><thead><tr><th className="th">URL</th><th className="th">Last modified</th></tr></thead>
                          <tbody>{f.urls.map((u) => <tr key={u.loc} className="border-t border-gray-100"><td className="td font-mono text-xs break-all">{u.loc}</td><td className="td text-gray-500 whitespace-nowrap">{dateTime(u.lastmod)}</td></tr>)}</tbody>
                        </table>
                      </div>
                    </details>
                  )}
                </FormSection>
              ))}
              {isFetching && <span className="sr-only" role="status">Updating</span>}
            </>
          )}
        </div>
      )}
    </>
  );
}
