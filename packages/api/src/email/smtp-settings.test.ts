import { describe, expect, it, vi } from 'vitest';
import { checkSmtpDestinationShape, resolveSmtpDestination, resolveSmtpPreset, sendTestEmail, SMTP_PRESETS, type CandidateSmtpSettings } from './smtp-settings.js';

describe('resolveSmtpPreset', () => {
  it('gmail preset provides host/port/secure defaults', () => {
    expect(resolveSmtpPreset('gmail')).toEqual({ host: 'smtp.gmail.com', port: 587, secure: false });
  });

  it('ses preset requires an explicit host (region-specific)', () => {
    expect(resolveSmtpPreset('ses').host).toBe('');
    expect(resolveSmtpPreset('ses', { host: 'email-smtp.us-east-1.amazonaws.com' }).host).toBe('email-smtp.us-east-1.amazonaws.com');
  });

  it('custom preset defers entirely to overrides', () => {
    expect(resolveSmtpPreset('custom', { host: 'mail.example.com', port: 25, secure: false }))
      .toEqual({ host: 'mail.example.com', port: 25, secure: false });
  });

  it('every preset id has a hint for the admin UI', () => {
    for (const id of Object.keys(SMTP_PRESETS) as Array<keyof typeof SMTP_PRESETS>) {
      expect(SMTP_PRESETS[id].hint.length).toBeGreaterThan(0);
    }
  });
});

describe('sendTestEmail', () => {
  const settings: CandidateSmtpSettings = { preset: 'custom', host: 'smtp.example.com', port: 587, secure: false, user: 'u', pass: 'p' };
  const publicLookup = { lookup: async () => [{ address: '93.184.216.34', family: 4 }] };

  it('delivered=true when the transporter sends successfully', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '1' });
    const makeTransport = vi.fn(() => ({ sendMail }) as never);
    const result = await sendTestEmail(settings, 'owner@example.com', makeTransport, publicLookup);
    expect(result).toEqual({ delivered: true });
    // G10: the connection is pinned to the vetted address; the configured name stays the TLS name.
    expect(makeTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.example.com', connectAddress: '93.184.216.34' }));
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@example.com', from: 'u' }));
  });

  it('delivered=false with a fixed category, never the transport error text (G10)', async () => {
    const auth = Object.assign(new Error('535 authentication failed for u@internal-host'), { code: 'EAUTH' });
    const result = await sendTestEmail(settings, 'owner@example.com', () => ({ sendMail: vi.fn().mockRejectedValue(auth) }) as never, publicLookup);
    expect(result).toEqual({ delivered: false, error: 'The SMTP server rejected the username or password' });
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNECTION' });
    const r2 = await sendTestEmail(settings, 'owner@example.com', () => ({ sendMail: vi.fn().mockRejectedValue(refused) }) as never, publicLookup);
    expect(r2.delivered).toBe(false);
    expect(r2.error).not.toMatch(/10\.0\.0\.5|5432|ECONN/);
  });

  it('never connects to a host that resolves to a private address (G10)', async () => {
    const makeTransport = vi.fn();
    const result = await sendTestEmail(settings, 'owner@example.com', makeTransport, { lookup: async () => [{ address: '10.0.0.5', family: 4 }] });
    expect(result.delivered).toBe(false);
    expect(makeTransport).not.toHaveBeenCalled();
  });

  it('rejects without host/port before ever calling the transport factory', async () => {
    const makeTransport = vi.fn();
    const result = await sendTestEmail({ ...settings, host: '' }, 'owner@example.com', makeTransport);
    expect(result.delivered).toBe(false);
    expect(makeTransport).not.toHaveBeenCalled();
  });
});

describe('SMTP destination policy (P8 / G10)', () => {
  it('accepts public DNS names on mail ports only', () => {
    expect(checkSmtpDestinationShape('smtp.gmail.com', 587)).toBeNull();
    expect(checkSmtpDestinationShape('smtp.gmail.com', 5432)).toBe('port_not_allowed');
    expect(checkSmtpDestinationShape('10.0.0.5', 587)).toBe('invalid_host');
    expect(checkSmtpDestinationShape('[::1]', 587)).toBe('invalid_host');
    expect(checkSmtpDestinationShape('localhost', 25)).toBe('invalid_host');
    expect(checkSmtpDestinationShape('postgres', 587)).toBe('invalid_host');
    expect(checkSmtpDestinationShape('mail.corp.internal', 587)).toBe('invalid_host');
  });

  it('resolves once and rejects any private/special record; unresolvable is its own category', async () => {
    await expect(resolveSmtpDestination('smtp.example.com', 587, async () => [{ address: '93.184.216.34', family: 4 }]))
      .resolves.toEqual({ host: 'smtp.example.com', address: '93.184.216.34' });
    await expect(resolveSmtpDestination('smtp.example.com', 587, async () => [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }]))
      .rejects.toMatchObject({ reason: 'destination_not_allowed' });
    await expect(resolveSmtpDestination('smtp.example.com', 587, async () => { throw new Error('ENOTFOUND'); }))
      .rejects.toMatchObject({ reason: 'host_unresolvable' });
  });
});
