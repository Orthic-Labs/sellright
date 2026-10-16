// The only HTML renderer a brand view may use (plan §1). Content must come from the L1 `toSanitizedHtml`.
import { component$ } from '@qwik.dev/core';
import { isSanitizedHtml, type SanitizedHtml } from '~/platform/sanitized';

export const RichContent = component$<{ content: SanitizedHtml; class?: string }>((props) => {
	if (!isSanitizedHtml(props.content)) return null;
	return <div class={props.class} dangerouslySetInnerHTML={props.content.html} />;
});
