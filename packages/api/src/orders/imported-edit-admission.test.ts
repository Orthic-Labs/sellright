import { describe, expect, it } from 'vitest';
import { assertImportedEditAllowed, classifyImportedEditAdmission, type ImportedEditSource } from './imported-edit-admission.js';
import { OrderEditError } from './order-edit.js';

const source = (value: unknown): ImportedEditSource => ({ present: true, value });
const admission = (state: unknown) => classifyImportedEditAdmission(source({ state }));

function refusal(input: ImportedEditSource, mode: 'plan' | 'address') {
  try { assertImportedEditAllowed(classifyImportedEditAdmission(input), mode); }
  catch (error) {
    expect(error).toBeInstanceOf(OrderEditError);
    return error as OrderEditError;
  }
  return null;
}

describe('imported edit admission', () => {
  it('leaves native orders to existing native, pricing & payment guards', () => {
    expect(classifyImportedEditAdmission({ present: false })).toEqual({ planRefusal: null, addressRefusal: null });
    expect(refusal({ present: false }, 'plan')).toBeNull();
    expect(refusal({ present: false }, 'address')).toBeNull();
  });

  it.each(['PaymentAuthorized', 'PaymentSettled', 'PartiallyShipped', 'Shipped', 'PartiallyDelivered', 'Refunded', 'PartiallyRefunded'])(
    'leaves known source %s to existing guards', (state) => {
      expect(admission(state)).toEqual({ planRefusal: null, addressRefusal: null });
    },
  );

  it('does not mistake partial/source shipping for synthetic Delivered fulfillment', () => {
    for (const state of ['PartiallyShipped', 'Shipped', 'PartiallyDelivered']) {
      const classified = classifyImportedEditAdmission(source({ state, fulfillmentStatus: 'Delivered', synthetic: true }));
      expect(classified.planRefusal).toBeNull();
      expect(classified.addressRefusal).toBeNull();
    }
  });

  it('refuses repricing for source Delivered while allowing direct address admission', () => {
    expect(refusal(source({ state: 'Delivered' }), 'plan')).toMatchObject({ status: 409, code: 'ORDER_NOT_EDITABLE' });
    expect(refusal(source({ state: 'Delivered' }), 'address')).toBeNull();
  });

  it('refuses every edit & direct address save for source Cancelled', () => {
    for (const mode of ['plan', 'address'] as const) {
      expect(refusal(source({ state: 'Cancelled' }), mode)).toMatchObject({ status: 409, code: 'ORDER_NOT_EDITABLE' });
    }
  });

  it('requires reconciliation for Modifying without guessing prior state or settlement', () => {
    const input = source({ state: 'Modifying', previousState: 'PaymentSettled', isSettled: true });
    expect(refusal(input, 'plan')).toMatchObject({ status: 409, code: 'ORDER_SOURCE_STATE_REQUIRES_RECONCILIATION' });
    expect(refusal(input, 'address')).toBeNull();
  });

  it.each([undefined, null, false, 3, 'Delivered', [], {}, { state: null }, { state: 3 }, { state: '' },
    { state: ' Delivered' }, { state: 'Delivered ' }, { state: 'delivered' }, { state: 'Unknown' },
    { state: 'ArrangingAdditionalPayment' }, { state: 'AddingItems' }].map(value => ({ value })))(
    'fails closed for present malformed/missing/unknown source $value without vetoing direct address', ({ value }) => {
      expect(refusal(source(value), 'plan')).toMatchObject({ status: 409, code: 'ORDER_SOURCE_STATE_REQUIRES_RECONCILIATION' });
      expect(refusal(source(value), 'address')).toBeNull();
    },
  );
});
