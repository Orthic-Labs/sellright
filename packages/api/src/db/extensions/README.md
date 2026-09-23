# Schema extensions

Extension seam: drop your own Drizzle `pgTable(...)` module(s) in this
directory and `pnpm db:generate` (drizzle-kit) picks them up automatically —
see `../../../drizzle.config.ts`'s `schema` array, which globs
`src/db/extensions/**/*.ts` alongside `src/db/schema.ts`. No SellRight
`schema-*.ts` file needs to change.

This directory ships empty; it exists only so the glob has somewhere to look.
Nothing here is auto-imported into the shared `s.*` namespace exported by
`../schema.js` — import your own tables directly from your own module in your
own route files, e.g.:

```ts
// src/db/extensions/schema-myapp.ts
import { pgTable, uuid, text } from 'drizzle-orm/pg-core';
import { store, ts } from '../schema-core.js';

export const myappWidget = pgTable('myapp_widget', {
  id: uuid().primaryKey().defaultRandom(),
  storeId: uuid().notNull().references(() => store.id),
  name: text().notNull(),
  createdAt: ts(),
});
```

```ts
// your own route file
import { myappWidget } from '../db/extensions/schema-myapp.js';
```

Migration generation/apply still follows this repo's normal `db:generate` /
`db:migrate` flow — this seam only widens what drizzle-kit's schema scan sees.
