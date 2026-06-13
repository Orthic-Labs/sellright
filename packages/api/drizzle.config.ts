import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  casing: 'snake_case',
  dbCredentials: {
    // Default mirrors env.ts: :5433 (DEV cluster) — never :5432 (prod vendure-postgres).
    url: process.env.DATABASE_URL ?? 'postgres://sellright:CHANGE_ME@127.0.0.1:5433/sellright_dev',
  },
});
