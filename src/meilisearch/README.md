# src/meilisearch/

Meilisearch connection and search execution.

## Files

| File        | Purpose                                       |
|------------|------------------------------------------------|
| client.js   | Meilisearch connection (uses MEILI_HOST env)  |
| searcher.js | Search, suggest, navigate, popular products   |
| indexer.js  | Import products into Meilisearch              |
| indexes.js  | Create and configure indexes on startup       |

## Index naming

Each client has its own isolated index:
- client_135_products
- client_137_products
- client_198_products
- etc.

Passed via options.meiliIndex in every search call ✅

## searcher.js key functions

- searchProducts(query, options) → main search
- getSuggestions(query, options) → autocomplete
- navigateCategory(cat, subcat)  → browse by category
- getPopularProducts(limit)      → fallback products
