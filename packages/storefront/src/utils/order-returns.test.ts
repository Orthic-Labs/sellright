import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReturnRequest, returnStatusLabel, RETURN_STATUS_LABEL } from './order-returns';

describe('buildReturnRequest', () => {
	it('keeps only positive whole quantities and trims the reason', () => {
		const built = buildReturnRequest({ S1: 2, S2: 0, S3: -1, S4: 1.5, S5: 1 }, '  too small  ');
		expect(built).toEqual({ ok: true, lines: [{ sku: 'S1', quantity: 2 }, { sku: 'S5', quantity: 1 }], reason: 'too small' });
	});

	it('refuses an empty selection', () => {
		expect(buildReturnRequest({}, 'damaged')).toEqual({ ok: false, message: 'Choose at least one item to return.' });
		expect(buildReturnRequest({ S1: 0 }, 'damaged')).toEqual({ ok: false, message: 'Choose at least one item to return.' });
	});

	it('refuses a missing or too-short reason', () => {
		expect(buildReturnRequest({ S1: 1 }, ' ')).toEqual({ ok: false, message: 'Tell us briefly why you are returning it.' });
		expect(buildReturnRequest({ S1: 1 }, 'no')).toEqual({ ok: false, message: 'Tell us briefly why you are returning it.' });
		expect(buildReturnRequest({ S1: 1 }, 'fit').ok).toBe(true);
	});
});

describe('returnStatusLabel', () => {
	it('covers every API status and tolerates an unknown one', () => {
		for (const status of ['requested', 'approved', 'received', 'refunded', 'rejected']) {
			expect(returnStatusLabel(status)).toBe(RETURN_STATUS_LABEL[status as keyof typeof RETURN_STATUS_LABEL]);
		}
		expect(returnStatusLabel('refunded').label).toBe('Refunded');
		expect(() => returnStatusLabel('something-new')).not.toThrow();
		expect(returnStatusLabel('something-new').label).toBe('Return requested');
	});

	it('the returns panel reads statuses through the guard, never by direct indexing', () => {
		const src = readFileSync(join(process.cwd(), 'src/components/account/OrderReturns.tsx'), 'utf8');
		expect(src).toContain('returnStatusLabel(r.status)');
		expect(src).not.toMatch(/STATUS_LABEL\[/);
	});
});
