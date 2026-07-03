#!/usr/bin/env node
// scripts/rotateApiKey.js
// Disables old key for a client and generates a new one atomically
//
// Usage: node scripts/rotateApiKey.js <clientId>

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const KEYS_FILE = path.join(__dirname, '../config/apiKeys.json');
const clientId  = process.argv[2];

if (!clientId) {
  console.error('Usage: node scripts/rotateApiKey.js <clientId>');
  process.exit(1);
}

const keysData = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));

// disable old key
let oldName = `Client ${clientId}`;
for (const [, entry] of Object.entries(keysData.keys)) {
  if (String(entry.clientId) === String(clientId) && entry.status === 'active') {
    entry.status     = 'disabled';
    entry.disabledAt = new Date().toISOString();
    oldName          = entry.name;
    console.log(`Disabled old key for client ${clientId}`);
  }
}

// generate new key
const newKey = `sk_live_${crypto.randomBytes(32).toString('hex')}`;
keysData.keys[newKey] = {
  clientId:      String(clientId),
  name:          oldName,
  status:        'active',
  permissions: {
    search: true, suggest: true,
    analytics: false, admin: false
  },
  allowedOrigins: [],
  rateLimit:      100,
  createdAt:      new Date().toISOString(),
  lastUsed:       null,
  lastOrigin:     null
};

const tmp = KEYS_FILE + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(keysData, null, 2));
fs.renameSync(tmp, KEYS_FILE);

console.log('');
console.log('✅ Key rotated successfully');
console.log(`New key: ${newKey}`);
console.log('⚠️  Share new key with client via secure channel');
console.log('Next: restart server or POST /api/admin/reload');
