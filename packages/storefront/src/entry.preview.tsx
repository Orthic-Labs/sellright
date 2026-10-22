// Must stay the first import: removes Node 26's server-side Web Storage globals before any app module evaluates.
import './utils/no-server-web-storage.server';
/*
 * WHAT IS THIS FILE?
 *
 * It's the bundle entry point for `pnpm preview`.
 * That is, serving your app built in production mode.
 *
 * Feel free to modify this file, but don't remove it!
 *
 * Learn more about Vite's preview command:
 * - https://vitejs.dev/config/preview-options.html#preview-options
 *
 */
import { createQwikRouter } from '@qwik.dev/router/middleware/node';
import render from './entry.ssr';

/**
 * The default export is the QwikCity adapter used by Vite preview.
 */
export default createQwikRouter({ render });
