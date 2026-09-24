// Launches the generic Qwik storefront (packages/storefront/server-demo/
// entry.express.js) for the isolated demo, the same way run.mjs launches
// interactive-server.mjs: strip anything that looks like a database or
// external-service credential from the inherited environment FIRST, so a
// pm2/shell environment leak can't hand this process something it must never
// have. Unlike interactive-server.mjs this process has no database access at
// all — it only talks same-origin /v1/* back to the demo wrapper (port 4310),
// which is the one process allowed to touch sellright_demo.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

for (const key of Object.keys(process.env)) {
  if (/^(DATABASE_URL|STRIPE_|SMTP_|GMAIL_|EMAIL_PASS|APNS_|GATEWAY_ACCOUNTS|SOURCE_DATABASE_URL|VENDURE_)/.test(key)) delete process.env[key];
}

const storefrontRoot = fileURLToPath(new URL('../../packages/storefront/', import.meta.url));
const entry = resolve(storefrontRoot, 'server-demo/entry.express.js');

const child = spawn(process.execPath, [entry], {
  cwd: storefrontRoot,
  stdio: 'inherit',
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    PORT: process.env.PORT ?? '4311',
    HOST: process.env.HOST ?? '127.0.0.1',
  },
});
child.on('exit', (code) => process.exit(code ?? 1));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
