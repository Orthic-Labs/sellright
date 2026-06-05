// damned/store/src/routes/newsletter/unsubscribe/[subscriber]/index.tsx
// One-click unsubscribe: loader auto-unsubscribes on GET.
// Idempotent — re-visits are safe and show the same confirmation.
import { component$ } from '@qwik.dev/core';
import { routeLoader$ } from '@qwik.dev/router';
import { getListmonkService } from '~/services/ListmonkService';
import { createSEOHead } from '~/utils/seo';

type LoaderResult =
  | { ok: true; email: string; alreadyUnsubbed: boolean }
  | { ok: false; reason: 'invalid_uuid' | 'not_found' | 'listmonk_error' };

export const useUnsubscribeLoader = routeLoader$(async ({ params, status }): Promise<LoaderResult> => {
  const uuid = params.subscriber;
  try {
    const svc = getListmonkService();
    const sub = await svc.lookupByUuid(uuid);
    if (!sub) {
      status(404);
      return { ok: false, reason: uuid.length === 36 ? 'not_found' : 'invalid_uuid' };
    }
    const alreadyUnsubbed = sub.brandListStatus === 'unsubscribed' || sub.brandListStatus === 'not_subscribed';
    if (!alreadyUnsubbed) {
      await svc.unsubscribeFromBrand(sub.id);
    }
    return { ok: true, email: sub.email, alreadyUnsubbed };
  } catch (err) {
    console.error('[newsletter/unsubscribe] loader error:', err);
    status(502);
    return { ok: false, reason: 'listmonk_error' };
  }
});

export default component$(() => {
  const loader = useUnsubscribeLoader();

  if (!loader.value.ok) {
    return (
      <div class="mx-auto max-w-2xl px-6 py-24 text-[#111110]">
        <h1 class="mb-4 font-display text-4xl">Link not valid</h1>
        <p class="mb-6 font-body text-lg">
          {loader.value.reason === 'invalid_uuid' && 'This unsubscribe link looks malformed.'}
          {loader.value.reason === 'not_found' && 'We could not find a subscriber matching this link. You may already be unsubscribed.'}
          {loader.value.reason === 'listmonk_error' && 'Our newsletter system is temporarily unreachable. Please try again in a minute.'}
        </p>
        <a href="/" class="inline-block bg-[#B87333] px-6 py-3 font-body font-medium text-white hover:bg-[#9c611f]">
          Return home
        </a>
      </div>
    );
  }

  return (
    <div class="mx-auto max-w-2xl px-6 py-16 text-[#111110]">
      <h1 class="mb-6 font-display text-4xl">You're unsubscribed</h1>
      <p class="mb-2 font-body text-lg">
        {loader.value.alreadyUnsubbed
          ? <>
              <span class="font-mono">{loader.value.email}</span> is no longer on the Damned Designs marketing list.
            </>
          : <>
              <span class="font-mono">{loader.value.email}</span> has been removed from the Damned Designs marketing list.
            </>
        }
      </p>
      <p class="mb-8 font-body text-base text-[#555]">
        You'll still receive transactional emails (order confirmations, shipping updates, account activity). Any other
        newsletters you're subscribed to separately are unaffected. Need to fully delete your data? Email{' '}
        <a class="underline" href="mailto:info@damneddesigns.com">info@damneddesigns.com</a>.
      </p>
      <a href="/" class="inline-block bg-[#B87333] px-6 py-3 font-body font-medium text-white hover:bg-[#9c611f]">
        Return to Damned Designs
      </a>
    </div>
  );
});

export const head = () =>
  createSEOHead({
    title: 'Unsubscribed — Damned Designs',
    description: 'You have been unsubscribed from the Damned Designs newsletter.',
    noindex: true,
  });
