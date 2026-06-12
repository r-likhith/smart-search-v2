# src/learned/

Modules that manage the correction maps.

## Files

| File           | Purpose                                      |
|---------------|-----------------------------------------------|
| learnedMap.js  | Load, apply, save, penalise corrections       |
| suggestMap.js  | Load, get, add autocomplete completions        |

## learnedMap.js

Key functions:
- loadMap()              → loads learnedMap.json into memory
- applyCorrection(query) → returns corrected query if known
- saveCorrection(...)    → strengthens a correction
- penaliseCorrection(...)→ weakens a bad correction
- getStats()             → returns map health stats

Correction lifecycle:
candidate → trusted → proven (or → disabled)

## suggestMap.js

Key functions:
- loadMap()              → loads suggestMap.json into memory
- getCompletion(prefix)  → returns completion for prefix
- addCompletion(...)     → adds new completion
- getStats()             → returns map stats

Data files are in learned/ folder (parent directory) ✅
