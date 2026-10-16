// expect-shape: definition-call
import { routeLoader$ } from '@qwik.dev/router';

export const useInline = routeLoader$(() => ({ a: 1 }));
