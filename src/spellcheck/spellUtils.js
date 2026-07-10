// ─── SPELL UTILITIES ──────────────────────────────────────
// Shared low-level spelling utilities ✅
// Used by: symspell, correctionValidator, benchmark, mastercheckup
//
// Keep this file focused:
//   ✅ edit distance
//   ✅ edit distance policy
//   ❌ phonetic helpers (not here)
//   ❌ semantic helpers (not here)
//   ❌ confidence helpers (not here)

// ─── EDIT DISTANCE (Levenshtein) ──────────────────────────
function getEditDistance(a, b) {
  if (!a || !b) return Math.max((a||'').length, (b||'').length);
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, (_, i) =>
    Array.from({length: n+1}, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0
    )
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

// ─── EDIT DISTANCE POLICY ─────────────────────────────────
// Policy as data — easy to tune, document, and test ✅
// Change here → all callers stay consistent ✅
const EDIT_DISTANCE_POLICY = [
  { maxLength: 4,        maxEdit: 0 },  // very short → no typo allowed
  { maxLength: 7,        maxEdit: 1 },  // medium → 1 edit allowed
  { maxLength: Infinity, maxEdit: 2 },  // long → 2 edits allowed
];

// accepts word string OR word length ✅
function maxAllowedEditDistance(lengthOrWord) {
  const len = typeof lengthOrWord === 'string'
    ? lengthOrWord.length
    : (lengthOrWord || 0);
  for (const rule of EDIT_DISTANCE_POLICY) {
    if (len <= rule.maxLength) return rule.maxEdit;
  }
  return 2;
}

module.exports = {
  getEditDistance,
  maxAllowedEditDistance,
  EDIT_DISTANCE_POLICY
};
