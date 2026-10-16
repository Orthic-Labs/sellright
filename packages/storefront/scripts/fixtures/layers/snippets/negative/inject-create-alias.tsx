// expect-shape: inject-element
const make = document.createElement.bind(document);
const { createElement } = document;
const alias = document.createElement;
export const a = make('div');
export const b = createElement.call(document, 'div');
export const c = alias.call(document, 'div');
