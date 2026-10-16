# Pre-route response policy

Engine hook (`packages/api/src/pre-route-policy.ts`) that lets an API plugin reshape JSON error bodies on a declared route set.

## Declaring a policy

```ts
registerApiPlugin({
  name: 'my-plugin',
  errorPolicy: {
    routes: [{ path: '/v1/licenses/*' }, { method: ['GET', 'POST'], path: '/api/:id' }],
    transform: (body, ctx) => /* new JSON body, or undefined to leave unchanged */ body,
  },
});
```

- `routes`: `method` optional (any method) or a string/list; `path` is exact, `/prefix/*`, or `:param` segments. `/*` matches everything.
- `transform(body, ctx)`: receives the parsed JSON error body plus `{status, method, path, requestId, headers}`; returns the replacement body or `undefined`.

## Guarantees (enforced by the engine, not the plugin)

- Applies only to responses with status >= 400 and a JSON content type, on declared routes.
- Status and all headers (including `x-request-id`) are carried over unchanged; only `content-length` is dropped.
- `/v1/admin` and everything under it is never transformed, even if declared.
- Covers `app.onError` and middleware-produced errors (maintenance gate) because the middleware is mounted right after request-id/access-log.
- Multiple plugins apply in registration order. No policy registered = no-op.

## Wiring

One call site in `app.ts`: `app.use('*', preRoutePolicy(listApiPlugins))`.
