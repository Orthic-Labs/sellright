import { describe, expect, it } from 'vitest';
import { readAffiliateToken } from './affiliate-token';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';

describe('readAffiliateToken', () => {
    it('reads the token from the URL fragment (#t=) without rewriting the URL', () => {
        expect(readAffiliateToken(`https://shop.test/affiliate#t=${TOKEN}`)).toEqual({ token: TOKEN, rewriteTo: null });
    });

    it('moves a legacy ?t= token into the fragment and strips the query param', () => {
        const r = readAffiliateToken(`https://shop.test/affiliate?t=${TOKEN}`);
        expect(r.token).toBe(TOKEN);
        expect(r.rewriteTo).toBe(`https://shop.test/affiliate#t=${TOKEN}`);
        expect(r.rewriteTo).not.toContain('?t=');
    });

    it('keeps unrelated query params when stripping the legacy token', () => {
        const r = readAffiliateToken(`https://shop.test/affiliate?utm=mail&t=${TOKEN}`);
        expect(r.rewriteTo).toBe(`https://shop.test/affiliate?utm=mail#t=${TOKEN}`);
    });

    it('prefers the fragment over a stale ?t=', () => {
        expect(readAffiliateToken(`https://shop.test/affiliate?t=old#t=${TOKEN}`)).toEqual({ token: TOKEN, rewriteTo: null });
    });

    it('returns no token for a bare /affiliate or blank values', () => {
        expect(readAffiliateToken('https://shop.test/affiliate')).toEqual({ token: null, rewriteTo: null });
        expect(readAffiliateToken('https://shop.test/affiliate?t=%20')).toEqual({ token: null, rewriteTo: null });
        expect(readAffiliateToken('https://shop.test/affiliate#t=')).toEqual({ token: null, rewriteTo: null });
    });
});
