// ADR-0001 DP-5 (checkout shell): the inline PAINT script (#425: the shop's DP-6 reveal script is gone: the shell's grid is visible
// from its HTML and Qwik fills availability in place). Originally DP-5/DP-6, the two inline PAINT scripts that make the cached shell look right before Qwik has
// loaded. Both are classic inline scripts in <head> (early-reads.ts puts them right after the parse-time reads script; the express
// layer allows them by sha256 on a shell render, by nonce on a dynamic one, and they are only emitted for a shell render), and both
// consume the SAME in-flight live read the page's early-reads script started: they read a CLONE of that response, so the Qwik consumer
// still takes the original once (no second round trip).
//
//   shop     The grid is in the shell (names, links, images: no stock, no price) but hidden (`[data-live-gate]` is
//            visibility:hidden, space reserved). When the live catalog read lands, this script hides every card that is not
//            confirmed in stock (`display:none` on its `data-slug` wrapper) and only then reveals the grid: an out-of-stock card is
//            never visible, not for a frame, and nothing moves. A failed or late read keeps the grid hidden (fail closed) and shows a
//            notice; Qwik's own read then decides. No stock value is stored anywhere: the set of in-stock slugs lives in this
//            function's scope for the one apply and nothing is written to the DOM but `display:none` on cards.
//   checkout The order summary paints from the visitor's live cart, read by the fixed-URL summary endpoint (/api/live/checkout-summary/:
//            the server reads the `sr_cart` and country cookies exactly as the server-rendered summary does; private, no-store; its
//            URL is in the shell's Link preload header), into SHADOW-DOM hosts that Qwik renders empty (`[data-sr-host]`), beside
//            the Qwik skeleton, so Qwik's vnode diff never sees (and never wipes) the painted nodes. (The browser's `sr_cart_count`
//            hint counts units, not lines, and the browser keeps no line items, so nothing can be painted before the read lands.) A cart this script cannot mirror
//            exactly (a coupon, a pre-order line, an unavailable line) is left to Qwik: nothing is painted for it.
//
// Nothing here reads or writes a stock value into storage, and nothing visitor-specific is in the script text: it is identical for every
// visitor (the cached shell's I-2). The cart is read from the in-memory response in the browser only.

import { BACKORDER_FALLBACK_LABEL, BACKORDER_ORDER_NOTE } from '~/utils/backorder';

export interface CheckoutPaintParams {
	/** The request key of the summary read this script paints from (early-reads.ts CHECKOUT_SUMMARY_URL). */
	k: string;
	/** theme.domain and the asset variant revision: the image URLs must equal OptimizedImage's so Qwik's <img> hits the same cache entry. */
	dm: string;
	rev: number;
}

/** JSON safe inside an HTML <script> element. */
const scriptJson = (value: unknown): string =>
	JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');


// ---------------------------------------------------------------------------------------------------- checkout

/** The shadow-DOM stylesheet of the summary hosts: the loaded summary's own boxes (CartContents' dark line row with its 88x112
 *  thumbnail, CartTotals' dark rows), written out because the page's utility classes do not reach into a shadow root. */
const PAINT_CSS =
	"*{box-sizing:border-box;margin:0;padding:0}ul{list-style:none;width:100%}" +
	".r{display:grid;grid-template-columns:88px minmax(0,1fr) auto;gap:1rem;width:100%;padding:1.25rem 0;border-top:1px solid rgba(var(--color-accent-rgb),.25)}" +
	".r:first-child{border-top:0}.th{width:88px;height:112px;overflow:hidden;background:rgba(253,250,246,.06)}" +
	".th img{display:block;width:100%;height:100%;object-fit:cover;object-position:center}" +
	".mid{display:flex;flex-direction:column;justify-content:space-between;min-width:0}.mid>div:first-child{min-width:0}" +
	"h3{font-family:var(--font-heading);font-size:15px;font-weight:400;line-height:1.375;color:#FDFAF6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}" +
	".v{font-size:11px;margin-top:.125rem;letter-spacing:.025em;color:rgba(253,250,246,.48)}" +
	".w{margin-bottom:.25rem}.w span{font-size:11px;letter-spacing:.5px;color:rgba(var(--color-accent-rgb),.7)}" +
	".q{display:flex;align-items:center;margin-top:.75rem;font-size:12px;color:rgba(253,250,246,.7)}" +
	".e{display:flex;flex-direction:column;align-items:flex-end;justify-content:space-between;min-width:84px}" +
	".p{text-align:right;font-size:14px;font-weight:500;color:#FDFAF6;font-variant-numeric:tabular-nums;flex-shrink:0}" +
	"dl{border-top:1px solid rgba(var(--color-accent-rgb),.25);margin-top:.5rem;padding-top:1rem;padding-bottom:.5rem}dl>div+div{margin-top:.75rem}" +
	".t{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:rgba(253,250,246,.4)}.t dd{font-weight:500;color:rgba(253,250,246,.6)}" +
	// #446: a backorder line's ship label and the order-level sentence (CartContents' same notices)
	".bo{font-size:12px;line-height:1.375;margin-top:.25rem;color:rgba(253,250,246,.7)}" +
	".n{font-size:12px;line-height:1.375;padding-top:.75rem;border-top:1px solid rgba(var(--color-accent-rgb),.25);color:rgba(253,250,246,.7)}";

const CHECKOUT_BODY =
	"(function(w,d,P){try{var S=w.__srEarly,p=S&&S.r&&S.r[P.k];if(!p||!S.ct)return;" +
	"var CSS='" + PAINT_CSS.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "',st=0,mo=null,cart=null,FB=" + JSON.stringify(BACKORDER_FALLBACK_LABEL) + ",NOTE=" + JSON.stringify(BACKORDER_ORDER_NOTE) + ";" +
	// escaping, formatting (Intl as utils/price-format.ts; '$' + grouped cents as hooks/checkout-total.ts formatCents)
	"function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');}" +
	"function money(v,c){var a=(v||0)/100,h=a%1!==0;return new Intl.NumberFormat('en-US',{style:'currency',currency:c||'USD',minimumFractionDigits:h?2:0,maximumFractionDigits:h?2:0}).format(a);}" +
	"function cents(v){return '$'+(v/100).toFixed(2).replace(/\\B(?=(\\d{3})+(?!\\d))/g,',');}" +
	"function host(n){return d.querySelector('[data-sr-host=\"'+n+'\"]');}" +
	"function put(n,html){var h=host(n);if(!h)return 0;var r=h.shadowRoot;if(!r){r=h.attachShadow({mode:'open'});var t=h.tagName==='SPAN'?'span':'div';r.innerHTML='<style>'+CSS+'</style><'+t+'></'+t+'>';}" +
	"r.lastChild.innerHTML=html;h.setAttribute('data-painted','');return 1;}" +
	// image: OptimizedImage responsive=\"thumbnail\" (widths 160/320, sizes 160px), eager + fetchpriority high
	"function img(l,alt){var raw=l.image||'',s=raw?(/^(https?:\\/\\/|\\/)/.test(raw)?raw:'/assets/'+raw):'/asset_placeholder.webp';" +
	"var hosted=s.indexOf('/assets/')>=0||s.indexOf('/assetspreview/')>=0||s.indexOf(P.dm)>=0,x=(s.indexOf(P.dm+'/assetspreview')>=0||s.charAt(0)!=='/')?' crossorigin=\"anonymous\"':'';" +
	"var o='<img width=\"160\" height=\"200\" loading=\"eager\" fetchpriority=\"high\" decoding=\"async\" sizes=\"160px\" alt=\"'+esc(alt)+'\"'+x;" +
	"if(!hosted)return '<picture>'+o+' src=\"'+esc(s)+'\"></picture>';" +
	"var b=s.split('?')[0],m=s.match(/[?&]v=([^&]+)/),v=(m?'&v='+m[1]:'')+'&r='+P.rev;" +
	"function ss(f,q){return esc(b+'?preset=thumb&format='+f+'&q='+q+v+' 160w, '+b+'?preset=card&format='+f+'&q='+q+v+' 320w');}" +
	"return '<picture><source srcset=\"'+ss('avif',75)+'\" sizes=\"160px\" type=\"image/avif\"><source srcset=\"'+ss('webp',75)+'\" sizes=\"160px\" type=\"image/webp\">'+o+" +
	"' src=\"'+esc(b+'?preset=large&format=jpg&q=80&r='+P.rev)+'\" srcset=\"'+ss('jpg',80)+'\"></picture>';}" +
	// the line row (CartContents, checkout view, not editable)
	"function title(s){return s.split('-').map(function(x){return x.charAt(0).toUpperCase()+x.slice(1);}).join(' ');}" +
	"function line(l,cur){var slug=l.productSlug||l.slug||'',pn=l.productName||l.name||title(slug);" +
	"var vn=l.options||(l.productName?l.name:(function(){var t=String(l.name||'').replace(pn,'').trim();return t.charAt(0)==='-'?t.substring(1).trim():t;})());" +
	"vn=String(vn||'').split(/\\s+-\\s+/).join(' / ');" +
	"var rem=l.availableQuantity===null?null:(typeof l.availableQuantity==='number'&&isFinite(l.availableQuantity)?l.availableQuantity:0);" +
	"var alt=l.productName?l.productName+', '+l.name:'Image of: '+l.name;" +
	"return '<li class=\"r\"><div class=\"th\">'+img(l,alt)+'</div><div class=\"mid\"><div><h3>'+esc(pn)+'</h3>'+(vn?'<p class=\"v\">'+esc(vn)+'</p>':'')+(l.backorder===true?'<p class=\"bo\">'+esc(typeof l.shipLabel==='string'&&l.shipLabel.trim()?l.shipLabel.trim():FB)+'</p>':'')+'</div>'+" +
	"(rem!==null&&rem<=5?'<div class=\"w\"><span>Only '+rem+' left</span></div>':'')+'<div class=\"q\">Qty '+esc(l.quantity)+'</div></div>'+" +
	"'<div class=\"e\"><span class=\"p\">'+money(l.lineSubtotal,cur)+'</span></div></li>';}" +
	// the cart this script can mirror exactly; anything else is left to Qwik (the skeleton stays)
	"function mirrorable(c){if(!c||c.status!=='active'||c.pricingIntent!=='checkout'||!c.lines||!c.lines.length)return 0;" +
	"if(c.coupons&&c.coupons.length)return 0;for(var i=0;i<c.lines.length;i++){var l=c.lines[i];if(!l||l.available!==true||l.isPreOrder)return 0;}return 1;}" +
	"function real(){if(st===2||!cart)return;var c=cart,cur=c.currency||'USD',sub=c.subtotal||0,dis=c.discountTotal||0,i,r='';" +
	"var bo=0;for(i=0;i<c.lines.length;i++){r+=line(c.lines[i],cur);if(c.lines[i].backorder===true)bo=1;}" +
	"var ship=c.quoteHash?c.shippingTotal:null,tot=c.quoteHash?c.grandTotal:sub-dis+(ship||0);" +
	"var t='<div class=\"t\"><dt>Subtotal</dt><dd>'+money(sub,cur)+'</dd></div>'+(dis>0?'<div class=\"t\"><dt>Discount</dt><dd>-'+money(dis,cur)+'</dd></div>':'')+" +
	"'<div class=\"t\"><dt>Shipping</dt><dd>'+(ship===null?'Calculated at next step':ship===0?'Free':money(ship,cur))+'</dd></div><div class=\"t\"><dt>Total</dt><dd>'+money(tot,cur)+'</dd></div>';" +
	"if(put('lines','<ul>'+r+'</ul>'+(bo?'<p class=\"n\">'+esc(NOTE)+'</p>':''))&&put('totals','<dl>'+t+'</dl>')){put('total',c.grandTotal>0?cents(c.grandTotal):'');st=2;if(mo)mo.disconnect();}}" +
	"function go(){if(st<2&&cart)real();}" +
	"p.then(function(r){return r.ok?r.json():null;}).then(function(j){j=j&&j.cart;if(mirrorable(j)){cart=j;go();}},function(){});" +
	"try{mo=new MutationObserver(go);mo.observe(d.documentElement,{childList:true,subtree:true});}catch(e){}" +
	"d.addEventListener('DOMContentLoaded',go);setTimeout(function(){if(mo)mo.disconnect();},8000);go();" +
	"}catch(e){}})(window,document,";

export const checkoutPaintScriptSource = (p: CheckoutPaintParams): string => `${CHECKOUT_BODY}${scriptJson(p)});`;
