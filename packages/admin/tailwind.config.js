/** @type {import('tailwindcss').Config} */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // All driven by CSS variables in theme-tokens.css → runtime theme + dark swap.
        ink: v('text'),
        muted: v('text-muted'),
        subtle: v('text-subtle'),
        canvas: v('bg'),
        surface: { DEFAULT: v('surface'), 2: v('surface-2') },
        // Always-dark outer chrome (sidebar). Constant across light/dark mode.
        shell: { DEFAULT: v('shell-bg'), surface: v('shell-surface'), text: v('shell-text'), muted: v('shell-muted'), border: v('shell-border'), active: v('shell-active-bg'), 'active-text': v('shell-active-text') },
        line: { DEFAULT: v('border'), strong: v('border-strong') },
        // `brand` is repointed to the active theme accent, so every existing
        // bg-brand / text-brand / bg-brand-light / hover:bg-brand-hover re-themes.
        brand: { DEFAULT: v('accent'), hover: v('accent-hover'), light: v('accent-soft'), ring: v('ring'), on: v('on-accent') },
        accent: { DEFAULT: v('accent'), hover: v('accent-hover'), soft: v('accent-soft'), on: v('on-accent') },
        success: { DEFAULT: v('success'), soft: v('success-soft') },
        warning: { DEFAULT: v('warning'), soft: v('warning-soft') },
        danger: { DEFAULT: v('danger'), soft: v('danger-soft') },
        info: { DEFAULT: v('info'), soft: v('info-soft') },
        // Remap the gray scale to the per-theme neutral ramp (inverts in dark),
        // so existing text-gray-*/border-gray-*/bg-gray-* utilities theme for free.
        gray: { 50: v('gray-50'), 100: v('gray-100'), 200: v('gray-200'), 300: v('gray-300'), 400: v('gray-400'), 500: v('gray-500'), 600: v('gray-600'), 700: v('gray-700'), 800: v('gray-800'), 900: v('gray-900') },
      },
      fontFamily: {
        sans: ['Hanken Grotesk', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        display: ['Schibsted Grotesk', 'Hanken Grotesk', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.05)',
        'card-hover': '0 2px 4px rgba(16,24,40,0.06), 0 6px 14px rgba(16,24,40,0.08)',
        popover: '0 4px 12px rgba(16,24,40,0.10), 0 2px 4px rgba(16,24,40,0.06)',
        modal: '0 18px 48px rgba(16,24,40,0.18), 0 6px 14px rgba(16,24,40,0.08)',
      },
      keyframes: {
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'drawer-in': { '0%': { transform: 'translateX(-100%)' }, '100%': { transform: 'translateX(0)' } },
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
      },
      animation: {
        shimmer: 'shimmer 1.5s infinite',
        'drawer-in': 'drawer-in 0.18s ease-out',
        'fade-in': 'fade-in 0.12s ease-out',
      },
    },
  },
  plugins: [],
};
