// expect-imports: import-framework-symbol
import { createContextId, useContext } from '@qwik.dev/core';

const CART = createContextId<{ cart: unknown }>('cart-context');
export const useLeakedCart = () => useContext(CART);
