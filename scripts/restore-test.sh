#!/bin/bash
# scripts/restore-test.sh
#
# Verifies the latest backup can actually be restored ✅
# Most teams verify backups exist but never verify restore works ✅
# Run this manually, or add to weekly cron alongside backup.sh ✅
#
# What it does:
#   1. Finds latest backup ✅
#   2. Copies to a temp directory ✅
#   3. Verifies SHA256 checksums match ✅
#   4. Verifies each file parses as valid JSON ✅
#   5. Reports restore-readiness ✅
#   6. Cleans up temp directory ✅
#
# What it does NOT do:
#   - Touch any live files (completely safe to run anytime) ✅
#   - Require Docker or the server to be running ✅

set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== RESTORE TEST ==="
echo ""

# ── find latest backup ────────────────────────────────────
LATEST=$(ls -dt backups/*/ 2>/dev/null | head -1)

if [ -z "$LATEST" ]; then
  echo "❌ No backups found in backups/"
  echo "   Run ./scripts/backup.sh first"
  exit 1
fi

echo "Latest backup: $LATEST"

# ── check checksums file exists ───────────────────────────
CHECKSUM_FILE="${LATEST}checksums.sha256"
if [ ! -f "$CHECKSUM_FILE" ]; then
  echo "❌ No checksums.sha256 found in $LATEST"
  echo "   Backup may be corrupt or created by an older version"
  exit 1
fi

# ── create temp restore directory ────────────────────────
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT  # always clean up, even on error ✅

echo "Restoring to temp directory: $TEMP_DIR"
echo ""

# ── copy backup files to temp ─────────────────────────────
cp "${LATEST}"*.json "$TEMP_DIR/" 2>/dev/null || true
cp "$CHECKSUM_FILE" "$TEMP_DIR/"

# ── verify checksums ──────────────────────────────────────
echo "Verifying checksums..."
CHECKSUM_PASS=0
CHECKSUM_FAIL=0

while IFS= read -r line; do
  EXPECTED_HASH=$(echo "$line" | awk '{print $1}')
  ORIGINAL_PATH=$(echo "$line" | awk '{print $2}')
  FILENAME=$(basename "$ORIGINAL_PATH")
  TEMP_FILE="$TEMP_DIR/$FILENAME"

  if [ ! -f "$TEMP_FILE" ]; then
    echo "  ❌ MISSING: $FILENAME"
    CHECKSUM_FAIL=$((CHECKSUM_FAIL + 1))
    continue
  fi

  ACTUAL_HASH=$(shasum -a 256 "$TEMP_FILE" | awk '{print $1}')
  if [ "$EXPECTED_HASH" = "$ACTUAL_HASH" ]; then
    echo "  ✅ checksum OK: $FILENAME"
    CHECKSUM_PASS=$((CHECKSUM_PASS + 1))
  else
    echo "  ❌ CHECKSUM MISMATCH: $FILENAME"
    echo "     expected: $EXPECTED_HASH"
    echo "     actual:   $ACTUAL_HASH"
    CHECKSUM_FAIL=$((CHECKSUM_FAIL + 1))
  fi
done < "$CHECKSUM_FILE"

# ── verify JSON parsability ───────────────────────────────
echo ""
echo "Verifying JSON integrity..."
JSON_PASS=0
JSON_FAIL=0

for FILE in "$TEMP_DIR"/*.json; do
  FILENAME=$(basename "$FILE")
  if node -e "JSON.parse(require('fs').readFileSync('$FILE', 'utf8'))" 2>/dev/null; then
    # get entry count for learnedMap specifically ✅
    if [ "$FILENAME" = "learnedMap.json" ]; then
      ENTRIES=$(node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('$FILE','utf8'))).length)" 2>/dev/null || echo "?")
      echo "  ✅ valid JSON: $FILENAME ($ENTRIES entries)"
    else
      echo "  ✅ valid JSON: $FILENAME"
    fi
    JSON_PASS=$((JSON_PASS + 1))
  else
    echo "  ❌ INVALID JSON: $FILENAME"
    JSON_FAIL=$((JSON_FAIL + 1))
  fi
done

# ── final report ──────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
echo "RESTORE TEST RESULT"
echo "════════════════════════════════════════"
echo "  Checksums:   $CHECKSUM_PASS passed, $CHECKSUM_FAIL failed"
echo "  JSON valid:  $JSON_PASS passed, $JSON_FAIL failed"
echo ""

if [ $CHECKSUM_FAIL -eq 0 ] && [ $JSON_FAIL -eq 0 ] && [ $CHECKSUM_PASS -gt 0 ]; then
  echo "✅ RESTORE READY — backup is intact and restorable"
  echo ""
  echo "To restore, run:"
  echo "  cp ${LATEST}learnedMap.json learned/learnedMap.json"
  echo "  cp ${LATEST}reverseIndex.json learned/reverseIndex.json"
  echo "  cp ${LATEST}suggestMap.json learned/suggestMap.json"
  echo "  cp ${LATEST}clicks.json learned/clicks.json"
  echo "  cp ${LATEST}buildState.json learned/buildState.json"
  echo "  curl -X POST http://localhost:3000/api/admin/reload -H 'x-api-key: \$API_KEY'"
  exit 0
else
  echo "❌ RESTORE NOT SAFE — backup has integrity issues"
  echo "   Do not restore from this backup until issues are resolved"
  exit 1
fi
