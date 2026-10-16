// expect-shape: definition-call
import { routeAction$, z, zod$ } from '@qwik.dev/router';

export const useInlineAction = routeAction$(() => ({ ok: true }), zod$({ word: z.string() }));
