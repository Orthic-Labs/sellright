import { component$ } from '@qwik.dev/core';
import { theme } from '~/theme/theme.config';
// Responsive hero images with multi-format support
import HeroImage_768 from '~/media/hero.jpg?format=avif&w=768&quality=75&url';
import HeroImage_1024 from '~/media/hero.jpg?format=avif&w=1024&quality=75&url';
import HeroImage_1600 from '~/media/hero.jpg?format=avif&w=1600&quality=75&url';
import HeroImageWebP_768 from '~/media/hero.jpg?format=webp&w=768&quality=80&url';
import HeroImageWebP_1024 from '~/media/hero.jpg?format=webp&w=1024&quality=80&url';
import HeroImageWebP_1600 from '~/media/hero.jpg?format=webp&w=1600&quality=80&url';
import HeroImageJPEG_768 from '~/media/hero.jpg?format=jpeg&w=768&quality=90&url';
import HeroImageJPEG_1024 from '~/media/hero.jpg?format=jpeg&w=1024&quality=90&url';
import HeroImageJPEG_1600 from '~/media/hero.jpg?format=jpeg&w=1600&quality=90&url';

export const HomeHero = component$(() => (
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
              alt={`${theme.storeName} — featured product photography`}
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
              <span class="hero-kicker-text" style="display:block;margin-bottom:16px">{theme.storeName}</span>
              {theme.tagline}
            </h1>
            <p class="hero-sub stagger-3">Thoughtfully made. Built to last. Backed by real support.</p>
            <div class="hero-ctas stagger-4">
              <a href="/shop" class="btn-primary">Shop Now <span class="btn-arrow">&rarr;</span></a>
              <a href="/shop" class="btn-ghost">See the Lineup</a>
            </div>
          </div>

          <div class="hero-meta stagger-4" style="text-shadow: 0 1px 16px rgba(0,0,0,0.5)">
            <div style="display:flex;flex-direction:column;gap:2px">
              <span class="meta-val">Free</span><span class="meta-label">Shipping over $100</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:2px">
              <span class="meta-val">Easy</span><span class="meta-label">30-day returns</span>
            </div>
          </div>
        </div>
      </section>
  </>
));
