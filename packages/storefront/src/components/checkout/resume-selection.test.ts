import { describe, expect, it } from 'vitest';
import { drainResumes, type ResumeQueue } from './resume-selection';

type Method = 'stripe' | 'nmi' | 'sezzle';

const makeQueue = (): ResumeQueue<Method> => ({ busy: false, pending: null, epoch: 0 });

/** A resume whose payment init the test releases by hand, recording which method each init ran for. */
const makeHarness = () => {
	const queue = makeQueue();
	const inits: Method[] = [];
	const releases: Array<() => void> = [];
	const run = async (method: Method | undefined) => {
		await new Promise<void>((resolve) => releases.push(resolve));
		if (method) inits.push(method);
	};
	const flush = async () => {
		for (let i = 0; i < 20 && releases.length === 0; i++) await Promise.resolve();
		releases.shift()?.();
		for (let i = 0; i < 20; i++) await Promise.resolve();
	};
	return { queue, inits, run, flush };
};

describe('resume method selection (latest wins)', () => {
	it('two rapid selections: the last one is applied, once, and nothing is left queued', async () => {
		const h = makeHarness();
		const first = drainResumes(h.queue, 'nmi', h.run);
		await Promise.resolve();
		await drainResumes(h.queue, 'sezzle', h.run); // lands while the first is in flight
		expect(h.queue.pending).toBe('sezzle');
		await h.flush(); // first settles
		await h.flush(); // queued second runs
		await first;
		expect(h.inits).toEqual(['nmi', 'sezzle']);
		expect(h.inits[h.inits.length - 1]).toBe('sezzle');
		expect(h.queue).toEqual({ busy: false, pending: null, epoch: 0 });
	});

	it('three rapid selections: intermediate ones are coalesced, final applied equals the last selected', async () => {
		const h = makeHarness();
		const first = drainResumes(h.queue, 'nmi', h.run);
		await Promise.resolve();
		await drainResumes(h.queue, 'sezzle', h.run);
		await drainResumes(h.queue, 'stripe', h.run);
		await h.flush();
		await h.flush();
		await first;
		expect(h.inits).toEqual(['nmi', 'stripe']);
		expect(h.queue).toEqual({ busy: false, pending: null, epoch: 0 });
	});

	it('a lone selection runs once; a later selection after it settled runs on its own', async () => {
		const h = makeHarness();
		const a = drainResumes(h.queue, 'nmi', h.run);
		await h.flush();
		await a;
		const b = drainResumes(h.queue, 'stripe', h.run);
		await h.flush();
		await b;
		expect(h.inits).toEqual(['nmi', 'stripe']);
	});

	it('a method-less resume (entry / late conversion) while busy is dropped and does not queue anything', async () => {
		const h = makeHarness();
		const first = drainResumes(h.queue, 'nmi', h.run);
		await Promise.resolve();
		await drainResumes(h.queue, undefined, h.run);
		expect(h.queue.pending).toBeNull();
		await h.flush();
		await first;
		expect(h.inits).toEqual(['nmi']);
	});

	it('a failing run releases the queue so the next selection can start', async () => {
		const queue = makeQueue();
		await expect(drainResumes(queue, 'nmi', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
		expect(queue).toEqual({ busy: false, pending: null, epoch: 0 });
		const seen: Array<Method | undefined> = [];
		await drainResumes(queue, 'stripe', async (m) => { seen.push(m); });
		expect(seen).toEqual(['stripe']);
	});
});
