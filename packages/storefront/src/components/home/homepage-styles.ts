export const STYLES = `
  /* ── Color palette ── */
  .hp { --accent: #965341; --accent-light: #B06B56; --accent-glow: rgba(150,83,65,0.35); --accent-dim: rgba(150,83,65,0.12); --dark: #0A0A0A; --dark-elevated: #111110; --dark-surface: #1A1A1A; --dark-border: #2A2A28; --parchment: #F7F2EA; --parchment-deep: #EDE7DC; --warm-grey: #706860; --off-white: #F5F0E8; --text-on-dark: #E8E2D8; --text-on-dark-secondary: #9A9488; --text-on-light: #1A1A1A; --text-on-light-secondary: #5A5650; }

  /* ── Hero image ── */
  .hero-img { image-rendering: auto; }

  /* ── Hero ── */
  .hero { position: relative; width: 100%; height: 100svh; min-height: 560px; overflow: hidden; display: flex; align-items: flex-end; }
  @supports not (height: 100svh) { .hero { height: 100vh; } }
  .hero-overlay { position: absolute; inset: 0; background: radial-gradient(ellipse 70% 60% at 50% 50%, transparent 0%, rgba(0,0,0,0.25) 100%), linear-gradient(to right, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.3) 30%, transparent 55%), linear-gradient(to bottom, rgba(0,0,0,0.2) 0%, transparent 25%, transparent 60%, rgba(0,0,0,0.65) 100%); z-index: 2; }
  .hero-content { position: relative; z-index: 10; width: 100%; padding: 0 1.5rem 3rem; display: flex; flex-direction: column; gap: 2rem; }
  @media (min-width: 1024px) { .hero-content { padding: 0 3.25rem 3.75rem; flex-direction: row; align-items: flex-end; justify-content: space-between; } }

  .hero-kicker { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .hero-kicker-dot { width: 8px; height: 8px; border-radius: 50%; background: #22C55E; flex-shrink: 0; }
  .hero-kicker-text { font-family: var(--font-mono); font-size: var(--step--1); letter-spacing: 0.18em; text-transform: uppercase; color: var(--accent-light); }
  .hero-title { font-family: var(--font-display); font-weight: 700; font-size: var(--step-4); line-height: 1.05; color: #fff; letter-spacing: -1px; margin-bottom: 10px; }
  .hero-title em { font-style: italic; color: var(--accent-light); }
  .hero-sub { font-family: var(--font-body); font-size: var(--step-0); color: rgba(255,255,255,0.65); letter-spacing: 0.2px; margin-bottom: 28px; max-width: 360px; line-height: 1.7; text-wrap: pretty; }
  .hero-ctas { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }

  .hero-meta { text-align: right; display: none; flex-direction: column; gap: 10px; }
  @media (min-width: 1024px) { .hero-meta { display: flex; } }
  .meta-val { font-family: var(--font-display); font-size: 26px; font-weight: 700; color: #fff; line-height: 1; }
  .meta-label { font-family: var(--font-mono); font-size: 0.75rem; letter-spacing: 2.5px; text-transform: uppercase; color: rgba(255,255,255,0.55); }

  /* ── Scroll hint ── */
  .scroll-hint { position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 10; opacity: 0.7; }

  /* ── Buttons ── */
  .btn-primary { display: inline-flex; align-items: center; gap: 10px; background: var(--accent); color: #fff; border: none; padding: 14px 32px; cursor: pointer; min-height: 48px; font-family: var(--font-body); font-weight: 500; font-size: var(--step--1); letter-spacing: 0.12em; text-transform: uppercase; border-radius: 2px; transition: background 0.2s, transform 0.15s; text-decoration: none; width: auto; }
  .btn-primary:hover { background: var(--accent-light); }
  .btn-primary:active { transform: scale(0.96); }
  .btn-ghost { display: inline-flex; align-items: center; gap: 8px; background: transparent; color: var(--off-white); border: 1px solid rgba(245,240,232,0.25); padding: 14px 32px; cursor: pointer; min-height: 48px; font-family: var(--font-body); font-weight: 500; font-size: var(--step--1); letter-spacing: 0.12em; text-transform: uppercase; border-radius: 2px; transition: border-color 0.2s, color 0.2s, transform 0.15s; text-decoration: none; width: auto; }
  .btn-ghost:hover { border-color: rgba(245,240,232,0.5); color: #fff; }
  .btn-ghost:active { transform: scale(0.96); }
  .btn-primary--dark { display: inline-flex; align-items: center; gap: 10px; background: var(--dark-surface); color: var(--off-white); border: none; padding: 14px 32px; cursor: pointer; min-height: 48px; font-family: var(--font-body); font-weight: 500; font-size: var(--step--1); letter-spacing: 0.12em; text-transform: uppercase; border-radius: 2px; transition: background 0.2s, transform 0.15s; text-decoration: none; }
  .btn-primary--dark:hover { background: var(--dark-border); }
  .btn-primary--dark:active { transform: scale(0.96); }
  .btn-ghost--dark { display: inline-flex; align-items: center; gap: 8px; background: transparent; color: var(--text-on-light); border: 1px solid rgba(26,26,26,0.2); padding: 14px 32px; cursor: pointer; min-height: 48px; font-family: var(--font-body); font-weight: 500; font-size: var(--step--1); letter-spacing: 0.12em; text-transform: uppercase; border-radius: 2px; transition: border-color 0.2s, color 0.2s, transform 0.15s; text-decoration: none; }
  .btn-ghost--dark:hover { border-color: var(--text-on-light); }
  .btn-ghost--dark:active { transform: scale(0.96); }
  .btn-arrow { display: inline-block; transition: transform 0.3s ease; }
  .btn-primary:hover .btn-arrow, .btn-primary--dark:hover .btn-arrow { transform: translateX(4px); }

  /* ── Trust bar (scrolling ticker) ── */
  .trust-bar { background: var(--dark); overflow: hidden; position: relative; padding: 16px 0; white-space: nowrap; }
  .trust-track { display: inline-flex; gap: 0; animation: hp-ticker 30s linear infinite; white-space: nowrap; }
  .trust-item { display: flex; align-items: center; gap: 10px; padding: 0 32px; white-space: nowrap; }
  .trust-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }
  .trust-text { font-family: var(--font-mono); font-size: var(--step--1); letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-on-dark-secondary); }

  /* ── Reveal system ── */
  .reveal { opacity: 0; transform: translateY(28px); transition: opacity 0.7s cubic-bezier(0.23,1,0.32,1), transform 0.7s cubic-bezier(0.23,1,0.32,1); }
  .reveal.visible { opacity: 1; transform: translateY(0); }
  .reveal-d1 { transition-delay: 0.1s; }
  .reveal-d2 { transition-delay: 0.2s; }
  .reveal-d3 { transition-delay: 0.3s; }
  .reveal-d4 { transition-delay: 0.4s; }
  @media (prefers-reduced-motion: reduce) { .reveal { opacity: 1; transform: none; transition: none; } }

  /* ── Hero text (no stagger — instant paint) ── */
  .stagger-1, .stagger-2, .stagger-3, .stagger-4 { opacity: 1; }

  /* ── Pre-order section ── */
  .preorder { background: var(--parchment); padding: 3rem 1.5rem; display: grid; grid-template-columns: 1fr; gap: 3rem; align-items: center; }
  @media (min-width: 1024px) { .preorder { padding: 5.5rem 3.25rem; grid-template-columns: 1fr 1fr; gap: 5rem; } }
  .po-badge { display: inline-flex; align-items: center; gap: 8px; background: var(--dark); color: var(--accent-light); padding: 6px 14px; font-family: var(--font-mono); font-size: 0.75rem; letter-spacing: 2.5px; text-transform: uppercase; margin-bottom: 24px; border-radius: 2px; }
  .po-dot-green { width: 6px; height: 6px; border-radius: 50%; background: #4ade80; animation: hp-pulse-dot 1.8s ease-in-out infinite; }
  .po-label { font-family: var(--font-mono); font-size: var(--step--1); letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); margin-bottom: 12px; }
  .po-title { font-family: var(--font-display); font-weight: 700; font-size: var(--step-3); line-height: 0.95; color: var(--text-on-light); letter-spacing: -0.5px; margin-bottom: 12px; text-wrap: balance; }
  .po-specs { font-family: var(--font-body); font-size: 0.8125rem; letter-spacing: 1px; color: var(--warm-grey); margin-bottom: 16px; }
  .po-sub { font-family: var(--font-body); font-size: var(--step-0); color: var(--text-on-light-secondary); line-height: 1.8; max-width: 400px; margin-bottom: 32px; text-wrap: pretty; }

  .po-selector-label { font-family: var(--font-mono); font-size: 0.75rem; letter-spacing: 2px; text-transform: uppercase; color: var(--warm-grey); margin-bottom: 10px; }
  .po-styles { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
  .po-style-btn { background: var(--parchment-deep); color: var(--text-on-light); border: 1px solid transparent; padding: 10px 20px; cursor: pointer; font-family: var(--font-body); font-size: 0.8125rem; letter-spacing: 1.5px; text-transform: uppercase; transition: border-color 0.2s, background 0.2s, color 0.2s, transform 0.15s; border-radius: 2px; }
  .po-style-btn:active { transform: scale(0.96); }
  .po-style-btn:hover { border-color: var(--accent); }
  .po-style-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }

  .po-colors { display: flex; gap: 12px; margin-bottom: 28px; }
  .po-color-swatch { width: 32px; height: 32px; border-radius: 50%; cursor: pointer; border: 2px solid transparent; transition: border-color 0.2s, box-shadow 0.2s, transform 0.15s; position: relative; }
  .po-color-swatch:hover { border-color: var(--accent-light); }
  .po-color-swatch.active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--parchment), 0 0 0 4px var(--accent); }
  .po-color-swatch::after { content: ''; position: absolute; bottom: -18px; left: 50%; transform: translateX(-50%); font-family: var(--font-body); font-size: 0.625rem; letter-spacing: 1px; text-transform: uppercase; color: var(--warm-grey); white-space: nowrap; }
  .po-color-black { background: #1a1a1a; }
  .po-color-white { background: #f5f0e8; border-color: #ddd; }
  .po-color-white.active { border-color: var(--accent); }
  .po-color-jade { background: #6b8f71; }

  .po-price { font-family: var(--font-display); font-size: 1.75rem; font-weight: 700; color: var(--text-on-light); margin-bottom: 4px; font-variant-numeric: tabular-nums; }
  .po-price-note { font-family: var(--font-mono); font-size: 0.75rem; color: var(--warm-grey); letter-spacing: 0.5px; margin-bottom: 24px; }
  .po-actions { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }

  .po-img-wrap { position: relative; overflow: hidden; border-radius: 2px; }
  .po-img { width: 100%; height: auto; aspect-ratio: 4/5; object-fit: cover; display: block; transition: transform 0.6s cubic-bezier(0.25,0.1,0.25,1); outline: 1px solid rgba(0,0,0,0.06); outline-offset: -1px; }
  .po-img-wrap:hover .po-img { transform: scale(1.03); }
  @media (max-width: 1023px) { .preorder-img-cell { order: -1; } }

  /* ── Tee section ── */
  .tee { position: relative; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='250' height='250'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.55' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='250' height='250' filter='url(%23n)' opacity='0.12'/%3E%3C/svg%3E"), linear-gradient(to bottom, #0a0a09, #181614); background-size: 250px 250px, 100% 100%; padding: 3rem 1.5rem; display: grid; grid-template-columns: 1fr; gap: 3rem; align-items: center; }
  @media (min-width: 1024px) { .tee { padding: 5.5rem 3.25rem; grid-template-columns: 1fr 1fr; gap: 5rem; } }
  .tee-img-wrap { position: relative; overflow: hidden; border-radius: 2px; }
  .tee-img { width: 100%; height: auto; aspect-ratio: 1/1; object-fit: cover; display: block; background: var(--dark-elevated); transition: transform 0.6s cubic-bezier(0.25,0.1,0.25,1); outline: 1px solid rgba(255,255,255,0.06); outline-offset: -1px; }
  .tee-img-wrap:hover .tee-img { transform: scale(1.03); }
  .tee-tag { position: absolute; top: 16px; left: 16px; background: var(--accent); color: #fff; padding: 6px 14px; font-family: var(--font-body); font-size: 0.6875rem; letter-spacing: 2px; text-transform: uppercase; border-radius: 2px; z-index: 2; }
  .tee-label { font-family: var(--font-mono); font-size: var(--step--1); letter-spacing: 0.18em; text-transform: uppercase; color: var(--accent-light); margin-bottom: 12px; }
  .tee-title { font-family: var(--font-display); font-weight: 700; font-size: var(--step-3); line-height: 0.95; color: var(--text-on-dark); letter-spacing: -0.5px; margin-bottom: 16px; text-wrap: balance; }
  .tee-title em { font-style: italic; color: var(--accent-light); }
  .tee-body { font-family: var(--font-body); font-size: var(--step-0); color: var(--text-on-dark-secondary); line-height: 1.8; max-width: 400px; margin-bottom: 20px; text-wrap: pretty; }
  .tee-spec { padding: 14px 0; border-bottom: 1px solid var(--dark-border); display: flex; justify-content: space-between; }
  .tee-spec:first-child { border-top: 1px solid var(--dark-border); }
  .tee-spec-k { font-family: var(--font-mono); font-size: 0.75rem; letter-spacing: 2px; text-transform: uppercase; color: var(--text-on-dark-secondary); }
  .tee-spec-v { font-family: var(--font-display); font-size: 0.875rem; color: var(--text-on-dark); }
  .tee-price { font-family: var(--font-display); font-size: 1.5rem; font-weight: 700; color: var(--text-on-dark); margin-top: 20px; margin-bottom: 24px; font-variant-numeric: tabular-nums; }

  /* ── Reviews ── */
  .reviews { background: var(--parchment); padding: 3rem 1.5rem; }
  @media (min-width: 1024px) { .reviews { padding: 5rem 3.25rem; } }
  .reviews-header { text-align: center; margin-bottom: 3rem; }
  .reviews-score { font-family: var(--font-display); font-size: 4rem; font-weight: 700; color: var(--text-on-light); line-height: 1; margin-bottom: 8px; font-variant-numeric: tabular-nums; }
  .reviews-tp-stars { display: flex; align-items: center; justify-content: center; gap: 4px; margin-bottom: 8px; }
  .reviews-tp-star { width: 20px; height: 20px; background: #00B67A; display: flex; align-items: center; justify-content: center; }
  .reviews-count { font-family: var(--font-mono); font-size: 0.8125rem; letter-spacing: 1.5px; color: var(--warm-grey); margin-bottom: 4px; }
  .reviews-label { font-family: var(--font-mono); font-size: 0.75rem; letter-spacing: 3px; text-transform: uppercase; color: var(--accent); }
  .reviews-grid { display: grid; grid-template-columns: 1fr; gap: 20px; }
  @media (min-width: 640px) { .reviews-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (min-width: 1024px) { .reviews-grid { grid-template-columns: repeat(3, 1fr); } }
  .rev-card { background: #fff; padding: 28px 24px; border-radius: 2px; border: 1px solid var(--parchment-deep); transition: transform 0.3s cubic-bezier(0.22,0.61,0.36,1), box-shadow 0.3s cubic-bezier(0.22,0.61,0.36,1); }
  .rev-card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px rgba(0,0,0,0.06); }
  .rev-stars { display: flex; gap: 3px; margin-bottom: 16px; }
  .rev-star { width: 12px; height: 12px; background: var(--accent); clip-path: polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%); }
  .rev-text { font-family: var(--font-body); font-size: var(--step-0); color: var(--text-on-light); line-height: 1.7; margin-bottom: 20px; text-wrap: pretty; }
  .rev-author { display: flex; align-items: center; gap: 12px; }
  .rev-avatar { width: 36px; height: 36px; border-radius: 50%; background: var(--accent-dim); color: var(--accent); display: flex; align-items: center; justify-content: center; font-family: var(--font-body); font-size: 0.8125rem; font-weight: 600; }
  .rev-name { font-family: var(--font-body); font-size: 0.8125rem; font-weight: 500; color: var(--text-on-light); letter-spacing: 0.5px; }
  .rev-verified { font-family: var(--font-mono); font-size: 0.6875rem; color: var(--warm-grey); letter-spacing: 0.5px; }

  /* ── Service strip ── */
  .service { background: var(--parchment); padding: 2rem 1.5rem; }
  @media (min-width: 768px) { .service { padding: 2.5rem 3.25rem; } }
  .service-card { background: #1B2A4A; border-radius: 4px; padding: 3rem 2rem; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 16px; }
  .service-title { font-family: var(--font-display); font-weight: 700; font-size: 1.5rem; color: #fff; text-wrap: balance; }
  .service-desc { font-family: var(--font-body); font-size: 0.875rem; color: rgba(255,255,255,0.7); max-width: 400px; line-height: 1.6; }
  .service-btn { display: inline-flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.1); color: #fff; border: 1px solid rgba(255,255,255,0.2); padding: 12px 28px; cursor: pointer; min-height: 44px; font-family: var(--font-body); font-weight: 500; font-size: 0.8125rem; letter-spacing: 1px; text-transform: uppercase; border-radius: 2px; transition: background 0.2s, border-color 0.2s, transform 0.15s; text-decoration: none; }
  .service-btn:hover { background: rgba(255,255,255,0.2); border-color: rgba(255,255,255,0.4); }
  .service-btn:active { transform: scale(0.96); }

  /* ── Newsletter ── */
  .newsletter { background: var(--dark-elevated); padding: 4rem 1.5rem; text-align: center; }
  @media (min-width: 768px) { .newsletter { padding: 5rem 3.25rem; } }
  .nl-label { font-family: var(--font-mono); font-size: var(--step--1); letter-spacing: 0.18em; text-transform: uppercase; color: var(--accent-light); margin-bottom: 12px; }
  .nl-title { font-family: var(--font-display); font-weight: 700; font-size: clamp(1.75rem, 3vw, 2.25rem); color: var(--text-on-dark); margin-bottom: 8px; text-wrap: balance; }
  .nl-sub { font-family: var(--font-body); font-size: 0.875rem; color: var(--text-on-dark-secondary); margin-bottom: 28px; max-width: 400px; margin-left: auto; margin-right: auto; line-height: 1.6; }
  .nl-form { display: flex; gap: 0; max-width: 420px; margin: 0 auto; }
  .nl-input { flex: 1; background: var(--dark-surface); border: 1px solid var(--dark-border); border-right: none; color: var(--text-on-dark); padding: 14px 16px; font-family: var(--font-body); font-size: 0.875rem; border-radius: 2px 0 0 2px; outline: none; }
  .nl-input::placeholder { color: var(--text-on-dark-secondary); }
  .nl-input:focus { border-color: var(--accent); }
  .nl-submit { background: var(--accent); color: #fff; border: none; padding: 14px 24px; cursor: pointer; font-family: var(--font-body); font-weight: 500; font-size: var(--step--1); letter-spacing: 0.12em; text-transform: uppercase; border-radius: 0 2px 2px 0; transition: background 0.2s, transform 0.15s; white-space: nowrap; }
  .nl-submit:hover { background: var(--accent-light); }
  .nl-submit:active { transform: scale(0.96); }

  /* ── Skeleton ── */
  @keyframes skel-shimmer { 0% { background-position: -468px 0; } 100% { background-position: 468px 0; } }
  .skeleton { background: linear-gradient(90deg, #f0ebe4 25%, #e8e0d5 37%, #f0ebe4 63%); background-size: 936px 100%; animation: skel-shimmer 1.6s ease-in-out infinite; border-radius: 4px; }

  /* ── Product image hover ── */
  .po-img, .tee-img { transition: transform 0.6s cubic-bezier(0.25,0.1,0.25,1); }
` as const;
