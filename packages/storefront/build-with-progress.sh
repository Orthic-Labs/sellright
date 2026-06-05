#!/bin/bash

echo "🚀 Starting build with progress indicators..."
echo "📊 Processing 45+ responsive image variants - this may take 2-3 minutes"
echo "⏱️  Started at: $(date)"
echo ""

# Start build with timestamp and show progress
pnpm build 2>&1 | while IFS= read -r line; do
    echo "[$(date '+%H:%M:%S')] $line"
done

echo ""
echo "✅ Build completed at: $(date)"
