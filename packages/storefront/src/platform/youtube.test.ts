// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { youtubeVideo, YOUTUBE_EMBED_ORIGIN } from './youtube';

describe('fixed YouTube URL boundary', () => {
	it('constructs only fixed HTTPS provider URLs from an eleven-character id', () => {
		expect(youtubeVideo('Abc123_-xyz')).toEqual({ embed: `${YOUTUBE_EMBED_ORIGIN}/embed/Abc123_-xyz?autoplay=1&rel=0`, watch: 'https://www.youtube.com/watch?v=Abc123_-xyz', thumbnail: 'https://i.ytimg.com/vi/Abc123_-xyz/hqdefault.jpg' });
	});
	it('rejects missing, short/long ids, URL/query injection & nonstrings before constructing any URLs', () => {
		for (const id of ['', 'short', 'Abc123_-xyzz', 'https://evil', 'abc?x=12345', 'abc/1234567', 'abc1234567&', '<script>abc', 'abcdefghijk\n', null, undefined, 123]) expect(youtubeVideo(id as string), String(id)).toBeNull();
	});
});
