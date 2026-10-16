// Fixed provider boundary: a video id never supplies an origin, path, query or iframe permission.
export const YOUTUBE_EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function youtubeVideo(id: string): { embed: string; watch: string; thumbnail: string } | null {
	if (typeof id !== 'string' || id.length !== 11 || !VIDEO_ID.test(id)) return null;
	return {
		embed: `${YOUTUBE_EMBED_ORIGIN}/embed/${id}?autoplay=1&rel=0`,
		watch: `https://www.youtube.com/watch?v=${id}`,
		thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
	};
}
