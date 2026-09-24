import { component$ } from '@qwik.dev/core';
// Tee section image — 65: decorative/lifestyle section, not a purchase decision image
import TeeImage_480 from '~/media/homelast.png?format=avif&w=480&quality=65&url';
import TeeImage_768 from '~/media/homelast.png?format=avif&w=768&quality=65&url';
import TeeImage_1024 from '~/media/homelast.png?format=avif&w=1024&quality=65&url';
import TeeImageWebP_480 from '~/media/homelast.png?format=webp&w=480&quality=70&url';
import TeeImageWebP_768 from '~/media/homelast.png?format=webp&w=768&quality=70&url';
import TeeImageWebP_1024 from '~/media/homelast.png?format=webp&w=1024&quality=70&url';
import TeeImageJPEG_1024 from '~/media/homelast.png?format=jpeg&w=1024&quality=80&url';
import { theme } from '~/theme/theme.config';

const SPOTLIGHT_SPECS = [
  { k: 'Material', v: 'Premium fabric, considered construction' },
  { k: 'Fit', v: 'True to size' },
  { k: 'Finish', v: 'Durable, high-density print' },
] as const;

const SPOTLIGHT_SLUG = (import.meta.env.VITE_HOME_SPOTLIGHT_SLUG as string | undefined) || '/shop';
const spotlightHref = SPOTLIGHT_SLUG.startsWith('/') ? SPOTLIGHT_SLUG : `/products/${SPOTLIGHT_SLUG}`;

export const HomeTeeSection = component$(() => (
  <>
      {/* ════════ Featured product section ════════ */}
      <section class="tee">
            <div class="tee-img-wrap">
              <span class="tee-tag">New Arrival</span>
              <picture>
                <source type="image/avif" srcset={`${TeeImage_480} 480w, ${TeeImage_768} 768w, ${TeeImage_1024} 1024w`} sizes="(max-width: 480px) 100vw, (max-width: 1024px) 80vw, 600px" />
                <source type="image/webp" srcset={`${TeeImageWebP_480} 480w, ${TeeImageWebP_768} 768w, ${TeeImageWebP_1024} 1024w`} sizes="(max-width: 480px) 100vw, (max-width: 1024px) 80vw, 600px" />
                <img src={TeeImageJPEG_1024} alt={`${theme.storeName} featured product`}
                  loading="lazy" decoding="async" width={1024} height={1024} class="tee-img" />
              </picture>
            </div>
            <div>
              <div class="tee-label" data-reveal>Featured</div>
              <h2 class="tee-title" data-reveal>New <em>arrival.</em></h2>
              <p class="tee-body" data-reveal>
                The same attention to detail we put into everything we make, applied to
                our latest release. Considered materials. Considered fit.
              </p>
              <div>
                {SPOTLIGHT_SPECS.map((s) => (
                  <div key={s.k} class="tee-spec">
                    <span class="tee-spec-k">{s.k}</span>
                    <span class="tee-spec-v">{s.v}</span>
                  </div>
                ))}
              </div>
              <a href={spotlightHref} class="btn-primary">Shop Now <span class="btn-arrow">&rarr;</span></a>
            </div>
      </section>
  </>
));
