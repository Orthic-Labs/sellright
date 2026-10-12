// expect-shape: worker-register
export const a = () => navigator.serviceWorker.register('/sw.js');
export const b = () => new Worker('/w.js');
export const c = () => new SharedWorker('/w.js');
