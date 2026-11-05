# Customer-journey suite (#425)

Measures what a customer does, not cold loads of single pages, and checks that the edge-cached pages stay correct.

| File | What it does |
|---|---|
| `net.mjs` | Arms. `liveA`: the live store, `/shop/` and `/checkout/` requested as `?sr_ab=1` (a query URL is never cached: the uncached render). `liveB`: the live store as customers get it (edge-cached page + edge reads Worker). `<port>`, `<port>c`, `<port>e`: a staging build behind an SSH tunnel; plain, served from an emulated cache, or with the Worker emulated. |
| `journey-ab.mjs` | Product page (cold) → options → Add to cart → drawer → Checkout → order total visible, interleaved A/B, m375 (150 ms RTT, 1.6 Mbps, 4x CPU). Reports medians, paired median difference and pairs won. |
| `shop-ab.mjs` | Landing on `/shop/` (as from search or an ad): TTFB, FCP, products visible, LCP, CLS, cards shown then removed. |
| `correctness.mjs` | Two customers at once each see only their own cart; a cart change right before Checkout shows the new total. Exit code 1 on failure. |
| `deploy-tab.mjs` | A tab opened before a deploy keeps working after it (drawer, checkout, total; no missing chunks). |
| `suite.sh` | Runs correctness and both A/Bs for Damned and Rotten. |

Setup: `npm i puppeteer-core` here; set `CHROME` to the Chrome binary (default: the Windows path). No order is ever placed.

Results of the first full runs are on sellright#425.
