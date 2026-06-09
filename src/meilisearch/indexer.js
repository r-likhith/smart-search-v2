const client = require('./client');
const { PRODUCTS_INDEX, CATEGORIES_INDEX } = require('./indexes');

// ─── PRODUCT INDEXING ─────────────────────────────────────

// Add or update a single product
async function indexProduct(product) {
  try {
    await client.index(PRODUCTS_INDEX).addDocuments([{
      id: product.id,
      name: product.name,
      description: product.description,
      category: product.category,
      subcategory: product.subcategory || '',
      catalogue: product.catalogue,
      brand: product.brand || '',
      tags: product.tags || [],
      price: product.price,
      popularity: product.popularity || 0,
      sales: product.sales || 0
    }]);
    console.log(`Indexed product: ${product.name}`);
  } catch (err) {
    console.error(`Error indexing product ${product.name}:`, err.message);
    throw err;
  }
}

// Add multiple products at once
async function indexProducts(products) {
  try {
    const docs = products.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      category: p.category,
      subcategory: p.subcategory || '',
      catalogue: p.catalogue,
      brand: p.brand || '',
      tags: p.tags || [],
      price: p.price,
      popularity: p.popularity || 0,
      sales: p.sales || 0
    }));

    await client.index(PRODUCTS_INDEX).addDocuments(docs);
    console.log(`Indexed ${docs.length} products`);
  } catch (err) {
    console.error('Error indexing products:', err.message);
    throw err;
  }
}

// Remove a product
async function removeProduct(productId) {
  try {
    await client.index(PRODUCTS_INDEX).deleteDocument(productId);
    console.log(`Removed product: ${productId}`);
  } catch (err) {
    console.error(`Error removing product ${productId}:`, err.message);
    throw err;
  }
}

// Update a product
async function updateProduct(product) {
  try {
    await client.index(PRODUCTS_INDEX).updateDocuments([{
      id: product.id,
      name: product.name,
      description: product.description,
      category: product.category,
      subcategory: product.subcategory || '',
      catalogue: product.catalogue,
      brand: product.brand || '',
      tags: product.tags || [],
      price: product.price,
      popularity: product.popularity || 0,
      sales: product.sales || 0
    }]);
    console.log(`Updated product: ${product.name}`);
  } catch (err) {
    console.error(`Error updating product ${product.name}:`, err.message);
    throw err;
  }
}

// ─── CATEGORY INDEXING ────────────────────────────────────

async function indexCategories(categories) {
  try {
    await client.index(CATEGORIES_INDEX).addDocuments(categories);
    console.log(`Indexed ${categories.length} categories`);
  } catch (err) {
    console.error('Error indexing categories:', err.message);
    throw err;
  }
}

module.exports = {
  indexProduct,
  indexProducts,
  removeProduct,
  updateProduct,
  indexCategories
};