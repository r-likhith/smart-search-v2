#!/usr/bin/env node
// scripts/disableApiKey.js
// Disables an API key immediately (does not delete it)
//
// Usage: node scripts/disableApiKey.js <key-preview-or-clientId>
// Example: node scripts/disableApiKey.js 198

const fs   = require('fs');
const path = require('path');

const KEYS_FILE = path.join(__dirname, '../config/apiKeys.json');
const target    = process.argv[2];

if (!target) {
  console.error('Usage: node scripts/disableApiKey.js <clientId>');
  process.exit(1);
}

const keysData = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
let   disabled = 0;

for (const [key, entry] of Object.entries(keysData.keys)) {
  if (String(entry.clientId) === String(target) && entry.status === 'active') {
    entry.status     = 'disabled';
    entry.disabledAt = new Date().toISOString();
    disabled++;
    console.log(`✅ Disabled key for client ${target}: ${key.slice(0, 16)}...`);
  }
}

if (disabled === 0) {
  console.warn(`⚠️  No active keys found for client ${target}`);
  process.exit(1);
}

const tmp = KEYS_FILE + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(keysData, null, 2));
fs.renameSync(tmp, KEYS_FILE);

console.log('Next: restart the server or POST /api/admin/reload');
