import { describe, expect, it, vi } from 'vitest';
import { resolveSmtpPreset, sendTestEmail, SMTP_PRESETS, type CandidateSmtpSettings } from './smtp-settings.js';

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

  it('delivered=true when the transporter sends successfully', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '1' });
    const result = await sendTestEmail(settings, 'owner@example.com', () => ({ sendMail }) as never);
    expect(result).toEqual({ delivered: true });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@example.com', from: 'u' }));
  });

  it('delivered=false with the underlying error surfaced', async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error('535 authentication failed'));
    const result = await sendTestEmail(settings, 'owner@example.com', () => ({ sendMail }) as never);
    expect(result).toEqual({ delivered: false, error: '535 authentication failed' });
  });

  it('rejects without host/port before ever calling the transport factory', async () => {
    const makeTransport = vi.fn();
    const result = await sendTestEmail({ ...settings, host: '' }, 'owner@example.com', makeTransport);
    expect(result.delivered).toBe(false);
    expect(makeTransport).not.toHaveBeenCalled();
  });
});
