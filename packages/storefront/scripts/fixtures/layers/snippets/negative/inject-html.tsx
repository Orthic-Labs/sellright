// expect-shape: inject-html
export const A = (p: { h: string }) => <div dangerouslySetInnerHTML={p.h} />;
export const b = (el: HTMLElement, h: string) => { el.innerHTML = h; };
