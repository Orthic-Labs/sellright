/** B2.8 real multipart image uploads & asset deletion. Test source only. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { env } from '../env.js';
import { slugifyCode } from '../lib/api-error.js';
import type { createAuthorizationFixtures } from './authorization-matrix.fixtures.testkit.js';
import { PRINCIPALS, type MatrixCase, type MatrixCell, type MatrixPrincipal, type MatrixProof, type PreparedMatrixCell } from './authorization-matrix.testkit.js';

type Fixture = Awaited<ReturnType<typeof createAuthorizationFixtures>>;
type Json = Record<string, any>;
export interface AssetControl { key: string; status: number; prepare(): Promise<PreparedMatrixCell> }
const deletionMessage = 'agents cannot delete — disable or trash instead; deletion needs a human';

function assetSource(f: Fixture) {
  const rows = async (sql: string, values: unknown[] = []) => (await f.queryStore(f.storeId, sql, values)).rows;
  const image = () => sharp({ create: { width: 4, height: 3, channels: 3, background: 'white' } });
  async function seedAsset() {
    const id = randomUUID(), path = `${f.storeSlug}/matrix/${id}.webp`, bytes = await image().webp({ quality: 85 }).toBuffer();
    await mkdir(dirname(join(env.ASSET_DIR, path)), { recursive: true });
    await writeFile(join(env.ASSET_DIR, path), bytes, { flag: 'wx' });
    await rows("INSERT INTO asset(id,store_id,type,path,width,height,alt) VALUES($1,$2,'image',$3,4,3,'Retained matrix image')", [id, f.storeId, path]);
    return { id, path, bytes };
  }
  async function seed() {
    const product = await f.seedProduct(), retained = await seedAsset(), target = await seedAsset();
    await rows('UPDATE product SET featured_asset_id=$1 WHERE id=$2', [retained.id, product.productId]);
    await rows('INSERT INTO product_asset(store_id,product_id,asset_id,position) VALUES($1,$2,$3,2)', [f.storeId, product.productId, retained.id]);
    await rows('INSERT INTO variant_asset(store_id,variant_id,asset_id,position) VALUES($1,$2,$3,3)', [f.storeId, product.variantId, retained.id]);
    return { ...product, retained, target };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;
  async function assertRetained(s: Seed, proof: MatrixProof) {
    proof.equal(await rows('SELECT store_id,type,path,width,height,alt FROM asset WHERE id=$1', [s.retained.id]),
      [{ store_id: f.storeId, type: 'image', path: s.retained.path, width: 4, height: 3, alt: 'Retained matrix image' }], 'existing associated image metadata retained', 'state');
    proof.equal(await rows('SELECT featured_asset_id FROM product WHERE id=$1', [s.productId]), [{ featured_asset_id: s.retained.id }], 'existing product featured image retained', 'state');
    proof.equal(await rows('SELECT asset_id,position FROM product_asset WHERE product_id=$1', [s.productId]), [{ asset_id: s.retained.id, position: 2 }], 'existing product gallery association retained', 'state');
    proof.equal(await rows('SELECT asset_id,position FROM variant_asset WHERE variant_id=$1', [s.variantId]), [{ asset_id: s.retained.id, position: 3 }], 'existing variant image association retained', 'state');
    proof.equal(await readFile(join(env.ASSET_DIR, s.retained.path)), s.retained.bytes, 'existing associated image bytes retained', 'state');
  }
  async function assertRemoved(path: string, proof: MatrixProof) {
    // Cleanup is deliberately post-commit & asynchronous; wait only for this known local file.
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await stat(join(env.ASSET_DIR, path)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        proof.equal((error as NodeJS.ErrnoException).code, 'ENOENT', 'committed deletion removes exactly target file', 'state');
        return;
      }
      await delay(10);
    }
    proof.ok(false, 'committed asset deletion must remove target file within bounded cleanup wait', 'state');
  }
  return { rows, image, seed, assertRetained, assertRemoved };
}

export function createAssetCases(f: Fixture): MatrixCase[] {
  const src = assetSource(f);
  return (['POST', 'DELETE'] as const).map((method): MatrixCase => {
    const key = method === 'POST' ? 'POST /v1/admin/assets' : 'DELETE /v1/admin/assets/{id}';
    const cells = {} as Record<MatrixPrincipal, MatrixCell>;
    for (const p of PRINCIPALS) {
      const allow = ['owner', 'manager', 'staff'].includes(p) || (p === 'agent' && method === 'POST');
      const status = allow ? method === 'POST' ? 201 : 200 : ['release_service', 'cache_token'].includes(p) ? 401 : 403;
      const message = p === 'foreign_store' ? `no access to store: ${f.storeSlug}` : p === 'read_only' ? "role 'read_only' is read-only"
        : p === 'agent' ? deletionMessage : p === 'cache_token' ? 'not authenticated' : 'invalid or expired session';
      const errorCode = p === 'agent' ? 'AGENT_NOT_ALLOWED' : status === 401
        ? p === 'release_service' && method === 'POST' ? 'INVALID_OR_EXPIRED_SESSION' : 'NOT_AUTHENTICATED' : slugifyCode(message);
      cells[p] = { effect: allow ? 'allow' : 'deny', status, ...(allow ? {} : { errorCode }), async prepare() {
        const s = await src.seed(), url = method === 'POST' ? '/v1/admin/assets' : `/v1/admin/assets/${s.target.id}`;
        const headers = { ...f.requestHeaders[p] };
        let form: FormData | undefined;
        if (method === 'POST') {
          delete headers['content-type']; // Request constructs its own real multipart boundary.
          form = new FormData();
          const png = await src.image().png().toBuffer();
          form.set('file', new File([Uint8Array.from(png)], 'synthetic-white.png', { type: 'image/png' }));
          form.set('alt', '  Synthetic uploaded white image  ');
        }
        return { url, init: { method, headers, ...(form ? { body: form } : {}) },
          ...(allow ? {} : { snapshot: f.snapshotFor(p, method, url, status, p === 'agent' ? 'delete' : undefined) }),
          async verify(response: Response, proof: MatrixProof) {
            const b = await response.json() as Json;
            if (!allow) {
              proof.equal(b.error?.code, errorCode, 'exact asset credential/store/role/hard-delete denial code');
              proof.equal(b.error?.message, message, 'exact asset credential/store/role/hard-delete denial message');
              await src.assertRetained(s, proof);
              proof.equal(await readFile(join(env.ASSET_DIR, s.target.path)), s.target.bytes, 'denied mutation retains actual target image', 'state');
              return;
            }
            if (method === 'POST') {
              proof.ok(typeof b.id === 'string' && /^[0-9a-f-]{36}$/.test(b.id), 'upload returns new asset UUID');
              proof.ok(typeof b.path === 'string' && b.path.startsWith(f.storeSlug + '/') && b.path.endsWith('.webp'), 'upload uses own-store private storage key');
              proof.equal(b, { id: b.id, path: b.path, url: '/assets/' + b.path, width: 4, height: 3, alt: 'Synthetic uploaded white image' }, 'exact normalized upload response');
              proof.equal(await src.rows('SELECT store_id,type,path,width,height,alt FROM asset WHERE id=$1', [b.id]),
                [{ store_id: f.storeId, type: 'image', path: b.path, width: 4, height: 3, alt: 'Synthetic uploaded white image' }], 'upload commits normalized image metadata in own store', 'state');
              const bytes = await readFile(join(env.ASSET_DIR, b.path));
              proof.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF', 'stored image has actual RIFF container', 'state');
              proof.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP', 'PNG upload was actually reencoded to WebP', 'state');
              const meta = await sharp(bytes).metadata();
              proof.equal({ format: meta.format, width: meta.width, height: meta.height }, { format: 'webp', width: 4, height: 3 }, 'persisted image decodes with expected MIME/dimensions', 'state');
              const decoded = await sharp(bytes).removeAlpha().raw().toBuffer();
              proof.equal(decoded.length, 4 * 3 * 3, 'persisted pixels have expected RGB extent', 'state');
              proof.ok(decoded.every(channel => channel >= 250), 'persisted pixels preserve genuine white image contents', 'state');
              proof.equal(await src.rows('SELECT product_id FROM product_asset WHERE asset_id=$1', [b.id]), [], 'upload alone does not attach new image to unrelated product', 'state');
              if (p === 'agent') proof.equal(await src.rows("SELECT action,(data->>'status')::int AS status FROM audit_log WHERE actor=$1 AND entity='agent' AND data->>'method'='POST' AND data->>'path'=$2 ORDER BY at DESC LIMIT 1", [f.identityFor('agent').email, url]),
                [{ action: 'request', status: 201 }], 'allowed agent upload receives durable attribution', 'state');
            } else {
              proof.equal(b, { ok: true }, 'exact successful deletion response');
              proof.equal(await src.rows('SELECT id FROM asset WHERE id=$1', [s.target.id]), [], 'unreferenced target row deletion committed', 'state');
              await src.assertRemoved(s.target.path, proof);
            }
            await src.assertRetained(s, proof);
          } };
      } };
    }
    return { key, contract: 'admin', cells };
  });
}

/** Business-rule control: genuine human credentials still preserve referenced image bytes. */
export function createAssetControls(f: Fixture): AssetControl[] {
  const src = assetSource(f);
  return [{ key: 'referenced product/variant image cannot be deleted', status: 409, async prepare() {
    const s = await src.seed(), url = `/v1/admin/assets/${s.retained.id}`;
    const snapshot = f.snapshotFor('owner', 'DELETE', url, 409), before = await snapshot();
    return { url, init: { method: 'DELETE', headers: f.requestHeaders.owner }, snapshot, async verify(response: Response, proof: MatrixProof) {
      const b = await response.json() as Json, message = 'asset is referenced by a product/variant/collection; remove the reference first';
      proof.equal(b.error?.code, slugifyCode(message), 'referenced image reports exact business-rule code');
      proof.equal(b.error?.message, message, 'referenced image reports exact refusal reason');
      proof.equal(await snapshot(), before, 'referenced deletion leaves complete domain/outbox/files/providers unchanged', 'state');
      await src.assertRetained(s, proof);
    } };
  } }];
}
