// expect-imports: import-framework-symbol
import { createContextId, useContext, useServerData, noSerialize } from '@qwik.dev/core';

export const useLeakedState = () => useContext(createContextId<unknown>('app_state'));
export const s = useServerData('x');
export const n = noSerialize({});
