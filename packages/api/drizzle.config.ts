import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  // Extension seam: './src/db/extensions/**/*.ts' lets a fork drop its own
  // Drizzle table modules into src/db/extensions/ and have `drizzle-kit
  // generate` pick them up for migrations, without editing any schema-*.ts
  // file here. Empty by default (see src/db/extensions/README.md) — an
  // unconfigured checkout's schema discovery is unchanged.
  schema: ['./src/db/schema.ts', './src/db/extensions/**/*.ts'],
  out: './drizzle',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: {
    // Default mirrors env.ts: :5433 (DEV cluster) — never :5432 (prod vendure-postgres).
    url: process.env.DATABASE_URL ?? 'postgres://sellright:CHANGE_ME@127.0.0.1:5433/sellright_dev',
  },
});
