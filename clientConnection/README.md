# Client Connection Scripts

Scripts to sync client product data from their Elasticsearch
into our Meilisearch for smart-search-v2.

## Usage

1. Add credentials to .env:
   ES_NODE=https://their-elastic-url
   ES_USERNAME=username
   ES_PASSWORD=password

2. Run sync for a specific client:
   node clientConnection/syncClient198.js

## Files

syncClient198.js  — Poojara Telecom (electronics, 1988 products)

## Notes
- Read-only access to their Elasticsearch
- Never writes back to their DB
- Run once to populate, then re-run to refresh
