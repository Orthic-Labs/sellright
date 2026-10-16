import { component$, useSignal } from '@qwik.dev/core';
import { BRAND_HEAD } from '~/platform/brand-data';
import { youtubeVideo } from '~/platform/youtube';

export interface YouTubeFacadeProps {
	id: string;
	title: string;
	class?: string;
	/** Fixed play-button geometry; classic uses currentColor for its outer surface. */
	appearance?: 'rounded' | 'classic';
}

/** A real watch link without JavaScript; the opted-in platform creates its fixed privacy frame only after a click. */
export const YouTubeFacade = component$<YouTubeFacadeProps>((props) => {
	const activated = useSignal<string | null>(null);
	const video = youtubeVideo(props.id);
	if (!video) return <span class={props.class}>{props.title}</span>;
	const enabled = BRAND_HEAD.embeds?.youtube === true;
	return (
		<div class={['sr-youtube', props.class]} style={{ aspectRatio: '16 / 9', position: 'relative' }}>
			{enabled && activated.value === props.id ? (
				<iframe
					class="sr-youtube-iframe"
					src={video.embed}
					title={props.title}
					allow="autoplay; fullscreen"
					allowFullscreen
					referrerPolicy="strict-origin-when-cross-origin"
					style={{ width: '100%', height: '100%', border: '0', display: 'block' }}
				/>
			) : (
				<a
					class="sr-youtube-facade"
					href={video.watch}
					target="_blank"
					rel="noopener noreferrer"
					aria-label={`${enabled ? 'Play' : 'Watch'} ${props.title} on YouTube`}
					preventdefault:click={enabled || undefined}
					onClick$={() => { if (enabled) activated.value = props.id; }}
					style={{ display: 'block', width: '100%', height: '100%' }}
				>
					<img class="sr-youtube-thumb" src={video.thumbnail} alt="" width={480} height={360} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
					<span class="sr-youtube-play" aria-hidden="true" style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>
						{props.appearance === 'classic' ? (
							<svg width="56" height="40" viewBox="0 0 68 48">
								<path class="sr-youtube-play-surface" d="M66.5 7.5a8 8 0 0 0-5.6-5.7C56 .5 34 .5 34 .5s-22 0-26.9 1.3A8 8 0 0 0 1.5 7.5 83.7 83.7 0 0 0 .2 24a83.7 83.7 0 0 0 1.3 16.5 8 8 0 0 0 5.6 5.7C12 47.5 34 47.5 34 47.5s22 0 26.9-1.3a8 8 0 0 0 5.6-5.7A83.7 83.7 0 0 0 67.8 24a83.7 83.7 0 0 0-1.3-16.5z" fill="currentColor" />
								<path d="M27 34l18-10-18-10z" fill="#fff" />
							</svg>
						) : (
							<svg width="68" height="48" viewBox="0 0 68 48"><rect width="68" height="48" rx="10" fill="#f00" /><path d="M27 14v20l18-10z" fill="#fff" /></svg>
						)}
					</span>
				</a>
			)}
		</div>
	);
});
