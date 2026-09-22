import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const config = JSON.parse(await readFile(resolve(homedir(), '.local/state/sellright-demo/runtime.json'), 'utf8'));
const root = fileURLToPath(new URL('../../', import.meta.url));
if (process.argv.includes('--seed') || process.argv.includes('--migrate')) {
  const migrate = process.argv.includes('--migrate');
  const args = [resolve(root, 'packages/api/dist/scripts/' + (migrate ? 'migrate.js' : 'seed-demo.js'))];
  if (!migrate && process.argv.includes('--apply')) args.push('--apply');
  const result = spawnSync(process.execPath, args, {
    cwd: root, stdio: 'inherit',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...config,
      DATABASE_URL: config.DATABASE_URL_OWNER, SELLRIGHT_DEMO_SEED: '1' },
  });
  process.exit(result.status ?? 1);
}
for (const key of Object.keys(process.env)) {
  if (/^(DATABASE_URL|STRIPE_|SMTP_|GMAIL_|EMAIL_PASS|APNS_|GATEWAY_ACCOUNTS|SOURCE_DATABASE_URL)/.test(key)) delete process.env[key];
}
const { DATABASE_URL_OWNER: _owner, ...runtime } = config;
Object.assign(process.env, runtime);
await import(process.argv.includes('--read-only') ? './server.mjs' : './interactive-server.mjs');
