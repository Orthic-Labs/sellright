import { describe, expect, it } from 'vitest';
import {
  canViewStorefront,
  generatePreviewToken,
  hashPreviewToken,
  isStorePublished,
  verifyPreviewToken,
} from './store-publish.js';

describe('isStorePublished', () => {
  it('defaults to published for existing stores (config null/empty/missing field)', () => {
    expect(isStorePublished(null)).toBe(true);
    expect(isStorePublished({})).toBe(true);
    expect(isStorePublished({ hostnames: ['example.com'] })).toBe(true);
  });
  it('is unpublished only on an explicit false', () => {
    expect(isStorePublished({ published: false })).toBe(false);
  });
  it('true stays published', () => {
    expect(isStorePublished({ published: true })).toBe(true);
  });
});

describe('preview tokens', () => {
  it('round-trips: a freshly issued token verifies against its own hash', () => {
    const token = generatePreviewToken();
    const hash = hashPreviewToken(token);
    expect(verifyPreviewToken({ previewTokenHash: hash }, token)).toBe(true);
  });
  it('rejects a wrong token', () => {
    const hash = hashPreviewToken(generatePreviewToken());
    expect(verifyPreviewToken({ previewTokenHash: hash }, 'not-the-token')).toBe(false);
  });
  it('rejects when no token was issued', () => {
    expect(verifyPreviewToken({}, 'anything')).toBe(false);
    expect(verifyPreviewToken(null, 'anything')).toBe(false);
  });
  it('rejects a missing supplied token', () => {
    const hash = hashPreviewToken(generatePreviewToken());
    expect(verifyPreviewToken({ previewTokenHash: hash }, undefined)).toBe(false);
    expect(verifyPreviewToken({ previewTokenHash: hash }, null)).toBe(false);
    expect(verifyPreviewToken({ previewTokenHash: hash }, '')).toBe(false);
  });
  it('two issued tokens are different', () => {
    expect(generatePreviewToken()).not.toBe(generatePreviewToken());
  });
});

describe('canViewStorefront', () => {
  it('published store: viewable with no token', () => {
    expect(canViewStorefront({}, undefined)).toBe(true);
  });
  it('unpublished store: not viewable without a token', () => {
    expect(canViewStorefront({ published: false }, undefined)).toBe(false);
  });
  it('unpublished store: viewable with the right token', () => {
    const token = generatePreviewToken();
    const hash = hashPreviewToken(token);
    expect(canViewStorefront({ published: false, previewTokenHash: hash }, token)).toBe(true);
  });
  it('unpublished store: not viewable with the wrong token', () => {
    const hash = hashPreviewToken(generatePreviewToken());
    expect(canViewStorefront({ published: false, previewTokenHash: hash }, 'wrong')).toBe(false);
  });
});
