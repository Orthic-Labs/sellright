import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname,sep} from 'node:path';
import {createRequire} from 'node:module';
import {demoBindHost} from './policy.mjs';
import {interactiveRequest,interactiveBody,sameOriginMutation,demoAdminCredentials} from './interactive-policy.mjs';
import {assertInteractiveDatabase,visitorFor,provisionVisitor,removeVisitor,cleanVisitors,hash,scoped} from './visitors.mjs';

const database=new URL(process.env.DATABASE_URL??'');
if(database.pathname!=='/sellright_demo'||process.env.SELLRIGHT_DEMO!=='1'||process.env.SMTP_ENABLED!=='false'||process.env.JOBS_ENABLED!=='0')throw Error('Isolated demo configuration required');
for(const [key,value]of Object.entries(process.env))if(value&&/^(STRIPE_.*KEY|STRIPE_.*SECRET|SMTP_HOST|GMAIL_USER|EMAIL_PASS|APNS_KEY_P8|SOURCE_DATABASE_URL|GATEWAY_ACCOUNTS_JSON_FILE)$/.test(key))throw Error('External service configuration forbidden: '+key);
if(process.env.GATEWAY_ACCOUNTS_JSON&&process.env.GATEWAY_ACCOUNTS_JSON!=='[]')throw Error('Gateway accounts forbidden');
const {createApp}=await import('../../packages/api/dist/app.js');
const {pool,withStore,assertRuntimeRoleUnprivileged}=await import('../../packages/api/dist/db/client.js');
const schema=await import('../../packages/api/dist/db/schema.js');
const {applyPaymentResult}=await import('../../packages/api/dist/payments/settle.js');
const require=createRequire(new URL('../../packages/api/package.json',import.meta.url));
const {eq,and,sql}=require('drizzle-orm');
await assertRuntimeRoleUnprivileged();
await assertInteractiveDatabase(pool);
// The demo wrapper calls Hono in-process. No demo feature may make HTTP calls.
globalThis.fetch=async()=>{throw Error('Outbound HTTP is disabled in the isolated demo');};
const app=createApp();
const directory=resolve(fileURLToPath(new URL('.',import.meta.url)));
const adminRoot=resolve(directory,'../../packages/admin/dist');
const assets=new Set(['shop.js','shop.css','catalog.png','demo-admin.js']);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
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
async function bounded(visitor){
  const result=await scoped(pool,visitor.id,async c=>(await c.query(`SELECT
    (SELECT count(*) FROM "order")::int AS orders,(SELECT count(*) FROM cart)::int AS carts,
    (SELECT count(*) FROM promotion)::int AS promotions,(SELECT count(*) FROM audit_log)::int AS changes,
    (SELECT count(*) FROM product)::int AS products,(SELECT count(*) FROM product_variant)::int AS variants`)).rows[0]);
  if(result.orders>=25||result.carts>=50||result.promotions>=25||result.changes>=250||result.products>=20||result.variants>=60)throw Error('This demo has reached its activity limit. Reset your demo to continue.');
}
await cleanVisitors(pool);
const server=createServer(async(req,res)=>{
  res.setHeader('X-Robots-Tag','noindex, nofollow');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json=(status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
  try{
    const url=new URL(req.url??'/','http://'+req.headers.host);
    if(!['localhost','127.0.0.1','demo.sellright.cc'].includes(url.hostname))return json(403,{error:'Unknown demo host'});
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
    if(url.pathname==='/enter'&&method==='GET'){res.writeHead(303,{location:'/'});res.end();return;}
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
    const shop=url.pathname==='/shop'||url.pathname.startsWith('/shop/');
    // No forced bounce to /shop here: an unauthenticated visitor hitting an
    // admin path (e.g. `/`, `/login`, `/enter`→`/`) gets the ordinary static
    // SPA shell. It calls GET /v1/admin/me, gets 401 below, and client-side
    // routing (Protected → <Navigate to="/login">) shows the demo-admin/admin
    // login screen. No store data is ever served pre-authentication.
    const root=shop?directory:adminRoot;
    const relative=shop?url.pathname.slice(6):url.pathname.slice(1);
    let file=resolve(root,relative|| (shop?'interactive-shop.html':'index.html'));
    if(shop&&['shop.js','shop.css'].includes(relative))file=resolve(root,'interactive-'+relative);
    if(shop&&!assets.has(relative))file=resolve(root,'interactive-shop.html');
    if(!file.startsWith(root+sep)&&file!==root)return json(403,{error:'Invalid path'});
    let payload;
    try{payload=await readFile(file);}catch{if(extname(url.pathname))return json(404,{error:'Not found'});file=resolve(root,shop?'interactive-shop.html':'index.html');payload=await readFile(file);}
    if(!shop&&extname(file)==='.html')payload=Buffer.from(payload.toString().replace('</head>','<script src="/shop/demo-admin.js" defer></script></head>'));
    res.writeHead(200,{'content-type':mime[extname(file)]??'application/octet-stream'});res.end(method==='HEAD'?undefined:payload);
  }catch(e){console.error('Demo request failed:',e.message);if(!res.headersSent)json(400,{error:'Demo request failed. Reset your session if this persists.'});else res.end();}
});
server.requestTimeout=15000;server.headersTimeout=10000;
server.listen(Number(process.env.DEMO_PORT??4310),demoBindHost(process.env.DEMO_BIND_HOST),()=>console.log('Interactive isolated demo ready'));
const cleanup=setInterval(async()=>{try{await serial('provision',async()=>{const stores=await assertInteractiveDatabase(pool);for(const s of stores)if(s.config.demoSession===1&&Date.parse(s.config.expiresAt)<=Date.now())await serial(s.id,()=>removeVisitor(pool,s.id));});cleanupHealthy=true;}catch{cleanupHealthy=false;console.error('Demo cleanup failed');}},60000);
cleanup.unref();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(cleanup);server.close(()=>void pool.end().then(()=>process.exit(0)));});
