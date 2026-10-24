import { describe, expect, it, vi } from 'vitest';
import { AdmissionStoppedError, createAdmission, Semaphore } from './admission.js';

// #360 N3: actual active passes never exceed the cap, also after a pass outlives its deadline.
describe('job admission', () => {
  it('keeps every slot until its pass settles; overdue passes are alarmed, never replaced', async () => {
    const onOverdue = vi.fn();
    const admission = createAdmission({ concurrency: 2, deadlineMs: 20, onOverdue });
    let running = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const passes = Array.from({ length: 6 }, (_, i) => admission.run(`job-${i}`, () => new Promise<void>((resolve) => {
      running++;
      peak = Math.max(peak, running);
      gates.push(() => { running--; resolve(); });
    })));
    await new Promise((r) => setTimeout(r, 80)); // well past the deadline
    expect(running).toBe(2);
    expect(admission.active).toBe(2);
    expect(admission.overdue).toBe(2);
    expect(onOverdue).toHaveBeenCalled();
    while (gates.length || running) {
      gates.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all(passes);
    expect(peak).toBe(2);
    expect(admission.active).toBe(0);
    expect(admission.overdue).toBe(0);
  });

  it('releases the slot when a pass throws', async () => {
    const admission = createAdmission({ concurrency: 1, deadlineMs: 1_000 });
    await expect(admission.run('boom', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await admission.run('next', async () => 'ran')).toBe('ran');
    expect(admission.active).toBe(0);
  });
});

describe('admission lanes and stop (#360 H2, L1)', () => {
  it('settlement effects and e-mails run while two long passes hold every general slot', async () => {
    const admission = createAdmission({ concurrency: 2, criticalConcurrency: 2, deadlineMs: 60_000 });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const long = [admission.run('listmonk-sync', () => gate), admission.run('catalog-manifest:stock', () => gate)];
    const queued = admission.run('auto-deliver', async () => 'general'); // waits: the general lane is full
    expect(await admission.run('pending-effects', async () => 'effects')).toBe('effects');
    expect(await admission.run('emails', async () => 'emails')).toBe('emails');
    expect(admission.active).toBe(2);
    open();
    await Promise.all(long);
    expect(await queued).toBe('general');
  });

  it('stop() refuses new passes, rejects queued ones and waits for running ones', async () => {
    const admission = createAdmission({ concurrency: 1, deadlineMs: 60_000 });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const running = admission.run('a', () => gate);
    await expect.poll(() => admission.active).toBe(1); // 'a' is admitted and running
    const queued = admission.run('b', async () => 'never');
    const stopping = admission.stop(1_000);
    await expect(queued).rejects.toBeInstanceOf(AdmissionStoppedError);
    await expect(admission.run('c', async () => 'never')).rejects.toBeInstanceOf(AdmissionStoppedError);
    open();
    await running;
    await stopping;
    expect(admission.active).toBe(0);
  });
});

describe('Semaphore', () => {
  it('admits at most `size` holders, FIFO, and ignores a double release', async () => {
    const slots = new Semaphore(2);
    const a = await slots.acquire();
    const b = await slots.acquire();
    const order: string[] = [];
    const c = slots.acquire().then((release) => { order.push('c'); return release; });
    const d = slots.acquire().then((release) => { order.push('d'); return release; });
    await Promise.resolve();
    expect(order).toEqual([]);
    a();
    a(); // idempotent: must not admit two waiters
    const releaseC = await c;
    await Promise.resolve();
    expect(order).toEqual(['c']);
    b();
    const releaseD = await d;
    expect(order).toEqual(['c', 'd']);
    releaseC();
    releaseD();
  });
});
