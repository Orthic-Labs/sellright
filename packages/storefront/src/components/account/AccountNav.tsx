import { $, component$ } from '@qwik.dev/core';
import { Link, useLocation } from '@qwik.dev/router';
import ShoppingBagIcon from '~/components/icons/ShoppingBagIcon';
import MapPinIcon from '~/components/icons/MapPinIcon';
import LockClosedIcon from '~/components/icons/LockClosedIcon';
import HomeIcon from '~/components/icons/HomeIcon';
import HeartIcon from '~/components/icons/HeartIcon';
import LogoutIcon from '~/components/icons/LogoutIcon';
import { logoutMutation } from '~/providers/shop/customer/customer';
import { LocalAddressService } from '~/services/LocalAddressService';

const navLinks = [
	{
		title: 'Overview',
		href: '/account',
		icon: HomeIcon,
		showOnMobile: true,
	},
	{
		title: 'Orders',
		href: '/account/orders',
		icon: ShoppingBagIcon,
		showOnMobile: true,
	},
	{
		title: 'Addresses',
		href: '/account/address-book',
		icon: MapPinIcon,
		showOnMobile: true,
	},
	{
		title: 'Password',
		href: '/account/password',
		icon: LockClosedIcon,
		showOnMobile: true,
	},
	{
		title: 'Support',
		href: '/contact',
		icon: HeartIcon,
		showOnMobile: false,
	},
];

export const AccountNav = component$(() => {
	const location = useLocation();

	const handleLogout = $(async () => {
		await logoutMutation();
		LocalAddressService.clearAddresses();
		window.location.reload();
	});

	return (
		<div class="sticky top-20 sm:top-16 z-40 border-b border-gray-200 bg-white">
			<div class="max-w-[1400px] mx-auto">
				<nav class="flex items-center justify-between gap-3 sm:gap-6 lg:gap-8 overflow-x-auto scrollbar-hide px-2 sm:px-6 lg:px-8" style="-webkit-overflow-scrolling: touch;">
					{navLinks.map((link) => {
						const locationPathname = location.url.pathname;
						const normalizedLocation = locationPathname.replace(/\/$/, '');
						const normalizedHref = link.href.replace(/\/$/, '');
						const isActive = link.href === '/account'
							? normalizedLocation === normalizedHref
							: normalizedLocation.startsWith(normalizedHref);

						return (
							<Link
								key={link.href}
								href={link.href}
								class={`flex flex-col sm:flex-row items-center gap-0.5 sm:gap-2 whitespace-nowrap border-b-2 py-2 sm:py-4 px-2 sm:px-3 text-[10px] sm:text-sm font-medium transition-colors ${
									isActive
										? 'border-[#965341] text-[#965341]'
										: 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
								} ${!link.showOnMobile ? 'hidden sm:flex' : ''}`}
							>
								<div class={`h-5 w-5 sm:h-4 sm:w-4 flex-shrink-0 [&_svg]:w-full [&_svg]:h-full ${isActive ? 'text-[#965341]' : 'text-gray-400'}`} aria-hidden="true">
									<link.icon />
								</div>
								<span class="text-center">{link.title}</span>
							</Link>
						);
					})}
					<button
						onClick$={handleLogout}
						class="flex flex-col sm:flex-row items-center gap-0.5 sm:gap-2 whitespace-nowrap border-b-2 border-transparent py-2 sm:py-4 px-2 sm:px-3 text-[10px] sm:text-sm font-medium text-gray-500 hover:border-gray-300 hover:text-gray-700 transition-colors"
					>
						<div class="h-5 w-5 sm:h-4 sm:w-4 flex-shrink-0 text-gray-400 [&_svg]:w-full [&_svg]:h-full" aria-hidden="true">
							<LogoutIcon />
						</div>
						<span class="text-center">Logout</span>
					</button>
				</nav>
			</div>
		</div>
	);
});

export default AccountNav;
