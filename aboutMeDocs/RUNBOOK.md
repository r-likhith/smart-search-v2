# Smart Search v2 — Operations Runbook

A reference for anyone operating, deploying, or debugging Smart Search v2.

---

## 1. Deployment

### Automatic (GitHub Actions)
Every push to `main` triggers an automatic deploy.
No manual steps needed — GitHub handles it.

Monitor at: `github.com/r-likhith/smart-search-v2/actions`

### Manual deploy (if GitHub Actions is unavailable)
```bash
ssh ubuntu@YOUR_SERVER_IP
cd ~/smart-search-v2
git fetch origin
git reset --hard origin/main
docker compose build
docker compose up -d
curl http://localhost:3000/api/health/ready
node mastercheckup.js 2>/dev/null | tail -5
```

---

## 2. Manual Rollback

If a deployment breaks production:

```bash
# 1. SSH into server
ssh ubuntu@YOUR_SERVER_IP
cd ~/smart-search-v2

# 2. Find last known good commit
git log --oneline -10

# 3. Reset to that commit
git checkout <COMMIT_SHA>

# 4. Rebuild and restart
docker compose build
docker compose up -d

# 5. Verify
curl http://localhost:3000/api/health/ready
node mastercheckup.js 2>/dev/null | tail -5
```

**Tip:** The failing commit SHA is shown in the GitHub Actions failure log.
You don't need to guess — it's printed there.

---

## 3. Health Checks

```bash
# is the process alive? (Docker healthcheck uses this)
curl http://localhost:3000/api/health/live

# can it serve search requests? (CI/CD uses this after deploy)
curl http://localhost:3000/api/health/ready

# full subsystem breakdown (you use this for debugging)
curl -s http://localhost:3000/api/health/deep | python3 -m json.tool
```

### What each status means
healthy    → all systems nominal
degraded   → correction layers missing, search still works
unavailable → Meilisearch unreachable, search fails

### Memory check
```bash
docker stats smart-search-api --no-stream \
  --format "table {{.MemUsage}}\t{{.MemPerc}}"
```

---

## 4. Backup and Restore

### Backup runs automatically
Every 24 hours inside the Docker container.
Covers: learnedMap, reverseIndex, suggestMap, clicks, buildState.

### Run backup manually
```bash
./scripts/backup.sh
```

### Verify latest backup is restorable
```bash
./scripts/restore-test.sh
```

### Restore from backup
```bash
# 1. Find the backup you want
ls -lt backups/

# 2. Verify it's clean before restoring
./scripts/restore-test.sh

# 3. Restore files
BACKUP=backups/YYYYMMDD-HHMMSS
cp $BACKUP/learnedMap.json   learned/
cp $BACKUP/reverseIndex.json learned/
cp $BACKUP/suggestMap.json   learned/
cp $BACKUP/clicks.json       learned/
cp $BACKUP/buildState.json   learned/

# 4. Reload without restart (no downtime)
curl -X POST http://localhost:3000/api/admin/reload \
  -H "x-api-key: YOUR_ADMIN_KEY"
```

---

## 5. API Key Management

```bash
# generate a new key for a client
node api-keys/generateApiKey.js <clientId> "Client Name"
# ⚠️ copy the key immediately — it will not be shown again

# list all keys (preview only — never shows full key)
node api-keys/listApiKeys.js

# disable a key (client leaves or key leaked)
node api-keys/disableApiKey.js <clientId>

# rotate a key (disable old, generate new atomically)
node api-keys/rotateApiKey.js <clientId>
# ⚠️ share new key with client via secure channel
```

After any key change:
```bash
# reload keys without restart
curl -X POST http://localhost:3000/api/admin/reload \
  -H "x-api-key: YOUR_ADMIN_KEY"
```

---

## 6. Admin Endpoints

All require `x-api-key` header with admin permission.

```bash
# reload learnedMap + suggestMap + API keys
curl -X POST http://localhost:3000/api/admin/reload \
  -H "x-api-key: YOUR_ADMIN_KEY"

# correction health dashboard
curl http://localhost:3000/api/admin/corrections \
  -H "x-api-key: YOUR_ADMIN_KEY" | python3 -m json.tool

# last 50 search events with full context
curl "http://localhost:3000/api/admin/recent-activity" \
  -H "x-api-key: YOUR_ADMIN_KEY" | python3 -m json.tool

# list all API keys (preview only)
curl http://localhost:3000/api/admin/keys \
  -H "x-api-key: YOUR_ADMIN_KEY" | python3 -m json.tool
```

---

## 7. Logs

```bash
# Docker logs (last 50 lines)
docker compose logs --tail 50

# follow live logs
docker compose logs -f

# analytics log (all search events)
tail -50 logs/analytics.log

# backup log
tail -20 logs/backup.log

# per-client analytics
tail -20 multiTenantLogs/client_198/analytics.log
```

---

## 8. Nightly Offline Learner (Groq)

Runs manually — not yet scheduled automatically.

```bash
# run inside Docker container
docker compose exec smart-search \
  node offlineLearner/index.js

# after it runs, reload to pick up new corrections
curl -X POST http://localhost:3000/api/admin/reload \
  -H "x-api-key: YOUR_ADMIN_KEY"
```

---

## 9. Smoke Test

```bash
# full system test (314 tests)
node mastercheckup.js 2>/dev/null | tail -10

# phonetic quality benchmark
node phoneticBenchmark.js 2>/dev/null | head -20

# quick search sanity check
curl -s -X POST http://localhost:3000/api/search \
  -H "x-api-key: searchapikey123" \
  -H "Content-Type: application/json" \
  -d '{"query":"labtop","clientId":"198"}' | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print('correction:', d['correction']['correctedQuery'])
print('hits:', d['meta']['totalHits'])
"
```

---

## 10. Docker Operations

```bash
# start everything
docker compose up -d

# stop everything (keeps data)
docker compose down

# stop and wipe Meilisearch data ⚠️
docker compose down -v

# rebuild image (after code changes)
docker compose up --build -d

# container status
docker ps

# memory usage
docker stats --no-stream

# clean up old images (run after deploys)
docker image prune -f

# full cleanup (use carefully) ⚠️
docker system prune
```

---

## 11. Emergency Contacts / Escalation
System owner:   Likhith
GitHub repo:    github.com/r-likhith/smart-search-v2
Health URL:     http://YOUR_SERVER/api/health/deep
Analytics:      http://YOUR_SERVER/analytics

---

## 12. Known Limitations
meilisearch-js@0.36.0:
Does not preserve underlying error codes on
connection failure. withRetry.js classifies
MeiliSearchCommunicationError as transient.
Revisit when upgrading to 0.58.0 ✅
AbortSignal (cancellation):
withRetry.js cannot cancel in-flight Meili
requests on timeout — they continue running
server-side until they complete or time out
naturally. Low severity at current traffic. ✅
Backup scheduler:
24h interval resets on container restart.
If server restarts at 2am, next backup runs
~24h after restart, not at 2am. ✅
