// expect-imports: import-platform-private
// A brand file may no longer re-export a private platform loader (platformApi.public lists the only public modules).
import { component$ } from '@qwik.dev/core';

export { useProbeAction, useProbeLoader } from '~/platform/probe';

export default component$(() => <main>probe</main>);
