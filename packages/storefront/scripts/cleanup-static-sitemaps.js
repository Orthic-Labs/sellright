#!/usr/bin/env node

/**
 * Post-build cleanup script to remove static sitemap files
 * These should be handled by dynamic routes, not static generation
 */

import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';

const distDir = 'dist';
const sitemapFiles = [
  'sitemap.xml',
  'sitemap-main.xml',
  'sitemap-products.xml',
  'sitemap-collections.xml',
  'sitemap-blog.xml',
  'robots.txt'
];

console.log('🧹 Cleaning up static sitemap files...');

let cleanedFiles = 0;

for (const file of sitemapFiles) {
  const filePath = join(distDir, file);
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath);
      console.log(`   ✅ Removed static ${file}`);
      cleanedFiles++;
    } catch (error) {
      console.warn(`   ⚠️  Could not remove ${file}:`, error.message);
    }
  }
}

if (cleanedFiles === 0) {
  console.log('   ✨ No static sitemap files found - all clean!');
} else {
  console.log(`🎉 Cleaned up ${cleanedFiles} static sitemap file(s)`);
  console.log('   Dynamic sitemap routes will now work correctly');
}