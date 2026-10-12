// expect-shape: inject-element
export const A = () => <a href="javascript:alert(1)">x</a>;
export const href = 'javascript:alert(1)';
export const t = () => setTimeout('alert(1)', 10);
export const s = (el: any) => { el.src = '/x.js'; };
