# configVendors/

Client configuration and helper utilities.

## Files

| File             | Purpose                                    |
|-----------------|---------------------------------------------|
| clients.js       | Registry of all clients and their config   |
| clientHelper.js  | Helper to get client scope for corrections |

## clients.js

Central registry of all clients:

```javascript
{
  '198': {
    id:         '198',
    name:       'Poojara Telecom',
    type:       'electronics',       // correction scope
    index:      'client_198_products',
    esIndex:    'izoleap_m_198_products',  // ES source
    meiliIndex: 'client_198_products',     // Meili target
    active:     true,
    synced:     true                 // enables delta sync
  }
}
```

## Adding a new client

Add an entry to clients.js then follow:
→ aboutMeDocs/ADDING_NEW_CLIENT.md ✅

## Client types (correction scopes)

electronics, grocery, sports, health, fmcg, meat_seafood, global
