/**
 * Order codes are store-configured (SellRight #309): digits only ("1001"), prefixed ("DD30306", "RH000001") or
 * starting with '#' ("#1001"). Every route segment and query value built from a code goes through
 * encodeURIComponent ('#' would otherwise end the path), and display adds a leading '#' only when the code has none.
 */
export const displayOrderCode = (code: string): string => (code.startsWith('#') ? code : `#${code}`);

