const config = {
	content: ['./src/**/*.{js,ts,jsx,tsx}'],
	theme: {
		extend: {
			maxWidth: {
				'8xl': '88rem', // 1408px
				'9xl': '96rem', // 1536px  
				'10xl': '100rem', // 1600px - Good for e-commerce
				// Proportional to header/footer (max-w-screen-2xl = 96rem = 1536px)
				'content-wide': '81.6rem',   // 85% of 96rem = 1306px
				'content-normal': '76.8rem', // 80% of 96rem = 1229px  
				'content-narrow': '72rem',   // 75% of 96rem = 1152px
			},			colors: {
				primary: {
					50: '#f0f0f0',
					100: '#e0e0e0',
					200: '#c0c0c0',
					300: '#a0a0a0',
					400: '#808080',
					500: '#000000',
					600: '#1a1a1a',
					700: '#262626',
					800: '#333333',
					900: '#404040',
				},
				brand: {
					red: '#965341',
					'red-hover': '#B06B56',
				},
				accent: {
					mint: '#7dd3fc',
					sage: '#a7f3d0',
					cream: '#fef3c7',
					blush: '#fecaca',
				},
			},
			fontFamily: {
				'display': ['var(--font-display)'],
				'heading': ['var(--font-display)'],
				'body': ['var(--font-body)'],
				'mono': ['var(--font-mono)'],
			},
			animation: {
				float: 'float 6s ease-in-out infinite',
				fadeInUp: 'fadeInUp 0.6s ease-out',
				'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
			},
			keyframes: {
				'glow-pulse': {
					'0%, 100%': { 
						boxShadow: '0 0 20px rgba(239, 68, 68, 0.3), 0 0 40px rgba(239, 68, 68, 0.1)',
					},
					'50%': { 
						boxShadow: '0 0 30px rgba(239, 68, 68, 0.5), 0 0 60px rgba(239, 68, 68, 0.2)',
					},
				},
			},
			textShadow: {
				'sm': '1px 1px 2px rgba(0, 0, 0, 0.5)',
				'md': '2px 2px 4px rgba(0, 0, 0, 0.5)',
				'lg': '3px 3px 6px rgba(0, 0, 0, 0.7)',
				'glow': '0 0 10px rgba(255, 255, 255, 0.8)',
			},
			dropShadow: {
				'premium': [
					'0 4px 8px rgba(0, 0, 0, 0.3)',
					'0 1px 3px rgba(0, 0, 0, 0.5)'
				],
				'glow-white': '0 0 10px rgba(255, 255, 255, 0.8)',
				'glow-red': '0 0 15px rgba(239, 68, 68, 0.6)',
			},
			borderRadius: {
				'2xl': '1rem',
				'3xl': '1.5rem',
			},
			boxShadow: {
				soft: '0 2px 15px -3px rgba(0, 0, 0, 0.07), 0 10px 20px -2px rgba(0, 0, 0, 0.04)',
				medium: '0 4px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
			},
		},
	},
	plugins: [
		// @ts-ignore
		require('@tailwindcss/forms'),

		// Text shadow plugin
		function ({ addUtilities }) {
			const textShadowUtilities = {
				'.text-shadow-sm': {
					textShadow: '1px 1px 2px rgba(0, 0, 0, 0.5)',
				},
				'.text-shadow-md': {
					textShadow: '2px 2px 4px rgba(0, 0, 0, 0.5)',
				},
				'.text-shadow-lg': {
					textShadow: '3px 3px 6px rgba(0, 0, 0, 0.7)',
				},
				'.text-shadow-glow': {
					textShadow: '0 0 10px rgba(255, 255, 255, 0.8)',
				},
			};
			addUtilities(textShadowUtilities);
		},
	],
};

export default config;
