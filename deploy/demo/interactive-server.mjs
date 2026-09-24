import {createServer,request as httpRequest} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
import {createRequire} from 'node:module';
import {demoBindHost} from './policy.mjs';
import {interactiveRequest,interactiveBody,sameOriginMutation,demoAdminCredentials,demoRouteTarget,allowedDemoHost} from './interactive-policy.mjs';
import {assertInteractiveDatabase,visitorFor,provisionVisitor,removeVisitor,cleanVisitors,hash,scoped} from './visitors.mjs';
import {ensureDemoSeedAssets} from './generate-demo-assets.mjs';

// The generic Qwik storefront (packages/storefront), built root-mounted
// exactly like any other deployment and served as its own process — see
// deploy/demo/ecosystem.config.cjs (sellright-demo-storefront) and
// deploy/demo/run-storefront.mjs. It has no database access of its own;
// every /v1/* call it makes is same-origin and lands right back on THIS
// process, which is the only thing that can resolve a visitor cookie to a
// tenant. The admin SPA is what moved instead — see demoRouteTarget().
const STOREFRONT_PORT = Number(process.env.SELLRIGHT_STOREFRONT_PORT ?? 4311);

const database=new URL(process.env.DATABASE_URL??'');
if(database.pathname!=='/sellright_demo'||process.env.SELLRIGHT_DEMO!=='1'||process.env.SMTP_ENABLED!=='false'||process.env.JOBS_ENABLED!=='0')throw Error('Isolated demo configuration required');
for(const [key,value]of Object.entries(process.env))if(value&&/^(STRIPE_.*KEY|STRIPE_.*SECRET|SMTP_HOST|GMAIL_USER|EMAIL_PASS|APNS_KEY_P8|SOURCE_DATABASE_URL|GATEWAY_ACCOUNTS_JSON_FILE)$/.test(key))throw Error('External service configuration forbidden: '+key);
if(process.env.GATEWAY_ACCOUNTS_JSON&&process.env.GATEWAY_ACCOUNTS_JSON!=='[]')throw Error('Gateway accounts forbidden');
const {createApp}=await import('../../packages/api/dist/app.js');
const {pool,withStore,assertRuntimeRoleUnprivileged}=await import('../../packages/api/dist/db/client.js');
const schema=await import('../../packages/api/dist/db/schema.js');
const {applyPaymentResult}=await import('../../packages/api/dist/payments/settle.js');
const {env}=await import('../../packages/api/dist/env.js');
const assetDir=resolve(env.ASSET_DIR);
const require=createRequire(new URL('../../packages/api/package.json',import.meta.url));
const {eq,and,sql}=require('drizzle-orm');
// Shared synthetic product photography for the seeded demo catalog — not
// committed (repo hook blocks binary images), rendered on disk once per
// unique assetDir. Non-fatal: a rendering failure just leaves the built-in
// icon placeholder until the next successful boot, never blocks traffic.
await ensureDemoSeedAssets(assetDir).catch((error)=>{console.error('generate-demo-assets failed (non-fatal):',error);});
await assertRuntimeRoleUnprivileged();
await assertInteractiveDatabase(pool);
// The demo wrapper calls Hono in-process. No demo feature may make HTTP calls.
globalThis.fetch=async()=>{throw Error('Outbound HTTP is disabled in the isolated demo');};
const app=createApp();
const directory=resolve(fileURLToPath(new URL('.',import.meta.url)));
// dist-demo, not dist: the admin SPA is built specifically for this /admin
// mount (packages/admin/vite.config.ts SELLRIGHT_ADMIN_BASE_PATH=/admin).
// The legacy read-only fallback (server.mjs, `run.mjs --read-only`) keeps
// using the plain root-mounted packages/admin/dist, untouched.
const adminRoot=resolve(directory,'../../packages/admin/dist-demo');
// The old vanilla /shop demo (interactive-shop.html/js/css) is retired — the
// generic Qwik storefront (packages/storefront) owns /shop now. demo-admin.js
// is the only file this process still serves out of deploy/demo/ directly
// (the "Open storefront / Reset demo" banner injected into the admin SPA).
const assets=new Set(['demo-admin.js']);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2','.webp':'image/webp','.avif':'image/avif','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif'};
const cookies=header=>Object.fromEntries((header??'').split(';').map(s=>s.trim().split('=')));
let cleanupHealthy=true;
const traffic=new Map();
const locks=new Map();
async function serial(key,fn){const previous=locks.get(key)??Promise.resolve();let release;const pending=new Promise(r=>{release=r;});const chain=previous.then(()=>pending);locks.set(key,chain);await previous;try{return await fn();}finally{release();if(locks.get(key)===chain)locks.delete(key);}}
async function settle(visitor,code){
  return withStore(visitor.id,async tx=>{
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pay:${visitor.id}:${code}`},0))`);
    const [order]=await tx.select().from(schema.order).where(and(eq(schema.order.storeId,visitor.id),eq(schema.order.code,code))).for('update');
    if(!order)throw Error('Demo order missing');
    if(order.state!=='PendingPayment')return order.state;
    await tx.update(schema.order).set({metadata:{...order.metadata,syntheticDemo:true}}).where(eq(schema.order.id,order.id));
    const result=await applyPaymentResult(tx,{storeId:visitor.id,order,method:'manual',amount:order.grandTotal,result:{state:'Settled',providerRef:'demo:'+visitor.id+':'+order.id,metadata:{syntheticDemo:true}}});
    return result.orderState;
  });
}
const syntheticAddress={fullName:'Alex Morgan',line1:'1 Demo Avenue',city:'Sample City',province:'CA',postalCode:'90001',country:'US'};
async function call(visitor,path,method='GET',body,extra={}){
  return app.request(path,{method,headers:{'content-type':'application/json','x-store-slug':visitor.slug,'x-real-ip':visitor.id,...extra},body:body===undefined?undefined:JSON.stringify(body)});
}
async function seedOrders(visitor){
  for(let i=0;i<3;i++){
    const r=await call(visitor,'/v1/shop/checkout','POST',{items:[{sku:visitor.variants[i*2].sku,quantity:i+1}],email:'sample'+i+'@demo.invalid',shippingAddress:syntheticAddress,shippingMethodCode:'standard'},{'idempotency-key':'demo-seed-'+i});
    if(!r.ok)throw Error('Could not create sample order');
    const order=await r.json();await settle(visitor,order.code);
  }
}
async function provision(){
  return serial('provision',async()=>{
    const created=await provisionVisitor(pool);
    try{await seedOrders(created);return created;}
    catch(e){await removeVisitor(pool,created.id);throw e;}
  });
}
function setVisitorCookies(res,visitor,url){
  const flags='; Path=/; Max-Age=3600; SameSite=Strict'+(url.hostname==='demo.sellright.cc'?'; Secure':'');
  res.setHeader('Set-Cookie',[`sr_demo=${visitor.token}; HttpOnly${flags}`,`sr_admin=${visitor.token}; HttpOnly${flags}`,`sr_csrf=${visitor.csrf}${flags}`]);
}
// Reverse-proxy a document/asset request to the storefront process. Streams
// both directions (no buffering) and forwards every original header as-is —
// EXCEPT `cookie`, which is overridden with the resolved visitor's cookies
// (or dropped) so a just-provisioned visitor (no cookie on the original
// request yet — the browser hasn't seen the Set-Cookie response above this
// call) is visible to the storefront's own SSR fetches on THIS same request,
// not just the next one.
function proxyToStorefront(req,res,cookie){
  return new Promise((done,fail)=>{
    const headers={...req.headers,host:`127.0.0.1:${STOREFRONT_PORT}`};
    if(cookie===undefined)delete headers.cookie;else headers.cookie=cookie;
    const upstream=httpRequest({host:'127.0.0.1',port:STOREFRONT_PORT,path:req.url,method:req.method,headers},upstreamRes=>{
      res.writeHead(upstreamRes.statusCode??502,upstreamRes.headers);
      upstreamRes.pipe(res);
      upstreamRes.on('end',done);
      upstreamRes.on('error',fail);
    });
    upstream.on('error',fail);
    req.pipe(upstream);
  });
}
async function bounded(visitor){
  const result=await scoped(pool,visitor.id,async c=>(await c.query(`SELECT
    (SELECT count(*) FROM "order")::int AS orders,(SELECT count(*) FROM cart)::int AS carts,
    (SELECT count(*) FROM promotion)::int AS promotions,(SELECT count(*) FROM audit_log)::int AS changes,
    (SELECT count(*) FROM product)::int AS products,(SELECT count(*) FROM product_variant)::int AS variants`)).rows[0]);
  if(result.orders>=25||result.carts>=50||result.promotions>=25||result.changes>=250||result.products>=20||result.variants>=60)throw Error('This demo has reached its activity limit. Reset your demo to continue.');
}
await cleanVisitors(pool);
const listenHost=demoBindHost(process.env.DEMO_BIND_HOST);
// The storefront process's own SSR fetches (utils/sellright.ts `sr()`) call
// back into this same process over plain HTTP using whatever address this
// server is actually bound to — which, in the deployed topology, is the
// private nginx bridge IP (172.22.0.1), not loopback. Node's fetch sets the
// Host header from that literal address, so it must be in this allowlist too
// — it's exactly as trusted as 127.0.0.1/localhost (only reachable from this
// host or containers on the same private bridge, never from the internet;
// real public traffic always arrives with Host: demo.sellright.cc, which
// nginx sets explicitly regardless of what address it dialed).
const server=createServer(async(req,res)=>{
  res.setHeader('X-Robots-Tag','noindex, nofollow');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json=(status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  try{
    const url=new URL(req.url??'/','http://'+req.headers.host);
    if(!allowedDemoHost(url.hostname,listenHost))return json(403,{error:'Unknown demo host'});
    const method=req.method??'GET';const mutation=!['GET','HEAD'].includes(method);
    const key=req.socket.remoteAddress??'unknown';const minute=Math.floor(Date.now()/60000);
    if(traffic.size>2000)traffic.clear();
    const previous=traffic.get(key);const hits=previous?.minute===minute?previous.hits+1:1;
    traffic.set(key,{minute,hits});
    if(hits>1200)return json(429,{error:'Demo is busy. Please retry shortly.'});
    if(mutation&&!sameOriginMutation(req.headers,url.host))return json(403,{error:'Same-origin request required'});
    if(url.pathname==='/robots.txt'){res.end('User-agent: *\nDisallow: /\n');return;}
    if(url.pathname==='/v1/readyz'){
      const stores=await assertInteractiveDatabase(pool);
      return json(cleanupHealthy?200:503,{status:cleanupHealthy?'ok':'error',synthetic:true,interactiveAdmin:true,isolatedVisitors:true,activeVisitors:stores.length-1});
    }
    let visitor=await visitorFor(pool,cookies(req.headers.cookie).sr_demo);
    if(url.pathname==='/demo/session'&&method==='POST'){
      if(!visitor)visitor=await provision();
      if(visitor.csrf)setVisitorCookies(res,visitor,url);
      return json(200,{slug:visitor.slug,expiresAt:visitor.config.expiresAt});
    }
    if(url.pathname==='/demo/session'&&method==='GET')return json(visitor?200:401,visitor?{slug:visitor.slug,expiresAt:visitor.config.expiresAt}:{error:'Start a demo session'});
    // The published admin credential (README: "Demo login: admin / admin").
    // Exempt from the CSRF gate below for the same reason /demo/session is —
    // there is no session/CSRF token yet for a visitor who hasn't logged in.
    // A shared literal never crosses tenants: a correct guess always maps to
    // *the caller's own* fresh-or-existing sandbox (a new store on first use,
    // the same cookie-bound store on any later use from that browser), never
    // to another visitor's data, because visitor identity here comes only
    // from the still-httpOnly sr_admin cookie this response is about to set.
    if(url.pathname==='/v1/admin/login'&&method==='POST'){
      let body;{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>2000)return json(413,{error:'Request too large'});chunks.push(chunk);}
        try{body=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{return json(400,{error:'Invalid request body'});}}
      if(!demoAdminCredentials(body))return json(401,{error:'invalid email or password'});
      if(!visitor){visitor=await provision();setVisitorCookies(res,visitor,url);}
      return json(200,{token:visitor.token,csrfToken:visitor.csrf,admin:{email:'admin'},stores:[{storeId:visitor.id,slug:visitor.slug,name:'Everyday Supply',currency:'USD',role:'manager'}]});
    }
    const csrf=cookies(req.headers.cookie).sr_csrf;
    if(mutation&&(!visitor||!csrf||hash(csrf)!==visitor.config.csrfHash||req.headers['x-csrf-token']!==csrf))return json(403,{error:'Demo session or CSRF token is invalid'});
    if(url.pathname==='/demo/reset'&&method==='POST'){
      await serial(visitor.id,()=>removeVisitor(pool,visitor.id));
      res.setHeader('Set-Cookie',['sr_demo=; HttpOnly; Path=/; Max-Age=0','sr_admin=; HttpOnly; Path=/; Max-Age=0','sr_csrf=; Path=/; Max-Age=0']);
      return json(200,{reset:true});
    }
    if(url.pathname==='/v1/admin/logout'&&method==='POST'){
      res.setHeader('Set-Cookie',['sr_demo=; HttpOnly; Path=/; Max-Age=0','sr_admin=; HttpOnly; Path=/; Max-Age=0','sr_csrf=; Path=/; Max-Age=0']);
      return json(200,{ok:true});
    }
    if(url.pathname==='/enter'&&method==='GET'){res.writeHead(303,{location:'/admin'});res.end();return;}
    if(url.pathname.startsWith('/v1/')){
      if(!visitor)return json(401,{error:'Sign in with the demo admin/admin credentials, or open the storefront to start again.'});
      if(!interactiveRequest(method,url.pathname))return json(403,{error:'This operation is unavailable in the isolated demo'});
      let body;
      if(mutation){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>12000)return json(413,{error:'Request too large'});chunks.push(chunk);}body=JSON.parse(Buffer.concat(chunks).toString()||'{}');if(!interactiveBody(url.pathname,body))return json(400,{error:'Only bounded demo data is accepted'});}
      const execute=async()=>{
        if(mutation)await bounded(visitor);
        const headers={cookie:`sr_admin=${visitor.token}; sr_csrf=${csrf??''}`};
        if(csrf)headers['x-csrf-token']=csrf;
        if(req.headers['idempotency-key'])headers['idempotency-key']=String(req.headers['idempotency-key']).slice(0,100);
        if(url.pathname==='/v1/shop/cart/estimate'){
          const cartResponse=await call(visitor,'/v1/shop/cart/'+body.cartToken);
          if(!cartResponse.ok)return json(cartResponse.status,{error:'Demo cart not found'});
          const cart=await cartResponse.json();
          const shipping=await scoped(pool,visitor.id,async c=>(await c.query('SELECT calculator FROM shipping_method WHERE store_id=$1 AND code=$2',[visitor.id,body.shippingMethodCode])).rows[0]);
          if(!shipping)return json(400,{error:'Unknown delivery method'});
          body={items:cart.lines.map(line=>({sku:line.sku,quantity:line.quantity})),shipping:shipping.calculator.flat,couponCode:body.couponCode,shipCountry:'US'};
        }
        if(url.pathname==='/v1/shop/checkout'){
          if(!headers['idempotency-key'])return json(400,{error:'Checkout idempotency key required'});
          const cartResponse=await call(visitor,'/v1/shop/cart/'+body.cartToken);
          if(!cartResponse.ok)return json(cartResponse.status,{error:'Demo cart not found'});
          const cart=await cartResponse.json();
          body={...body,items:cart.lines.map(line=>({sku:line.sku,quantity:line.quantity})),email:'sample0@demo.invalid',shippingAddress:syntheticAddress};
        }
        const response=await call(visitor,url.pathname+url.search,method,body,headers);
        const data=await response.json();
        if(url.pathname==='/v1/shop/checkout'&&response.ok){data.state=await settle(visitor,data.code);data.simulated=true;}
        return json(response.status,data);
      };
      return await serial(visitor.id,execute);
    }
    if(mutation)return json(405,{error:'Method not allowed'});
    // Product/collection imagery. In a real (non-demo) deployment nginx
    // serves ASSET_DIR at /assets/<path> directly (see admin-assets.ts); this
    // demo's nginx vhost has no such rule (everything proxies to this
    // process, see sellright-demo.conf), and demoRouteTarget() would
    // otherwise send this straight to the storefront's own /assets/ (its
    // bundled CSS/JS chunks, a same-named but unrelated directory) where it
    // 404s. Handle it here instead, reading the same ASSET_DIR the in-process
    // app writes to.
    if(url.pathname.startsWith('/assets/')){
      const relative=url.pathname.slice('/assets/'.length);
      const file=resolve(assetDir,relative);
      if(!relative||!file.startsWith(assetDir+sep))return json(400,{error:'Invalid asset path'});
      try{
        const payload=await readFile(file);
        res.writeHead(200,{'content-type':mime[extname(file)]??'application/octet-stream','cache-control':'public, max-age=31536000, immutable'});
        res.end(method==='HEAD'?undefined:payload);
      }catch{return json(404,{error:'Not found'});}
      return;
    }
    const target=demoRouteTarget(url.pathname);
    if(target==='storefront'){
      // A first-time browser has no sr_demo cookie yet. Every /v1/* read the
      // storefront's SSR is about to make requires one (the `if(!visitor)`
      // 401 guard above, for any /v1/* path), so provision it now, on the
      // document request, before proxying — the old shop.js could get away
      // with client-side-only provisioning because it never rendered
      // anything server-side; Qwik's SSR can't defer that.
      // Only for document navigations (no file extension): asset requests
      // (/build/*.js etc.) never trigger an SSR data load and firing
      // provision() once per script tag would be wasteful and racy.
      if(!visitor&&!extname(url.pathname)){
        try{visitor=await provision();setVisitorCookies(res,visitor,url);}
        catch(e){return json(503,{error:e.message||'Could not start a demo session'});}
      }
      const forwardCookie=visitor?[`sr_demo=${visitor.token}`,`sr_admin=${visitor.token}`,`sr_csrf=${visitor.csrf}`].join('; '):undefined;
      try{return await proxyToStorefront(req,res,forwardCookie);}
      catch(e){console.error('Storefront proxy failed:',e.message);if(!res.headersSent)return json(502,{error:'Storefront is unavailable. Please retry shortly.'});res.end();return;}
    }
    // No forced bounce to /admin/login here: an unauthenticated visitor
    // hitting an admin path (e.g. `/admin`, `/admin/login`, `/enter`→`/admin`)
    // gets the ordinary static SPA shell. It calls GET /v1/admin/me, gets 401
    // below, and client-side routing (Protected → <Navigate to="/login">,
    // basename-relative) shows the demo-admin/admin login screen. No store
    // data is ever served pre-authentication.
    const root=target==='demo-asset'?directory:adminRoot;
    // The admin SPA is built with base '/admin/' (its OWN html/asset
    // references all carry that prefix — packages/admin/vite.config.ts
    // SELLRIGHT_ADMIN_BASE_PATH), but its files sit at adminRoot's TOP level
    // on disk, so /admin/* must have that prefix stripped before resolving;
    // demo-asset (demo-admin.js) has no such prefix to strip.
    const relative=target==='admin'?url.pathname.slice('/admin'.length).replace(/^\/+/,''):url.pathname.slice(1);
    let file=resolve(root,relative||'index.html');
    if(target==='demo-asset'&&!assets.has(relative))return json(404,{error:'Not found'});
    if(!file.startsWith(root+sep)&&file!==root)return json(403,{error:'Invalid path'});
    let payload;
    try{payload=await readFile(file);}catch{if(extname(url.pathname))return json(404,{error:'Not found'});file=resolve(root,'index.html');payload=await readFile(file);}
    if(target==='admin'&&extname(file)==='.html')payload=Buffer.from(payload.toString().replace('</head>','<script src="/demo-admin.js" defer></script></head>'));
    res.writeHead(200,{'content-type':mime[extname(file)]??'application/octet-stream'});res.end(method==='HEAD'?undefined:payload);
  }catch(e){console.error('Demo request failed:',e.message);if(!res.headersSent)json(400,{error:'Demo request failed. Reset your session if this persists.'});else res.end();}
});
server.requestTimeout=15000;server.headersTimeout=10000;
server.listen(Number(process.env.DEMO_PORT??4310),listenHost,()=>console.log('Interactive isolated demo ready'));
const cleanup=setInterval(async()=>{try{await serial('provision',async()=>{const stores=await assertInteractiveDatabase(pool);for(const s of stores)if(s.config.demoSession===1&&Date.parse(s.config.expiresAt)<=Date.now())await serial(s.id,()=>removeVisitor(pool,s.id));});cleanupHealthy=true;}catch{cleanupHealthy=false;console.error('Demo cleanup failed');}},60000);
cleanup.unref();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(cleanup);server.close(()=>void pool.end().then(()=>process.exit(0)));});
