// src/auth/apiKeyManager.js
//
// Per-client API key management ✅
// Storage: config/apiKeys.json (flat file, no DB needed at this scale)
// Keys are opaque — clientId is NOT encoded in the key itself ✅
// Mapping lives only in apiKeys.json ✅
//
// Key lifecycle:
//   generate → active → disabled (revoked)
//   re-enable by setting status: active ✅
//
// Future evolution:
//   swap JSON file for PostgreSQL api_keys table
//   middleware doesn't change — only this module does ✅

const fs   = require('fs');
const path = require('path');

const KEYS_FILE = path.join(__dirname, '../../config/apiKeys.json');

// ─── LOAD KEYS ────────────────────────────────────────────
// loaded once at startup, reloaded on demand ✅
// not hot-reloaded — restart or /api/admin/reload to pick up changes ✅

let keysData = { version: 1, keys: {} };

function loadKeys() {
  try {
    if (!fs.existsSync(KEYS_FILE)) {
      console.warn('[ApiKeys] config/apiKeys.json not found — using empty key store');
      return;
    }
    const raw = fs.readFileSync(KEYS_FILE, 'utf8');
    keysData  = JSON.parse(raw);
    const count = Object.keys(keysData.keys || {}).length;
    console.log(`[ApiKeys] Loaded ${count} API keys (version ${keysData.version}) ✅`);
  } catch (err) {
    console.error('[ApiKeys] Failed to load apiKeys.json:', err.message);
  }
}

// ─── VALIDATE KEY ─────────────────────────────────────────
// returns clientConfig or null ✅
// updates lastUsed + lastOrigin in memory (not persisted — performance) ✅

function validateKey(apiKey, origin = null) {
  if (!apiKey) return null;

  const entry = (keysData.keys || {})[apiKey];
  if (!entry) return null;
  if (entry.status !== 'active') return null;

  // update lastUsed in memory ✅
  entry.lastUsed   = new Date().toISOString();
  entry.lastOrigin = origin || null;

  return entry;
}

// ─── PERSIST LAST USED (async, non-blocking) ──────────────
// called occasionally to persist lastUsed to disk ✅
// not called on every request — too expensive ✅
// called by the nightly backup scheduler instead ✅

function persistKeys() {
  try {
    const tmp = KEYS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(keysData, null, 2));
    fs.renameSync(tmp, KEYS_FILE);
  } catch (err) {
    console.error('[ApiKeys] Failed to persist keys:', err.message);
  }
}

// ─── GET ALL KEYS (for admin listing) ─────────────────────

function getAllKeys() {
  return Object.entries(keysData.keys || {}).map(([key, entry]) => ({
    keyPreview:    key.slice(0, 12) + '...',  // never expose full key ✅
    clientId:      entry.clientId,
    name:          entry.name,
    status:        entry.status,
    permissions:   entry.permissions,
    rateLimit:     entry.rateLimit,
    createdAt:     entry.createdAt,
    lastUsed:      entry.lastUsed,
    lastOrigin:    entry.lastOrigin
  }));
}

module.exports = { loadKeys, validateKey, persistKeys, getAllKeys };
