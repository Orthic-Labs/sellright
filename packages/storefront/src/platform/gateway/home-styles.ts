// #427: the core home's stylesheet handle, in its own gateway file so only the core home route loads it. Defined in the gateway
// index it sat in the shared chunk every page loads (~21 KB raw), on brand homes too, which never use it.
import { STYLES as RAW_HOMEPAGE_STYLES } from '~/components/home/homepage-styles';
import { gateValue } from './gate';
import { str } from './schema';

export const homepageStyles: string = /*#__PURE__*/ gateValue('homepageStyles', RAW_HOMEPAGE_STYLES, str);
