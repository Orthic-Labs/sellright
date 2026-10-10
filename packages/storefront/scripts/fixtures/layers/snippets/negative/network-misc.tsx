// expect-shape: global-network
export const a = () => window.fetch('/x');
export const b = () => navigator.sendBeacon('/x', 'y');
export const c = () => new WebSocket('wss://example.invalid');
export const d = () => new XMLHttpRequest();
