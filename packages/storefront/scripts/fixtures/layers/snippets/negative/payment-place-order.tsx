// expect-shape: orchestration-call
import { placeOrder } from '~/platform/checkout';

export const submit = () => placeOrder();
