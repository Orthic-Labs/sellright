import { createSEOHead } from '~/utils/seo';
import { theme } from '~/theme/theme.config';

export const head = () => {
 return createSEOHead({
  title: 'Sign In',
  description: `Sign in to your ${theme.storeName} account or create a new one to shop, track orders, and manage your profile.`,
  noindex: true,
 });
};
