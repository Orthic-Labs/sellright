import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
const state = resolve(homedir(), '.local/state/sellright-demo');
const child = spawn('/usr/lib/postgresql/17/bin/postgres', [
  '-D', resolve(state, 'postgres'), '-k', state, '-p', '5545', '-c', 'listen_addresses=',
], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill('SIGINT'));
child.on('error', () => process.exit(1));
child.on('exit', code => process.exit(code ?? 1));
