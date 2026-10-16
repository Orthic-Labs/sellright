// A12 probe route (see src/platform/probe.ts). Re-exports the platform loader and action and renders them.
import { component$, useSignal, useVisibleTask$ } from '@qwik.dev/core';
import { Form, Link } from '@qwik.dev/router';
import { useProbeAction, useProbeLoader } from '~/platform/probe';

export { useProbeAction, useProbeLoader };

export default component$(() => {
	const loader = useProbeLoader();
	const action = useProbeAction();
	const resumed = useSignal('no');
	useVisibleTask$(() => {
		resumed.value = 'yes';
	});
	return (
		<main>
			<h1>platform re-export probe</h1>
			<p data-testid="probe-loader">{loader.value.value}</p>
			<p data-testid="probe-resumed">{resumed.value}</p>
			<Form action={action}>
				<input name="word" data-testid="probe-word" />
				<button type="submit" data-testid="probe-submit">send</button>
			</Form>
			{action.value?.success && <p data-testid="probe-result">{action.value.echoed}</p>}
			{action.value?.failed && (
				<p data-testid="probe-failed">{JSON.stringify(action.value.fieldErrors ?? {})}</p>
			)}
			<Link href="/__platform-reexport-probe/second/" data-testid="probe-link-second">second route</Link>
		</main>
	);
});
