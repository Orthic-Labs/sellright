# Damned Designs - Custom Knife Storefront

An e-commerce storefront for [Vendure](https://www.vendure.io) built with [Qwik](https://qwik.builder.io/) & [Qwik City](https://qwik.builder.io/qwikcity/overview).

A modern, responsive storefront for custom knife sales featuring:

## Features

- Cart ✅
- Checkout flow ✅
- Search facet filters ✅
- Login ✅
- Account creation ✅
- Customer account management ✅
- SPA-mode navigation ✅
- GraphQL code generation ✅
- Modern UI with custom fonts ✅
- Responsive design ✅

## Development

Development mode uses [Vite's development server](https://vitejs.dev/). During development, the `dev` command will server-side render (SSR) the output.

```shell
pnpm start
```

> Note: during dev mode, Vite may request a significant number of `.js` files. This does not represent a Qwik production build.

## Preview

The preview command will create a production build of the client modules, a production build of `src/entry.preview.tsx`, and run a local server. The preview server is only for convenience to locally preview a production build, and it should not be used as a production server.

```shell
pnpm preview # or `yarn preview`
```

## Production

The production build will generate client and server modules by running both client and server build commands. Additionally, the build command will use Typescript to run a type check on the source code.

```shell
pnpm build # or `yarn build`
```

## i18n

The application supports English translations using Qwik's `` template function.

### Marking strings for translation

Any string can be marked for translation by using the `` template function:

```typescript
export default component$((props: { name: string }) => {
	return <span>{`Hello ${props.name}!`}</span>;
});
```

English translations are stored in `src/locales/message.en.json` and loaded automatically by the application.

---

## Related

- [Vendure Docs](https://vendure.io/docs)
- [Vendure Github](https://github.com/vendure-ecommerce/vendure)
- [Vendure Discord](https://vendure.io/community)
- [Qwik Docs](https://qwik.builder.io/)
- [Qwik Github](https://github.com/BuilderIO/qwik)
- [@QwikDev](https://twitter.com/QwikDev)
- [Qwik Discord](https://qwik.builder.io/chat)
