// storekit-sandbox-path: generic, dependency-free "try each configured
// environment's verifier in a fixed order, keep whichever one's failure
// ISN'T specifically 'wrong environment'" orchestration.
//
// Deliberately has NO import of `@apple/app-store-server-library` (or of
// anything from storekit-verify.ts) so it can be unit-tested in this
// sandbox TODAY, before that dependency is installed — see
// docs/dispatch/evidence/storekit-sandbox-path.md. The real per-environment
// `verify` functions storekit-verify.ts plugs in DO depend on the Apple
// library; this module only orchestrates whatever async functions it's
// handed, and knows nothing about JWS, certificates, or Apple's SDK types.
//
// Why this exists (HR-PRO-014 / TestFlight sandbox isolation): Apple's own
// docs state TestFlight in-app purchases ALWAYS use the Sandbox
// environment
// (https://developer.apple.com/documentation/storekit/testing-in-app-purchases-with-sandbox).
// This backend must accept genuine Production purchases from the public
// App Store release AND genuine Sandbox purchases from TestFlight testers
// against the SAME running deployment — there is no single "which
// environment does this deployment speak" switch that can express both
// without either rejecting every TestFlight tester (Production-only) or
// letting anyone with a free Sandbox Apple ID grant themselves real
// Production Pro (Sandbox-only, or an environment value trusted from the
// request). A request never gets to PICK which environment it is; Apple's
// signed transaction payload carries its own `environment` field, itself
// covered by the JWS signature. `verifyAcrossEnvironments` below tries
// each configured environment's OWN verifier (each pinned to exactly one
// Apple `Environment` value at construction — unchanged from the
// single-environment design this replaces) in a fixed, server-decided
// order, and returns whichever one's signature-and-shape checks actually
// match — never a client-supplied selector, and never a config value that
// could accept "any environment."
export interface EnvironmentAttempt<TResult extends { kind: string }, TEnvLabel> {
  /** Label attached to the result when THIS attempt is the one that
   *  matched (the environment's own identity, e.g. Apple's `Environment.
   *  SANDBOX` / `Environment.PRODUCTION` — kept as a generic type
   *  parameter so this module never needs to import the real enum). */
  label: TEnvLabel;
  verify: (jws: string) => Promise<TResult>;
}

/** The one result `kind` value that means "this attempt used the wrong
 *  verifier for this transaction, try the next configured environment"
 *  rather than "this transaction is bad." Every other kind (including
 *  'ok') stops the search immediately — a real failure for the environment
 *  that DOES match (bad signature, revoked, wrong bundle/product,
 *  malformed) must never be masked by silently falling through to try a
 *  different environment's verifier against the same JWS. */
const CONTINUE_KIND = 'wrong_environment';

export interface VerifyAcrossEnvironmentsResult<TResult, TEnvLabel> {
  result: TResult;
  /** The label of the attempt whose verifier actually matched, or `null`
   *  when no configured environment matched (either every attempt
   *  returned 'wrong_environment', or the one that "won" wasn't a
   *  successful 'ok' — see below). Only ever non-null when `result.kind
   *  === 'ok'`; a caller must not treat a non-null label on its own as
   *  proof of success. */
  matchedLabel: TEnvLabel | null;
}

export async function verifyAcrossEnvironments<TResult extends { kind: string }, TEnvLabel>(
  jws: string,
  attempts: ReadonlyArray<EnvironmentAttempt<TResult, TEnvLabel>>,
): Promise<VerifyAcrossEnvironmentsResult<TResult, TEnvLabel>> {
  if (attempts.length === 0) {
    // A deployment with literally no environment configured (e.g.
    // Production unconfigured AND Sandbox somehow not attempted) is a
    // caller bug, not a "no purchase matched" outcome — fail loudly rather
    // than silently reporting every transaction as unverifiable.
    throw new Error('verifyAcrossEnvironments: no environment attempts configured');
  }
  let last: TResult | null = null;
  for (const attempt of attempts) {
    const result = await attempt.verify(jws);
    if (result.kind !== CONTINUE_KIND) {
      return { result, matchedLabel: result.kind === 'ok' ? attempt.label : null };
    }
    last = result;
  }
  // Every configured attempt reported 'wrong_environment' — the
  // transaction doesn't match ANY environment this deployment is
  // configured to accept. Surface the last attempt's result (they're all
  // 'wrong_environment' at this point, so any of them is representative).
  return { result: last as TResult, matchedLabel: null };
}
