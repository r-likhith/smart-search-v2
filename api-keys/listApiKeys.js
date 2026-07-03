#!/usr/bin/env node
// scripts/listApiKeys.js
// Shows all registered API keys (key preview only — never full key)

const fs   = require('fs');
const path = require('path');

const KEYS_FILE = path.join(__dirname, '../config/apiKeys.json');

if (!fs.existsSync(KEYS_FILE)) {
  console.error('config/apiKeys.json not found');
  process.exit(1);
}

const { keys } = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));

console.log('');
console.log('═══════════════════════════════════════════════════════');
console.log('  API KEYS');
console.log('═══════════════════════════════════════════════════════');

for (const [key, entry] of Object.entries(keys)) {
  const preview = key.slice(0, 16) + '...';
  const status  = entry.status === 'active' ? '✅ active' : '❌ disabled';
  console.log('');
  console.log(`  Key:       ${preview}`);
  console.log(`  Client:    ${entry.clientId || '(legacy/shared)'} — ${entry.name}`);
  console.log(`  Status:    ${status}`);
  console.log(`  RateLimit: ${entry.rateLimit} req/min`);
  console.log(`  Created:   ${entry.createdAt}`);
  console.log(`  LastUsed:  ${entry.lastUsed || 'never'}`);
  console.log(`  LastFrom:  ${entry.lastOrigin || 'unknown'}`);
}

console.log('');
console.log('═══════════════════════════════════════════════════════');
console.log(`  Total: ${Object.keys(keys).length} keys`);
console.log('');
