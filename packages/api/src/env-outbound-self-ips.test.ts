import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

describe('OUTBOUND_SELF_IPS operator inventory', () => {
  it.each(['', '   ', '93.184.216.34', '2606:4700::1111', '::ffff:93.184.216.34', ' 93.184.216.34, 2606:4700::1111 '])(
    'accepts empty inventory or literal IPv4/IPv6 list %s', (value) => {
      expect(parseEnv({ NODE_ENV: 'test', OUTBOUND_SELF_IPS: value }).env.OUTBOUND_SELF_IPS).toBe(value);
    },
  );

  it.each(['merchant.example', 'https://93.184.216.34', '93.184.216.34:8443', '93.184.216.0/24',
    '[2606:4700::1111]', 'fe80::1%eth0', '999.1.1.1', '010.0.0.1', '93.184.216.34,', ',2606:4700::1111',
    '93.184.216.34,,2606:4700::1111', '93.184.216.34,invalid'])('rejects invalid inventory %s before boot', (value) => {
      expect(() => parseEnv({ NODE_ENV: 'test', OUTBOUND_SELF_IPS: value })).toThrow(/OUTBOUND_SELF_IPS/);
    });
});
