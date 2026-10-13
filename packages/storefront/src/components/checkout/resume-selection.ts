/**
 * Latest-selection-wins queue for payment-method choices made on the resume view.
 *
 * A method click replaces the payment view (the in-flight resume is superseded) and starts a new resume. If a second
 * click lands before the first resume has settled, the second resume must not be dropped: the superseded first one
 * writes nothing, so a dropped second leaves the selected method with no initialised payment. Instead the last
 * selection is remembered and applied once the in-flight run settles — exactly one run per settled selection, and the
 * final applied method is always the last one the shopper chose.
 */
export interface ResumeQueue<M> {
	busy: boolean;
	pending: M | null;
}

/**
 * Runs `run(first)`; any selection made while it is in flight is queued (the newest replaces an older queued one) and
 * run once the current run settles. A call made while busy returns immediately: with a method it queues it, without
 * one (entry / late-conversion resumes) it is dropped, as before.
 */
export const drainResumes = async <M>(
	queue: ResumeQueue<M>,
	first: M | undefined,
	run: (method: M | undefined) => Promise<void>,
): Promise<void> => {
	if (queue.busy) {
		if (first !== undefined) queue.pending = first;
		return;
	}
	queue.busy = true;
	try {
		let next: M | undefined = first;
		for (;;) {
			queue.pending = null;
			await run(next);
			if (queue.pending === null) return;
			next = queue.pending;
		}
	} finally {
		queue.pending = null;
		queue.busy = false;
	}
};
