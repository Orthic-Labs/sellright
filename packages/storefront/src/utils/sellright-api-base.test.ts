import { describe, expect, it } from 'vitest';
import { resolveApiBase } from './sellright';

describe('resolveApiBase (WS-C runtime SELLRIGHT_API_URL override)', () => {
  it('prefers a non-empty runtime URL over the build-time one', () => {
    expect(resolveApiBase('https://api.example.com', 'http://127.0.0.1:3300')).toBe('https://api.example.com');
  });
  it('falls back to the build-time URL when runtime is undefined', () => {
    expect(resolveApiBase(undefined, 'http://127.0.0.1:3300')).toBe('http://127.0.0.1:3300');
  });
  it('falls back to the build-time URL when runtime is empty/whitespace', () => {
    expect(resolveApiBase('', 'http://127.0.0.1:3300')).toBe('http://127.0.0.1:3300');
    expect(resolveApiBase('   ', 'http://127.0.0.1:3300')).toBe('http://127.0.0.1:3300');
  });
  it('trims a trailing slash from either source', () => {
    expect(resolveApiBase('https://api.example.com/', 'http://127.0.0.1:3300')).toBe('https://api.example.com');
    expect(resolveApiBase(undefined, 'http://127.0.0.1:3300/')).toBe('http://127.0.0.1:3300');
  });
});
