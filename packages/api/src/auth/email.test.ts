import { describe, expect, it } from 'vitest';
import { normalizeEmail } from './email.js';

describe('normalizeEmail', () => {
  it('trims whitespace and lowercases the whole address', () => {
    expect(normalizeEmail('  Alice.Example@Example.COM  ')).toBe('alice.example@example.com');
  });
});
