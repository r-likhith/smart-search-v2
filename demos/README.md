# demos/

Interactive demo pages for testing the search experience.

## Pages

| File               | Store                  | Client ID |
|-------------------|------------------------|-----------|
| client-135.html    | Sports Store           | 135       |
| client-137.html    | Grocery Store          | 137       |
| client-198.html    | Electronics (Poojara)  | 198       |
| client-210.html    | FMCG Store             | 210       |
| client-226.html    | Supermarket            | 226       |
| client-237.html    | Fresh Grocery          | 237       |
| client-246.html    | Health Store           | 246       |
| client-247.html    | Meat & Seafood         | 247       |
| index.html         | Demo index page        | —         |

## Access
http://localhost:3000/demos
http://localhost:3000/demos/client-198.html

## Features tested

- Search with typo correction ✅
- Correction banner display ✅
- "Search instead for X" link ✅
- Autocomplete suggestions ✅
- Click tracking (toast feedback) ✅
- Zero result fallback ✅
- Client isolation ✅

## Adding a new demo page

```bash
cp demos/client-198.html demos/client-999.html
```

Update in the new file:
- CLIENT_ID = '999'
- Store name and description
- Color theme
- Placeholder text

See aboutMeDocs/ADDING_NEW_CLIENT.md for full guide ✅
