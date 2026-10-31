// Brand views, plan §2.4 "Analytics and CSP": the CSP origins and the GTM loader for head.json `analytics`. A small module of its own so the
// Express entry can import `analyticsCsp` without pulling in the head resolver. Pure.
import type { BrandHeadSpec } from './head-resolve';

export interface AnalyticsCsp {
	script: string[];
	connect: string[];
}

/**
 * OpenAI Ads Measurement Pixel origins (developers.openai.com/ads/measurement-pixel, checked 2026-10-22). Its image fallback on
 * bzr.openai.com is already covered by `img-src https:`. Loaded through a GTM template (injectScript), never a Custom HTML tag.
 */
export const OPENAI_PIXEL_CSP = { script: ['https://bzrcdn.openai.com'], connect: ['https://bzr.openai.com', 'https://bzrcdn.openai.com'] } as const;

/**
 * CSP additions for the declared analytics and any opted-in ad platform. No `unsafe-eval`. GA4 hosts from Google's tag CSP guide
 * (developers.google.com/tag-platform/security/guides/csp, checked 2026-10-30), limited to the ones the stores call: with Google signals
 * on, g/collect also goes to analytics.google.com, www.google.com and stats.g.doubleclick.net (all blocked live on Damned, #407).
 */
export function analyticsCsp(analytics: BrandHeadSpec['analytics'] | undefined): AnalyticsCsp | undefined {
	if (!analytics) return undefined;
	const openai = analytics.adPlatforms?.includes('openai') ?? false;
	return {
		script: ['https://*.googletagmanager.com', ...(openai ? OPENAI_PIXEL_CSP.script : [])],
		connect: ['https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://*.googletagmanager.com', 'https://*.google.com', 'https://*.g.doubleclick.net', ...(openai ? OPENAI_PIXEL_CSP.connect : [])],
	};
}

/**
 * The GTM loader (Google's snippet, nonce'd): a STATIC script. It takes the container id from its own `data-gtm-id` attribute (validated
 * at build as `^GTM-[A-Z0-9]{4,12}$`, escaped by the JSX attribute), so no code is built from data. #375: before `gtm.js` it pushes the
 * `user_data` stored by a consented earlier page (platform/controllers/user-data.ts), so page-view tags carry it. With `data-ud="1"` (a
 * brand with the OpenAI pixel, implied consent) it also works on a FIRST visit: it creates the `sr_vid` visitor cookie, adds the
 * request's country (`data-co`, Cloudflare CF-IPCountry) and hashes the visitor id (SubtleCrypto) before starting GTM, holding the
 * loader at most 200 ms; a page whose stored data already has an external id starts GTM at once. #360: the dataLayer pushes happen at once,
 * but gtm.js itself is inserted only after the window load event plus idle (at most 3 s) or the first interaction, so the container
 * (and the GA4 tag it injects, ~2 s of main thread on a 4x CPU phone) never competes with the page's first paint and LCP.
 */
export const GTM_LOADER_SOURCE =
	"(function(w,d,s,l){var c=d.currentScript,i=c&&c.getAttribute('data-gtm-id');if(!i)return;w[l]=w[l]||[];var u=null;try{u=JSON.parse(w.localStorage.getItem('sr-user-data')||'null');}catch(e){}if(!u||typeof u!=='object'||Array.isArray(u))u={};var done=0,go=function(){if(done)return;done=1;for(var k in u){w[l].push({user_data:u});break;}w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+encodeURIComponent(i);if(c.nonce){j.setAttribute('nonce',c.nonce);}var ins=0,x=function(){if(ins)return;ins=1;f.parentNode.insertBefore(j,f);};if(!w.addEventListener){x();return;}['pointerdown','keydown','touchstart','scroll'].forEach(function(e){w.addEventListener(e,x,{once:true,passive:true,capture:true});});var lz=function(){(w.requestIdleCallback||function(cb){return setTimeout(cb,1);})(x,{timeout:3000});};if(d.readyState==='complete'){lz();}else{w.addEventListener('load',lz,{once:true});}};if(c.getAttribute('data-ud')!=='1'){go();return;}var co=c.getAttribute('data-co');if(!u.country&&co&&/^[A-Z]{2}$/.test(co))u.country=co;var m=d.cookie.match(/(?:^|; )sr_vid=([A-Za-z0-9-]{8,64})(?:;|$)/),v=m&&m[1];if(!v){try{v=w.crypto.randomUUID();}catch(e){v=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,12);}d.cookie='sr_vid='+v+'; Path=/; Max-Age=31536000; SameSite=Lax'+(w.location.protocol==='https:'?'; Secure':'');}var save=function(){try{w.localStorage.setItem('sr-user-data',JSON.stringify(u));}catch(e){}};if(u.sha256_external_id){save();go();return;}setTimeout(go,200);try{w.crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)).then(function(b){var h='',a=new Uint8Array(b);for(var n=0;n<a.length;n++)h+=(a[n]<16?'0':'')+a[n].toString(16);u.sha256_external_id=h;save();go();},go);}catch(e){go();}})(window,document,'script','dataLayer');";

/** Cloudflare's visitor country (CF-IPCountry) as the loader's data-co, or undefined (missing, XX unknown, T1 Tor). */
export function ipCountry(header: string | string[] | undefined | null): string | undefined {
	const v = (Array.isArray(header) ? header[0] : header)?.trim().toUpperCase();
	return v && /^[A-Z]{2}$/.test(v) && v !== 'XX' && v !== 'T1' ? v : undefined;
}
