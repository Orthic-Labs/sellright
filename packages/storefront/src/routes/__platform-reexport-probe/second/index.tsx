// A12 probe: a second route file re-exporting the SAME loader and action as ../index.tsx.
import { component$ } from '@qwik.dev/core';
import { Form } from '@qwik.dev/router';
import { useProbeAction, useProbeLoader } from '~/platform/probe';

export { useProbeAction, useProbeLoader };

export default component$(() => {
	const loader = useProbeLoader();
	const action = useProbeAction();
	return (
		<main>
			<h1>platform re-export probe, second route</h1>
			<p data-testid="probe-loader">{loader.value.value}</p>
			<Form action={action}>
				<input name="word" data-testid="probe-word" />
				<button type="submit" data-testid="probe-submit">send</button>
			</Form>
			{action.value?.success && <p data-testid="probe-result">{action.value.echoed}</p>}
			{action.value?.failed && <p data-testid="probe-failed">{JSON.stringify(action.value.fieldErrors ?? {})}</p>}
		</main>
	);
});
