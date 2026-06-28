import { component$ } from '@qwik.dev/core';
import VerificationButton from '~/components/verification/VerificationButton';

const TRUST_SIGNALS = [
  'Free shipping over $100',
  'Lifetime defect warranty',
  'Pay in 4 with Sezzle',
  'Ships within 2 business days',
] as const;

const ReviewStars = component$<{ color?: string }>(({ color }) => (
  <div class="rev-stars">
    {[...Array(5)].map((_, i) => <div key={i} class="rev-star" style={color ? { background: color } : undefined} />)}
  </div>
));

type HomeReviewsProps = {
  tpData: { score: string; count: string; reviews: Array<{ text: string; name: string }> };
};

export const HomeTrustBar = component$(() => (
  <>
      {/* ════════ Trust Bar (scrolling ticker) ════════ */}
      <div class="trust-bar" aria-label="Trust signals">
        <div class="trust-track" style="display:inline-flex;white-space:nowrap;animation:hp-ticker 30s linear infinite">
          {[...TRUST_SIGNALS, ...TRUST_SIGNALS, ...TRUST_SIGNALS].map((item, i) => (
            <div key={`${item}-${i}`} class="trust-item">
              <span class="trust-dot" />
              <span class="trust-text">{item}</span>
            </div>
          ))}
        </div>
      </div>
  </>
));

export const HomeReviewsSection = component$<HomeReviewsProps>(({ tpData }) => (
  <>
      {/* ════════ Reviews ════════ */}
      <section class="reviews">
            <div class="reviews-header" data-reveal>
              <div class="reviews-score">{tpData.score}</div>
              <div class="reviews-tp-stars">
                {[...Array(5)].map((_, i) => (
                  <div key={i} class="reviews-tp-star">
                    <svg width="12" height="12" viewBox="0 0 10 10"><path d="M5 0l1.2 3.8H10L6.9 6.2l1.2 3.8L5 7.6 1.9 10l1.2-3.8L0 3.8h3.8z" fill="white"/></svg>
                  </div>
                ))}
              </div>
              <div class="reviews-count">Based on {tpData.count} reviews on Trustpilot</div>
              <div class="reviews-label">What Our Customers Say</div>
            </div>
            <div class="reviews-grid">
              {tpData.reviews.slice(0, 3).map((r: any) => (
                <div key={r.name} class="rev-card" data-reveal>
                  <ReviewStars />
                  <p class="rev-text">{r.text}</p>
                  <div class="rev-author">
                    <div class="rev-avatar">{r.name.charAt(0)}</div>
                    <div>
                      <div class="rev-name">{r.name}</div>
                      <div class="rev-verified">Verified Purchase</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
      </section>
  </>
));

export const HomeServiceSection = component$(() => (
  <>
      {/* ════════ Service strip ════════ */}
      <section class="service">
          <div class="service-card" data-reveal>
            <svg width="40" height="28" viewBox="0 0 60 40" fill="none" aria-hidden="true">
              <rect width="60" height="40" rx="2" fill="#B22234"/>
              <rect y="3.08" width="60" height="3.08" fill="white"/>
              <rect y="9.23" width="60" height="3.08" fill="white"/>
              <rect y="15.38" width="60" height="3.08" fill="white"/>
              <rect y="21.54" width="60" height="3.08" fill="white"/>
              <rect y="27.69" width="60" height="3.08" fill="white"/>
              <rect y="33.85" width="60" height="3.08" fill="white"/>
              <rect width="24" height="21.54" fill="#3C3B6E"/>
            </svg>
            <div class="service-title">Thank You for Your Service</div>
            <div class="service-desc">Exclusive pricing for active military, veterans, first responders, and teachers.</div>
            <VerificationButton
              variant="secondary"
              size="sm"
              class="service-btn"
            />
          </div>
      </section>
  </>
));
