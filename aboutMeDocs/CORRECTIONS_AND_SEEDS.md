# learned/

This folder contains the correction data that powers Smart Search v2.

---

## Files

### Seed files (committed to git) ✅
These are the starting state — committed once, updated manually.

| File                      | Size       | Purpose                          |
|--------------------------|------------|----------------------------------|
| learnedMap.seed.json      | ~156 entries | Typo corrections (labtop→laptop) |
| suggestMap.seed.json      | ~113 entries | Autocomplete completions         |
| reverseIndex.seed.json    | ~103 words   | Reverse lookup index             |

### Runtime files (gitignored) ✅
These are generated at runtime — change with every search.
Never committed to git.

| File                    | Purpose                              |
|------------------------|--------------------------------------|
| learnedMap.json         | Active corrections (grows over time) |
| suggestMap.json         | Active completions (grows over time) |
| reverseIndex.json       | Active reverse index                 |
| learnedMap.backup.json  | Auto backup before each save         |
| reverseIndex.backup.json| Auto backup before each save         |
| clicks.json             | Click tracking data                  |
| buildState.json         | Click-to-correction build state      |

---

## How seed files work
New developer clones repo ✅
runs: node scripts/setup.js ✅
→ seed files copied to runtime files ✅
→ system starts with 156 corrections ✅
→ corrections grow as traffic flows ✅

---

## Updating seed files

When corrections have grown significantly (e.g. 50+ new
validated entries), update the seeds so new developers
start with a richer baseline:

```bash
cp learned/learnedMap.json    learned/learnedMap.seed.json
cp learned/suggestMap.json    learned/suggestMap.seed.json
cp learned/reverseIndex.json  learned/reverseIndex.seed.json

git add learned/*.seed.json
git commit -m "chore: update correction seeds"
git push
```

Do this periodically — not after every search session.
Good trigger: every 50+ new trusted corrections ✅

---

## learnedMap entry lifecycle
New correction added:
→ status: candidate ✅
After traffic validates it:
→ status: trusted ✅  (5+ successful uses)
→ status: proven  ✅  (20+ successful uses)
If correction causes bad results:
→ penalised ✅
→ status: disabled ✅
Proven entries are protected:
→ cannot be penalised ✅
→ most reliable corrections ✅

---

## Sources of corrections

| Source    | How added                          | Trust level |
|----------|------------------------------------|-------------|
| manual   | Added by hand in learnedMap.json   | High ✅     |
| symspell | Auto-detected spelling fix         | High ✅     |
| phonetic | Sound-alike match                  | Medium ✅   |
| groq     | AI-generated via offline learner   | Candidate ✅|
| click    | User click behavior                | Medium ✅   |

---

## Stats

Current seed state:
- learnedMap:   156 entries (100 manual, 27 symspell, 8 ollama, 21 groq)
- suggestMap:   113 completions
- reverseIndex: 103 correct words mapped

---

## Notes

- Runtime files are mounted as Docker volumes ✅
  Data persists across docker compose down/up ✅
- Seed files are the safety net ✅
  If runtime files are lost, run setup.js again ✅
- Never edit runtime files directly ✅
  Use the admin API or offline learner ✅
