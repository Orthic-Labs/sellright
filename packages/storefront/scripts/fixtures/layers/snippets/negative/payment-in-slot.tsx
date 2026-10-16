// expect-shape: orchestration-call
// L3 variant lives under src/brand-slots/: a slot must not call a payment gateway either.
declare const sezzle: { checkout: () => void };

export default () => sezzle.checkout();
