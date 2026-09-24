import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DEMO_SEED_PRODUCTS,ensureDemoSeedAssets} from './generate-demo-assets.mjs';

test('renders one webp per seeded demo product',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sellright-demo-assets-'));
  const written=await ensureDemoSeedAssets(dir);
  assert.equal(written.length,DEMO_SEED_PRODUCTS.length);
  for(const {slug} of DEMO_SEED_PRODUCTS){
    const path=join(dir,'demo-seed',`${slug}.webp`);
    const info=await stat(path);
    assert.ok(info.size>0,`${slug}.webp should be non-empty`);
    const bytes=await readFile(path);
    // RIFF....WEBP header — cheap sanity check without a decoder dependency.
    assert.equal(bytes.toString('ascii',0,4),'RIFF');
    assert.equal(bytes.toString('ascii',8,12),'WEBP');
  }
});

test('is deterministic — identical bytes across independent runs',async()=>{
  const dirA=await mkdtemp(join(tmpdir(),'sellright-demo-assets-a-'));
  const dirB=await mkdtemp(join(tmpdir(),'sellright-demo-assets-b-'));
  await ensureDemoSeedAssets(dirA);
  await ensureDemoSeedAssets(dirB);
  for(const {slug} of DEMO_SEED_PRODUCTS){
    const a=await readFile(join(dirA,'demo-seed',`${slug}.webp`));
    const b=await readFile(join(dirB,'demo-seed',`${slug}.webp`));
    assert.ok(a.equals(b),`${slug}.webp should be byte-identical across runs`);
  }
});

test('idempotent — never rewrites a file that already exists',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'sellright-demo-assets-c-'));
  await ensureDemoSeedAssets(dir);
  const path=join(dir,'demo-seed',`${DEMO_SEED_PRODUCTS[0].slug}.webp`);
  const before=await stat(path);
  const second=await ensureDemoSeedAssets(dir);
  assert.equal(second.length,0,'no files should be (re)written the second time');
  const after=await stat(path);
  assert.equal(before.mtimeMs,after.mtimeMs);
});
