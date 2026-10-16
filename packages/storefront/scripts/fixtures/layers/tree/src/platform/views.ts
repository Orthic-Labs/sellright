// Fixture public platform module (layers.json platformApi.public).
export type Cents = number;
export interface ActionResult { ok: boolean }
export const formatMoney = (cents: Cents) => String(cents / 100);
export { Link } from '@qwik.dev/router';
