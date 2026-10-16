// expect-shape: global-network
export const a = () => (globalThis).fetch('/shop-api');
export const b = () => (window as any).fetch('/shop-api');
export const c = () => (self)!.fetch('/shop-api');
export const d = () => ((globalThis as unknown) as Window)['fetch']('/shop-api');
export const e = () => new (window as any).WebSocket('wss://example.invalid');
export const f = () => ((global) satisfies object).XMLHttpRequest;
