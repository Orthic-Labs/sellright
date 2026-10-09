// Test-only: a throwaway Apple-like CA and ES256 x5c signer, so StoreKit JWS in
// tests verify through the real SignedDataVerifier (same construction as
// routes/storekit-webhooks.db.test.ts). Never imported by production code.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey, sign as cryptoSign, X509Certificate } from 'node:crypto';
import { Environment, SignedDataVerifier } from '@apple/app-store-server-library';

const LEAF_EKU_OID = '1.2.840.113635.100.6.11.1';
const INTERMEDIATE_EKU_OID = '1.2.840.113635.100.6.2.1';

export interface AppleFixture {
  makeJws(payload: Record<string, unknown>): string;
  sandboxVerifier: SignedDataVerifier;
  prodVerifier: SignedDataVerifier;
  cleanup(): void;
}

export function createAppleFixture(bundleId: string, appAppleId: number): AppleFixture {
  const dir = mkdtempSync(join(tmpdir(), 'sk-fixture-'));
  const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: dir, stdio: 'pipe' });
  const derB64Of = (file: string) => readFileSync(join(dir, file), 'utf8')
    .replace(/-----BEGIN CERTIFICATE-----/, '').replace(/-----END CERTIFICATE-----/, '').replace(/\s+/g, '');
  run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'root.key']);
  run('openssl', ['req', '-x509', '-new', '-key', 'root.key', '-days', '3650', '-subj', '/CN=Test Root CA/', '-addext', 'basicConstraints=critical,CA:true', '-out', 'root.pem']);
  run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'inter.key']);
  run('openssl', ['req', '-new', '-key', 'inter.key', '-subj', '/CN=Test Intermediate CA/', '-out', 'inter.csr']);
  writeFileSync(join(dir, 'inter.ext'), `basicConstraints=critical,CA:true\n${INTERMEDIATE_EKU_OID}=critical,ASN1:NULL\n`);
  run('openssl', ['x509', '-req', '-in', 'inter.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-days', '3650', '-extfile', 'inter.ext', '-out', 'inter.pem']);
  run('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'leaf.key']);
  run('openssl', ['req', '-new', '-key', 'leaf.key', '-subj', '/CN=Test StoreKit Leaf/', '-out', 'leaf.csr']);
  writeFileSync(join(dir, 'leaf.ext'), `basicConstraints=critical,CA:false\n${LEAF_EKU_OID}=critical,ASN1:NULL\n`);
  run('openssl', ['x509', '-req', '-in', 'leaf.csr', '-CA', 'inter.pem', '-CAkey', 'inter.key', '-CAcreateserial', '-days', '3650', '-extfile', 'leaf.ext', '-out', 'leaf.pem']);
  const leafPrivPem = readFileSync(join(dir, 'leaf.key'), 'utf8');
  const x5c = [derB64Of('leaf.pem'), derB64Of('inter.pem'), derB64Of('root.pem')];
  const rootDer = new X509Certificate(readFileSync(join(dir, 'root.pem'), 'utf8')).raw;
  const b64url = (buf: Buffer) => buf.toString('base64url');
  return {
    makeJws(payload) {
      const headerB64 = b64url(Buffer.from(JSON.stringify({ alg: 'ES256', x5c })));
      const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
      const sig = cryptoSign('sha256', Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'), {
        key: createPrivateKey(leafPrivPem), dsaEncoding: 'ieee-p1363',
      });
      return `${headerB64}.${payloadB64}.${b64url(sig)}`;
    },
    sandboxVerifier: new SignedDataVerifier([rootDer], false, Environment.SANDBOX, bundleId),
    prodVerifier: new SignedDataVerifier([rootDer], false, Environment.PRODUCTION, bundleId, appAppleId),
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}
