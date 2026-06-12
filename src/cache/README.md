# src/cache/

In-memory caching layer.

## Purpose

Caches frequent search results to reduce
Meilisearch load and improve response times.

## Notes

- Cache is in-memory only ✅
- Resets on server restart ✅
- Not persistent across restarts ✅
- Used selectively for hot queries ✅
