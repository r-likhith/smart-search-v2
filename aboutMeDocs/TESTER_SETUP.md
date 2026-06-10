# Tester Setup Guide

This guide gets you from zero to a running Smart Search v2
in under 10 minutes. No coding knowledge needed.

---

## What you need

- A Mac or Windows computer ✅
- Internet connection ✅
- That's it ✅

---

## Step 1 — Install Docker Desktop

Docker runs the entire system for you automatically.

1. Go to: https://www.docker.com/products/docker-desktop/
2. Click "Download Docker Desktop"
3. Choose your system:
   - Mac with Apple chip (M1/M2/M3) → Download for Apple Silicon
   - Mac with Intel chip → Download for Intel
   - Windows → Download for Windows
4. Install it like any normal app
5. Open Docker Desktop
6. Wait until you see the whale icon in your menu bar ✅
7. Docker is ready when it says "Docker Desktop is running" ✅

Not sure which Mac you have?
- Click Apple menu → About This Mac
- If you see "Apple M1/M2/M3" → Apple Silicon
- If you see "Intel" → Intel

---

## Step 2 — Get the project

Open Terminal (Mac) or Command Prompt (Windows) and run:

```bash
git clone https://github.com/r-likhith/smart-search-v2.git
cd smart-search-v2
```

Don't have git?
- Mac: run `xcode-select --install` in Terminal
- Windows: download from https://git-scm.com/download/win

---

## Step 3 — Set up environment

Copy the environment template:

```bash
cp .env.example .env
```

Open the `.env` file and fill in these values:
MEILI_MASTER_KEY=    ← ask the team for this value
API_KEY=             ← ask the team for this value
GROQ_API_KEY=        ← ask the team for this value

Everything else can stay as-is for testing.

---

## Step 4 — Start the system

```bash
docker compose up
```

This will:
- Download Meilisearch (first time only, takes ~1 min) ✅
- Start the search engine ✅
- Load all product data ✅
- Start the Smart Search API ✅

You'll know it's ready when you see:
smart-search-api | 🌿 Smart Search v2
smart-search-api | Running at http://localhost:3000

This takes about 30-60 seconds the first time.

---

## Step 5 — Open the demo pages

Open your browser and go to:
http://localhost:3000/demos

You'll see 8 store demos:
- 📱 Electronics store
- ⚽ Sports store
- 🛒 Grocery store
- 🏪 FMCG store
- 🥑 Supermarket
- 🥦 Fresh Grocery
- 💊 Health store
- 🐟 Meat & Seafood store

Click any store to start testing ✅

---

## What to test

### 1. Basic search
Type any product name and see results appear.

### 2. Typo correction
Try typing with mistakes:
labtop     → should show laptops ✅
leggigns   → should show leggings ✅
nikee      → should show Nike products ✅
keybord    → should show keyboards ✅

Look for the banner that says:
"Showing results for laptop — Search instead for labtop"

### 3. Autocomplete
Start typing slowly (3+ characters) and watch
suggestions appear below the search box.

### 4. Click tracking
Click on any product card.
You should see a green toast: "✓ Click recorded"

### 5. No results
Search for something that doesn't exist:
xyznotaproduct
Should show popular products as fallback.

### 6. Client isolation
Search "chicken" on the meat store → meat products ✅
Search "chicken" on the electronics store → different results ✅
Each store only shows its own products.

---

## Useful pages

| Page                              | What it shows              |
|----------------------------------|----------------------------|
| http://localhost:3000/demos       | All 8 store demos          |
| http://localhost:3000/analytics   | Search analytics dashboard |
| http://localhost:3000/api/health  | System health check        |

---

## Stopping the system

Press `Ctrl+C` in the Terminal where docker compose is running.

Or in a new Terminal:
```bash
cd smart-search-v2
docker compose down
```

---

# docker compose down ✅ — use this normally
What it does:
→ stops containers ✅
→ removes containers ✅
→ removes network ✅

What it KEEPS:
→ meili_data volume ✅
→ all your product indexes ✅
→ all your learned corrections ✅
→ all your logs ✅

Use this: every time you stop ✅

# docker compose down -v ⚠️ — use carefully
What it does:
→ everything above PLUS ✅
→ DELETES meili_data volume ✅
→ ALL product indexes gone ✅
→ Meilisearch starts empty ✅
→ need to reimport everything ✅

Use this ONLY when:
→ you want a completely fresh start ✅
→ data is corrupted ✅
→ switching Meilisearch versions ✅
→ intentional wipe ✅

Rule of thumb
Daily use:
→ docker compose down ✅

Something broken, need fresh start:
→ docker compose down -v ✅
→ then docker compose up ✅
→ data reloads from data.ms ✅

## Starting again later

```bash
cd smart-search-v2
docker compose up
```

Your data is saved — no need to set up again ✅

---

## Something not working?

### Docker not starting
- Make sure Docker Desktop is open and running ✅
- Look for the whale icon in menu bar ✅

### Port already in use
```bash
docker compose down
docker compose up
```

### Search returns no results
- Wait 30 more seconds for startup to complete ✅
- Check the Terminal for error messages ✅

### Page not loading
- Make sure docker compose up is still running ✅
- Try http://localhost:3000/api/health ✅
- Should return: {"data":{"status":"healthy"}} ✅

### Still stuck?
Send a screenshot of your Terminal to the team ✅

---

## What to report

When you find something, note:
1. Which store demo you were on ✅
2. What you searched for ✅
3. What you expected to see ✅
4. What you actually saw ✅
5. A screenshot if possible ✅

---

## Summary
Install Docker Desktop ✅
git clone the project ✅
cp .env.example .env + fill values ✅
docker compose up ✅
open http://localhost:3000/demos ✅
start testing ✅
