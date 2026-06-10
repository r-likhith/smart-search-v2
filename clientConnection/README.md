# clientConnection

Scripts to sync client product data from Elasticsearch into
Meilisearch for smart-search-v2.

---

## Files

### syncClient.js — Universal full sync
One-time import for any client. Run once to populate,
then switch to deltaSync for ongoing updates.

```bash
SYNC_CLIENT_ID=198 node clientConnection/syncClient.js
SYNC_CLIENT_ID=137 node clientConnection/syncClient.js
```

What it does:
- Fetches ALL active+approved products from ES ✅
- Creates and configures the Meilisearch index ✅
- Imports everything in batches of 100 ✅
- Shows progress as it runs ✅

Requirements:
- ES_NODE, ES_USERNAME, ES_PASSWORD in .env ✅
- client must exist in configVendors/clients.js ✅
- client must have esIndex and meiliIndex set ✅

---

### deltaSync.js — Continuous incremental sync
Runs automatically in background when ENABLE_DELTA_SYNC=true.
Detects and syncs only changed products every 5-30 minutes.

Started by server.js on startup.
Never run this directly — server manages it.

Key behaviours:
- Change detection via _seq_no (no clock skew) ✅
- PIT + search_after pagination (no missed docs) ✅
- Circuit breaker: 3 failures → pause 1hr ✅
- Crash recovery: stale lock detection on startup ✅
- Retry: 3x exponential backoff ✅
- Per-client isolation: one fail ≠ others fail ✅
- Adaptive intervals: active store syncs more often ✅

Endpoints:
- GET  /api/sync/status   → per-client sync health
- POST /api/sync/trigger  → force immediate sync

---

## Setup for a new client

1. Add to configVendors/clients.js:
```javascript
{
  id:         '999',
  name:       'Store Name',
  type:       'electronics',
  index:      'client_999_products',
  esIndex:    'izoleap_m_999_products',
  meiliIndex: 'client_999_products',
  active:     true,
  synced:     true
}
```

2. Run full sync:
```bash
SYNC_CLIENT_ID=999 node clientConnection/syncClient.js
```

3. Enable delta sync in .env:
ENABLE_DELTA_SYNC=true

4. Restart server ✅

---

## Environment variables required
ES_NODE=https://your-kibana-url
ES_USERNAME=your_username
ES_PASSWORD=your_password
ENABLE_DELTA_SYNC=true

---

## Notes
- Read-only access to client Elasticsearch ✅
- Never writes back to client's database ✅
- Each client's state saved in sync_state/ ✅
- Full docs: see aboutMeDocs/DELTA_SYNC.md ✅
