import { createSEOHead } from '~/utils/seo';

export const head = () => {
 return createSEOHead({
  title: 'Sign In',
  description: 'Sign in to your Damned Designs account or create a new one to shop, track orders, and manage your profile.',
  noindex: true,
 });
};
