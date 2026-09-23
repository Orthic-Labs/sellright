import { component$ } from '@qwik.dev/core';
import { Link } from '@qwik.dev/router';
import { theme } from '~/theme/theme.config';

const SEZZLE_CONFIGURED = !!(import.meta.env.VITE_SEZZLE_MERCHANT_UUID as string | undefined);

export default component$(() => {
	return (
		<footer
			role="contentinfo"
			style={{
				background: '#0A0A0A',
				borderTop: '1px solid rgba(255,255,255,0.04)',
				padding: '40px 0',
			}}
		>
			<div style={{
				maxWidth: '1200px',
				margin: '0 auto',
				padding: '0 24px',
				display: 'flex',
				flexDirection: 'column',
				gap: '24px',
				alignItems: 'center',
			}}>
				{/* Links */}
				<nav style={{
					display: 'flex',
					flexWrap: 'wrap',
					justifyContent: 'center',
					gap: '16px 24px',
				}}>
					{[
						{ href: '/contact/', label: 'Contact & About' },
						{ href: '/blog/', label: 'Blog' },
						{ href: '/press/', label: 'Press' },
						{ href: '/returns/', label: 'Returns & Refunds' },
						{ href: '/track-order/', label: 'Track Order' },
						{ href: '/privacy/', label: 'Privacy' },
						{ href: '/terms/', label: 'Terms' },
					].map((link) => (
						<Link
							key={link.href}
							href={link.href}
							style={{
								fontFamily: 'var(--font-body)',
								fontSize: '0.8125rem',
								color: '#9A9488',
								textDecoration: 'none',
								minHeight: '44px',
								display: 'flex',
								alignItems: 'center',
								transition: 'color 0.15s',
							}}
							onMouseEnter$={(e: any) => { e.target.style.color = 'var(--color-accent-hover)'; }}
							onMouseLeave$={(e: any) => { e.target.style.color = '#9A9488'; }}
						>
							{link.label}
						</Link>
					))}
				</nav>

				{/* Social links */}
				<div style={{
					display: 'flex',
					justifyContent: 'center',
					gap: '20px',
				}}>
					{/* Instagram */}
					{theme.social.instagram && (
						<a
							href={theme.social.instagram}
							target="_blank"
							rel="nofollow noopener noreferrer"
							aria-label={`${theme.storeName} on Instagram`}
							style={{
								color: '#9A9488',
								transition: 'color 0.15s',
								display: 'flex',
								alignItems: 'center',
								minHeight: '44px',
								minWidth: '44px',
								justifyContent: 'center',
							}}
							onMouseEnter$={(e: any) => { e.currentTarget.querySelector('svg').style.color = 'var(--color-accent-hover)'; }}
							onMouseLeave$={(e: any) => { e.currentTarget.querySelector('svg').style.color = '#9A9488'; }}
						>
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style={{ color: 'inherit' }}>
								<rect x="2" y="2" width="20" height="20" rx="5"/>
								<circle cx="12" cy="12" r="5"/>
								<circle cx="17.5" cy="6.5" r="1.5" fill="currentColor" stroke="none"/>
							</svg>
						</a>
					)}
					{/* Facebook */}
					{theme.social.facebook && (
						<a
							href={theme.social.facebook}
							target="_blank"
							rel="nofollow noopener noreferrer"
							aria-label={`${theme.storeName} on Facebook`}
							style={{
								color: '#9A9488',
								transition: 'color 0.15s',
								display: 'flex',
								alignItems: 'center',
								minHeight: '44px',
								minWidth: '44px',
								justifyContent: 'center',
							}}
							onMouseEnter$={(e: any) => { e.currentTarget.querySelector('svg').style.color = 'var(--color-accent-hover)'; }}
							onMouseLeave$={(e: any) => { e.currentTarget.querySelector('svg').style.color = '#9A9488'; }}
						>
							<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'inherit' }}>
								<path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>
							</svg>
						</a>
					)}
					{/* Twitter/X */}
					{theme.social.twitter && (
						<a
							href={theme.social.twitter}
							target="_blank"
							rel="nofollow noopener noreferrer"
							aria-label={`${theme.storeName} on Twitter`}
							style={{
								color: '#9A9488',
								transition: 'color 0.15s',
								display: 'flex',
								alignItems: 'center',
								minHeight: '44px',
								minWidth: '44px',
								justifyContent: 'center',
							}}
							onMouseEnter$={(e: any) => { e.currentTarget.querySelector('svg').style.color = 'var(--color-accent-hover)'; }}
							onMouseLeave$={(e: any) => { e.currentTarget.querySelector('svg').style.color = '#9A9488'; }}
						>
							<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'inherit' }}>
								<path d="M18.9 2H22l-7.6 8.7L23.3 22H16.7l-5.2-6.8L5.6 22H2.5l8.1-9.3L1.6 2h6.8l4.7 6.2L18.9 2z"/>
							</svg>
						</a>
					)}
				</div>

				{/* Payment icons */}
				<div style={{
					display: 'flex',
					flexWrap: 'wrap',
					justifyContent: 'center',
					gap: '12px',
				}}>
					{/* Visa */}
					<svg width="38" height="24" viewBox="0 0 38 24"><rect width="38" height="24" rx="3" fill="#1A1F71"/><text x="19" y="15" text-anchor="middle" fill="white" font-family="Inter,sans-serif" font-size="8" font-weight="700">VISA</text></svg>
					{/* Mastercard */}
					<svg width="38" height="24" viewBox="0 0 38 24"><rect width="38" height="24" rx="3" fill="#252525"/><circle cx="15" cy="12" r="7" fill="#EB001B"/><circle cx="23" cy="12" r="7" fill="#F79E1B"/></svg>
					{/* Amex */}
					<svg width="38" height="24" viewBox="0 0 38 24"><rect width="38" height="24" rx="3" fill="#006FCF"/><text x="19" y="15" text-anchor="middle" fill="white" font-family="Inter,sans-serif" font-size="6" font-weight="700">AMEX</text></svg>
					{/* Discover */}
					<svg width="38" height="24" viewBox="0 0 38 24"><rect width="38" height="24" rx="3" fill="#252525" stroke="#333" stroke-width="0.5"/><circle cx="22" cy="12" r="6" fill="#F47216"/><circle cx="16" cy="12" r="6" fill="#1A1A1A"/></svg>
					{/* Diners Club */}
					<svg width="38" height="24" viewBox="0 0 38 24"><rect width="38" height="24" rx="3" fill="#252525" stroke="#333" stroke-width="0.5"/><circle cx="19" cy="12" r="8" fill="none" stroke="#fff" stroke-width="1.2"/><line x1="19" y1="4" x2="19" y2="20" stroke="#fff" stroke-width="1.2"/></svg>
					{/* JCB */}
					<svg width="38" height="24" viewBox="0 0 38 24"><rect width="38" height="24" rx="3" fill="#252525" stroke="#333" stroke-width="0.5"/><rect x="8" y="6" width="7" height="12" rx="1.5" fill="#0B7BC0"/><rect x="16" y="6" width="7" height="12" rx="1.5" fill="#E4001B"/><rect x="24" y="6" width="7" height="12" rx="1.5" fill="#00A650"/></svg>
					{/* Sezzle — only shown when the store has a Sezzle merchant configured */}
					{SEZZLE_CONFIGURED && (
						<svg width="38" height="24" viewBox="0 0 38 24"><rect width="38" height="24" rx="3" fill="#252525" stroke="#333" stroke-width="0.5"/><text x="19" y="15" text-anchor="middle" fill="#8B62E8" font-family="Inter,sans-serif" font-size="6" font-weight="700">Sezzle</text></svg>
					)}
				</div>

				{/* Copyright */}
				<p style={{
					fontFamily: 'var(--font-body)',
					fontSize: '0.8125rem',
					color: '#9A9488',
					margin: '0',
				}}>
					&copy; {new Date().getFullYear()} {theme.legalName}. All rights reserved.
				</p>
			</div>
		</footer>
	);
});
