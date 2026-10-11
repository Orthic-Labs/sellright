// Static entry stand-in for the smoke child tests: the real lock, the real startLocal, the journal the real smokeLocal writes.
// Its parameters arrive as one JSON argument, never as generated source.
import { loadConfig, recordSmokeChild, underLock } from '../lib.mjs';
import { makeContext } from '../entry.mjs';

const { config, cwd, port, pollMs } = JSON.parse(process.argv[2]);
const ctx = makeContext(loadConfig(config));
await underLock(ctx, async () => {
	const h = await ctx.deps.startLocal({ cwd, port, env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1' }, inheritFd: ctx.lockFd, parentPollMs: pollMs, onSpawn: (info) => recordSmokeChild(ctx.paths, { ...info, port, cwd }) });
	console.log(JSON.stringify({ pid: h.pid }));
	setInterval(() => {}, 1000);
	await new Promise(() => {});
});
