// expect-shape: definition-call
import { routeLoader$ as rl } from '@qwik.dev/router';

export const useRenamed = rl(() => ({ a: 1 }));
