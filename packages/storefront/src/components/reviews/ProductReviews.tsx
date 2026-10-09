import { $, component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { getMe } from '~/services/customer';
import { getProductReviews, submitProductReview } from '~/providers/shop/rewards/rewards';
import { SellRightError } from '~/sellright/client';
import type { ReviewList } from '~/sellright/types/rewards';
import { theme } from '~/theme/theme.config';
import { pointsLabel, reviewDate, reviewErrorMessage, starString, validateReviewDraft } from '~/utils/rewards';

const PAGE = 10;
const BTN =
	'inline-flex items-center justify-center min-h-[48px] px-6 text-[13px] tracking-[0.12em] uppercase text-white bg-[var(--gold)] hover:bg-[var(--gold-d)] disabled:opacity-60 disabled:cursor-default cursor-pointer transition-colors';
const BTN_GHOST =
	'inline-flex items-center justify-center min-h-[48px] px-6 text-[13px] tracking-[0.12em] uppercase text-[var(--ink)] border border-[var(--ink)] bg-transparent hover:bg-[var(--ink)] hover:text-[var(--color-ink-contrast)] disabled:opacity-60 disabled:cursor-default cursor-pointer transition-colors';
const FIELD =
	'w-full px-3 py-2.5 text-[15px] border border-[var(--rule)] bg-white text-[var(--ink)] rounded-none focus:outline-2 focus:outline-[var(--gold)] focus:outline-offset-1';

/**
 * PDP reviews block: average + distribution, approved reviews, and a
 * write-a-review form for signed-in customers. Every number comes from the
 * API; moderation happens in the admin, so a submitted review is
 * acknowledged as "awaiting approval" unless the API reports it already
 * approved — it is never shown optimistically. Renders nothing when the
 * store has reviews switched off. Guests are pointed at sign-in: the API's
 * guest path needs a purchase proof + bot check this form does not collect.
 */
export const ProductReviews = component$<{ slug: string; productName: string }>(({ slug, productName }) => {
	const data = useSignal<ReviewList | null>(null);
	const loadError = useSignal(false);
	/** null until the session check resolves — avoids flashing "Sign in" at signed-in shoppers. */
	const signedIn = useSignal<boolean | null>(null);
	const loadingMore = useSignal(false);
	const formOpen = useSignal(false);
	const rating = useSignal(0);
	const title = useSignal('');
	const body = useSignal('');
	const name = useSignal('');
	const sending = useSignal(false);
	const error = useSignal('');
	const done = useSignal<'' | 'pending' | 'approved'>('');

	useVisibleTask$(async () => {
		try {
			data.value = await getProductReviews(slug, { limit: PAGE });
		} catch {
			loadError.value = true;
		}
		signedIn.value = await getMe().then((me) => !!me, () => false);
	});

	const more = $(async () => {
		if (!data.value || loadingMore.value) return;
		loadingMore.value = true;
		try {
			const next = await getProductReviews(slug, { limit: PAGE, offset: data.value.reviews.length });
			data.value = { ...data.value, reviews: [...data.value.reviews, ...next.reviews] };
		} catch {
			error.value = 'We could not load more reviews. Please try again.';
		} finally {
			loadingMore.value = false;
		}
	});

	const pickRating = $((e: Event) => {
		const n = Number((e.target as HTMLElement).closest('[data-star]')?.getAttribute('data-star'));
		if (n >= 1 && n <= 5) rating.value = n;
	});

	const submit = $(async () => {
		error.value = '';
		const problem = validateReviewDraft({ rating: rating.value, body: body.value });
		if (problem) {
			error.value = problem;
			return;
		}
		sending.value = true;
		try {
			const res = await submitProductReview(slug, {
				rating: rating.value,
				body: body.value.trim(),
				...(title.value.trim() ? { title: title.value.trim() } : {}),
				...(name.value.trim() ? { name: name.value.trim() } : {}),
			});
			done.value = res.status;
			formOpen.value = false;
			if (res.status === 'approved') data.value = await getProductReviews(slug, { limit: PAGE });
		} catch (e) {
			error.value = reviewErrorMessage(e instanceof SellRightError ? { status: e.status, code: e.code } : null);
		} finally {
			sending.value = false;
		}
	});

	const d = data.value;
	if (loadError.value || (d && !d.enabled)) return null;

	return (
		<section class="max-w-[1200px] mx-auto px-4 sm:px-6 pt-10 pb-28 md:pb-16 text-[var(--ink)]" id="reviews" aria-labelledby="reviews-title" data-testid="product-reviews">
			<h2 id="reviews-title" class="text-[28px] sm:text-[30px] font-bold tracking-tight" style="font-family:var(--font-heading)">Reviews</h2>
			{!d && <p class="mt-4 text-[14px] text-[var(--mid)]">Loading reviews…</p>}

			{d && d.count > 0 && (
				<div class="flex flex-wrap items-center gap-x-10 gap-y-5 my-5" data-testid="reviews-summary">
					<div>
						<div class="text-5xl font-bold leading-none" style="font-family:var(--font-heading)">{d.average.toFixed(1)}</div>
						<div class="mt-1 text-[18px] tracking-[2px] text-[var(--gold)]" role="img" aria-label={`${d.average.toFixed(1)} out of 5 stars`}>{starString(d.average)}</div>
						<div class="text-[14px] text-[var(--mid)]">{d.count} {d.count === 1 ? 'review' : 'reviews'}</div>
					</div>
					<div class="grid grid-cols-[auto_1fr_auto] items-center gap-x-2.5 gap-y-1 min-w-[220px] text-[13px] text-[var(--mid)]" aria-hidden="true">
						{([5, 4, 3, 2, 1] as const).map((n) => (
							<div key={n} class="contents">
								<span>{n}★</span>
								<span class="block h-1.5 bg-[var(--rule)] rounded-sm overflow-hidden">
									<i class="block h-full bg-[var(--gold)]" style={{ width: `${(d.distribution[n] / d.count) * 100}%` }} />
								</span>
								<span>{d.distribution[n]}</span>
							</div>
						))}
					</div>
				</div>
			)}
			{d && d.count === 0 && <p class="mt-4 text-[14px] text-[var(--mid)]">No reviews yet. Be the first to review {productName}.</p>}

			{d && d.reviews.length > 0 && (
				<div class="border-t border-[var(--rule)]">
					{d.reviews.map((r) => (
						<article key={r.id} class="py-5 border-b border-[var(--rule)]" data-testid="review-item">
							<div class="flex flex-wrap items-center gap-x-3 gap-y-1 mb-1.5 text-[13px] text-[var(--mid)]">
								<span class="text-[16px] tracking-[2px] text-[var(--gold)]" role="img" aria-label={`${r.rating} out of 5 stars`}>{starString(r.rating)}</span>
								<strong class="font-semibold text-[var(--ink)]">{r.authorName}</strong>
								{r.verifiedBuyer && <span class="text-[12px] tracking-wide text-[var(--gold)]">Verified buyer</span>}
								<time dateTime={r.createdAt}>{reviewDate(r.createdAt)}</time>
							</div>
							{r.title && <h3 class="text-[16px] font-semibold mb-1">{r.title}</h3>}
							<p class="text-[15px] leading-[1.7] whitespace-pre-wrap break-words">{r.body}</p>
							{r.reply && (
								<div class="mt-3 px-3.5 py-3 text-[14px] leading-relaxed bg-white/60 border-l-[3px] border-[var(--gold)]">
									<b class="font-semibold">Reply from {theme.storeName}:</b> {r.reply}
								</div>
							)}
						</article>
					))}
				</div>
			)}
			{d && d.reviews.length < d.count && (
				<div class="mt-4">
					<button type="button" class={BTN_GHOST} disabled={loadingMore.value} onClick$={more}>
						{loadingMore.value ? 'Loading…' : 'Show more reviews'}
					</button>
				</div>
			)}

			{done.value && (
				<p class="mt-5 text-[14px] leading-relaxed" role="status" data-testid="review-ack">
					{done.value === 'approved' ? 'Thanks, your review is live.' : 'Thanks for your review. It will appear once it has been approved.'}
					{d && d.bonusPoints > 0 && done.value === 'pending' ? ` You'll earn ${pointsLabel(d.bonusPoints)} when it is approved.` : ''}
				</p>
			)}

			{d && !done.value && (
				<div class="flex flex-wrap items-center gap-3 mt-5">
					{signedIn.value === true && !formOpen.value && (
						<button type="button" class={BTN} onClick$={() => { formOpen.value = true; }}>Write a review</button>
					)}
					{signedIn.value === false && (
						<p class="text-[14px]"><a class="underline" href="/sign-in">Sign in</a> to write a review.</p>
					)}
					{signedIn.value === true && d.bonusPoints > 0 && !formOpen.value && (
						<span class="text-[14px] text-[var(--mid)]">Earn {pointsLabel(d.bonusPoints)} when your review is approved.</span>
					)}
				</div>
			)}

			{formOpen.value && (
				<form class="mt-5 p-5 bg-white/60 grid gap-3.5 max-w-[640px]" preventdefault:submit onSubmit$={submit} aria-label="Write a review">
					<div>
						<div class="text-[13px] tracking-wide text-[var(--mid)]" id="rv-rating-label">Your rating</div>
						<div class="flex gap-1" role="radiogroup" aria-labelledby="rv-rating-label">
							{[1, 2, 3, 4, 5].map((n) => (
								<button
									key={n}
									type="button"
									role="radio"
									data-star={n}
									aria-checked={rating.value === n}
									aria-label={`${n} ${n === 1 ? 'star' : 'stars'}`}
									class={`min-w-11 min-h-11 text-[28px] leading-none bg-transparent border-0 cursor-pointer ${rating.value >= n ? 'text-[var(--gold)]' : 'text-[var(--rule)]'}`}
									onClick$={pickRating}
								>★</button>
							))}
						</div>
					</div>
					<label class="grid gap-1.5 text-[13px] tracking-wide text-[var(--mid)]">Title (optional)
						<input class={FIELD} type="text" maxLength={120} value={title.value} onInput$={(_, el) => { title.value = el.value; }} />
					</label>
					<label class="grid gap-1.5 text-[13px] tracking-wide text-[var(--mid)]">Your review
						<textarea class={FIELD} rows={5} maxLength={5000} required value={body.value} onInput$={(_, el) => { body.value = el.value; }} />
					</label>
					<label class="grid gap-1.5 text-[13px] tracking-wide text-[var(--mid)]">Display name (optional)
						<input class={FIELD} type="text" maxLength={60} value={name.value} onInput$={(_, el) => { name.value = el.value; }} />
					</label>
					{error.value && <p class="text-[14px] text-red-700" role="alert">{error.value}</p>}
					<div class="flex flex-wrap items-center gap-3">
						<button type="submit" class={BTN} disabled={sending.value}>{sending.value ? 'Sending…' : 'Submit review'}</button>
						<button type="button" class={BTN_GHOST} onClick$={() => { formOpen.value = false; }}>Cancel</button>
					</div>
				</form>
			)}
			{!formOpen.value && error.value && <p class="mt-3 text-[14px] text-red-700" role="alert">{error.value}</p>}
		</section>
	);
});
