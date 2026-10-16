import type { OrderDetail } from '../../api';

/** Order detail plus the order-editing fields the API adds (G13). */
export type OrderDetailX = Omit<OrderDetail, 'events'> & {
  paymentStatus?: string;
  amountDue?: number;
  adjustments?: { id: string; label: string; amount: number }[];
  shippingOverride?: boolean;
  events: (Omit<OrderDetail['events'][number], 'data'> & { data?: { note?: string; reason?: string | null; changes?: string[]; kind?: string } })[];
};

export interface AddressForm {
  fullName: string; line1: string; line2: string; city: string; province: string; postalCode: string; country: string; phone: string;
}
export const EMPTY_ADDRESS: AddressForm = { fullName: '', line1: '', line2: '', city: '', province: '', postalCode: '', country: '', phone: '' };

export interface EditContext {
  code: string; state: string; currency: string;
  editable: { items: boolean; addressOnly: boolean; address: boolean; blockedReason: string | null };
  lines: { id: string; sku: string; name: string; quantity: number; unitPrice: number; lineTotal: number; fulfilledQty: number; refundedQty: number; minQuantity: number }[];
  adjustments: { id: string; label: string; amount: number; actor: string | null; createdAt: string }[];
  shipping: { amount: number; override: boolean; methodCode: string | null };
  shippingMethods: { code: string; name: string; rate: number }[];
  amountDue: number;
  shippingAddress: Partial<Record<keyof AddressForm, string | null>> | null;
  billingAddress: Partial<Record<keyof AddressForm, string | null>> | null;
  hasCustomer: boolean;
  history: { id: string; actor: string | null; reason: string | null; balance: number; createdAt: string; grandTotalBefore: number | null; grandTotalAfter: number | null; settlement: { type?: string; status?: string; message?: string; paymentId?: string } | null }[];
}

export interface Totals { subtotal: number; discountTotal: number; shippingTotal: number; taxTotal: number; adjustmentTotal: number; grandTotal: number }
export interface LineDiff { lineId: string | null; sku: string; name: string; change: string; beforeQty: number; afterQty: number; beforeTotal: number; afterTotal: number; fromSku?: string }
export interface Preview {
  code: string; state: string; currency: string; before: Totals; after: Totals; lines: LineDiff[];
  adjustments: { id: string | null; label: string; amount: number }[];
  shipping: { amount: number; override: boolean; methodCode: string | null; methodName: string | null };
  promotion: { code: string | null; type: string; value: number } | null;
  stock: { sku: string; name: string; delta: number; available: number | null; ok: boolean }[]; stockOk: boolean;
  balance: { newGrandTotal: number; settled: number; refunded: number; netPaid: number; editRefunded: number; amountDue: number };
  settlementOptions: string[];
  refund: { feasible: boolean; reason?: string; payments: { id: string; method: string; amount: number; available: number }[] } | null;
  warnings: string[]; address: { shipping: { changed: boolean; countryChanged: boolean }; billing: { changed: boolean } };
  isPreOrder: boolean; recipientEmail: string | null;
}
export interface CommitResponse {
  editId: string; code: string; state: string; grandTotal: number; balance: number; amountDue: number; replay: boolean;
  settlement: { type: string; status: string; message?: string };
}
export type SettlementChoice =
  | { type: 'refund_now'; paymentId?: string } | { type: 'leave_credit' }
  | { type: 'send_pay_link' } | { type: 'record_payment'; method: 'cash' | 'zelle' | 'check' | 'card_phone' | 'other'; reference?: string; amount?: number }
  | { type: 'leave_due' };

export type WireOp =
  | { op: 'set_quantity'; lineId: string; quantity: number }
  | { op: 'swap_variant'; lineId: string; sku: string; quantity?: number }
  | { op: 'add_item'; sku: string; quantity: number; unitPrice?: number }
  | { op: 'apply_coupon'; code: string } | { op: 'remove_coupon' }
  | { op: 'set_shipping_method'; code: string } | { op: 'set_shipping_amount'; amount: number } | { op: 'remove_shipping' }
  | { op: 'add_adjustment'; label: string; amount: number } | { op: 'remove_adjustment'; adjustmentId: string }
  | { op: 'set_address'; kind: 'shipping' | 'billing'; address: { fullName?: string; line1: string; line2?: string; city: string; province?: string; postalCode?: string; country: string; phone?: string }; saveToAddressBook?: boolean };

export interface StagedEdit {
  qty: Record<string, number>;
  swaps: Record<string, { sku: string; name: string; quantity?: number }>;
  adds: { sku: string; name: string; quantity: number; unitPrice?: number }[];
  coupon: { mode: 'keep' | 'remove' | 'apply'; code: string };
  shipping: { mode: 'keep' | 'method' | 'custom' | 'none'; code: string; amountCents: number };
  adjAdd: { label: string; amountCents: number }[];
  adjRemove: string[];
  address: { shipping?: AddressForm; billing?: AddressForm; saveToAddressBook: boolean };
}
export const emptyStaged = (): StagedEdit => ({
  qty: {}, swaps: {}, adds: [], coupon: { mode: 'keep', code: '' }, shipping: { mode: 'keep', code: '', amountCents: 0 },
  adjAdd: [], adjRemove: [], address: { saveToAddressBook: false },
});
