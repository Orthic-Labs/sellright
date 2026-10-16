// Fixture: a reviewed (allow-listed) util path that launders the API adapter through a re-export. The checker walks into it.
export { client } from '~/sellright/client';
export const fmt = (n: number) => String(n);
