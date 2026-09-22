import {randomUUID, randomBytes, createHash} from 'node:crypto';
import {demoStoreId} from './safety.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
const quoted = name => {
  if (!/^[a-z_]+$/.test(name)) throw Error('Unexpected demo schema identifier');
  return '"' + name + '"';
};
export async function scoped(pool, storeId, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL statement_timeout = '10000ms'");
    await c.query("SELECT set_config('app.current_store',$1,true)", [storeId]);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
export async function assertInteractiveDatabase(pool) {
  const {rows} = await pool.query('SELECT id,slug,config FROM store');
  if (!rows.some(s => s.id === demoStoreId && s.slug === 'demo' && s.config?.demo === true)) throw Error('Missing demo baseline');
  for (const s of rows) {
    if (s.config?.demo !== true || Object.values(s.config.payments ?? {}).some(Boolean)) throw Error('Unsafe demo store');
    if (s.id !== demoStoreId && (!/^demo-v-[a-f0-9]{32}$/.test(s.slug) || s.config.demoSession !== 1 || !Number.isFinite(Date.parse(s.config.expiresAt)))) throw Error('Unexpected demo tenant');
  }
  return rows;
}
export async function visitorFor(pool, token) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) return null;
  const {rows:[row]} = await pool.query(`SELECT s.id,s.slug,s.config,a.id AS admin_id,se.expires_at
    FROM session se JOIN admin_user a ON a.id=se.admin_user_id
    JOIN admin_user_store m ON m.admin_user_id=a.id JOIN store s ON s.id=m.store_id
    WHERE se.token_hash=$1 AND se.expires_at>now() AND s.config->>'demoSession'='1'`, [hash(token)]);
  if (!row || Date.parse(row.config.expiresAt) <= Date.now()) return null;
  return {...row, token};
}
export async function provisionVisitor(pool) {
  const id = randomUUID(); const slug = 'demo-v-' + id.replaceAll('-', '');
  const token = randomBytes(32).toString('hex'); const csrf = randomBytes(24).toString('hex');
  const adminId = randomUUID(); const expiresAt = new Date(Date.now() + 3600000).toISOString();
  const data = await scoped(pool, id, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('demo-visitor-capacity',0))");
    const {rows:[count]} = await c.query("SELECT count(*)::int AS n FROM store WHERE config->>'demoSession'='1'");
    if (count.n >= 40) throw Error('Demo is at capacity. Please try again shortly.');
    await c.query('INSERT INTO store(id,slug,name,currency,config) VALUES($1,$2,$3,$4,$5)', [id,slug,'Everyday Supply','USD',{
      demo:true,demoSession:1,expiresAt,adminId,csrfHash:hash(csrf),storefrontUrl:'https://demo.sellright.cc/shop',
      payments:{stripe:false,nmi:false,sezzle:false,cod:false,manual:false},
    }]);
    await c.query('INSERT INTO admin_user(id,email) VALUES($1,$2)',[adminId,slug+'@demo.invalid']);
    await c.query("INSERT INTO admin_user_store(admin_user_id,store_id,role) VALUES($1,$2,'manager')",[adminId,id]);
    await c.query('INSERT INTO session(admin_user_id,token_hash,expires_at) VALUES($1,$2,$3)',[adminId,hash(token),expiresAt]);
    const categories = new Map();
    for (const [name,code] of [['Desk & Paper','desk'],['Everyday Carry','carry'],['At Home','home']]) {
      const {rows:[collection]} = await c.query('INSERT INTO collection(store_id,slug,name,description) VALUES($1,$2,$3,$4) RETURNING id',[id,code,name,'Considered essentials for everyday rituals.']);
      categories.set(code,collection.id);
    }
    const products = [
      ['Studio Notebook','studio-notebook','NOTEBOOK',1800,'desk','Lay-flat pages, a cloth cover and room for the next idea.','Sage','Ink'],
      ['Everyday Tote','everyday-tote','TOTE',2400,'carry','A generous cotton carryall with an inside pocket and comfortable handles.','Natural','Ink'],
      ['Stoneware Cup','stoneware-cup','CUP',2200,'home','A quietly sculptural cup with a soft matte glaze. Holds 300 ml.','Cloud','Slate'],
      ['Desk Tray','desk-tray','TRAY',3200,'desk','Keep keys, pens and daily essentials in one considered place.','Rose','Stone'],
    ];
    const variants=[];
    for(const [i,[name,productSlug,sku,price,category,description,...colors]] of products.entries()) {
      const {rows:[p]}=await c.query("INSERT INTO product(store_id,slug,name,status,description,product_type,tags) VALUES($1,$2,$3,'active',$4,$5,$6) RETURNING id",[id,productSlug,name,description,category,['demo',category]]);
      await c.query('INSERT INTO collection_product(store_id,collection_id,product_id,position) VALUES($1,$2,$3,$4)',[id,categories.get(category),p.id,i]);
      for(const [n,color] of colors.entries()) {
        const {rows:[v]}=await c.query(`INSERT INTO product_variant(store_id,product_id,sku,name,price,fulfillment_type,weight_g)
          VALUES($1,$2,$3,$4,$5,'physical',200) RETURNING id`,[id,p.id,'DEMO-'+sku+(n?'-ALT':''),name+' / '+color,price+n*200]);
        await c.query('INSERT INTO stock(store_id,variant_id,on_hand) VALUES($1,$2,$3)',[id,v.id,24+i*8]);
        variants.push({...v,sku:'DEMO-'+sku+(n?'-ALT':''),name:name+' / '+color,price:price+n*200});
      }
    }
    await c.query("INSERT INTO shipping_method(store_id,code,name,calculator) VALUES($1,'standard','Standard delivery','{\"flat\":500}'),($1,'express','Express delivery','{\"flat\":1200}')",[id]);
    await c.query("INSERT INTO promotion(store_id,code,type,value,enabled) VALUES($1,'WELCOME10','percentage',10,true)",[id]);
    const customers=[];
    for(const [i,name] of ['Alex Morgan','Jamie Lee','Sam Rivera'].entries()) {
      const {rows:[customer]}=await c.query('INSERT INTO customer(store_id,email,first_name,last_name) VALUES($1,$2,$3,$4) RETURNING id',[id,'sample'+i+'@demo.invalid',name.split(' ')[0],name.split(' ')[1]]);
      customers.push(customer.id);
    }
    return {variants,customers};
  });
  return {id,slug,token,csrf,admin_id:adminId,config:{demo:true,demoSession:1,expiresAt,adminId,csrfHash:hash(csrf)},...data};
}

export function deletionOrder(tables, edges) {
  const left=new Set(tables); const result=[];
  while(left.size) {
    const leaves=[...left].filter(parent=>!edges.some(([child,target])=>target===parent&&child!==parent&&left.has(child)));
    if(!leaves.length)throw Error('Demo cleanup schema has a dependency cycle');
    result.push(...leaves);leaves.forEach(t=>left.delete(t));
  }
  return result;
}
export async function removeVisitor(pool, id) {
  if(id===demoStoreId)throw Error('Cannot remove baseline');
  return scoped(pool,id,async c=>{
    const {rows:[store]}=await c.query('SELECT slug,config FROM store WHERE id=$1 FOR UPDATE',[id]);
    if(!store)return;
    if(store.config?.demoSession!==1||store.config.demo!==true||!/^demo-v-[a-f0-9]{32}$/.test(store.slug))throw Error('Refusing non-visitor cleanup');
    const {rows:columns}=await c.query("SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='store_id'");
    const {rows:foreign}=await c.query(`SELECT a.relname AS child,b.relname AS parent FROM pg_constraint f
      JOIN pg_class a ON a.oid=f.conrelid JOIN pg_class b ON b.oid=f.confrelid
      WHERE f.contype='f' AND f.connamespace='public'::regnamespace`);
    const tables=deletionOrder(columns.map(r=>r.table_name),foreign.map(r=>[r.child,r.parent]));
    await c.query('DELETE FROM session WHERE admin_user_id=$1',[store.config.adminId]);
    for(const table of tables)await c.query('DELETE FROM '+quoted(table)+' WHERE store_id=$1',[id]);
    await c.query('DELETE FROM admin_user WHERE id=$1 AND email=$2',[store.config.adminId,store.slug+'@demo.invalid']);
    await c.query('DELETE FROM store WHERE id=$1',[id]);
  });
}
export async function cleanVisitors(pool) {
  const stores=await assertInteractiveDatabase(pool);
  for(const s of stores)if(s.config.demoSession===1&&Date.parse(s.config.expiresAt)<=Date.now())await removeVisitor(pool,s.id);
}
