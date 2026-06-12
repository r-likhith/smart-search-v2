# Smart Search v2

Intelligent search microservice with spell correction,
phonetic matching, intent parsing, and self-learning.

Plug it into any website. It runs independently.

---

## What it does
User types "labtop"              → finds laptops ✅

User types "nikee"               → finds Nike products ✅

User types "red kurta under 500" → filters by color + price ✅

User types "eyefone"             → finds iPhones (sound-alike) ✅

Learns from traffic. Gets smarter over time. ✅

---

## Quick start (5 minutes)

### 1. Install Docker Desktop
Download from: https://www.docker.com/products/docker-desktop/
Open it and wait for the whale icon in your menu bar ✅

### 2. Clone the project
```bash
git clone https://github.com/r-likhith/smart-search-v2.git
cd smart-search-v2
```

### 3. Set up environment
```bash
cp .env.example .env
# Open .env and fill in your real values
```

### 4. Set up seed data
```bash
node scripts/setup.js
```

### 5. Start everything
```bash
docker compose up
```

Wait for:
🌿 Smart Search v2

Running at http://localhost:3000

### 6. Open the right page for your role
See Pages section below ✅

---

## Pages — who uses what

### Testers
http://localhost:3000/demos
8 isolated client store demos.
Test search, typo correction, autocomplete, click tracking.
One page per store. No overlap between clients.
→ See aboutMeDocs/TESTER_SETUP.md for full guide ✅

### Developers
http://localhost:3000
Single-client dev UI with:
- Configurable API key and host ✅
- Live activity log (shows corrections firing) ✅
- Quick search + suggest testing ✅
- Useful for debugging pipeline behaviour ✅
http://localhost:3000/analytics
Analytics dashboard showing:
- Which correction layers are firing ✅
- Zero result queries ✅
- LearnedMap lifecycle (candidate → trusted → proven) ✅
- Source performance (manual vs symspell vs groq) ✅
- Cross-client correction risks ✅
- Layer funnel (learnedmap → symspell → phonetic) ✅
Use this to understand what the pipeline is doing ✅

---

## API endpoints
POST /api/search              → search products

GET  /api/suggest?q=          → autocomplete

POST /api/navigate            → browse by category

POST /api/behaviour/click     → record a click

GET  /api/analytics           → analytics dashboard

GET  /api/admin/corrections   → correction health

POST /api/admin/reload        → reload maps without restart

GET  /api/sync/status         → delta sync health

POST /api/sync/trigger        → force a sync

GET  /api/health              → system health

---

## Stopping

```bash
docker compose down      # stop — keeps all data ✅
docker compose down -v   # stop — wipes Meilisearch data ⚠️
```

---

## Daily commands

```bash
docker compose up                                        # start
docker compose down                                      # stop
node mastercheckup.js                                    # run tests
docker compose exec smart-search \
  node offlineLearner/index.js                           # nightly learner
curl -X POST http://localhost:3000/api/admin/reload \
  -H "x-api-key: searchapikey123"                       # reload maps
```

---

## Architecture
Your Website

│

▼

Smart Search v2 (this service)

│

├── Meilisearch       (search engine)

├── learnedMap        (correction memory)

├── SymSpell          (spell correction)

├── Phonetic          (sound-alike matching)

├── IntentParser      (filter extraction)

├── OfflineLearner    (nightly AI learning via Groq)

└── DeltaSync         (Elasticsearch → Meilisearch sync)

Your website only needs to know:
POST /api/search

GET  /api/suggest

Nothing else ✅

---

## Tests

```bash
node mastercheckup.js   # 309 tests — full system check
node brutalTest.js      # edge cases
node chaosTest.js       # stress test
```

---

## Documentation
aboutMeDocs/

TESTER_SETUP.md          → zero to running for testers

ADDING_NEW_CLIENT.md     → onboard a new store

DELTA_SYNC.md            → ES → Meilisearch sync explained

CORRECTIONS_AND_SEEDS.md → correction lifecycle + seed files

COMMANDS.md              → every command in one place
