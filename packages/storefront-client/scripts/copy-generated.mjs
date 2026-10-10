#!/usr/bin/env node
// Copies the generated OpenAPI schema types into dist/ after tsc (tsc does not emit .d.ts-only sources). Replaces the
// former inline eval one-liner. An optional first argument overrides the package root (used by the test).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function copyGenerated(root) {
  mkdirSync(join(root, 'dist', 'generated'), { recursive: true });
  copyFileSync(join(root, 'src', 'generated', 'schema.d.ts'), join(root, 'dist', 'generated', 'schema.d.ts'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  copyGenerated(resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..')));
}
