import { describe, expect, it } from 'vitest';
import { textBody } from './text-body.js';

describe('email text body', () => {
  it('removes markup while preserving escaped customer text', () => {
    expect(textBody('<p>Hello <strong>Tom &amp; Jo</strong></p>')).toBe('Hello Tom &amp; Jo');
  });
  it('preserves link destinations and paragraph breaks used downstream', () => {
    expect(textBody('<p><a href="https://shop.example/reset?token=a&amp;b=c"><strong>Reset</strong></a><br>Now</p><p>Thanks</p>'))
      .toBe('Reset (https://shop.example/reset?token=a&amp;b=c)\nNow\n\nThanks');
  });
  it.each(['<script>alert(1)</script>', '<scr<script>ipt>alert(1)</scr</script>ipt>', '<script'])('parses malformed or executable markup: %s', (html) => {
    expect(textBody(html)).not.toMatch(/<[a-z]/i);
  });
});
