import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, ExternalLink, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';
import { dateTime } from '../lib/format';
import { describeRefresh, maskKey, seoSettingsPatch, validateIndexNowKey, validateSiteUrl, type RefreshResult } from '../lib/seo';
import { EmptyState, ErrorState, Field, FormSection, InlineAlert, KpiCard, Loading, PageHeader, Spinner } from '../components/ui';

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
        <form id="seo-settings" className="space-y-4" data-testid="seo-settings-form"
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
        <div className="space-y-5">
          <SeoSettingsCard onSaved={() => qc.invalidateQueries({ queryKey: key })} />
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
