// #386: the home newsletter form posts here. nginx on the live stores returns 404 for /newsletter-signup (a leftover
// rule from the previous storefront) and forwards /api/* to the storefront, so the same handler is served under /api/.
export { onPost } from "../../newsletter-signup/index";
