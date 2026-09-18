import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const state = resolve(homedir(), '.local/state/sellright-demo');
await mkdir(state, { recursive: true, mode: 0o700 });
const socket = encodeURIComponent(state);
const config = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://sellright_demo_app@localhost:5545/sellright_demo?host=' + socket,
  DATABASE_URL_OWNER: 'postgresql://sr_demo_owner@localhost:5545/sellright_demo?host=' + socket,
  SELLRIGHT_DEMO: '1',
  DEMO_PORT: '4310',
  DEMO_ADMIN_PASSWORD: randomBytes(32).toString('hex'),
  DOWNLOAD_URL_SECRET: randomBytes(32).toString('hex'),
  SMTP_ENABLED: 'false',
  JOBS_ENABLED: '0',
  JOBS_PUSH_ENABLED: '0',
  GATEWAY_ACCOUNTS_JSON: '[]',
  STOREFRONT_URL: 'https://demo.sellright.cc/shop',
  PGAPPNAME: 'sellright-demo',
  PGPOOL_MAX: '4',
  ASSET_DIR: resolve(state, 'assets'),
  DOWNLOAD_DIR: resolve(state, 'downloads'),
};
await writeFile(resolve(state, 'runtime.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log('Created private demo runtime configuration; no credentials printed');
