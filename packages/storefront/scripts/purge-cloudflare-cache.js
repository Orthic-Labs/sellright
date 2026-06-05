#!/usr/bin/env node

/**
 * Post-build script to purge Cloudflare cache via the Vendure backend API.
 * Runs against localhost; backend endpoint is not exposed externally.
 */

import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';

const baseEnv = resolve(process.cwd(), '.env');
const prodEnv = resolve(process.cwd(), '.env.production');
if (existsSync(baseEnv)) config({ path: baseEnv });
if (existsSync(prodEnv)) config({ path: prodEnv, override: true });

const backendUrl = process.env.VENDURE_API_URL
  ? process.env.VENDURE_API_URL.replace('/shop-api', '')
  : 'http://localhost:3100';

async function purgeCache() {
  console.log(`🧹 Requesting full Cloudflare cache purge via backend (${backendUrl})...`);

  try {
    const response = await fetch(`${backendUrl}/cache-admin/purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purgeAll: true }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`❌ Backend purge request failed: ${response.status} ${response.statusText}`);
      console.error(text);
      return;
    }

    const data = await response.json();
    if (data.success) {
      console.log('✅ Cloudflare cache successfully purged via backend!');
    } else {
      console.error('❌ Backend returned an error:', data.error);
    }
  } catch (error) {
    console.error('❌ Failed to connect to backend API:', error.message);
    console.log('   Make sure the Vendure backend is running during the build process.');
  }
}

purgeCache();
