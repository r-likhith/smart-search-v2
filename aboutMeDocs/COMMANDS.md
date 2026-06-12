# Commands Reference

Every command you need for Smart Search v2, organised by task.
Copy-paste ready. ✅

---

## Daily operations

### Start the system
```bash
docker compose up
```

### Start in background (detached)
```bash
docker compose up -d
```

### Stop the system (keeps all data) ✅
```bash
docker compose down
```

### Stop and wipe Meilisearch data ⚠️
```bash
docker compose down -v
```

### Restart a single service
```bash
docker compose restart smart-search
docker compose restart meilisearch
```

---

## System health

### API health check
```bash
curl http://localhost:3000/api/health
```

### View live logs (both services)
```bash
docker compose logs -f
```

### View logs for one service
```bash
docker compose logs -f smart-search
docker compose logs -f meilisearch
```

### View recent logs (last 50 lines)
```bash
docker compose logs --tail=50 smart-search
```

### Check running containers
```bash
docker compose ps
```

### Watch correction pipeline firing in real time
```bash
docker compose logs -f smart-search | grep -E "Layer|SymSpell|Phonetic|Intent|Cosmetic|LearnedMap"
```

---

## Testing

### Run full test suite
Note: Meilisearch must be running for all 309 tests ✅
```bash
node mastercheckup.js
```

### Run tests — summary only
```bash
node mastercheckup.js 2>/dev/null | grep -E "Phase|Total|❌"
```

### Run tests — check failures only
```bash
node mastercheckup.js 2>/dev/null | grep "❌"
```

### Run brutal edge case tests
```bash
node brutalTest.js
```

### Run chaos/stress tests
```bash
node chaosTest.js
```

---

## Search API

### Test search
```bash
curl -s -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -H "x-api-key: searchapikey123" \
  -d '{"query":"laptop","clientId":"198"}'
```

### Test search with typo
```bash
curl -s -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -H "x-api-key: searchapikey123" \
  -d '{"query":"labtop","clientId":"198"}' | \
  python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print('hits:',d['meta']['totalHits'],'correction:',d['correction']['applied'])"
```

### Test suggest (autocomplete)
```bash
curl -s "http://localhost:3000/api/suggest?q=lap&clientId=198" \
  -H "x-api-key: searchapikey123"
```

### Test health
```bash
curl -s http://localhost:3000/api/health
```

---

## Admin operations

### Reload learnedMap without restart
```bash
curl -s -X POST http://localhost:3000/api/admin/reload \
  -H "x-api-key: searchapikey123"
```

### Check correction health (full)
```bash
curl -s http://localhost:3000/api/admin/corrections \
  -H "x-api-key: searchapikey123" | python3 -m json.tool
```

### Check correction stats only
```bash
curl -s http://localhost:3000/api/admin/corrections \
  -H "x-api-key: searchapikey123" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); s=d['stats']; print('total:',s['totalEntries'],'trusted:',s.get('trusted',0),'candidates:',s.get('candidateEntries',0),'disabled:',s.get('disabledEntries',0))"
```

### Check source performance
```bash
curl -s http://localhost:3000/api/admin/corrections \
  -H "x-api-key: searchapikey123" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); [print(k,v) for k,v in d.get('sourcePerformance',{}).items()]"
```

---

## Analytics / observability

### Open analytics dashboard
http://localhost:3000/analytics

### Open developer test UI (with activity log)
http://localhost:3000

### What to watch in analytics
Zero result queries  → feed to offline learner ✅

Layer funnel         → see which layer is correcting ✅

LearnedMap lifecycle → candidate → trusted → proven ✅

Source performance   → manual vs symspell vs groq ✅

Cross-client risks   → corrections leaking between clients ✅

Promoted last 7 days → learning velocity ✅

---

## Offline learner

### Run nightly learner (local)
```bash
node offlineLearner/index.js
```

### Run nightly learner (Docker)
```bash
docker compose exec smart-search node offlineLearner/index.js
```

### What it does
Reads zero-result queries from logs ✅

Sends to Groq AI for correction ✅

Validates correction against Meilisearch inventory ✅

Saves validated corrections as candidates ✅

---

## Delta sync (Elasticsearch → Meilisearch)

### Check sync status for all clients
```bash
curl -s http://localhost:3000/api/sync/status \
  -H "x-api-key: searchapikey123" | python3 -m json.tool
```

### Trigger immediate sync for a client
```bash
curl -s -X POST http://localhost:3000/api/sync/trigger \
  -H "Content-Type: application/json" \
  -H "x-api-key: searchapikey123" \
  -d '{"clientId":"198"}'
```

### Enable delta sync
In .env set:
ENABLE_DELTA_SYNC=true
Then restart server ✅

---

## Adding a new client

### Step 1 — Full sync from Elasticsearch
```bash
SYNC_CLIENT_ID=999 node clientConnection/syncClient.js
```

### Step 2 — Verify import
```bash
curl -s http://localhost:7700/indexes/client_999_products/stats \
  -H "Authorization: Bearer YOUR_MEILI_MASTER_KEY"
```

### Step 3 — Reload server
```bash
curl -s -X POST http://localhost:3000/api/admin/reload \
  -H "x-api-key: searchapikey123"
```

Full guide: aboutMeDocs/ADDING_NEW_CLIENT.md ✅

---

## Meilisearch direct access

### Check all indexes
```bash
curl -s http://localhost:7700/indexes \
  -H "Authorization: Bearer YOUR_MEILI_MASTER_KEY"
```

### Check index stats (document count)
```bash
curl -s http://localhost:7700/indexes/client_198_products/stats \
  -H "Authorization: Bearer YOUR_MEILI_MASTER_KEY"
```

### Search directly in Meilisearch (bypass API)
```bash
curl -s -X POST \
  http://localhost:7700/indexes/client_198_products/search \
  -H "Authorization: Bearer YOUR_MEILI_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"q":"laptop","limit":5}'
```

---

## learnedMap maintenance

### Check full correction stats
```bash
curl -s http://localhost:3000/api/admin/corrections \
  -H "x-api-key: searchapikey123"
```

### Prune stale corrections (dry run — safe, no changes)
```bash
node scripts/pruneLearnedMap.js
```

### Prune and apply changes
```bash
node scripts/pruneLearnedMap.js --apply
```

### Rebuild reverse index
```bash
node scripts/buildReverseIndex.js
```

### Rebuild SymSpell dictionary
```bash
node scripts/buildDictionary.js
node scripts/buildProductDict.js
```

### Update seed files (after 50+ new trusted corrections)
```bash
cp learned/learnedMap.json    learned/learnedMap.seed.json
cp learned/suggestMap.json    learned/suggestMap.seed.json
cp learned/reverseIndex.json  learned/reverseIndex.seed.json
git add learned/*.seed.json
git commit -m "chore: update correction seeds"
git push
```

---

## Development setup

### First time setup after cloning
```bash
git clone https://github.com/r-likhith/smart-search-v2.git
cd smart-search-v2
cp .env.example .env
# fill in .env with real values
node scripts/setup.js
docker compose up
```

### Run locally without Docker
```bash
# Terminal 1 — start Meilisearch
start-meili

# Terminal 2 — start server
node server.js
```

---

## Git workflow

### Check status
```bash
git status
git log --oneline
```

### Save and push changes
```bash
git add .
git commit -m "your message"
git push
```

### Pull latest changes
```bash
git pull
```

---

## Docker build

### Rebuild image after code changes
```bash
docker compose build
docker compose up
```

### Rebuild from scratch (clears image cache)
```bash
docker compose down
docker compose build --no-cache
docker compose up
```

### Run a one-off command inside container
```bash
docker compose exec smart-search node scripts/setup.js
docker compose exec smart-search node scripts/pruneLearnedMap.js
docker compose exec smart-search node offlineLearner/index.js
```

---

## Pages — who uses what
http://localhost:3000              → Developer UI (activity log, debug)

http://localhost:3000/demos        → Tester UI (8 isolated client stores)

http://localhost:3000/analytics    → Developer observability dashboard

http://localhost:7700              → Meilisearch direct (admin only)
