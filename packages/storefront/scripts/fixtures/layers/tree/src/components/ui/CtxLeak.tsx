// Fixture L2 base file that reads app state through the framework: a context hook is not an allowed framework symbol.
import { createContextId, useContext } from '@qwik.dev/core';

export const Ctx = createContextId<{ n: number }>('fixture');
export const useCtx = () => useContext(Ctx);
