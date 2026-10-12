export type Cents = number;
export const formatMoney = (c: Cents) => String(c / 100);
