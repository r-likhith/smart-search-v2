# Delta Sync — Elasticsearch to Meilisearch

# Folder - clientConnections (where this happens)

## Overview

Smart Search v2 does not connect directly to your client's
database. Instead it maintains its own search-optimised copy
of the product catalog in Meilisearch.

Delta Sync is the bridge that keeps that copy fresh.
Client's System:              Smart Search v2:
─────────────────             ──────────────────────
Elasticsearch          →      Meilisearch
(source of truth)             (search-optimised copy)
Products added    →  upserted to search index ✅
Products updated  →  upserted to search index ✅
Products deleted  →  removed from search index ✅
Products rejected →  removed from search index ✅
Out of stock      →  kept visible (badge shown) ✅

---

## Two Sync Modes

### Mode 1 — Full Sync (one-time import)

Used when:
- Setting up a new client for the first time ✅
- Rebuilding the search index from scratch ✅

Script: `clientConnection/syncClient.js`

```bash
SYNC_CLIENT_ID=198 node clientConnection/syncClient.js
```

What it does:
- Connects to client's Elasticsearch via Kibana proxy ✅
- Fetches ALL active + approved products ✅
- Maps ES fields to Meilisearch format ✅
- Configures index settings (filters, sorting, ranking) ✅
- Imports everything in batches of 100 ✅

Duration: 2-10 minutes depending on catalog size ✅
Run once: then switch to delta sync ✅

---

### Mode 2 — Delta Sync (continuous incremental)

Used when:
- After initial import is complete ✅
- Keeping search data fresh automatically ✅
- Running continuously in background ✅

Script: `clientConnection/deltaSync.js`
Started by: `server.js` when `ENABLE_DELTA_SYNC=true`

What it does:
- Runs automatically every 10-30 minutes ✅
- Detects only products that changed since last sync ✅
- Upserts new/updated products ✅
- Removes deactivated/rejected products ✅
- Runs for all enabled clients simultaneously ✅
- Never crashes the server ✅

---

## How Change Detection Works

Delta sync uses `_seq_no` from Elasticsearch:
First run:
→ fetch ALL products ✅
→ record highest _seq_no seen ✅
→ save to sync_state/client_198.json ✅
Subsequent runs:
→ fetch only docs where _seq_no > last_seq_no ✅
→ much faster — only changed products ✅
→ no clock skew issues ✅
→ no missed documents ✅

Why `_seq_no` instead of `updated_at`:
- `updated_at` can have clock drift between servers ✅
- `_seq_no` is monotonically increasing ✅
- Every write to ES increments `_seq_no` ✅
- Guaranteed to catch every change ✅

---

## Product Rules

| ES Status          | Search Action     | Visible? |
|-------------------|-------------------|----------|
| active + approved  | UPSERT            | ✅ Yes   |
| active + pending   | DELETE            | ❌ No    |
| active + rejected  | DELETE            | ❌ No    |
| inactive + any     | DELETE            | ❌ No    |
| out of stock       | UPSERT (keep)     | ✅ Yes   |

Out of stock products stay visible in search.
The frontend shows an "Out of Stock" badge.
This is intentional — customers can wishlist or wait.

---

## Field Mapping

Elasticsearch fields are mapped to Meilisearch format:

| ES Field              | Meilisearch Field | Notes                    |
|----------------------|-------------------|--------------------------|
| title / product_name  | name              | primary search field     |
| category_l1_name      | catalogue         | top level category       |
| category_l2_name      | category          | main category            |
| category_l3_name      | subcategory       | sub category             |
| category_l4_name      | subCategory       | leaf category            |
| brand_name            | brand             | brand filter             |
| max_sale_price        | price             | selling price            |
| mrp_price             | mrp               | original price           |
| variants[color]       | color             | color filter             |
| variants[size/storage]| size              | size filter              |
| is_top_seller         | popularity: 10    | ranking boost            |
| is_featured           | popularity: 5     | ranking boost            |
| qty / stock           | inStock           | stock status             |
| product_slug          | slug              | URL identifier           |
| thumbnail             | thumbnail         | product image            |

---

## Safety Features

### PIT Pagination
Problem: large catalogs paginate slowly
products can shift during pagination
causing missed or duplicate docs ✅
Solution: Point-In-Time (PIT) snapshot ✅
→ ES freezes a consistent view ✅
→ pagination uses search_after ✅
→ no missed documents ✅
→ no duplicates ✅

### Circuit Breaker
Problem: ES goes down → sync retries forever
hammering ES makes things worse ✅
Solution: Circuit breaker ✅
→ 3 consecutive failures → pause 1 hour ✅
→ after 1 hour → auto-resume ✅
→ other clients continue unaffected ✅
→ visible in sync status endpoint ✅

### Crash Recovery
Problem: server crashes mid-sync
lock file left behind
next startup never runs ✅
Solution: heartbeat + stale lock detection ✅
→ sync writes heartbeat every 30s ✅
→ on startup: check all locks ✅
→ lock older than 5 mins = crashed ✅
→ auto-release stale lock ✅
→ sync resumes normally ✅

### Retry with Backoff
Problem: ES temporarily unavailable
single retry fails ✅
Solution: 3 retries with exponential backoff ✅
→ attempt 1: immediate ✅
→ attempt 2: wait 1s ✅
→ attempt 3: wait 2s ✅
→ all failed → circuit breaker counts it ✅

### Per-Client Isolation
Problem: one client's ES goes down
other clients also stop ✅
Solution: fully isolated per client ✅
→ each client has its own timer ✅
→ each client has its own lock ✅
→ each client has its own state file ✅
→ one client failure ≠ others fail ✅

### Adaptive Intervals
Active store (many changes):
→ >50 changes  → sync every 5 mins ✅
→ >10 changes  → sync every 10 mins ✅
Quiet store (few changes):
→ 0 changes    → slow down to 1hr ✅
→ default      → 15-30 mins ✅
Saves ES resources automatically ✅

---

## How to Enable for a New Client

### Step 1 — Add ES config to clients.js

Edit `configVendors/clients.js`:

```javascript
{
  id:         '999',
  name:       'New Store',
  type:       'electronics',
  index:      'client_999_products',    // Meilisearch index
  esIndex:    'izoleap_m_999_products', // Elasticsearch index
  meiliIndex: 'client_999_products',
  active:     true,
  synced:     true                      // enables delta sync ✅
}
```

Key fields:
- `esIndex` → the Elasticsearch index name ✅
- `meiliIndex` → the Meilisearch index name ✅
- `synced: true` → enables delta sync ✅
- `active: true` → client is active ✅

### Step 2 — Run full sync first

```bash
SYNC_CLIENT_ID=999 node clientConnection/syncClient.js
```

Wait for completion. Verify:
```bash
curl -s http://localhost:7700/indexes/client_999_products/stats \
  -H "Authorization: Bearer YOUR_MEILI_MASTER_KEY"
```

### Step 3 — Enable delta sync

In `.env`:
ENABLE_DELTA_SYNC=true

Restart server:
```bash
# local
node server.js

# Docker
docker compose restart smart-search
```

### Step 4 — Verify sync is running

```bash
curl -s http://localhost:3000/api/sync/status \
  -H "x-api-key: searchapikey123" | python3 -m json.tool
```

---

## Monitoring Sync Status

### Endpoint
GET /api/sync/status
Headers: x-api-key: your_api_key

### Response fields explained

```json
{
  "198": {
    "name": "Poojara Telecom",
    "lastSync": "2026-06-10T08:00:00Z",     // when last ran ✅
    "lastSeqNo": 45231,                       // last ES seq_no seen ✅
    "nextSyncIn": "12mins",                   // when next run ✅
    "currentInterval": "15mins",              // current frequency ✅
    "isRunning": false,                       // sync in progress? ✅
    "isPaused": false,                        // circuit breaker? ✅
    "pausedUntil": null,                      // resume time ✅
    "consecutiveFailures": 0,                 // failure count ✅
    "lastError": null,                        // last error msg ✅
    "lastChangeCount": 12,                    // changes last run ✅
    "lastDurationMs": 3200,                   // how long it took ✅
    "totalSyncs": 48,                         // total runs ✅
    "successfulSyncs": 48,                    // successful runs ✅
    "successRate": "100%",                    // health metric ✅
    "totalUpserted": 1240,                    // lifetime upserts ✅
    "totalDeleted": 23,                       // lifetime deletes ✅
    "totalRetries": 2                         // lifetime retries ✅
  }
}
```

### What healthy looks like
isRunning:           false (not mid-sync)
isPaused:            false (no circuit break)
consecutiveFailures: 0
successRate:         95-100%
lastError:           null

### What to investigate
isPaused: true          → ES connection issues ✅
consecutiveFailures > 2 → check ES credentials ✅
successRate < 80%       → check ES availability ✅
lastChangeCount = 0     → normal if quiet store ✅
for many runs           → check ES index name ✅

---

## Manual Trigger

Force a sync immediately without waiting:

```bash
curl -s -X POST http://localhost:3000/api/sync/trigger \
  -H "Content-Type: application/json" \
  -H "x-api-key: searchapikey123" \
  -d '{"clientId": "198"}'
```

Useful when:
- Testing after setup ✅
- Products updated and you want immediate refresh ✅
- Debugging sync issues ✅

---

## Running in Docker

### Check sync status
```bash
docker compose exec smart-search \
  wget -qO- \
  --header="x-api-key: searchapikey123" \
  http://localhost:3000/api/sync/status
```

### Trigger manual sync
```bash
docker compose exec smart-search \
  wget -qO- --post-data='{"clientId":"198"}' \
  --header="Content-Type: application/json" \
  --header="x-api-key: searchapikey123" \
  http://localhost:3000/api/sync/trigger
```

### View sync logs
```bash
docker compose logs smart-search | grep -i "sync\|delta\|upserted\|deleted"
```

---

## Troubleshooting

### Sync not starting
Check: ENABLE_DELTA_SYNC=true in .env ✅
Check: synced: true in clients.js ✅
Check: active: true in clients.js ✅
Check: server logs on startup ✅

### Circuit breaker triggered
Symptom: isPaused: true in status ✅
Cause:   3+ consecutive ES failures ✅
Fix:     Check ES_NODE, ES_USERNAME, ES_PASSWORD ✅
Check ES is accessible from server ✅
Wait 1hr for auto-resume OR restart server ✅

### Products not appearing in search
Check: sync status shows recent lastSync ✅
Check: product status=true in ES ✅
Check: approved_status=approved in ES ✅
Check: Meilisearch index has documents ✅
curl http://localhost:7700/indexes/client_198_products/stats

### Missing products after sync
Check: lastSeqNo in sync_state/client_198.json ✅
Check: ES index name matches esIndex in clients.js ✅
Run full sync to rebuild from scratch:
SYNC_CLIENT_ID=198 node clientConnection/syncClient.js

---

## State Files

Each client's sync state is saved in `sync_state/`:
sync_state/
client_135.json   ← Sports store sync state
client_137.json   ← Grocery store sync state
client_198.json   ← Electronics store sync state
...

These files track:
- Last `_seq_no` processed ✅
- Lock status (isRunning) ✅
- Circuit breaker state ✅
- All metrics ✅

These files are gitignored — they are runtime data ✅
They persist across server restarts via Docker volumes ✅

---

## Architecture Summary
Elasticsearch                    Meilisearch
(client's DB)                    (our search)
│                                │
│   clientConnection/            │
│   syncClient.js                │
│   ────────────────────────►    │
│   Full sync (one-time)         │
│                                │
│   clientConnection/            │
│   deltaSync.js                 │
│   ──── every 5-30 mins ────►   │
│   Incremental only             │
│                                │
│
Smart Search API
(serves website)
