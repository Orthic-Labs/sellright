/** Reads the admin e2e SMTP sink (support/smtp-sink.mjs): the staff-invite accept link only ever travels by e-mail. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_DIR } from './env.mjs';

export const MAILBOX_FILE = join(RUN_DIR, 'mailbox.jsonl');

/** Undo quoted-printable soft breaks and =XX escapes (the invite link may be QP-encoded in the HTML/text parts). */
function decodeQp(raw: string): string {
	return raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** The newest staff-invite accept link e-mailed to `email` (exactly as sent), waiting up to `timeoutMs`. */
export async function inviteLinkFor(email: string, timeoutMs = 10_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	const to = email.toLowerCase();
	for (;;) {
		if (existsSync(MAILBOX_FILE)) {
			const mails = readFileSync(MAILBOX_FILE, 'utf8').trim().split('\n').filter(Boolean)
				.map((l) => JSON.parse(l) as { to: string[]; data: string })
				.filter((m) => m.to.includes(to));
			for (const m of mails.reverse()) {
				const hit = /https?:\/\/[^\s"'<>]+\/accept-invite\?token=[0-9a-f]{64}/.exec(decodeQp(m.data));
				if (hit) return hit[0];
			}
		}
		if (Date.now() > deadline) throw new Error(`no invite e-mail for ${email} within ${timeoutMs}ms`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

/** The token from the newest invite link e-mailed to `email`. */
export async function inviteTokenFor(email: string, timeoutMs = 10_000): Promise<string> {
	return new URL(await inviteLinkFor(email, timeoutMs)).searchParams.get('token')!;
}
