import { component$, noSerialize, useContext, useSignal, useVisibleTask$, type NoSerialize } from '@qwik.dev/core';
import { APP_STATE } from '~/constants';
import { CloseIcon } from '~/platform/gateway';
import { Link } from '@qwik.dev/router';

export default component$(() => {
	const appState = useContext(APP_STATE);
	const panelRef = useSignal<Element>();
	const opener = useSignal<NoSerialize<Element> | null>(null);

	// FC-12, the cart drawer's approach (components/cart/Cart.tsx, #401): on open remember the opener and move focus into the
	// panel; Tab wraps inside it, Escape closes; on close focus returns to the opener if it is still there.
	useVisibleTask$(({ track, cleanup }) => {
		const open = track(() => appState.showMenu);
		if (!open || typeof document === 'undefined') return;
		const active = document.activeElement;
		opener.value = active && active !== document.body ? noSerialize(active) : null;
		let cancelled = false;
		let frame = 0;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') { appState.showMenu = false; return; }
			if (e.key !== 'Tab') return;
			const panel = panelRef.value as HTMLElement | undefined;
			if (!panel) return;
			const focusables = [...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
				.filter((el) => el.offsetParent !== null);
			if (!focusables.length) { e.preventDefault(); panel.focus(); return; }
			const first = focusables[0]!, last = focusables[focusables.length - 1]!;
			const current = document.activeElement;
			if (!panel.contains(current)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
			if (e.shiftKey && (current === first || current === panel)) { e.preventDefault(); last.focus(); }
			else if (!e.shiftKey && current === last) { e.preventDefault(); first.focus(); }
		};
		document.addEventListener('keydown', onKey);
		cleanup(() => {
			cancelled = true;
			cancelAnimationFrame(frame);
			document.removeEventListener('keydown', onKey);
			if (!appState.showMenu) {
				const back = opener.value as HTMLElement | null;
				opener.value = null;
				if (back?.isConnected) requestAnimationFrame(() => back.focus());
			}
		});
		const focusPanel = () => {
			if (cancelled) return;
			const panel = panelRef.value as HTMLElement | undefined;
			if (panel) panel.focus();
			else frame = requestAnimationFrame(focusPanel);
		};
		frame = requestAnimationFrame(focusPanel);
	}, { strategy: 'document-ready' });

	return (
		<>
			{appState.showMenu && (
				<div class="fixed inset-0 overflow-hidden z-20">
					<div class="absolute inset-0 overflow-hidden">
						<div class="absolute inset-0 bg-gray-500/75 transition-opacity opacity-100"></div>
						<div class="fixed inset-y-0 pr-10 max-w-full flex">
							<div class="w-screen max-w-md translate-x-0">
								<div ref={panelRef} role="dialog" aria-modal="true" aria-label="Menu" tabIndex={-1} class="h-full flex flex-col bg-white shadow-xl overflow-y-scroll">
									<div class="flex-1 py-6 overflow-y-auto px-4 sm:px-6">
										<div class="flex items-start justify-between">
											<h2 class="text-lg font-medium text-gray-900">{`Menu`}</h2>
											<div class="ml-3 h-7 flex items-center">
												<button
													type="button"
													class="-m-2 p-2 text-gray-400 hover:text-gray-500"
													onClick$={() => (appState.showMenu = false)}
												>
													<span class="sr-only">Close panel</span>
													<CloseIcon />
												</button>
											</div>
										</div>
										<div class="flex flex-col pt-6">
												<Link
													class="text-lg font-medium text-gray-90 hover:text-gray-500 pt-4"
													href="/shop"
												>
													Shop All Products
												</Link>
											</div>
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>
			)}
		</>
	);
});
