import { component$ } from '@qwik.dev/core';
// Tee section image — 65: decorative/lifestyle section, not a purchase decision image
import TeeImage_480 from '~/media/homelast.png?format=avif&w=480&quality=65&url';
import TeeImage_768 from '~/media/homelast.png?format=avif&w=768&quality=65&url';
import TeeImage_1024 from '~/media/homelast.png?format=avif&w=1024&quality=65&url';
import TeeImageWebP_480 from '~/media/homelast.png?format=webp&w=480&quality=70&url';
import TeeImageWebP_768 from '~/media/homelast.png?format=webp&w=768&quality=70&url';
import TeeImageWebP_1024 from '~/media/homelast.png?format=webp&w=1024&quality=70&url';
import TeeImageJPEG_1024 from '~/media/homelast.png?format=jpeg&w=1024&quality=80&url';

const TEE_SPECS = [
  { k: 'Material', v: '280gsm, 50% cotton, 45% polyester, 5% lycra' },
  { k: 'Fit', v: 'Relaxed / oversized' },
  { k: 'Print', v: 'High density + puff screen print' },
] as const;

export const HomeTeeSection = component$(() => (
  <>
      {/* ════════ The Tee section ════════ */}
      <section class="tee">
            <div class="tee-img-wrap">
              <span class="tee-tag">New Drop</span>
              <picture>
                <source type="image/avif" srcset={`${TeeImage_480} 480w, ${TeeImage_768} 768w, ${TeeImage_1024} 1024w`} sizes="(max-width: 480px) 100vw, (max-width: 1024px) 80vw, 600px" />
                <source type="image/webp" srcset={`${TeeImageWebP_480} 480w, ${TeeImageWebP_768} 768w, ${TeeImageWebP_1024} 1024w`} sizes="(max-width: 480px) 100vw, (max-width: 1024px) 80vw, 600px" />
                <img src={TeeImageJPEG_1024} alt="Damned Designs heavyweight tee - premium EDC apparel"
                  loading="lazy" decoding="async" width={1024} height={1024} class="tee-img" />
              </picture>
            </div>
            <div>
              <div class="tee-label" data-reveal>Apparel</div>
              <h2 class="tee-title" data-reveal>The Damned <em>Tee.</em></h2>
              <p class="tee-body" data-reveal>
                The same obsessive attention we put into our blades, applied to what you wear.
                Premium fabric. Considered fit. One design that says everything.
              </p>
              <div>
                {TEE_SPECS.map((s) => (
                  <div key={s.k} class="tee-spec">
                    <span class="tee-spec-k">{s.k}</span>
                    <span class="tee-spec-v">{s.v}</span>
                  </div>
                ))}
              </div>
              <div class="tee-price">$30</div>
              <a href="/products/t-shirt-mascot" class="btn-primary">Shop the Tee <span class="btn-arrow">&rarr;</span></a>
            </div>
      </section>
  </>
));
