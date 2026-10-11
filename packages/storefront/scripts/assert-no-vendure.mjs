#!/usr/bin/env node
// Storefront no-Vendure guard (plan D7). The storefront is a native REST client over @sellright/storefront-client:
// no GraphQL, no Vendure coupling. Two tiers, derived from Rotten's scripts/assert-no-vendure.sh:
//
//   Tier 1  every code file under src/ (base and overlay alike), always a hard failure:
//           `graphql`, a gql`` tagged template, `@vendure`, `__typename`.
//           The bare word "vendure" (any case) also fails, except in files named in scripts/assert-no-vendure.allowlist.
//   Tier 2  the strict token list (priceWithTax, featuredAsset, customFields, facetValues, emailAddress, streetLine1,
//           streetLine2, and __typename), applied ONLY to brand-origin files: the paths in <root>/.compose-overlay-files.txt
//           (L3 files and L2 ejects). Base-origin files carry some of these as REST wire names or legacy leftovers
//           that the brand does not own, so the base is not held to the strict list here. A brand excepts one
//           token in one file through scripts/assert-no-vendure.exceptions (`path|token|reason`, one per line).
//           When there is no overlay list (the base alone) tier 2 has no files.
//   Config  root config files (package.json, tsconfig.json, vite/tailwind/postcss config, ecosystem*.cjs) fail on an
//           `@vendure` import or an ALL_CAPS identifier containing VENDURE (`/home/vendure` paths are ignored).
//
//   node scripts/assert-no-vendure.mjs [--root DIR] [--overlay-list FILE]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Self-contained on purpose: the guard runs first in `build` and needs nothing but node.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const normalizeRel = (p) => path.posix.normalize(p.replaceAll('\\', '/')).replace(/^\.\//, '');

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs']);
const TIER1_SIGNAL = /graphql|gql`|@vendure|__typename/;
const WIRE_TOKENS = ['__typename', 'priceWithTax', 'featuredAsset', 'customFields', 'facetValues', 'emailAddress', 'streetLine1', 'streetLine2'];
const TIER2 = new RegExp(`\\b(${WIRE_TOKENS.join('|')})\\b`, 'g');
const BARE_WORD = /vendure/i;
const CONFIG_HARD = /@vendure|\b[A-Z][A-Z0-9_]*VENDURE[A-Z0-9_]*\b/;
const CONFIG_FILES = /^(ecosystem.*\.cjs|vite\.config\.ts|postcss\.config\.cjs|tailwind\.config\.mjs|tsconfig\.json|package\.json)$/;

const dataLines = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#')) : [];

function walkSrc(root) {
  const out = [];
  const visit = (dirRel) => {
    for (const ent of fs.readdirSync(path.join(root, dirRel), { withFileTypes: true })) {
      if (ent.name === 'node_modules') continue;
      const rel = `${dirRel}/${ent.name}`;
      if (ent.isDirectory()) visit(rel);
      else if (ent.isFile() && CODE_EXT.has(path.extname(ent.name).toLowerCase())) out.push(rel);
    }
  };
  if (fs.existsSync(path.join(root, 'src'))) visit('src');
  return out.sort();
}

/** Returns findings `{ file, line, tier, token, message }`. Pure: reads files under root, never writes. */
export function checkNoVendure({ root, overlayList } = {}) {
  root = path.resolve(root ?? PACKAGE_ROOT);
  const findings = [];
  const allowlist = new Set(dataLines(path.join(root, 'scripts/assert-no-vendure.allowlist')).map(normalizeRel));
  const exceptions = new Set(
    dataLines(path.join(root, 'scripts/assert-no-vendure.exceptions')).map((l) => {
      const [file, token] = l.split('|').map((p) => p.trim());
      return `${normalizeRel(file)}|${token}`;
    }),
  );
  const listFile = overlayList ? path.resolve(overlayList) : path.join(root, '.compose-overlay-files.txt');
  if (overlayList && !fs.existsSync(listFile)) throw new Error(`overlay list not found: ${listFile}`);
  const overlay = new Set(dataLines(listFile).map(normalizeRel));

  for (const rel of walkSrc(root)) {
    const lines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n');
    const strict = overlay.has(rel);
    lines.forEach((line, i) => {
      const at = (tier, token, message) => findings.push({ file: rel, line: i + 1, tier, token, message });
      const signal = line.match(TIER1_SIGNAL);
      if (signal) at(1, signal[0], `GraphQL/Vendure coupling signal "${signal[0]}"`);
      if (BARE_WORD.test(line) && !allowlist.has(rel)) {
        at(1, 'vendure', `unexpected "vendure" mention (add the file to scripts/assert-no-vendure.allowlist only for genuine one-time migration history)`);
      }
      if (strict) {
        for (const m of line.matchAll(TIER2)) {
          if (m[1] === '__typename' && signal) continue; // already reported by tier 1
          if (!exceptions.has(`${rel}|${m[1]}`)) at(2, m[1], `strict token "${m[1]}" in a brand-origin file (excepted per file and token in scripts/assert-no-vendure.exceptions)`);
        }
      }
    });
  }

  for (const ent of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []) {
    if (!ent.isFile() || !CONFIG_FILES.test(ent.name)) continue;
    fs.readFileSync(path.join(root, ent.name), 'utf8').split('\n').forEach((line, i) => {
      if (CONFIG_HARD.test(line.replaceAll('/home/vendure', ''))) {
        findings.push({ file: ent.name, line: i + 1, tier: 'config', token: 'vendure', message: 'Vendure-shaped identifier in a config file' });
      }
    });
  }
  return findings;
}

function main() {
  const argv = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root' || argv[i] === '--overlay-list') opts[argv[i].slice(2)] = argv[++i];
    else throw new Error(`unknown option ${argv[i]}`);
  }
  const findings = checkNoVendure({ root: opts.root, overlayList: opts['overlay-list'] });
  for (const f of findings) console.error(`assert-no-vendure: ${f.file}:${f.line} [tier ${f.tier}] ${f.message}`);
  if (findings.length > 0) {
    console.error('assert-no-vendure: FAILED (see above)');
    process.exit(1);
  }
  console.log('assert-no-vendure: OK');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
