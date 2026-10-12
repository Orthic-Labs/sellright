// expect-shape: inject-element
export const a = (el: Element) => el.setAttribute('onload', 'x()');
export const b = (el: Element, name: string) => el.setAttribute(name, 'x');
export const c = (el: Element) => el.setAttribute('srcdoc', '<p>');
