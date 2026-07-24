# Smart Search v2 — Infrastructure Requirements

Document Version: 1.0.0
Service: Smart Search v2
Last Updated: 2026-07-24

---

## What is this
An internal search service deployed as a standalone Docker application.
Consumers interact through HTTP APIs only.

```text
                           Smart Search Platform

                             GitLab Repository
                                     │
                              git clone / git pull
                                     │
                           Docker Compose Deployment
                    ┌────────────────┴────────────────┐
                    │                                 │
                    ▼                                 ▼
             Smart Search API                 Meilisearch
                    │                                 │
                    └────────────────┬────────────────┘
                                     │
                              Elasticsearch
                                     │
                           Product Catalogue
                                     │
                    ┌────────────────┴────────────────┐
                    ▼                                 ▼
                 PIMS                        Customer Next.js
```

---

## API Consumers
Current consumers:
- PIMS
- Customer Next.js

Both interact through HTTP APIs only.
Smart Search is an independent service with no shared code.

All Smart Search API endpoints require the configured API key.
Health endpoints (/api/health/live, /api/health/ready, /api/health/deep)
are publicly accessible without authentication.

---

## Server Requirements
- Ubuntu 22.04 LTS
- 4GB RAM minimum (8GB recommended)
- 20GB storage minimum
- Static IP or dedicated endpoint

### Ports
External:
- 22 — SSH
- 80 — HTTP (optional)
- 443 — HTTPS (recommended)
- 3000 — Smart Search API (or configured PORT)

Internal (not exposed publicly):
- 7700 — Meilisearch

### Inbound Access
Only the Smart Search API should be reachable by clients.
Meilisearch must remain internal to the Docker network.

### Expected Resource Usage
- Smart Search API: approximately 300–600 MB RAM
- Meilisearch: allocate at least 2 GB of memory — actual usage depends on catalog size

---

## What needs to be installed on the server

```bash
# Docker + Docker Compose v2
curl -fsSL https://get.docker.com | sh

# Ensure deployment user has Docker permissions
sudo usermod -aG docker $USER
newgrp docker

# Git v2+
sudo apt install git -y
```

Docker Compose builds the Smart Search image from the repository Dockerfile
and pulls Meilisearch from Docker Hub.
All other dependencies are managed automatically.

---

## Docker Network
Both containers communicate over an internal Docker network:

```text
Smart Search API
       │
       ▼
  Meilisearch
```

Meilisearch is not exposed publicly.
Restart policy is defined in docker-compose.yml.

---

## Outbound Network Access
Smart Search requires outbound access to:
- Elasticsearch (configured via ES_NODE in .env)
- Groq API at api.groq.com (if AI correction is enabled)

Ensure firewall rules allow these outbound connections.

---

## Elasticsearch Connectivity
Smart Search connects to Elasticsearch for product data sync.
Elasticsearch must be reachable before synchronization begins.
Connection is configured through ES_NODE in .env.

ES_NODE=http://<elasticsearch-host>:<port>


---

## Environment Variables
The development team supplies required variables and documentation.
Infrastructure populates production values for the deployment environment.

| Variable                       | Description                                    |
|--------------------------------|------------------------------------------------|
| PORT                           | API listening port (default: 3000)             |
| SMART_SEARCH_API_KEY           | Authentication key for all API requests        |
| MEILI_HOST                     | Meilisearch endpoint (internal Docker network) |
| MEILI_MASTER_KEY               | Meilisearch master key                         |
| ES_NODE                        | Elasticsearch endpoint                         |
| ES_USERNAME                    | Elasticsearch username                         |
| ES_PASSWORD                    | Elasticsearch password                         |
| CORS_ORIGIN                    | Allowed frontend origin                        |
| DISABLE_DEMOS                  | Enable/disable demo pages (true/false)         |
| GROQ_API_KEY                   | Groq API key for AI correction                 |
| ENABLE_DELTA_SYNC              | Enable delta sync (false by default)           |

Generate API key with:
```bash
openssl rand -hex 32
```

---

## Persistent Data
All directories are bind-mounted from the project folder into Docker containers
as defined in docker-compose.yml.

### Runtime State (must survive container recreation)
- `./data.ms/` — Meilisearch indexed product data
- `./learned/` — correction learning data
- `./sync_state/` — sync state tracking

### Log Directories (rotated separately)
- `./logs/` — application query logs
- `./multiTenantLogs/` — per-client isolated logs

---

## What is needed from infrastructure
1. GitLab repository created and access to modify
2. Smart Search service deployed and operational
3. Dedicated Smart Search endpoint
   - Example: http://server-ip:3000
   - Or: https://search.internal.company.com
4. SSL configured if using HTTPS

---

## Infrastructure Responsibilities
- Provision the Linux server
- Install Docker and Git
- Clone repository and configure production .env
- Provide dedicated endpoint (IP or domain)
- Configure SSL if using HTTPS
- Ensure Docker services restart on server reboot
- Perform git pull for deployments

## Development Responsibilities
- Complete Smart Search repository
- Dockerfile and docker-compose.yml
- Health endpoints
- Client synchronization scripts
- Verification scripts
- This documentation

---

## Releases
Production deployments should reference Git tags or release branches:
- v1.0.0
- v1.0.1
- v1.1.0

Avoid deploying arbitrary commits to production.

---

## Deployment Lifecycle

```text
Developer
    │
    ▼
git push to GitLab
    │
    ▼
Infrastructure: git pull
    │
    ▼
docker compose up -d --build
    │
    ▼
Health verification
    │
    ▼
Production ready
```

Future: GitLab CI/CD may automate this workflow.

---

## Startup Sequence
1. Docker starts
2. Meilisearch becomes healthy
3. Smart Search API starts
4. Health endpoint reports Ready
5. Initialize search index if required (first deployment only)

---

## First Deployment
```bash
# 1. Clone repository
git clone <gitlab-repo-url>
cd smart-search-v2

# 2. Configure .env for production

# 3. Start services
docker compose up -d

# 4. Verify application is running
curl http://<endpoint>/api/health/ready
# Expected: {"status":"ready"}

# 5. Initialize search index (first time only)
node clientConnection/syncAllClients.js

# 6. Verify
node mastercheckup.js
```

## Search Index Initialization
Imports product data from Elasticsearch into Meilisearch.

Required only when:
- First deployment
- ./data.ms/ directory removed
- Complete reindex requested

```bash
node clientConnection/syncAllClients.js
```

The application runs independently of this step.
Sync only populates the search index.
Elasticsearch must be reachable before running sync.

## Updating
```bash
git pull
docker compose up -d --build

# Verify
curl http://<endpoint>/api/health/ready
node mastercheckup.js
```

## Rollback
```bash
git fetch --tags
git checkout <tag or release branch>
docker compose up -d --build
```

---

## Safe vs Unsafe Operations

Safe:
- `docker compose down`
- `docker compose restart`

Unsafe (deletes bind-mounted data — must re-sync):
- `docker compose down -v`

---

## Backup
- Bind-mounted runtime state (./data.ms/, ./learned/, ./sync_state/)
- Production .env
- ./logs and ./multiTenantLogs (optional)

Source code is backed up in GitLab.

---

## Health Endpoints
- `/api/health/live` — container alive
- `/api/health/ready` — ready to accept requests
- `/api/health/deep` — all dependencies healthy

```bash
curl http://<endpoint>/api/health/ready
# Expected: {"status":"ready"}
```

---

## Logging

Smart Search owns:
- correction pipeline
- confidence scores
- latency
- fallback events
- learning data

PIMS owns:
- orchestration
- Elasticsearch communication
- Smart Search availability
- integration failures

Application logs written to:
- `./logs/queries.log` — global
- `./multiTenantLogs/client_<id>/queries.log` — per client

Include in server log rotation if required.

---

## Monitoring
```bash
# Application containers only
docker compose ps

# All logs combined
docker compose logs -f

# Individual container logs
docker logs smart-search-api --tail=50 -f
docker logs smart-search-meili --tail=50 -f

# Resource usage
docker stats
```

---

## Troubleshooting

**Health check fails**
→ `docker compose logs smart-search-api`

**Meilisearch unavailable**
→ `docker compose logs smart-search-meili`

**Container repeatedly restarting**
→ `docker compose ps`
→ `docker compose logs smart-search-api`
→ verify .env configuration

**Search returns no results**
→ `node clientConnection/syncAllClients.js`
→ verify Elasticsearch connectivity

**Cannot connect to Elasticsearch**
→ verify ES_NODE in .env
→ verify network access to Elasticsearch cluster

**API requests returning 401**
→ verify SMART_SEARCH_API_KEY in .env matches x-api-key header in requests

**Groq AI correction not working**
→ verify GROQ_API_KEY in .env
→ verify outbound access to api.groq.com

---

## Future Operational Enhancements
- GitLab CI/CD deployment automation
- Centralized log aggregation
- Metrics and dashboards
- Automated backups
- Alerting on fallback rate or latency

---

## Notes
- Port configurable via PORT in .env
- All configuration via .env file
- Versions managed by Docker images in docker-compose.yml


---

## Server Sizing Guide

### Minimum vs Recommended
                Minimum        Recommended

RAM 2GB 4GB
CPU 1 core 2 cores
Storage 10GB 20GB


### Resource Breakdown

RAM:
Smart Search API: 300MB
Meilisearch: 500MB-1GB
OS overhead: 500MB
─────────────────────────────
Minimum total: 2GB
Recommended total: 4GB

Storage:
OS: 5GB
Docker images: 1GB
Meilisearch data: 2GB (depends on catalog size)
Logs: 1GB
─────────────────────────────
Minimum total: 10GB
Recommended total: 20GB


### Current Catalog

8 clients — approximately 18,000 products total
Meilisearch RAM usage: approximately 200-300MB
Well within minimum requirements


### Why Recommended Size (4GB / 2 CPU / 20GB)

**Performance**
- Meilisearch runs fully in RAM — no disk swapping
- Search responses under 50ms
- Suggest responses under 100ms
- 2 CPUs handle parallel requests without queuing

**Growth Headroom**
- Current catalog (~18k products) uses ~300MB
- Can grow to ~200k products without server upgrade
- Can add 10-15 more clients without upgrade

**Stability**
- ~2.4GB free buffer after all services start
- No crashes under load
- Memory spikes handled safely
- Log rotation runs without impact

**Future Features**
- Delta sync runs comfortably
- Click tracking handled easily
- Lightweight AI models can run if needed

**Summary**

4GB = peace of mind for 2+ years
2GB = works today, tight tomorrow


