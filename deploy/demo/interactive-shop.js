const $=id=>document.getElementById(id);
const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n/100);
const photos={'studio-notebook':'notebook','everyday-tote':'tote','stoneware-cup':'cup','desk-tray':'tray'};
let cart=null,busy=false;
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
const link=(label,href,cls)=>{const n=el('a',label,cls);n.href=href;return n;};
const button=(label,run,cls='button')=>{const n=el('button',label,cls);n.addEventListener('click',()=>action(run));return n;};
function photo(slug,name){const p=el('div',null,'photo '+(photos[slug]??'notebook'));p.role='img';p.setAttribute('aria-label',name);return p;}
function csrf(){return document.cookie.split('; ').find(s=>s.startsWith('sr_csrf='))?.slice(8)??'';}
async function request(path,body,method='POST',extra={}){
  const r=await fetch(path,{method:body===undefined?'GET':method,headers:{'content-type':'application/json','x-csrf-token':csrf(),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json();if(!r.ok){if(r.status===409&&data.cart)cart=data.cart;throw Error(data.error??'Please try again.');}return data;
}
function error(message){$('error').hidden=!message;$('error').textContent=message??'';}
async function action(fn){if(busy)return;busy=true;error();document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(e){error(e.message);}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=b.dataset.unavailable==='1');}}
function count(){$('count').textContent=(cart?.lines??[]).reduce((n,l)=>n+l.quantity,0);}
async function quantity(sku,n){
  if(n>10)throw Error('Maximum 10 per item in the sample store.');
  if(!cart||cart.status!=='active'){cart=await request('/v1/shop/cart',{items:[{sku,quantity:n}]});localStorage.setItem('sellright-demo-cart',cart.token);}
  else cart=await request('/v1/shop/cart/'+cart.token+'/lines',{lines:[{sku,quantity:n}],expectedRevision:cart.revision},'PATCH');
  count();
}
async function navigate(path){history.pushState({},'',path);await render();window.scrollTo(0,0);}
function heading(title,eyebrow){const h=el('div',null,'heading');if(eyebrow)h.append(el('p',eyebrow,'eyebrow'));h.append(el('h1',title));return h;}
async function catalog(category){
  const data=await request('/v1/shop/catalog/products');
  const categories={desk:'Desk & Paper',home:'At Home',carry:'Everyday Carry'};
  const products=category?data.items.filter(p=>p.tags?.includes(category)):data.items;
  const section=el('section',null,'catalog');section.append(heading(category?categories[category]??'Collection':'Everyday essentials',category?'THE COLLECTION':'EVERYDAY SUPPLY'));
  const controls=el('div',null,'catalog-controls');
  const search=el('input');search.type='search';search.placeholder='Find something good';search.setAttribute('aria-label','Search products');
  const sort=el('select');sort.setAttribute('aria-label','Sort products');for(const [v,t]of [['featured','Featured'],['price','Price: low to high'],['name','Name']]){const o=el('option',t);o.value=v;sort.append(o);}controls.append(search,sort);section.append(controls);
  const grid=el('div',null,'products');section.append(grid);
  function paint(){grid.replaceChildren();let list=products.filter(p=>p.name.toLowerCase().includes(search.value.toLowerCase()));if(sort.value==='price')list.sort((a,b)=>a.minPrice-b.minPrice);if(sort.value==='name')list.sort((a,b)=>a.name.localeCompare(b.name));
    for(const p of list){const card=el('article',null,'product');const a=link('', '/shop/product/'+p.slug);a.append(photo(p.slug,p.name));const info=el('div',null,'product-info');info.append(link(p.name,'/shop/product/'+p.slug),el('span',money(p.minPrice)));card.append(a,info,el('p',p.inStock?'Two finishes / In stock':'Currently unavailable','muted'));grid.append(card);}if(!list.length)grid.append(el('p','No products match your search.','empty'));}
  search.addEventListener('input',paint);sort.addEventListener('change',paint);paint();return section;
}
async function product(slug){
  const p=await request('/v1/shop/catalog/products/'+encodeURIComponent(slug));
  const section=el('section',null,'product-detail');section.append(photo(slug,p.name));
  const info=el('div',null,'detail-copy');info.append(link('All goods','/shop','muted'),heading(p.name,'EVERYDAY SUPPLY'));
  const price=el('p',null,'detail-price');const select=el('select');select.setAttribute('aria-label','Choose finish');
  for(const v of p.variants){const option=el('option',v.name);option.value=v.sku;select.append(option);}
  const selected=()=>p.variants.find(v=>v.sku===select.value);const availability=el('p',null,'stock-note');
  const add=button('Add to bag',async()=>{const v=selected();if(v.enabled===false)throw Error('This finish is currently unavailable.');await quantity(v.sku,(cart?.lines.find(l=>l.sku===v.sku)?.quantity??0)+1);await navigate('/shop/cart');});
  const refresh=()=>{price.textContent=money(selected().salePrice??selected().price);const unavailable=selected().enabled===false;availability.textContent=unavailable?'Currently unavailable':'Available in the sample store';add.disabled=unavailable;add.dataset.unavailable=unavailable?'1':'0';};select.addEventListener('change',refresh);refresh();
  info.append(price,el('p',p.description,'description'),el('label','Finish'),select,availability,
    add,
    el('p','Standard delivery $5 / Express delivery $12','delivery-note'));
  const details=el('details');details.append(el('summary','Materials & care'),el('p','Made for everyday use. Wipe gently and store in a dry place. This is a synthetic sample product.'));info.append(details);section.append(info);return section;
}
function lineRows(){const container=el('div',null,'cart-lines');for(const l of cart?.lines??[]){const row=el('div',null,'cart-line');row.append(el('strong',l.name),el('span',money(l.lineTotal)));const q=el('div',null,'quantity');
  const less=button('−',async()=>{await quantity(l.sku,l.quantity-1);await render();},'icon');less.setAttribute('aria-label','Decrease '+l.name);
  const more=button('+',async()=>{await quantity(l.sku,l.quantity+1);await render();},'icon');more.setAttribute('aria-label','Increase '+l.name);
  q.append(less,el('span',String(l.quantity)),more);row.append(q,button('Remove',async()=>{await quantity(l.sku,0);await render();},'text-button'));container.append(row);}return container;}
function bag(){const s=el('section',null,'bag');s.append(heading('Your bag'));if(!cart?.lines?.length){s.append(el('p','Your bag is empty.','empty'),link('Explore the collection','/shop','button'));return s;}
  s.append(lineRows());const total=el('div',null,'total');total.append(el('span','Subtotal'),el('strong',money(cart.subtotal)));s.append(total,el('p','Delivery calculated at checkout.','muted'),link('Continue to checkout','/shop/checkout','button'),link('Keep browsing','/shop','secondary-link'));return s;}
async function checkout(){
  if(!cart?.lines?.length)return bag();
  const s=el('section',null,'checkout');s.append(heading('Checkout','BAG / CHECKOUT / CONFIRMATION'));const columns=el('div',null,'checkout-columns');
  const form=el('div',null,'checkout-form');form.append(el('h2','Delivery'),el('p','Alex Morgan\n1 Demo Avenue\nSample City, CA 90001, US','address'));
  const shipping=el('select');shipping.setAttribute('aria-label','Delivery method');for(const [code,name]of [['standard','Standard delivery / $5'],['express','Express delivery / $12']]){const o=el('option',name);o.value=code;shipping.append(o);}form.append(shipping,el('h2','Payment'),el('p','Simulated payment / No card details required','payment-mode'));
  const code=el('input');code.placeholder='Discount code';code.maxLength=32;code.setAttribute('aria-label','Discount code');form.append(el('h2','Discount'),code,el('p','Sample code: WELCOME10','muted'));
  const review=el('div',null,'order-review');review.append(el('h2','Order summary'));for(const line of cart.lines){const r=el('div',null,'summary-line');r.append(el('span',line.name+' × '+line.quantity),el('strong',money(line.lineTotal)));review.append(r);}
  const total=el('div',null,'total');const quoteNote=el('p',null,'muted');
  const update=async()=>{const quote=await request('/v1/shop/cart/estimate',{cartToken:cart.token,shippingMethodCode:shipping.value,...(code.value.trim()?{couponCode:code.value.trim()}: {})});total.replaceChildren(el('span','Total'),el('strong',money(quote.grandTotal)));quoteNote.textContent=quote.coupon?.applied?'Discount applied: '+money(quote.discountTotal):code.value.trim()?'Discount not applied. Check your code.':'Includes delivery';};
  shipping.addEventListener('change',()=>update().catch(e=>error(e.message)));code.addEventListener('change',()=>update().catch(e=>error(e.message)));form.append(button('Apply code',update,'text-button'));await update();review.append(total,quoteNote);
  const orderKey=sessionStorage.getItem('demo-checkout-key')??crypto.randomUUID();sessionStorage.setItem('demo-checkout-key',orderKey);
  const place=button('Place demo order',async()=>{
    await update();
    const out=await request('/v1/shop/checkout',{cartToken:cart.token,expectedRevision:cart.revision,shippingMethodCode:shipping.value,...(code.value.trim()?{couponCode:code.value.trim()}: {})},'POST',{'idempotency-key':orderKey});
    if(out.state!=='Paid')throw Error('The simulated payment did not complete.');
    sessionStorage.setItem('demo-order-'+out.code,JSON.stringify(out));sessionStorage.removeItem('demo-checkout-key');localStorage.removeItem('sellright-demo-cart');cart=null;count();await navigate('/shop/confirmation/'+out.code);
  });review.append(place);columns.append(form,review);s.append(columns);return s;
}
function confirmation(code){const s=el('section',null,'confirmation');const order=JSON.parse(sessionStorage.getItem('demo-order-'+code)??'null');s.append(el('div','✓','checkmark'),heading('Order confirmed'),el('p',code,'order-code'));if(order)s.append(el('p',money(order.grandTotal)+' / Simulated payment complete'));s.append(el('p','No payment was charged and no parcel will be shipped.','muted'),link('View this order in admin','/orders/'+encodeURIComponent(code),'button'),link('Continue shopping','/shop','secondary-link'));return s;}
async function render(){error();const path=location.pathname.split('/').filter(Boolean);let view;if(path[1]==='product')view=await product(path[2]);else if(path[1]==='cart')view=bag();else if(path[1]==='checkout')view=await checkout();else if(path[1]==='confirmation')view=confirmation(path[2]);else view=await catalog(path[1]==='collection'?path[2]:null);$('content').replaceChildren(view);document.title=(view.querySelector('h1')?.textContent??'Shop')+' | Everyday Supply';count();}
document.addEventListener('click',event=>{const a=event.target.closest('a');if(!a||event.metaKey||event.ctrlKey||event.shiftKey||a.target)return;const u=new URL(a.href);if(u.origin===location.origin&&(u.pathname==='/shop'||u.pathname.startsWith('/shop/'))){event.preventDefault();action(()=>navigate(u.pathname));}});
window.addEventListener('popstate',()=>action(render));
$('reset').addEventListener('click',()=>action(async()=>{if(!confirm('Reset your sample store and start again?'))return;await request('/demo/reset',{});localStorage.removeItem('sellright-demo-cart');sessionStorage.clear();location.assign('/shop');}));
(async()=>{try{const session=await request('/demo/session',{});localStorage.setItem('sr_admin_store',session.slug);const token=localStorage.getItem('sellright-demo-cart');if(token){try{cart=await request('/v1/shop/cart/'+token);}catch{localStorage.removeItem('sellright-demo-cart');}}await render();}catch(e){error(e.message);$('content').replaceChildren(el('p','The sample store could not be opened. Please reload to try again.','empty'));}})();
