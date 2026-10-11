export interface LegacyAddress {
	streetLine1: string;
	emailAddress: string;
}
export const toLegacy = (a: LegacyAddress) => `${a.streetLine1} <${a.emailAddress}>`;
