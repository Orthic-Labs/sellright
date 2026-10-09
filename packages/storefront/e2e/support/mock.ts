/** Client for the mock gateway process (support/mock-gateways.mjs): inspect what the API sent, steer Sezzle. */
import { createHmac } from 'node:crypto';
import { API_URL, MOCK_URL, SEZZLE, SEZZLE_ACCOUNT } from './env.mjs';

const get = async <T>(path: string): Promise<T> => (await fetch(MOCK_URL + '/control' + path)).json() as Promise<T>;
const post = async <T>(path: string, body: unknown = {}): Promise<T> =>
	(await fetch(MOCK_URL + '/control' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<T>;

export interface MockMail { envelopeTo: string[]; subject: string; to: string; from: string; text: string; html: string; at: number }
export interface MockHook { path: string; headers: Record<string, string>; body: string; at: number }
export interface SezzleSession { uuid: string; reference_id: string; amount: number; currency: string; complete_url: string; cancel_url: string; session: any; captures: unknown[]; refunds: unknown[] }

export const mock = {
	nmiCalls: async () => (await get<{ calls: Array<{ type: string; amount: string; orderid: string; token: string | null; transactionid: string | null }> }>('/calls?service=nmi')).calls,
	sezzleCalls: async () => (await get<{ calls: Array<{ method: string; path: string }> }>('/calls?service=sezzle')).calls,
	mails: async () => (await get<{ mails: MockMail[] }>('/mails')).mails,
	hooks: async () => (await get<{ hooks: MockHook[] }>('/hooks')).hooks,
	sezzleSessions: async () => (await get<{ sessions: SezzleSession[] }>('/sezzle/sessions')).sessions,
	/** The shopper approved on Sezzle's hosted page; Sezzle captured (intent CAPTURE). The API's next authoritative GET sees it. */
	sezzleCapture: (uuid: string) => post('/sezzle/capture', { uuid }),
	/** Forget recorded calls / hooks / mails (specs run serially against one mock, so each starts from a clean slate). */
	reset: () => post('/reset'),
	failNextHooks: (count: number) => post('/hooks/fail', { count }),
};

/** A Sezzle webhook the way Sezzle signs it: HMAC-SHA256 hex of the raw body with the merchant private key. */
export function signedSezzleWebhook(event: { eventId: string; event: 'order.captured' | 'order.authorized' | 'order.refunded'; orderUuid: string; referenceId: string }) {
	const raw = JSON.stringify({ uuid: event.eventId, event: event.event, data_type: 'order', created_at: new Date().toISOString(), data: { uuid: event.orderUuid, reference_id: event.referenceId } });
	return { raw, signature: createHmac('sha256', SEZZLE.privateKey).update(raw).digest('hex') };
}

export async function postSezzleWebhook(storeId: string, w: { raw: string; signature: string }): Promise<number> {
	const res = await fetch(`${API_URL}/v1/webhooks/sezzle/${storeId}/${SEZZLE_ACCOUNT}`, { method: 'POST', headers: { 'content-type': 'application/json', 'sezzle-signature': w.signature }, body: w.raw });
	return res.status;
}
