export interface Money { cents: number; currency: string }
export function addMoney(a: Money, b: Money): Money {
	return { cents: a.cents + b.cents, currency: a.currency };
}
export function negateMoney(a: Money): Money {
	return { cents: -a.cents, currency: a.currency };
}
export function zeroMoney(currency: string): Money {
	return { cents: 0, currency };
}
