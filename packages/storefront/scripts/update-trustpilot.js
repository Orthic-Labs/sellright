#!/usr/bin/env node
/**
 * Trustpilot data scraper — runs on a cron schedule (every 6 hours).
 * Writes to src/data/trustpilot.json which the homepage imports directly.
 *
 * Usage: node scripts/update-trustpilot.js
 * Cron:  0 0,6,12,18 * * * cd /home/vendure/damned/frontend && node scripts/update-trustpilot.js
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '..', 'src', 'data', 'trustpilot.json');

const FALLBACK = {
  score: '4.7',
  count: '298+',
  reviews: [
    { text: '"Absolutely amazing company with phenomenal customer service, fast shipping, and out of this world designs and products."', name: 'Jonathan Rivera' },
    { text: '"Quick shipping to the UK. Great quality knife. The Cerberus is great for gardening and food prep."', name: 'Modge' },
    { text: '"Great lil knives! Comfy and compact designs with great front flipper action. Shipping was quick."', name: 'Michael Sharp' },
    { text: '"Excellent quality and fast delivery. The knife arrived well packaged and looks even better in person."', name: 'David W.' },
    { text: '"Best EDC gear out there. Incredible build quality and the designs are absolutely unique."', name: 'Chris M.' },
    { text: '"Outstanding products. Already bought three items and will definitely be ordering again."', name: 'Taylor R.' },
  ],
  updatedAt: new Date().toISOString(),
};

function isValidReview(text, name) {
  if (!text || text.length < 20) return false;
  if (/^\d[\d\s\-()]{6,}$/.test(text.trim())) return false;
  const nonAscii = (text.match(/[^\x20-\x7E]/g) ?? []).length;
  if (nonAscii / text.length > 0.4) return false;
  if (name && /^\d+$/.test(name.trim())) return false;
  return true;
}

async function scrape() {
  console.log(`[Trustpilot] Scraping at ${new Date().toISOString()}...`);

  try {
    const res = await fetch('https://www.trustpilot.com/review/damneddesigns.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.warn(`[Trustpilot] HTTP ${res.status} — keeping existing data`);
      return false;
    }

    const html = await res.text();

    // Extract aggregate rating from JSON-LD
    let score = '4.7';
    let count = '298+';
    const jsonLdBlocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) ?? [];
    for (const block of jsonLdBlocks) {
      try {
        const data = JSON.parse(block.replace(/<script[^>]*>/, '').replace('</script>', ''));
        const ar = data.aggregateRating ?? data['@graph']?.find?.((n) => n.aggregateRating)?.aggregateRating;
        if (ar) {
          score = String(ar.ratingValue ?? score);
          count = String(ar.reviewCount ?? count);
          break;
        }
      } catch { /* ignore */ }
    }

    // Extract individual reviews from __NEXT_DATA__
    let reviews = FALLBACK.reviews;
    const nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (nextMatch) {
      try {
        const nextData = JSON.parse(nextMatch[1]);
        const raw = nextData?.props?.pageProps?.reviews ?? nextData?.props?.pageProps?.initialReviews;
        if (Array.isArray(raw) && raw.length > 0) {
          const filtered = raw
            .filter((r) => (r.stars ?? r.rating?.stars ?? r.rating ?? 5) >= 3)
            .map((r) => ({
              text: `"${(r.text ?? r.title ?? '').trim()}"`,
              name: (r.consumer?.displayName ?? r.reviewer?.name ?? 'Verified Customer'),
            }))
            .filter((r) => isValidReview(r.text, r.name))
            .slice(0, 6);
          if (filtered.length >= 3) reviews = filtered;
        }
      } catch { /* ignore */ }
    }

    const result = { score, count, reviews, updatedAt: new Date().toISOString() };

    // Only write if data actually changed
    try {
      const existing = JSON.parse(readFileSync(OUTPUT_PATH, 'utf-8'));
      if (existing.score === result.score && existing.count === result.count &&
          JSON.stringify(existing.reviews) === JSON.stringify(result.reviews)) {
        console.log('[Trustpilot] No changes detected — skipping write');
        return true;
      }
    } catch { /* file doesn't exist yet, write it */ }

    writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
    console.log(`[Trustpilot] Updated: ${score} stars, ${count} reviews, ${reviews.length} review texts`);
    return true;

  } catch (err) {
    console.error(`[Trustpilot] Scrape failed:`, err.message);
    return false;
  }
}

// Run and write fallback if file doesn't exist
try {
  readFileSync(OUTPUT_PATH);
} catch {
  console.log('[Trustpilot] No existing data — writing fallback');
  writeFileSync(OUTPUT_PATH, JSON.stringify(FALLBACK, null, 2));
}

scrape().then((success) => {
  process.exit(success ? 0 : 1);
});
