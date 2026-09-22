(() => {
  const style=document.createElement('style');style.textContent='body{padding-top:42px!important}.demo-toolbar{position:fixed;inset:0 0 auto;z-index:10000;height:42px;background:#173f34;color:white;display:flex;align-items:center;gap:20px;padding:0 20px;font:12px system-ui}.demo-toolbar a{color:white}.demo-toolbar span{margin-right:auto}.demo-toolbar button{background:transparent;color:white;border:1px solid #ffffff80;border-radius:3px;padding:4px 9px;cursor:pointer}@media(max-width:600px){.demo-toolbar{font-size:10px;padding:0 10px;gap:10px}}';document.head.append(style);
  const bar=document.createElement('div');bar.className='demo-toolbar';
  const label=document.createElement('span');label.textContent='SellRight demo / Your private sample store';
  const shop=document.createElement('a');shop.href='/shop';shop.textContent='Open storefront ↗';
  const reset=document.createElement('button');reset.textContent='Reset demo';
  reset.onclick=async()=>{if(!confirm('Reset your sample store?'))return;const csrf=document.cookie.split('; ').find(v=>v.startsWith('sr_csrf='))?.slice(8);const r=await fetch('/demo/reset',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf??''},body:'{}'});if(r.ok){localStorage.removeItem('sellright-demo-cart');location.assign('/shop');}else alert('Could not reset the demo. Please retry.');};
  bar.append(label,shop,reset);document.body.append(bar);
  style.textContent+='[aria-live].fixed.top-3{top:54px!important}';
  const allowed=['/','/orders','/products','/inventory','/customers','/reports','/activity','/collections','/discounts'];
  function trimNavigation(){
    document.querySelectorAll('aside a').forEach(a=>{const path=new URL(a.href).pathname;if(!allowed.includes(path))a.style.display='none';});
    document.querySelectorAll('input[type=file]').forEach(input=>{input.disabled=true;const label=input.closest('label');if(label){label.title='File uploads are disabled in the public demo';label.style.opacity='.45';label.style.pointerEvents='none';}});
    document.querySelectorAll('button').forEach(b=>{if(['Add group','Set as featured','Remove from gallery'].includes(b.textContent.trim())||['Set as featured','Remove from gallery'].includes(b.title)||/^(Export|Import|Upload)\b/.test(b.textContent.trim())){b.disabled=true;b.title='External files and option editing are unavailable in this demo';}});
  }
  const root=document.getElementById('root');if(root)new MutationObserver(trimNavigation).observe(root,{subtree:true,childList:true});trimNavigation();
})();
