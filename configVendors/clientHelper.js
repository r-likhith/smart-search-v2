const clients = require('./clients');

// ─── RESOLVE CLIENT ID ────────────────────────────────────
// Handles both direct clientId (198) and vendor_slug format
// (izoleap_m_198, izoleap_m_198_products) ✅
// Extracts trailing number from vendor_slug ✅

function resolveClientId(clientId) {
  if (!clientId) return null;
  const id = String(clientId);

  // direct match first ✅
  if (clients[id]) return id;

  // extract trailing number from vendor_slug ✅
  // izoleap_m_198 → 198
  // izoleap_m_198_products → 198
  const match = id.match(/(\d+)(?:_products)?$/);
  if (match) {
    const extracted = match[1];
    if (clients[extracted]) return extracted;
  }

  return null;
}

// get client config by clientId
function getClient(clientId) {
  const resolved = resolveClientId(clientId);
  return resolved ? clients[resolved] : null;
}

// get Meilisearch index for a clientId
function getClientIndex(clientId) {
  const client = getClient(clientId);
  return client ? client.meiliIndex : null;
}

// get client scope (type) for a clientId ✅
// used for cross-client penalty detection ✅
// and future scope enforcement ✅
function getClientScope(clientId) {
  const client = getClient(clientId);
  return client ? client.type : null;
}

// validate clientId exists and is active
function isValidClient(clientId) {
  const client = getClient(clientId);
  return client !== null && client.active === true;
}

// get all active clients
function getAllActiveClients() {
  return Object.entries(clients)
    .filter(([, c]) => c.active)
    .map(([id, c]) => ({ id, ...c }));
}

// get all unsynced clients
function getUnsyncedClients() {
  return Object.entries(clients)
    .filter(([, c]) => c.active && !c.synced)
    .map(([id, c]) => ({ id, ...c }));
}

module.exports = {
  resolveClientId,
  getClient,
  getClientIndex,
  getClientScope,
  isValidClient,
  getAllActiveClients,
  getUnsyncedClients
};
