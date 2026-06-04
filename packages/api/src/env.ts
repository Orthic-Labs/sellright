import { z } from 'zod';

/** Fail-fast env validation. The server refuses to boot on missing/invalid config. */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3100),
  DATABASE_URL: z.string().url().default('postgres://cp:cp@127.0.0.1:5432/cp_dev'),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);
