import { component$, useSignal, useVisibleTask$, $ } from '@qwik.dev/core';
import { server$ } from '@qwik.dev/router';
import { createSEOHead } from '~/utils/seo';


const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';

const SUBJECTS = [
	{ value: 'GENERAL', label: 'General Inquiry' },
	{ value: 'SHIPPING', label: 'Shipping Question' },
	{ value: 'WARRANTY', label: 'Warranty Claim' },
	{ value: 'SPARE_PARTS', label: 'Spare Parts' },
	{ value: 'CUSTOM_ORDER', label: 'Custom Order' },
	{ value: 'OTHER', label: 'Other' },
];

const submitFormServer = server$(async function(formData: {
	name: string; email: string; subject: string; message: string;
	turnstileToken: string; honeypot: string;
}) {
	const { submitContactForm } = await import('~/providers/shop/contact/contact');
	return submitContactForm(formData);
});

export default component$(() => {
	const name = useSignal('');
	const email = useSignal('');
	const subject = useSignal('GENERAL');
	const message = useSignal('');
	const honeypot = useSignal('');
	const turnstileToken = useSignal('');
	const formState = useSignal<'idle' | 'sending' | 'success' | 'error'>('idle');
	const errorMessage = useSignal('');

	useVisibleTask$(() => {
		if (!TURNSTILE_SITE_KEY) return;
		(window as any).onTurnstileLoad = () => {
			const container = document.getElementById('turnstile-container');
			if (!container) return;
			(window as any).turnstile.render(container, {
				sitekey: TURNSTILE_SITE_KEY,
				theme: 'light',
				callback: (token: string) => { turnstileToken.value = token; },
				'expired-callback': () => { turnstileToken.value = ''; },
			});
		};
		const script = document.createElement('script');
		script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad';
		script.async = true;
		document.head.appendChild(script);
	});

	const handleSubmit = $(async () => {
		if (!name.value.trim() || !email.value.trim() || !message.value.trim()) {
			errorMessage.value = 'Please fill in all required fields.';
			formState.value = 'error';
			return;
		}
		if (!turnstileToken.value && TURNSTILE_SITE_KEY) {
			errorMessage.value = 'Please complete the security check.';
			formState.value = 'error';
			return;
		}
		formState.value = 'sending';
		try {
			const result = await submitFormServer({
				name: name.value.trim(),
				email: email.value.trim(),
				subject: subject.value,
				message: message.value.trim(),
				turnstileToken: turnstileToken.value,
				honeypot: honeypot.value,
			});
			if (result.success) {
				formState.value = 'success';
			} else {
				errorMessage.value = result.message || 'Something went wrong.';
				formState.value = 'error';
			}
		} catch {
			errorMessage.value = 'Failed to send message. Please try again.';
			formState.value = 'error';
		}
	});

	return (
		<div class="bg-[#F7F2EA] min-h-screen py-6 sm:py-8 lg:py-10">
			<div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 w-full">
				<div class="max-w-4xl mx-auto">
					<div class="grid lg:grid-cols-2 gap-12 lg:gap-16">
						{/* Contact Form */}
						<div>
							<h1 class="font-['Cormorant_Garamond'] text-3xl font-bold text-[#111110] mb-6">Get In Touch</h1>

							{formState.value === 'success' ? (
								<div class="bg-white rounded-lg p-8 text-center shadow-sm">
									<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="w-16 h-16 text-[#965341] mx-auto mb-4"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
									<h2 class="font-['Cormorant_Garamond'] text-2xl font-bold text-[#111110] mb-2">Check Your Email</h2>
									<p class="text-[#555] font-['IBM_Plex_Sans'] text-sm">
										We've sent a verification email. Click the link to confirm your submission.
									</p>
								</div>
							) : (
								<div class="bg-white rounded-lg p-6 sm:p-8 shadow-sm">
									<div class="space-y-5">
										<div>
											<label class="block text-xs font-medium text-[#888] uppercase tracking-wider mb-1.5 font-['IBM_Plex_Sans']">Name *</label>
											<input
												type="text"
												value={name.value}
												onInput$={(e: any) => name.value = e.target.value}
												class="w-full px-4 py-2.5 border border-[#e0d8ce] rounded bg-[#FDFAF6] text-[#111110] text-sm font-['IBM_Plex_Sans'] focus:outline-none focus:border-[#965341] transition-colors"
												placeholder="Your name"
											/>
										</div>
										<div>
											<label class="block text-xs font-medium text-[#888] uppercase tracking-wider mb-1.5 font-['IBM_Plex_Sans']">Email *</label>
											<input
												type="email"
												value={email.value}
												onInput$={(e: any) => email.value = e.target.value}
												class="w-full px-4 py-2.5 border border-[#e0d8ce] rounded bg-[#FDFAF6] text-[#111110] text-sm font-['IBM_Plex_Sans'] focus:outline-none focus:border-[#965341] transition-colors"
												placeholder="your@email.com"
											/>
										</div>
										<div>
											<label class="block text-xs font-medium text-[#888] uppercase tracking-wider mb-1.5 font-['IBM_Plex_Sans']">Subject</label>
											<select
												value={subject.value}
												onChange$={(e: any) => subject.value = e.target.value}
												class="w-full px-4 py-2.5 border border-[#e0d8ce] rounded bg-[#FDFAF6] text-[#111110] text-sm font-['IBM_Plex_Sans'] focus:outline-none focus:border-[#965341] transition-colors"
											>
												{SUBJECTS.map(s => (
													<option key={s.value} value={s.value}>{s.label}</option>
												))}
											</select>
										</div>
										<div>
											<label class="block text-xs font-medium text-[#888] uppercase tracking-wider mb-1.5 font-['IBM_Plex_Sans']">Message *</label>
											<textarea
												value={message.value}
												onInput$={(e: any) => message.value = e.target.value}
												rows={5}
												class="w-full px-4 py-2.5 border border-[#e0d8ce] rounded bg-[#FDFAF6] text-[#111110] text-sm font-['IBM_Plex_Sans'] focus:outline-none focus:border-[#965341] transition-colors resize-vertical"
												placeholder="How can we help?"
											/>
										</div>

										{/* Honeypot */}
										<div style={{ position: 'absolute', left: '-9999px', top: '-9999px' }} aria-hidden="true">
											<input
												type="text"
												name="website"
												value={honeypot.value}
												onInput$={(e: any) => honeypot.value = e.target.value}
												tabIndex={-1}
												autocomplete="off"
											/>
										</div>

										{/* Turnstile */}
										<div id="turnstile-container" class="min-h-[65px]"></div>

										{formState.value === 'error' && (
											<p class="text-red-600 text-sm font-['IBM_Plex_Sans']">{errorMessage.value}</p>
										)}

										<button
											onClick$={handleSubmit}
											disabled={formState.value === 'sending'}
											class="w-full bg-[#965341] text-white py-3 px-6 rounded text-sm font-medium uppercase tracking-widest font-['IBM_Plex_Sans'] hover:bg-[#a06529] active:scale-[0.96] transition-colors disabled:opacity-50"
										>
											{formState.value === 'sending' ? 'Sending...' : 'Send Message'}
										</button>
									</div>
								</div>
							)}
						</div>

						{/* Right Column: Contact Information */}
						<div>
							<h2 class="font-['Cormorant_Garamond'] text-3xl font-bold text-[#111110] mb-6">Contact Info</h2>
							<div class="space-y-6 mb-8">
								<div class="flex items-start space-x-4">
									<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="w-6 h-6 text-[#965341] mt-1 flex-shrink-0"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
									<div>
										<h3 class="font-semibold text-[#111110] font-['IBM_Plex_Sans'] text-sm">Email</h3>
										<p class="text-[#555] font-['IBM_Plex_Sans'] text-sm">info@damneddesigns.com</p>
									</div>
								</div>
								<div class="flex items-start space-x-4">
									<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="w-6 h-6 text-[#965341] mt-1 flex-shrink-0"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>
									<div>
										<h3 class="font-semibold text-[#111110] font-['IBM_Plex_Sans'] text-sm">Address</h3>
										<p class="text-[#555] font-['IBM_Plex_Sans'] text-sm">
											169 Madison Ave STE 15182<br />New York, NY 10016<br />United States
										</p>
									</div>
								</div>
							</div>

							<div class="space-y-4">
								<div class="bg-white rounded-lg p-5 shadow-sm">
									<h3 class="text-sm font-medium text-[#111110] mb-2 font-['IBM_Plex_Sans'] uppercase tracking-wider">Shipping Policy</h3>
									<p class="text-[#555] text-sm font-['IBM_Plex_Sans']">In stock products ship within 2 working days via standard shipping.</p>
								</div>
								<div class="bg-white rounded-lg p-5 shadow-sm">
									<h3 class="text-sm font-medium text-[#111110] mb-2 font-['IBM_Plex_Sans'] uppercase tracking-wider">Warranty Policy</h3>
									<p class="text-[#555] text-sm font-['IBM_Plex_Sans']">Free return or replacement for factory defects within 2 days of receipt. Contact us with photo evidence of any defects.</p>
								</div>
								<div class="bg-white rounded-lg p-5 shadow-sm">
									<h3 class="text-sm font-medium text-[#111110] mb-2 font-['IBM_Plex_Sans'] uppercase tracking-wider">Spare Parts</h3>
									<p class="text-[#555] text-sm font-['IBM_Plex_Sans']">Contact us with your product model and specific part information before purchasing any replacement components.</p>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
});

export const head = () => {
	return createSEOHead({
		title: 'Contact & About Us',
		description: 'Get in touch for product inquiries, support, or questions about our precision-manufactured knives. Learn about our story, policies, and commitment to quality.',
		noindex: false,
		ogUrl: 'https://www.damneddesigns.com/contact/',
		canonical: 'https://www.damneddesigns.com/contact/',
	});
};

import type { StaticGenerateHandler } from '@qwik.dev/router';
export const onStaticGenerate: StaticGenerateHandler = () => {
  return { params: [] };
};
