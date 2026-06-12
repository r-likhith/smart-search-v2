# scripts/

Utility and maintenance scripts.

## Files

| File                  | When to use                              |
|----------------------|-------------------------------------------|
| setup.js              | Once after cloning — copies seed files   |
| importProducts.js     | Import products from Excel into Meili    |
| buildDictionary.js    | Rebuild SymSpell dictionary from catalog |
| buildProductDict.js   | Build product-specific dictionary        |
| buildReverseIndex.js  | Rebuild reverseIndex from learnedMap     |
| enrichLearnedMap.js   | Add suggestMap entries from learnedMap   |
| pruneLearnedMap.js    | Remove stale/failed corrections (dry run)|
| extractCategories.js  | Extract category tree from products      |
| setupSynonyms.js      | Configure Meilisearch synonyms           |
| readExcel.js          | Helper to read Excel files               |
| fullDictScan.js       | Scan catalog for dictionary additions    |

## Most commonly used

### First-time setup
```bash
node scripts/setup.js
```

### Add new client products
```bash
node scripts/importProducts.js --clientId 999 --file products.xlsx
```

### Rebuild dictionary after new products
```bash
node scripts/buildDictionary.js
node scripts/buildProductDict.js
```

### Prune bad corrections (safe — dry run by default)
```bash
node scripts/pruneLearnedMap.js
node scripts/pruneLearnedMap.js --apply  # to actually prune
```
