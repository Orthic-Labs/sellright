# Future Optimization: Static Product JSON

## Concept
Instead of querying Vendure's GraphQL search API on every shop page load, serve product catalog data from a pre-generated static JSON file.

## How It Works
1. A backend cron job (Node script or Vendure plugin) runs every 5 minutes
2. Queries all products from Vendure with static fields: name, slug, price, featured image URL, custom fields (salePrice, preOrderPrice, shipDate)
3. **Stock is NEVER included in the JSON** — always queried live
4. Writes output to a JSON file served statically (e.g., `/data/catalog.json`)
5. Frontend imports this file directly — zero GraphQL overhead for static product data
6. Stock status is queried separately with a lightweight `inStock` boolean query and merged client-side

## What the JSON Contains
```json
{
  "products": [
    {
      "productId": "1",
      "productName": "Djinn",
      "slug": "djinn",
      "featuredImage": "https://assets.damneddesigns.com/preview/djinn.webp",
      "priceWithTax": { "min": 15000, "max": 22500 },
      "salePrice": null,
      "preOrderPrice": null,
      "shipDate": null
    }
  ],
  "generatedAt": "2026-03-26T12:00:00Z"
}
```

## What the JSON Does NOT Contain
- Stock levels or inStock status (always live)
- Gallery images (only needed on PDP)
- Variant details (only needed on PDP)
- Descriptions (only needed on PDP)

## Operational Complexity
- **New products:** Automatically picked up on next cron run (5 min max delay)
- **Product edits:** Same — picked up on next run. Could also be triggered by SSE `product-updated` event for near-instant updates.
- **Deployment:** JSON file is part of the build artifact or served from a persistent path
- **Failure mode:** If cron fails, stale JSON still works (products don't change often). Frontend can fall back to live GraphQL query.

## When to Implement
This becomes viable when:
- Product catalog grows to **200+ products** and the GraphQL search response becomes a bottleneck
- The "show all products" toggle (including out-of-stock) is slow and frequently used
- You want to eliminate GraphQL dependency for the shop page entirely

## Current State (March 2026)
- Only ~6 products are in-stock at any time
- `inStock: true` filter is server-side in Vendure — returns only in-stock products
- Shop page load is already lightweight for the default (in-stock only) view
- **Not needed yet** — revisit when catalog grows significantly

## Rotten's Approach (for reference)
Rotten uses a manually maintained `products.json` with 2 products and 54 variants. This works because the catalog is tiny and rarely changes. The auto-generated approach described here is the scalable version of the same idea.
