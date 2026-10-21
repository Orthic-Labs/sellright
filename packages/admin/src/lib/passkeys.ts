import { startAuthentication, startRegistration, browserSupportsWebAuthn, browserSupportsWebAuthnAutofill } from '@simplewebauthn/browser';
import { api, ApiError, type LoginResp } from '../api';

export { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill };

export interface PasskeyRow { id: string; label: string; deviceType: string; backedUp: boolean; createdAt: string; lastUsedAt: string | null }
export interface Capabilities { passkeys: boolean }

export const CANCELLED_MESSAGE = 'Passkey request was cancelled or timed out. Try again when you are ready.';

/** Error whose message is safe to show; `cancelled` marks a user dismissal / timeout (not a failure). */
export class PasskeyError extends Error {
  constructor(message: string, public cancelled = false, public code?: string) { super(message); }
}

function isCancel(e: unknown): boolean {
  const x = e as { name?: string; code?: string; cause?: { name?: string } } | null;
  return x?.name === 'NotAllowedError' || x?.cause?.name === 'NotAllowedError' || x?.name === 'AbortError' || x?.cause?.name === 'AbortError' || x?.code === 'ERROR_CEREMONY_ABORTED';
}

const CODE_MESSAGES: Record<string, string> = {
  PASSKEY_INVALID: 'That passkey could not be verified.',
  CEREMONY_INVALID: 'The passkey request expired. Please try again.',
  FEATURE_DISABLED: 'Passkeys are not available.',
  TOTP_REQUIRED_FIRST: 'Set up your authenticator app first',
  TOO_MANY_PASSKEYS: 'You have reached the maximum number of passkeys. Remove one to add another.',
  CREDENTIAL_EXISTS: 'This passkey is already registered.',
};

/** Friendly message for any failure in a passkey flow. Never includes credential material. */
export function passkeyErrorMessage(e: unknown): string {
  if (e instanceof PasskeyError) return e.message;
  if (isCancel(e)) return CANCELLED_MESSAGE;
  if (e instanceof ApiError) return (e.code && CODE_MESSAGES[e.code]) || e.message;
  const name = (e as { name?: string } | null)?.name;
  if (name === 'WebAuthnError' || name === 'InvalidStateError') return 'This device could not complete the passkey request.';
  return e instanceof Error ? e.message : 'Passkey request failed';
}

export function isStepUpRequired(e: unknown): boolean {
  return e instanceof ApiError && e.status === 403 && e.message === 'step_up_required';
}

/** Run a browser ceremony; convert failures into PasskeyError (keeps ApiError so callers can read status/code). */
async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (e) {
    if (e instanceof ApiError) throw e;
    throw new PasskeyError(passkeyErrorMessage(e), isCancel(e));
  }
}

/** 404 or any network failure means "not available". */
export async function capabilities(): Promise<Capabilities> {
  try {
    const r = await api.get<Partial<Capabilities>>('/capabilities');
    return { passkeys: r?.passkeys === true };
  } catch { return { passkeys: false }; }
}

type Opts = { options: Parameters<typeof startAuthentication>[0]['optionsJSON'] };
type RegOpts = { options: Parameters<typeof startRegistration>[0]['optionsJSON'] };

export async function loginWithPasskey({ useBrowserAutofill = false }: { useBrowserAutofill?: boolean } = {}): Promise<LoginResp> {
  const { options } = await api.post<Opts>('/passkeys/login/options', {});
  const response = await ceremony(() => startAuthentication({ optionsJSON: options, useBrowserAutofill }));
  return api.post<LoginResp>('/passkeys/login/verify', { response });
}

export async function registerPasskey(label: string): Promise<PasskeyRow> {
  const { options } = await api.post<RegOpts>('/passkeys/register/options', {});
  const response = await ceremony(() => startRegistration({ optionsJSON: options }));
  return api.post<PasskeyRow>('/passkeys/register/verify', { response, label });
}

export async function stepUpWithPasskey(): Promise<void> {
  const { options } = await api.post<Opts>('/step-up/passkey/options', {});
  const response = await ceremony(() => startAuthentication({ optionsJSON: options }));
  await api.post('/step-up/passkey/verify', { response });
}

export async function listPasskeys(): Promise<PasskeyRow[]> {
  return (await api.get<{ items: PasskeyRow[] }>('/passkeys')).items;
}

export async function deletePasskey(id: string): Promise<void> {
  await api.del(`/passkeys/${encodeURIComponent(id)}`);
}
