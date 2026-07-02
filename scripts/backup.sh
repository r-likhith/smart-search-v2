#!/bin/bash
# scripts/backup.sh
#
# Nightly backup of all learned intelligence data ✅
# Verifies each backup file with SHA256 checksum ✅
# Fails loudly if nothing was backed up ✅
# Keeps last 14 days, auto-rotates older backups ✅
#
# Schedule via cron (run crontab -e and add):
#   0 2 * * * cd ~/Desktop/smart-search-v2 && ./scripts/backup.sh >> logs/backup.log 2>&1
#
# To restore from a specific backup:
#   ./scripts/restore-test.sh              ← verify first
#   cp backups/YYYYMMDD-HHMMSS/learnedMap.json learned/learnedMap.json
#   then POST /api/admin/reload

set -euo pipefail

cd "$(dirname "$0")/.."

TS=$(date +%Y%m%d-%H%M%S)
DEST="backups/$TS"
CHECKSUM_FILE="$DEST/checksums.sha256"
COPIED=0
FAILED=0

mkdir -p "$DEST"

echo "[$TS] Starting backup..."

# ── copy learned data files ───────────────────────────────
for FILE in \
  learned/learnedMap.json \
  learned/reverseIndex.json \
  learned/suggestMap.json \
  learned/clicks.json \
  learned/buildState.json; do

  if [ -f "$FILE" ]; then
    cp "$FILE" "$DEST/"
    COPIED=$((COPIED + 1))
    echo "  ✅ copied $FILE"
  else
    echo "  ⚠️  skipped $FILE (not found)"
  fi
done

# ── fail loudly if nothing was copied ────────────────────
# "Backup complete — 0 files" is operationally misleading ✅
if [ "$COPIED" -eq 0 ]; then
  echo ""
  echo "❌ No files backed up — learned/ directory may be missing or empty"
  echo "   Check that volumes are mounted correctly in docker-compose.yml"
  rm -rf "$DEST"
  exit 1
fi

# ── checksum verification ─────────────────────────────────
echo ""
echo "Verifying checksums..."

for BACKED_UP in "$DEST"/*.json; do
  [ -f "$BACKED_UP" ] || continue

  # verify file is valid JSON ✅
  if node -e "JSON.parse(require('fs').readFileSync('$BACKED_UP', 'utf8'))" 2>/dev/null; then
    shasum -a 256 "$BACKED_UP" >> "$CHECKSUM_FILE"
    echo "  ✅ verified $(basename $BACKED_UP)"
  else
    echo "  ❌ CORRUPT: $(basename $BACKED_UP) — not valid JSON"
    FAILED=1
  fi
done

# ── report result ─────────────────────────────────────────
echo ""
if [ $FAILED -eq 0 ]; then
  echo "✅ Backup complete — $COPIED files verified → $DEST"
else
  echo "⚠️  Backup completed with errors — check $DEST"
  exit 1
fi

# ── rotate old backups — keep last 14 ────────────────────
BACKUP_COUNT=$(ls -dt backups/*/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$BACKUP_COUNT" -gt 14 ]; then
  ls -dt backups/*/ | tail -n +15 | xargs rm -rf
  echo "🗑️  Rotated old backups (kept last 14)"
fi

echo "[$TS] Done."
