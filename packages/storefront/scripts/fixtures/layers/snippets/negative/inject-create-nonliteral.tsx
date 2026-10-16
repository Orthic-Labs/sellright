// expect-shape: inject-element
export const make = (tag: string) => document.createElement(tag);
export const g = (k: string) => (document as any)[k]('script');
