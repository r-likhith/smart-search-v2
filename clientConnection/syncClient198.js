require('dotenv').config();
const https = require('https');
const http = require('http');
const { MeiliSearch } = require('meilisearch');

// ─── CONFIG ───────────────────────────────────────────────
const ES_NODE     = process.env.ES_NODE     || 'YOUR_KIBANA_URL';
const ES_USERNAME = process.env.ES_USERNAME || 'YOUR_USERNAME';
const ES_PASSWORD = process.env.ES_PASSWORD || 'YOUR_PASSWORD';
const ES_INDEX    = 'izoleap_m_198_products';
const MEILI_HOST  = 'http://localhost:7700';
const MEILI_INDEX = 'client_198_products';
const BATCH_SIZE  = 100;

const meili = new MeiliSearch({ host: MEILI_HOST });

// ─── KIBANA PROXY REQUEST ─────────────────────────────────
// We use Kibana's console proxy since we only have Kibana URL
// POST /api/console/proxy?path=...&method=GET

async function esRequest(method, path, body = null) {
  const baseUrl = ES_NODE.replace(/\/$/, '');
  const proxyPath = '/api/console/proxy?path=' + encodeURIComponent(path) + '&method=' + method;
  const fullUrl = new URL(baseUrl + proxyPath);

  const options = {
    hostname: fullUrl.hostname,
    port: fullUrl.port || (fullUrl.protocol === 'https:' ? 443 : 80),
    path: fullUrl.pathname + fullUrl.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'kbn-xsrf': 'true',
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
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Parse error: ' + data.substring(0, 300)));
        }
      });
    });
    req.on('error', reject);
    req.write(reqBody);
    req.end();
  });
}

// ─── FIELD MAPPER ─────────────────────────────────────────

function extractColor(variants = []) {
  const colorVariant = variants.find(v =>
    v.name && (v.name.toLowerCase() === 'colour' || v.name.toLowerCase() === 'color')
  );
  return colorVariant ? colorVariant.value : null;
}

function extractSize(variants = []) {
  const sizeVariant = variants.find(v =>
    v.name && ['storage', 'ram', 'size', 'capacity', 'gm', 'kg', 'ml', 'l'].includes(v.name.toLowerCase())
  );
  return sizeVariant ? sizeVariant.value : null;
}

function extractPrice(doc) {
  if (doc.max_sale_price) return doc.max_sale_price;
  if (doc.sale_price) return doc.sale_price;
  if (doc.mrp_price) return doc.mrp_price;
  if (doc.prices) {
    const firstKey = Object.keys(doc.prices)[0];
    if (firstKey) return doc.prices[firstKey].sale_price || doc.prices[firstKey].mrp_price;
  }
  return 0;
}

function buildDescription(doc) {
  const parts = [];
  if (doc.short_description) parts.push(doc.short_description.replace(/<[^>]*>/g, ''));
  if (doc.description) parts.push(doc.description.replace(/<[^>]*>/g, ''));
  if (doc.specifications?.length) {
    const specs = doc.specifications.map(s => `${s.name}: ${s.value}`).join('. ');
    parts.push(specs);
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
  console.log('🔄 Starting sync: Elasticsearch → Meilisearch');
  console.log(`   Source: ${ES_INDEX}`);
  console.log(`   Target: ${MEILI_INDEX}\n`);

  // create/configure Meilisearch index
  try {
    await meili.createIndex(MEILI_INDEX, { primaryKey: 'id' });
    console.log(`✅ Index "${MEILI_INDEX}" created`);
  } catch (e) {
    console.log(`ℹ️  Index "${MEILI_INDEX}" already exists`);
  }

  // configure filterable attributes
  const task = await meili.index(MEILI_INDEX).updateFilterableAttributes([
    'category', 'catalogue', 'subcategory', 'subCategory',
    'brand', 'color', 'size', 'price', 'mrp',
    'popularity', 'sales', 'inStock', 'isActive', 'vendorId'
  ]);
  await meili.waitForTask(task.taskUid);
  console.log('✅ Filterable attributes configured');

  const task2 = await meili.index(MEILI_INDEX).updateSortableAttributes([
    'price', 'mrp', 'popularity', 'sales'
  ]);
  await meili.waitForTask(task2.taskUid);
  console.log('✅ Sortable attributes configured\n');

  // fetch all products via pagination
  let synced = 0;
  let skipped = 0;
  let from = 0;
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

    if (!resp.hits || !resp.hits.hits) {
      console.error('\nUnexpected response:', JSON.stringify(resp).substring(0, 300));
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
  console.log(`   Skipped: ${skipped} products (no name/inactive)`);

  const stats = await meili.index(MEILI_INDEX).getStats();
  console.log(`   In Meilisearch: ${stats.numberOfDocuments} documents`);
}

sync().catch(console.error);