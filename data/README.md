# data/

Static reference data used by the search pipeline.

## Files

| File                    | Purpose                              |
|------------------------|---------------------------------------|
| dictionary.txt          | SymSpell word dictionary (25K words) |
| dictionary_phrases.txt  | SymSpell phrase dictionary (120K)    |
| productDict.txt         | Product-specific terms (181 entries) |
| categories.js           | Category tree for all clients        |

## dictionary.txt

General English words used by SymSpell for spell correction.
Built from a combination of:
- Standard English dictionary ✅
- Product catalog terms ✅
- Brand names ✅

Rebuilt using: node scripts/buildDictionary.js

## dictionary_phrases.txt

Multi-word phrases for SymSpell.
Handles: "running shoes", "face wash", "kurta set" etc.

## productDict.txt

Product-specific terms that general dictionaries miss:
- Brand names (Samsung, Himalaya, etc.)
- Product types (kurta, saree, dupatta, etc.)
- Technical terms (5G, AMOLED, etc.)

Rebuilt using: node scripts/buildProductDict.js

## categories.js

Category hierarchy for all 8 clients.
Used by intent parser and navigation.
