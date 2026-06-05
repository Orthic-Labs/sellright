import { component$, Slot, useStyles$ } from '@qwik.dev/core';
import type { RequestHandler } from '@qwik.dev/router';

export const onGet: RequestHandler = async ({ cacheControl, headers }) => {
    cacheControl({ noStore: true });
    headers.set('x-route-class', 'affiliate-dashboard');
    headers.set('Cache-Control', 'no-store');
};

export default component$(() => {
    useStyles$(`
        .aff-shell { min-height: 100vh; display: flex; flex-direction: column; background: #F7F2EA; }
        .aff-shell-header { display: flex; align-items: center; padding: 1.25rem 1.5rem; }
        .aff-wordmark { font-family: var(--font-display), 'Cormorant Garamond', Georgia, serif; font-size: 1.25rem; font-weight: 600; letter-spacing: -0.005em; color: #111110; text-decoration: none; }
        .aff-wordmark:hover { color: #B87333; }
        .aff-shell-main { flex: 1; }
        .aff-shell-footer { padding: 1.5rem; border-top: 1px solid #e8e6e0; text-align: center; font-family: var(--font-mono), 'IBM Plex Mono', monospace; font-size: 11.5px; letter-spacing: 0.04em; color: #5a5a55; }
        .aff-shell-footer a { color: #B87333; text-decoration: none; }
        .aff-shell-footer a:hover { text-decoration: underline; }
        @media (max-width: 720px) {
            .aff-shell-header { padding: 1rem 1rem; }
            .aff-shell-footer { padding: 1.25rem 1rem; }
        }
    `);

    return (
        <div class="aff-shell">
            <header class="aff-shell-header">
                <a href="/" class="aff-wordmark">Damned Designs</a>
            </header>
            <main class="aff-shell-main">
                <Slot />
            </main>
            <footer class="aff-shell-footer">
                © 2026 Damned Designs · <a href="mailto:info@damneddesigns.com">Email us</a>
            </footer>
        </div>
    );
});
