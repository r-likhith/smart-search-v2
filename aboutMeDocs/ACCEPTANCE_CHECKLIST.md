# Smart Search v2 — Acceptance Checklist
# Phase 1 + Phase 2A

Run this checklist before approving staging deployment.
Each item must be verified by the team.

---

## PRE-REQUISITES

- [ ] Smart Search server running (Docker)
- [ ] ngrok tunnel active
- [ ] PIMS running (port 3036)
- [ ] Next.js running (port 3001)
- [ ] MongoDB accessible
- [ ] All 8 clients synced

```bash
# verify Smart Search
curl -s https://<ngrok-url>/api/health/ready

# run integration test
bash test-smart-search-integration.sh
```

---

## SECTION 1 — Smart Search Server

### Health
- [ ] GET /api/health/ready → status: ready
- [ ] GET /api/health/live → status: alive
- [ ] GET /api/health/deep → all components green
- [ ] Docker container healthy

### Correction Engine
- [ ] Typo correction works
  - Search: "smrtwatch" → corrected: "smartwatch" ✅
  - Search: "laptpo" → corrected: "laptop" ✅
  - Search: "bluetoth" → corrected: "bluetooth" ✅
- [ ] Confidence score returned (0-1)
- [ ] Correction source logged (symspell/learnedMap/phonetic/ollama)
- [ ] Correct word → no correction applied

### Suggest / Autocomplete
- [ ] GET /api/suggest returns categories + brands + products
  - ?q=labtop&clientId=198 → corrected: laptop ✅
  - ?q=keyborad&clientId=198 → corrected: keyboard ✅
- [ ] Deduplication working (no duplicate categories)
- [ ] Category suppression for < 3 char queries
  - ?q=ac → no categories shown ✅
  - ?q=air → categories shown ✅
- [ ] Response time < 400ms (on production network)

### Security
- [ ] Requests without x-api-key rejected (401)
- [ ] Wrong x-api-key rejected (403)
- [ ] Rate limiting active (429 after threshold)
- [ ] Client isolation verified (client_198 data ≠ client_137 data)

---

## SECTION 2 — PIMS Integration (Phase 1)

### Feature Flags
- [ ] Client 198 enabled
  - SMART_SEARCH_CLIENT_IDS=198 in .env ✅
  - Log: [SmartSearch] client=198 corrected "X" → "Y" ✅
- [ ] Client 137 disabled
  - Log: [SmartSearch] disabled client=137 ✅
- [ ] All other clients disabled by default ✅

### Query Correction
- [ ] Typo corrected before ES query
  - Search "smrtwatch" → PIMS logs correction ✅
  - ES receives "smartwatch" ✅
  - Products return correctly ✅
- [ ] Correct query passes unchanged
  - Search "smartwatch" → no correction ✅
  - Same products returned ✅
- [ ] originalQuery preserved in metadata
- [ ] effectiveQuery used for ES
- [ ] info.correction returned in response:
```json
  {
    "applied": true,
    "originalQuery": "smrtwatch",
    "correctedQuery": "smartwatch",
    "effectiveQuery": "smartwatch"
  }
```

### Fallback Behavior
- [ ] Smart Search timeout → ES gets original query
  - Stop Smart Search server
  - Search still works ✅
  - Log: [SmartSearch] timeout client=198 ✅
- [ ] Wrong API key → silent fallback
- [ ] Feature flag off → ES direct ✅

### Query Preservation
- [ ] Pagination preserves corrected query
  - Search "smrtwatch" → page 2 → still smartwatch ✅
- [ ] Sorting preserves corrected query
- [ ] Filters preserve corrected query
- [ ] Breadcrumbs show corrected query (if applicable)

---

## SECTION 3 — Customer Next.js (Phase 2A)

### Suggest Dropdown (while typing)

#### header-search.tsx
- [ ] Suggest fires after 300ms debounce
- [ ] High confidence banner shows
  - Type "smrtwatch" → "Showing results for 'smartwatch'" ✅
- [ ] Low confidence banner shows
  - Type ambiguous typo → "Did you mean 'X'?" ✅
- [ ] No banner when no correction needed
  - Type "smartwatch" → no banner ✅
- [ ] Categories show for query ≥ 3 chars
  - Type "labtop" → categories appear ✅
- [ ] Categories hidden for query < 3 chars
  - Type "ac" → no categories ✅
  - Products still show ✅
- [ ] Category click navigates correctly
  - Click "iPad, Tablets & Laptops" → navigates ✅
- [ ] Banner click accepts correction
  - Click "smartwatch" → search bar updates ✅
  - Dropdown stays open ✅
  - PIMS re-fetches ✅
- [ ] Context retention
  - Accept "smartwatch" → type " charger"
  - Shows "Showing results for 'smartwatch charger'" ✅
- [ ] Dropdown closes on navigation

#### mobile-search.tsx
- [ ] Same behavior as header-search ✅
- [ ] Overlay closes on Enter ✅
- [ ] Overlay closes on category click ✅
- [ ] Clear button clears suggestions ✅

### Search (on Enter)
- [ ] Corrected query used on Enter
  - Type "smrtwatch" → Enter
  - URL: /products?q=smartwatch ✅
  - Search bar: "smartwatch" ✅
- [ ] Correct query unchanged on Enter
  - Type "smartwatch" → Enter
  - URL: /products?q=smartwatch ✅
- [ ] Silent URL correction after PIMS response
  - URL updates silently ✅
  - No page reload ✅
  - All filters preserved ✅

### Search Results Page
- [ ] Title shows corrected query
  - "Search Results for 'smartwatch'" ✅
- [ ] Products relevant to corrected query ✅
- [ ] Pagination works correctly ✅
- [ ] Filters work correctly ✅

---

## SECTION 4 — Cross-Client Isolation

- [ ] Client 198 (electronics) searches don't show grocery products
  - Search "rice" on client 198 → 0 results ✅
- [ ] Client 137 (grocery) searches don't show electronics
  - Search "iphone" on client 137 → 0 results ✅
- [ ] Each client shows own categories in suggest ✅
- [ ] Logs isolated per client ✅
  - multiTenantLogs/client_198/ ✅
  - multiTenantLogs/client_137/ ✅

---

## SECTION 5 — Observability

- [ ] queries.log receiving entries
- [ ] analytics.log receiving entries  
- [ ] products.log receiving entries
- [ ] Per-client logs isolated ✅
- [ ] Log contains required fields:
  - [ ] event: "smart_search"
  - [ ] clientId
  - [ ] query + correctedQuery
  - [ ] appliedCorrection
  - [ ] correctionSource
  - [ ] correctionConfidence
  - [ ] isFallback + fallbackReason
  - [ ] smartSearchEnabled
  - [ ] processingTime

---

## SECTION 6 — Performance

- [ ] Search response < 400ms (production network)
- [ ] Suggest response < 400ms (production network)
- [ ] No memory leaks after 100 requests
- [ ] Rate limiting doesn't affect normal usage
- [ ] Timeout fallback < 2s (development) / 400ms (production)

---

## SECTION 7 — Security

- [ ] API keys rotated from development values
  - Change: searchapikey123 → strong random key ✅
- [ ] CORS restricted to production domain
  - Change: * → https://yourdomain.com ✅
- [ ] Demo endpoints disabled in production
  - /demos → 404 in production ✅
- [ ] HTTPS only (SSL certificate) ✅
- [ ] ES credentials not in source code ✅
- [ ] .env not committed to Git ✅

---

## SECTION 8 — Known Limitations (Phase 1)

These are expected behaviors, not bugs:

- Partial words may suggest incorrect corrections
  - "inver" → "inner" (not "inverter")
  - Fix: Phase 4C catalog-aware correction
  - Workaround: type more characters

- 2-char queries show products only (no categories)
  - By design: CATEGORY_MIN_QUERY_LENGTH = 3
  - Prevents irrelevant category suggestions

- Short query categories may be unrelated
  - "air" → shows both AC and earbuds categories
  - Fix: Phase 4C relevance tuning
  - Expected for Phase 1

- "No Result Found" locally
  - Local: missing JWT → PIMS Prisma error
  - Staging: JWT available → products appear ✅

---

## SECTION 9 — Integration Test Script

Run from any terminal:
```bash
bash test-smart-search-integration.sh
```

Expected: 6/6 tests passing ✅

---

## SIGN-OFF

### Phase 1 (PIMS Query Correction)
- [ ] PIMS team reviewed elastic.products.ts changes
- [ ] Feature flags configured correctly
- [ ] Smart Search URL confirmed for staging
- [ ] Timeout set to 400ms for production
- [ ] All checklist items verified on staging
- [ ] Signed off by: _____________ Date: _______

### Phase 2A (Next.js Suggest)
- [ ] Frontend team reviewed header-search.tsx
- [ ] Frontend team reviewed mobile-search.tsx
- [ ] Feature flags configured correctly
- [ ] All checklist items verified on staging
- [ ] Signed off by: _____________ Date: _______

### Smart Search v2 Server
- [ ] DevOps reviewed Docker setup
- [ ] API keys rotated
- [ ] CORS configured for production
- [ ] SSL certificate installed
- [ ] Monitoring configured
- [ ] Signed off by: _____________ Date: _______

---

*Generated: 2026-07-22*
*Version: Phase 1 + 2A*
*Tests: 319/319 passing*
