// damned/store/src/routes/newsletter/confirm/[subscriber]/index.tsx
import { component$ } from '@qwik.dev/core';
import { routeLoader$ } from '@qwik.dev/router';
import { getListmonkService } from '~/services/ListmonkService';
import { createSEOHead } from '~/utils/seo';

type ConfirmResult =
  | { ok: true; email: string; alreadyConfirmed: boolean }
  | { ok: false; reason: 'invalid_uuid' | 'not_found' | 'listmonk_error' };

export const useConfirmLoader = routeLoader$(async ({ params, status }): Promise<ConfirmResult> => {
  const uuid = params.subscriber;
  try {
    const svc = getListmonkService();
    const sub = await svc.lookupByUuid(uuid);
    if (!sub) {
      status(404);
      return { ok: false, reason: uuid.length === 36 ? 'not_found' : 'invalid_uuid' };
    }
    if (sub.brandListStatus === 'confirmed') {
      return { ok: true, email: sub.email, alreadyConfirmed: true };
    }
    await svc.confirmSubscription(sub.id);
    return { ok: true, email: sub.email, alreadyConfirmed: false };
  } catch (err) {
    console.error('[newsletter/confirm] loader error:', err);
    status(502);
    return { ok: false, reason: 'listmonk_error' };
  }
});

export default component$(() => {
  const loader = useConfirmLoader();

  if (!loader.value.ok) {
    return (
      <div class="mx-auto max-w-2xl px-6 py-24 text-[#111110]">
        <h1 class="mb-4 font-display text-4xl">Link not valid</h1>
        <p class="mb-6 font-body text-lg">
          {loader.value.reason === 'invalid_uuid' && 'This confirmation link looks malformed.'}
          {loader.value.reason === 'not_found' && 'We could not find a subscriber matching this link.'}
          {loader.value.reason === 'listmonk_error' && 'Our newsletter system is temporarily unreachable. Please try again in a minute.'}
        </p>
        <a href="/" class="inline-block bg-[#B87333] px-6 py-3 font-body font-medium text-white hover:bg-[#9c611f]">
          Return home
        </a>
      </div>
    );
  }

  return (
    <div class="mx-auto max-w-2xl px-6 py-24 text-[#111110]">
      <h1 class="mb-6 font-display text-4xl">
        {loader.value.alreadyConfirmed ? "You're already in" : 'Welcome to Damned Designs'}
      </h1>
      <p class="mb-2 font-body text-lg">
        <span class="font-mono">{loader.value.email}</span> is confirmed on our newsletter.
      </p>
      <p class="mb-8 font-body text-base text-[#555]">
        Expect a handful of emails a year — new drops, restocks, and behind-the-blade stories. No spam, no filler.
      </p>
      <a href="/shop" class="inline-block bg-[#B87333] px-8 py-3 font-body font-medium text-white hover:bg-[#9c611f]">
        Browse the shop
      </a>
    </div>
  );
});

export const head = () =>
  createSEOHead({
    title: 'Newsletter confirmed — Damned Designs',
    description: 'Your subscription is confirmed.',
    noindex: true,
  });
