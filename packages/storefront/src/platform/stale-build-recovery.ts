// A page left open across a deploy can ask for a code chunk the new build no longer has (dynamic import 404), or catch the
// storefront mid-restart (a route loader comes back empty after a 502). Either leaves the page half-rendered: checkout
// showed a grey summary and a disabled button. This static inline script, nonce'd in <head> before any app code, reloads
// the page ONCE so it picks up the current build. A 30 s guard prevents loops; if storage is blocked it does nothing.

/** Browser messages for a failed dynamic import (Chrome, Firefox, Safari) and Qwik's empty route-loader response. */
export const STALE_BUILD_PATTERN =
	/Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|returned empty response/i;

export const STALE_BUILD_RECOVERY_SOURCE =
	"(function(){var K='sr-stale-build-reload',P=" +
	STALE_BUILD_PATTERN.toString() +
	";function r(m){if(!m||!P.test(String(m)))return;try{var t=+sessionStorage.getItem(K)||0;if(Date.now()-t<30000)return;sessionStorage.setItem(K,String(Date.now()))}catch(e){return}location.reload()}" +
	"addEventListener('unhandledrejection',function(e){var x=e.reason;r(x&&(x.message||x))});" +
	"addEventListener('error',function(e){r(e.message||(e.error&&e.error.message))});" +
	"document.addEventListener('qerror',function(e){var d=e.detail||{};r((d.error&&d.error.message)||d.error)})})();";
