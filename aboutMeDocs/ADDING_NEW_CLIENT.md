# Adding a New Client to Smart Search v2

## Overview

Smart Search v2 is a multi-tenant search microservice.
Each client (store) gets:
- An isolated Meilisearch index ✅
- Their own product catalog ✅
- Scoped spell corrections ✅
- Independent analytics ✅
- A dedicated demo page ✅

No data crosses between clients.
One client's searches never affect another client's results.

---

## Prerequisites

Before adding a new client, ensure:
- Smart Search v2 is running (local or Docker) ✅
- You have the product data file (Excel .xlsx or JSON) ✅
- You have the API key ✅

---

## Step 1 — Register the client

Edit `configVendors/clients.js` and add your client:

```javascript
{
  id:    '999',                      // unique client ID ✅
  name:  'New Store 999',            // display name ✅
  type:  'electronics',              // scope for corrections ✅
                                     // options: electronics, grocery,
                                     //          sports, health, fmcg,
                                     //          meat_seafood, global
  index: 'client_999_products'       // Meilisearch index name ✅
}
```

**Scope types explained:**
| Type         | Used for                              |
|-------------|---------------------------------------|
| electronics  | phones, laptops, gadgets              |
| grocery      | food, beverages, packaged goods       |
| sports       | fitness, gear, equipment              |
| health       | vitamins, supplements, pharma         |
| fmcg         | household, personal care              |
| meat_seafood | fresh meat, fish, poultry             |
| global       | multi-category or mixed inventory     |

---

## Step 2 — Prepare product data

### Required fields (minimum)
id          → unique product identifier
name        → product name (used in search)
brand       → brand name
category    → main category
price       → selling price (number)
inStock     → true/false

### Recommended fields (for better search)
subcategory → sub-category
mrp         → original price
size        → size variant
color       → color variant
description → product description
sku         → stock keeping unit
slug        → URL-friendly name

### Supported formats
- Excel (.xlsx) — recommended ✅
- JSON array ✅

---

## Step 3 — Import products

### Local setup
```bash
node scripts/importProducts.js \
  --clientId 999 \
  --file ./products_999.xlsx
```

### Docker setup
```bash
docker compose exec smart-search \
  node scripts/importProducts.js \
  --clientId 999 \
  --file ./products_999.xlsx
```

### What the importer does
- Creates `client_999_products` index in Meilisearch ✅
- Sets up search ranking rules ✅
- Sets up filterable attributes ✅
- Imports all products ✅
- Verifies document count ✅

### Verify import
```bash
curl -s http://localhost:7700/indexes/client_999_products/stats \
  -H "Authorization: Bearer YOUR_MEILI_MASTER_KEY"
```

Expected output:
```json
{ "numberOfDocuments": 1234, "isIndexing": false }
```

---

## Step 4 — Create demo page

### Copy existing demo
```bash
cp demos/client-198.html demos/client-999.html
```

### Update these values in client-999.html

```javascript
// Line ~1: Update title
<title>New Store 999 — Search</title>

// Line ~10: Update color (pick a unique brand color)
header { background: #1a5bb5; }  // change to your color

// Line ~200: Update CLIENT_ID
const CLIENT_ID = '999';

// Line ~60: Update store info
<h1>🏪 New Store 999</h1>
<p>Client ID: 999 · Electronics · 1234 products</p>

// Line ~70: Update placeholder
placeholder="Search products..."
```

### Color recommendations
Pick a color that represents the store type:
- Electronics → Blues (#1a5bb5, #1565c0)
- Grocery → Greens (#2e7d32, #388e3c)
- Sports → Oranges (#e65100, #bf360c)
- Health → Purples (#6a1b9a, #4a148c)
- Meat/Seafood → Reds (#c62828, #b71c1c)

---

## Step 5 — Reload server

After adding the client, reload without restart:

### Local
```bash
curl -X POST http://localhost:3000/api/admin/reload \
  -H "x-api-key: searchapikey123"
```

### Docker
```bash
docker compose exec smart-search \
  wget -qO- --post-data="" \
  --header="x-api-key: searchapikey123" \
  http://localhost:3000/api/admin/reload
```

---

## Step 6 — Verify everything works

### Test search
```bash
curl -s -X POST http://localhost:3000/api/search \
  -H "Content-Type: application/json" \
  -H "x-api-key: searchapikey123" \
  -d '{"query":"your product","clientId":"999"}'
```

### Test suggest (autocomplete)
```bash
curl -s "http://localhost:3000/api/suggest?q=prod&clientId=999" \
  -H "x-api-key: searchapikey123"
```

### Open demo page
http://localhost:3000/demos/client-999.html

### Check analytics
http://localhost:3000/analytics

---

## Step 7 — Run offline learner (after traffic)

Once real users start searching, run nightly:

### Local
```bash
node offlineLearner/index.js
```

### Docker
```bash
docker compose exec smart-search \
  node offlineLearner/index.js
```

The offline learner will:
- Find zero-result queries from client 999 ✅
- Generate corrections via Groq AI ✅
- Validate corrections against inventory ✅
- Save validated corrections to learnedMap ✅

---

## Quick reference

| Task                | Command                                      |
|--------------------|----------------------------------------------|
| Import products     | `node scripts/importProducts.js`             |
| Reload server       | `POST /api/admin/reload`                     |
| Test search         | `POST /api/search`                           |
| View analytics      | `http://localhost:3000/analytics`            |
| Run offline learner | `node offlineLearner/index.js`               |
| Check corrections   | `GET /api/admin/corrections`                 |

---

## Notes

- Each client index is fully isolated ✅
- learnedMap corrections are scoped per client type ✅
- Cross-client risks are monitored in the dashboard ✅
- Offline learner runs across all clients simultaneously ✅
- Adding a client never affects existing clients ✅
- Data persists across server restarts via Docker volumes ✅
