import { component$ } from '@qwik.dev/core';


export default component$(() => {
	return (
		<form action="/search" class="relative">
			<div class="relative">
				<div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
					<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="h-5 w-5 text-slate-400"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
				</div>
				<input
					type="search"
					name="q"
					default-value={''}
					placeholder={`Search custom knives...`}
					autoComplete="off"
					class="block w-full pl-10 pr-3 py-2 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-hidden focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-white/80 backdrop-blur-xs transition-all duration-200"
				/>
			</div>
		</form>
	);
});
