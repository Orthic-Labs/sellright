// Brand views, plan §1 "Mount rule": the build-time lookup of every view slot, in one place. A slot file is either present
// (the constant is the brand's component) or absent (undefined). The routes and the layout choose between the L1 `Brand<X>Mount`
// and today's component with `export default xView ? BrandXMount : BaseXPage`; the constant never changes at runtime.
import { getSlot } from '~/components/slots';

export const shellHeaderView = getSlot('shell.header');
export const shellFooterView = getSlot('shell.footer');
export const homeView = getSlot('route.home');
export const contentView = getSlot('route.content');
export const blogView = getSlot('route.blog');
export const blogPostView = getSlot('route.blog-post');
export const contactView = getSlot('route.contact');
