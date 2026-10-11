// An eject (or L3 route file) that re-exports a platform loader and action (plan A12): allowed.
import { component$ } from '@qwik.dev/core';

export { useProbeAction, useProbeLoader } from '~/platform/probe';

export default component$(() => <main>probe</main>);
