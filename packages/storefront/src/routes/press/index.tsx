import { component$ } from '@qwik.dev/core';
import { createSEOHead } from '~/utils/seo';
import { useStoreIdentityLoader } from '~/routes/layout';

export default component$(() => {
  return (
    <div style={{
      background: '#0A0A0A',
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '80px 24px',
      textAlign: 'center',
    }}>
      <p style={{
        fontFamily: 'var(--font-body)',
        fontSize: '0.75rem',
        letterSpacing: '2.5px',
        textTransform: 'uppercase',
        color: 'var(--color-accent)',
        marginBottom: '16px',
      }}>Press</p>
      <h1 style={{
        fontFamily: 'var(--font-display)',
        fontSize: 'clamp(2rem, 4vw, 3rem)',
        fontWeight: '700',
        color: '#F5F0E8',
        marginBottom: '12px',
      }}>Press &amp; Media</h1>
      <p style={{
        color: '#9A9488',
        fontSize: '1rem',
        maxWidth: '420px',
      }}>For press inquiries, reviews, and media kits — reach out via our contact page.</p>
    </div>
  );
});

export const head = ({ resolveValue }: { resolveValue: any }) => {
  const identity = resolveValue(useStoreIdentityLoader);
  return createSEOHead({
    title: `Press — ${identity.storeName}`,
    description: `Press inquiries, media kits, and review samples for ${identity.storeName}.`,
    ogUrl: `${identity.siteOrigin}/press/`,
    identity,
  });
};
