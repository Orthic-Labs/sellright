// expect-shape: inject-call
export const a = (el: Element, h: string) => el.insertAdjacentHTML('beforeend', h);
export const b = (h: string) => document.write(h);
export const c = () => eval('1');
export const d = () => new Function('return 1');
export const e = (h: string) => new DOMParser().parseFromString(h, 'text/html');
