import { component$ } from '@qwik.dev/core';
import { createSEOHead } from '~/utils/seo';

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
        color: '#965341',
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

export const head = () => createSEOHead({
  title: 'Press — Damned Designs',
  description: 'Press inquiries, media kits, and review samples for Damned Designs EDC products.',
  ogUrl: 'https://www.damneddesigns.com/press/',
});
