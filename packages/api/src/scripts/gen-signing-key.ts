// Generate the Ed25519 license-signing keypair. Run ONCE per environment
// (prod = the box). The private key signs entitlement tokens; the public key is
// embedded in every licensed app's native verifier.
//
//   pnpm --filter @sellright/api exec tsx src/scripts/gen-signing-key.ts
//
// - PRIVATE key  -> set as LICENSE_SIGNING_KEY in packages/api/.env (gitignored).
//                   NEVER commit it, never ship it in a client. (stdout)
// - PUBLIC key   -> embed in each app as a Rust `[u8; 32]` (stderr, non-secret).
//
// Re-running generates a NEW key — only do that for a deliberate key rotation, and
// then ship the new public key to every app before switching the env over.

import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pem = (privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).trim();
const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
const raw = Buffer.from(jwk.x, 'base64url'); // 32 raw public-key bytes

// stdout = the secret, so it can be captured/redirected on its own.
process.stdout.write(pem + '\n');

// stderr = operator guidance + the public key (non-secret).
const e = process.stderr;
e.write('\n--- PRIVATE KEY above (stdout) ---\n');
e.write('Set it as LICENSE_SIGNING_KEY in packages/api/.env (single line, escape newlines as \\n).\n');
e.write('NEVER commit it.\n\n');
e.write('--- PUBLIC KEY (embed in each app, non-secret) ---\n');
e.write(`hex:        ${raw.toString('hex')}\n`);
e.write(`base64url:  ${raw.toString('base64url')}\n`);
e.write(`Rust [u8;32]: [${Array.from(raw).join(', ')}]\n`);
