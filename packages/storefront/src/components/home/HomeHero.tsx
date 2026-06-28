import { component$ } from '@qwik.dev/core';
// Responsive hero images with multi-format support
// Hero (LCP) — 75: sharp enough for knife detail at this size, saves ~45KB vs q85
import HeroImage_768 from '~/media/hero.jpg?format=avif&w=768&quality=75&url';
import HeroImage_1024 from '~/media/hero.jpg?format=avif&w=1024&quality=75&url';
import HeroImage_1600 from '~/media/hero.jpg?format=avif&w=1600&quality=75&url';
import HeroImageWebP_768 from '~/media/hero.jpg?format=webp&w=768&quality=80&url';
import HeroImageWebP_1024 from '~/media/hero.jpg?format=webp&w=1024&quality=80&url';
import HeroImageWebP_1600 from '~/media/hero.jpg?format=webp&w=1600&quality=80&url';
import HeroImageJPEG_768 from '~/media/hero.jpg?format=jpeg&w=768&quality=90&url';
import HeroImageJPEG_1024 from '~/media/hero.jpg?format=jpeg&w=1024&quality=90&url';
import HeroImageJPEG_1600 from '~/media/hero.jpg?format=jpeg&w=1600&quality=90&url';

type HomeHeroProps = {
  tpData: { score: string; count: string };
};

export const HomeHero = component$<HomeHeroProps>(({ tpData }) => (
  <>
      {/* ════════ Hero ════════ */}
      <section class="hero">
        <div class="absolute inset-0">
          <picture>
            <source type="image/avif"
              srcset={`${HeroImage_768} 768w, ${HeroImage_1024} 1024w, ${HeroImage_1600} 1600w`}
              sizes="(max-width: 768px) 100vw, (max-width: 1440px) 1024px, 1600px" />
            <source type="image/webp"
              srcset={`${HeroImageWebP_768} 768w, ${HeroImageWebP_1024} 1024w, ${HeroImageWebP_1600} 1600w`}
              sizes="(max-width: 768px) 100vw, (max-width: 1440px) 1024px, 1600px" />
            <source type="image/jpeg"
              srcset={`${HeroImageJPEG_768} 768w, ${HeroImageJPEG_1024} 1024w, ${HeroImageJPEG_1600} 1600w`}
              sizes="(max-width: 768px) 100vw, (max-width: 1440px) 1024px, 1600px" />
            <img
              src={HeroImageJPEG_1024}
              alt="Premium EDC folding knife with precision craftsmanship - Damned Designs"
              loading="eager" fetchPriority="high" decoding="sync"
              width={1600} height={1067}
              class="hero-img absolute inset-0 w-full h-full object-cover"
              style="object-position: center 40%"
            />
          </picture>
          <div class="hero-overlay" />
        </div>

        <div class="scroll-hint" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.5">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>

        <div class="hero-content">
          <div style="text-shadow: 0 1px 20px rgba(0,0,0,0.4)">
            <h1 class="hero-title">
              <span class="hero-kicker-text" style="display:block;margin-bottom:16px">EDC Knives &middot; Fidgets &middot; Gear</span>
              Built to be<br /><em>carried.</em><br />Not collected.
            </h1>
            <div class="hero-kicker stagger-2" style="margin-top:16px">
              <span class="hero-kicker-dot" style="width:8px;height:8px;border-radius:50%;background:#22C55E;position:relative;display:inline-block" />
              <span class="hero-kicker-text">Pocket Fixed Blade &mdash; From $40 &mdash; Pre-Order Now</span>
            </div>
            <p class="hero-sub stagger-3">14C28N stainless steel. G10 handles. Kydex sheath. Find another at this price &mdash; we'll wait.</p>
            <div class="hero-ctas stagger-4">
              <a href="/products/pocket-fixed-blade" class="btn-primary">Shop Now <span class="btn-arrow">&rarr;</span></a>
              <a href="/shop" class="btn-ghost">See the Lineup</a>
            </div>
          </div>

          <div class="hero-meta stagger-4" style="text-shadow: 0 1px 16px rgba(0,0,0,0.5)">
            <a href="https://www.trustpilot.com/review/damneddesigns.com" target="_blank" rel="noopener noreferrer" style="text-align:right;margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid rgba(255,255,255,.18);display:block;text-decoration:none" aria-label="Trustpilot reviews">
              <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-bottom:5px">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="#00B67A"><path d="M12 2l2.9 6.26L22 9.27l-5.5 5.01L17.82 22 12 18.77 6.18 22l1.32-7.72L2 9.27l7.1-1.01L12 2z"/></svg>
                <div style="display:flex;gap:2px">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} style="width:14px;height:14px;background:#00b67a;display:flex;align-items:center;justify-content:center">
                      <svg width="9" height="9" viewBox="0 0 10 10"><path d="M5 0l1.2 3.8H10L6.9 6.2l1.2 3.8L5 7.6 1.9 10l1.2-3.8L0 3.8h3.8z" fill="white"/></svg>
                    </div>
                  ))}
                </div>
                <span style="font-size:0.75rem;letter-spacing:2.5px;text-transform:uppercase;color:rgba(255,255,255,.65)">Trustpilot</span>
              </div>
              <div style="font-size:0.75rem;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,.55)">{tpData.score} &middot; {tpData.count} reviews</div>
            </a>
            <div style="display:flex;flex-direction:column;gap:2px">
              <span class="meta-val">7+</span><span class="meta-label">Years making EDC</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:2px">
              <span class="meta-val">Free</span><span class="meta-label">Shipping over $100</span>
            </div>
          </div>
        </div>
      </section>
  </>
));
