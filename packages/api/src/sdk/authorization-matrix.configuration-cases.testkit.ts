/** Local configuration authorization contracts; no remote provider or listener. */
import { randomUUID } from 'node:crypto';
import { decryptSecret } from '../security/secret-crypto.js';
import { MATRIX_PROVIDER } from './authorization-matrix.transport.testkit.js';
import { DEFAULT_LOYALTY_SETTINGS } from '../money/loyalty.js';
import { invalidateStoreCache } from '../store-context.js';
import type { MatrixMutationFixture } from './authorization-matrix.mutation-cases.testkit.js';
import { PRINCIPALS, type MatrixCase, type MatrixCell, type MatrixPrincipal, type MatrixProof } from './authorization-matrix.testkit.js';

type Access = 'credentials' | 'email' | 'manage' | 'manage-only' | 'sheerid' | 'write';
type Prepared = { url: string; body: unknown; verify(response: Response, proof: MatrixProof): Promise<void> };
export function createConfigurationCases(fixture: MatrixMutationFixture): MatrixCase[] {
  const query = async (sql: string, values: unknown[] = []) => (await fixture.queryStore(fixture.storeId, sql, values)).rows;
  const config = async () => (await query('select config from store where id=$1', [fixture.storeId]))[0]!.config;
  const actor = (principal: MatrixPrincipal) => principal + '-' + fixture.storeSlug + '@matrix.invalid';
  const cases: MatrixCase[] = [];
  const add = (key: string, access: Access, prepare: (principal: MatrixPrincipal) => Promise<Prepared>) => {
    const method = key.split(' ')[0]!;
    const cell = (principal: MatrixPrincipal): MatrixCell => {
      const status = principal === 'release_service' || principal === 'cache_token' ? 401
        : principal === 'foreign_store' || principal === 'read_only' ? 403
        : principal === 'agent' && ['credentials', 'email', 'sheerid'].includes(access) ? 403
        : principal === 'manager' && access === 'email' ? 403
        : (principal === 'staff' || principal === 'agent') && access !== 'write' ? 403 : 200;
      const group = principal === 'agent' && ['credentials', 'email', 'sheerid'].includes(access) ? 'credentials' : undefined;
      return { effect: status === 200 ? 'allow' : 'deny', status, ...(group ? { errorCode: 'AGENT_NOT_ALLOWED' } : {}),
        async prepare() {
          const prepared = await prepare(principal);
          return { url: prepared.url, init: { method, headers: fixture.requestHeaders[principal], body: JSON.stringify(prepared.body) },
            ...(status === 200 ? {} : { snapshot: fixture.snapshotFor(principal, method, prepared.url, status, group) }),
            async verify(response: Response, proof: MatrixProof) {
              if (status === 200) return prepared.verify(response, proof);
              const body = await response.json() as any;
              if (status === 401) {
                proof.equal(body.error?.code, 'NOT_AUTHENTICATED', 'non-session credentials rejected');
                proof.ok(['not authenticated', 'invalid or expired session'].includes(body.error?.message), 'authentication reason');
              } else if (group) {
                proof.equal(body.error?.code, 'AGENT_NOT_ALLOWED', 'credential hard boundary');
                proof.equal(body.error?.message, 'agents cannot change credentials or payment/e-mail secrets', 'agent credential denial');
              } else {
                const role = principal === 'agent' ? 'staff' : principal;
                const message = principal === 'foreign_store' ? 'no access to store: ' + fixture.storeSlug
                  : principal === 'manager' && access === 'email' ? "role 'manager' cannot manage owner-level access"
                  : principal === 'read_only' && !['manage-only', 'sheerid'].includes(access) ? "role 'read_only' is read-only"
                  : "role '" + role + "' cannot manage settings/staff";
                proof.equal(body.error?.message, message, 'exact store/role authorization');
              }
            },
          };
        },
      };
    };
    cases.push({ key, contract: 'admin', cells: Object.fromEntries(PRINCIPALS.map(p => [p, cell(p)])) as Record<MatrixPrincipal, MatrixCell> });
  };
  add('PUT /v1/admin/payments/settings/{provider}/{mode}', 'credentials', async principal => {
    const secret = 'matrix-nmi-secret-' + randomUUID(), mode = 'test', field = 'securityKey';
    return { url: '/v1/admin/payments/settings/nmi/test', body: { fields: { securityKey: secret } }, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await response.json(), { ok: true }, 'secret update response');
      const rows = await query("select key_version,iv,ciphertext,auth_tag,last4,updated_by from store_secret where provider='nmi' and mode=$1 and field=$2", [mode, field]);
      proof.equal(rows.length, 1, 'one encrypted scoped secret', 'state');
      const row = rows[0]!;
      proof.equal(decryptSecret({ v: row.key_version, iv: row.iv, ct: row.ciphertext, tag: row.auth_tag }, 'store:' + fixture.storeId + ':nmi:test:securityKey'), secret, 'committed ciphertext authenticates exact synthetic secret', 'state');
      proof.equal({ last4: row.last4, updatedBy: row.updated_by }, { last4: secret.slice(-4), updatedBy: actor(principal) }, 'secret provenance', 'state');
      proof.ok(!JSON.stringify(row).includes(secret), 'no plaintext stored', 'state');
      const audits = await query("select actor,data from audit_log where entity='store_secret' and entity_id='nmi:test:securityKey' and data->>'last4'=$1", [secret.slice(-4)]);
      proof.equal(audits, [{ actor: actor(principal), data: { provider: 'nmi', mode: 'test', field, last4: secret.slice(-4) } }], 'secret audit contains no plaintext', 'state');
    } };
  });
  add('PUT /v1/admin/email/settings', 'email', async principal => {
    const credential = MATRIX_PROVIDER.smtpPassword, from = 'sender-' + randomUUID() + '@matrix.invalid';
    const body = { preset: 'custom', host: 'smtp.matrix.synthetic.invalid', port: 587, secure: false, user: MATRIX_PROVIDER.smtpUser, from, credential };
    return { url: '/v1/admin/email/settings', body, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await response.json(), { ok: true }, 'SMTP update response');
      proof.equal((await config()).email.smtp, { preset: 'custom', host: body.host, port: 587, secure: false, user: MATRIX_PROVIDER.smtpUser, from }, 'owner SMTP configuration committed', 'state');
      const rows = await query("select key_version,iv,ciphertext,auth_tag,last4,updated_by from store_secret where provider='smtp' and mode='default' and field='authCredential'");
      proof.equal(rows.length, 1, 'one SMTP credential', 'state');
      const row = rows[0]!;
      proof.equal(decryptSecret({ v: row.key_version, iv: row.iv, ct: row.ciphertext, tag: row.auth_tag }, 'store:' + fixture.storeId + ':smtp:default:authCredential'), credential, 'SMTP ciphertext bound to store purpose', 'state');
      proof.equal(row.updated_by, actor(principal), 'SMTP secret actor', 'state');
      proof.ok(!JSON.stringify(await config()).includes(credential), 'SMTP plaintext absent from public config', 'state');
    } };
  });
  add('PUT /v1/admin/loyalty/settings', 'manage', async () => {
    const body = { ...DEFAULT_LOYALTY_SETTINGS, enabled: true, earnRatePerDollar: 3, pointsPerDollarOff: 100, minRedeemPoints: 50, expiryDays: 30 };
    return { url: '/v1/admin/loyalty/settings', body, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await response.json(), body, 'exact saved loyalty program');
      proof.equal((await config()).loyalty, body, 'loyalty settings committed', 'state');
    } };
  });
  add('PATCH /v1/admin/sheerid/config', 'sheerid', async principal => {
    const programId = 'matrix-program-' + randomUUID(), body = { programId };
    return { url: '/v1/admin/sheerid/config', body, async verify(response: Response, proof: MatrixProof) {
      proof.equal(await response.json(), { ok: true }, 'SheerID update response');
      proof.equal((await config()).sheerid.programId, programId, 'SheerID program committed', 'state');
      proof.equal(await query("select actor,data from audit_log where action='sheerid_config' and data->>'programId'=$1", [programId]),
        [{ actor: actor(principal), data: { programId } }], 'SheerID update actor', 'state');
    } };
  });
  add('PATCH /v1/admin/seo/config', 'manage-only', async principal => {
    const siteUrl = 'https://seo-' + randomUUID() + '.matrix.invalid', body = { siteUrl, contactEmail: 'seo@matrix.invalid', organization: { name: 'Matrix Organization' } };
    return { url: '/v1/admin/seo/config', body, async verify(response: Response, proof: MatrixProof) {
      const result = await response.json() as any;
      proof.equal(result.siteUrl, siteUrl, 'SEO URL response');
      proof.equal(result.organization.name, body.organization.name, 'organization response');
      const saved = (await config()).seo;
      proof.equal({ siteUrl: saved.siteUrl, contactEmail: saved.contactEmail, name: saved.organization.name }, { siteUrl, contactEmail: body.contactEmail, name: body.organization.name }, 'SEO config committed', 'state');
      const audits = await query("select actor,to_state from audit_log where action='seo_config_updated' and entity_id=$1 order by at desc limit 1", [fixture.storeId]);
      proof.equal(audits[0]!.actor, actor(principal), 'SEO audit actor', 'state');
      proof.equal(JSON.parse(audits[0]!.to_state).siteUrl, siteUrl, 'SEO audit exact target', 'state');
    } };
  });
  add('POST /v1/admin/seo/sitemaps/refresh', 'write', async principal => {
    const siteUrl = 'https://sitemaps.matrix.invalid';
    await query("update store set config=jsonb_set(config,'{seo}',coalesce(config->'seo','{}') || $2::jsonb) where id=$1", [fixture.storeId, JSON.stringify({ siteUrl })]);
    invalidateStoreCache(fixture.storeSlug);
    const before = await query("select count(*)::int as count from audit_log where action='sitemaps_refreshed'");
    return { url: '/v1/admin/seo/sitemaps/refresh', body: { indexNow: false }, async verify(response: Response, proof: MatrixProof) {
      const body = await response.json() as any;
      proof.ok(body.totalUrls > 0, 'configured live sitemap has real URLs');
      proof.equal(body.cdn.configured, false, 'synthetic config has no CDN account');
      proof.equal(body.cdn.purged, false, 'no external CDN call required');
      proof.ok(body.cdn.urls.every((url: string) => url.startsWith(siteUrl + '/')), 'purge scope is configured store');
      proof.equal(body.indexNow, { attempted: false, submitted: 0, ok: null, status: null, error: null }, 'explicit no IndexNow request');
      const rows = await query("select actor,data from audit_log where action='sitemaps_refreshed' order by at desc limit 1");
      proof.equal(rows[0]!.actor, actor(principal), 'refresh actor', 'state');
      proof.equal(rows[0]!.data.totalUrls, body.totalUrls, 'generated URL count committed to audit', 'state');
      proof.equal((await query("select count(*)::int as count from audit_log where action='sitemaps_refreshed'"))[0]!.count, before[0]!.count + 1, 'one refresh audit committed', 'state');
    } };
  });
  return cases;
}
