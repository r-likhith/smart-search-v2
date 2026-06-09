// Universal sync script — works for any client
// Usage: CLIENT_ID=137 node clientConnection/syncClient.js

require('dotenv').config();
const https   = require('https');
const http    = require('http');
const { MeiliSearch } = require('meilisearch');
const clients = require('../configVendors/clients');

// ─── CONFIG ───────────────────────────────────────────────
const CLIENT_ID  = process.env.SYNC_CLIENT_ID;
const MEILI_HOST = 'http://localhost:7700';
const BATCH_SIZE = 100;

if (!CLIENT_ID) {
  console.error('❌ SYNC_CLIENT_ID not set');
  console.error('   Usage: SYNC_CLIENT_ID=137 node clientConnection/syncClient.js');
  process.exit(1);
}

const clientConfig = clients[CLIENT_ID];
if (!clientConfig) {
  console.error(`❌ Unknown clientId: ${CLIENT_ID}`);
  process.exit(1);
}

const ES_NODE     = process.env.ES_NODE;
const ES_USERNAME = process.env.ES_USERNAME;
const ES_PASSWORD = process.env.ES_PASSWORD;
const ES_INDEX    = clientConfig.esIndex;
const MEILI_INDEX = clientConfig.meiliIndex;

const meili = new MeiliSearch({ host: MEILI_HOST });

// ─── KIBANA PROXY REQUEST ─────────────────────────────────

async function esRequest(method, path, body = null) {
  const baseUrl  = ES_NODE.replace(/\/$/, '');
  const proxyPath = '/api/console/proxy?path=' + encodeURIComponent(path) + '&method=' + method;
  const fullUrl  = new URL(baseUrl + proxyPath);

  const options = {
    hostname: fullUrl.hostname,
    port:     fullUrl.port || (fullUrl.protocol === 'https:' ? 443 : 80),
    path:     fullUrl.pathname + fullUrl.search,
    method:   'POST',
    headers: {
      'Content-Type':  'application/json',
      'kbn-xsrf':      'true',
      'Authorization': 'Basic ' + Buffer.from(ES_USERNAME + ':' + ES_PASSWORD).toString('base64')
    },
    rejectUnauthorized: false
  };

  return new Promise((resolve, reject) => {
    const reqBody = body ? JSON.stringify(body) : '{}';
    options.headers['Content-Length'] = Buffer.byteLength(reqBody);

    const protocol = fullUrl.protocol === 'https:' ? https : http;
    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Parse error: ' + data.substring(0, 300))); }
      });
    });
    req.on('error', reject);
    req.write(reqBody);
    req.end();
  });
}

// ─── FIELD MAPPER ─────────────────────────────────────────

function extractColor(variants = []) {
  const v = variants.find(v =>
    v.name && (v.name.toLowerCase() === 'colour' || v.name.toLowerCase() === 'color')
  );
  return v ? v.value : null;
}

function extractSize(variants = []) {
  const v = variants.find(v =>
    v.name && ['storage', 'ram', 'size', 'capacity', 'gm', 'kg', 'ml', 'l',
                'weight', 'volume', 'pack', 'packing', 'number'].includes(v.name.toLowerCase())
  );
  return v ? v.value : null;
}

function extractPrice(doc) {
  if (doc.max_sale_price && doc.max_sale_price > 0) return doc.max_sale_price;
  if (doc.sale_price && doc.sale_price > 0)         return doc.sale_price;
  if (doc.mrp_price && doc.mrp_price > 0)           return doc.mrp_price;
  if (doc.prices) {
    const firstKey = Object.keys(doc.prices)[0];
    if (firstKey) {
      const p = doc.prices[firstKey];
      return p.sale_price || p.mrp_price || 0;
    }
  }
  return 0;
}

function buildDescription(doc) {
  const parts = [];
  if (doc.short_description) parts.push(doc.short_description.replace(/<[^>]*>/g, '').trim());
  if (doc.description)       parts.push(doc.description.replace(/<[^>]*>/g, '').trim());
  if (doc.specifications?.length) {
    parts.push(doc.specifications.map(s => `${s.name}: ${s.value}`).join('. '));
  }
  const highlights = [doc.highlight1, doc.highlight2, doc.highlight3, doc.highlight4, doc.highlight5]
    .filter(Boolean).join('. ');
  if (highlights) parts.push(highlights);
  return parts.join(' ').trim() || null;
}

function mapProduct(doc) {
  return {
    id:          doc.id,
    sku:         doc.sku,
    name:        doc.title || doc.product_name,
    description: buildDescription(doc),
    catalogue:   doc.category_l1_name || null,
    category:    doc.category_l2_name || doc.category_l1_name || null,
    subcategory: doc.category_l3_name || null,
    subCategory: doc.category_l4_name || null,
    brand:       doc.brand_name || null,
    price:       extractPrice(doc),
    mrp:         doc.mrp_price || 0,
    color:       extractColor(doc.variants || []),
    size:        extractSize(doc.variants || []),
    popularity:  doc.is_top_seller ? 10 : (doc.is_featured ? 5 : 0),
    sales:       0,
    inStock:     (doc.qty > 0 || doc.stock > 0),
    isActive:    doc.status === true && doc.approved_status === 'approved',
    vendorId:    doc.vendor_id,
    slug:        doc.product_slug,
    thumbnail:   doc.thumbnail
  };
}

// ─── SYNC ─────────────────────────────────────────────────

async function sync() {
  console.log(`🔄 Syncing client ${CLIENT_ID} — ${clientConfig.name}`);
  console.log(`   Type:   ${clientConfig.type}`);
  console.log(`   Source: ${ES_INDEX}`);
  console.log(`   Target: ${MEILI_INDEX}\n`);

  // create index
  try {
    await meili.createIndex(MEILI_INDEX, { primaryKey: 'id' });
    console.log(`✅ Index "${MEILI_INDEX}" created`);
  } catch (e) {
    console.log(`ℹ️  Index "${MEILI_INDEX}" already exists`);
  }

  // configure filterable attributes
  const t1 = await meili.index(MEILI_INDEX).updateFilterableAttributes([
    'category', 'catalogue', 'subcategory', 'subCategory',
    'brand', 'color', 'size', 'price', 'mrp',
    'popularity', 'sales', 'inStock', 'isActive', 'vendorId'
  ]);
  await meili.waitForTask(t1.taskUid);
  console.log('✅ Filterable attributes configured');

  // configure sortable attributes
  const t2 = await meili.index(MEILI_INDEX).updateSortableAttributes([
    'price', 'mrp', 'popularity', 'sales'
  ]);
  await meili.waitForTask(t2.taskUid);

  // configure searchable attributes
  const t3 = await meili.index(MEILI_INDEX).updateSearchableAttributes([
    'name', 'description', 'catalogue', 'category',
    'subcategory', 'subCategory', 'brand', 'color', 'size'
  ]);
  await meili.waitForTask(t3.taskUid);
  console.log('✅ Searchable + Sortable attributes configured\n');

  // paginate through all products
  let synced  = 0;
  let skipped = 0;
  let from    = 0;
  let hasMore = true;

  while (hasMore) {
    const resp = await esRequest('GET', `/${ES_INDEX}/_search`, {
      from,
      size: BATCH_SIZE,
      query: {
        bool: {
          must: [
            { term: { status: true } },
            { term: { 'approved_status.keyword': 'approved' } }
          ]
        }
      }
    });

    if (!resp.hits?.hits) {
      console.error('\nUnexpected response:', JSON.stringify(resp).substring(0, 200));
      break;
    }

    const hits = resp.hits.hits;
    if (hits.length === 0) { hasMore = false; break; }

    const batch = hits.map(h => mapProduct(h._source)).filter(p => p.name);
    skipped += (hits.length - batch.length);

    if (batch.length > 0) {
      const addTask = await meili.index(MEILI_INDEX).addDocuments(batch);
      await meili.waitForTask(addTask.taskUid);
      synced += batch.length;
      process.stdout.write(`\r   Synced: ${synced} products...`);
    }

    from += hits.length;
    if (from >= resp.hits.total.value) hasMore = false;
  }

  console.log(`\n\n✅ Sync complete!`);
  console.log(`   Synced:  ${synced} products`);
  console.log(`   Skipped: ${skipped} (no name / inactive)`);

  const stats = await meili.index(MEILI_INDEX).getStats();
  console.log(`   In Meilisearch: ${stats.numberOfDocuments} documents`);

  // update synced flag reminder
  console.log(`\n💡 Remember to set synced:true for client ${CLIENT_ID} in configVendors/clients.js`);
}

sync().catch(console.error);
