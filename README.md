# Smart Search v2

Intelligent search microservice with multi-tenant support,
spell correction, phonetic matching, and offline learning.

## Quick Start

### 1. Setup environment
cp .env.example .env
# Edit .env with your real values

### 2. Start services
docker compose up -d

### 3. Import products
node scripts/importProducts.js

### 4. Test
curl http://localhost:3000/api/health

## Endpoints
- POST /api/search
- GET  /api/suggest?q=
- GET  /api/analytics
- GET  /api/admin/corrections
- POST /api/admin/reload

## Demo pages
http://localhost:3000/demos

## Analytics dashboard
http://localhost:3000/analytics

## Offline learner (run nightly)
docker compose exec smart-search node offlineLearner/index.js

## Tests
node mastercheckup.js
node brutalTest.js
node chaosTest.js
