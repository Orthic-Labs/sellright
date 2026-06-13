/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#1a1a1a',
        brand: { DEFAULT: '#008060', hover: '#006e52', light: '#e3f1ed', ring: '#00806033' },
        // Operator shell layers: shell (sidebar) sits behind canvas, surfaces sit on canvas.
        shell: '#fafaf9',
        canvas: '#f6f6f7',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
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
