import { createSEOHead } from '~/utils/seo';

export const head = () => {
  return createSEOHead({
    title: 'My Orders',
    description: 'View your order history and track current orders.',
    noindex: true,
  });
};
