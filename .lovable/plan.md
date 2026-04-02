

## Fix: Kotak Order Placement Failing

### Root Cause

Two issues found from edge function logs:

1. **Wrong API URL**: The order function calls `https://gw-napi.kotaksecurities.com/Orders/2.0/quick/order/rule/ms/place` (hardcoded). But the broker session stores a dynamic `base_url` = `https://e41.kotaksecurities.com` assigned during authentication. Kotak Neo requires using this dynamic base URL for all API calls post-login. The hardcoded URL returns an empty/error response.

2. **Unsafe response parsing**: `kotakResponse.json()` crashes with "Unexpected end of JSON input" because the wrong endpoint returns an empty or HTML response. The code should use `.text()` first, then try JSON parse.

### Fix (single file: `supabase/functions/kotak-place-order/index.ts`)

**Change 1**: Read `base_url` from the `broker_sessions` row (already available since we `select("*")`). Use it to construct the order endpoint URL:
```
const orderUrl = `${session.base_url}/Orders/2.0/quick/order/rule/ms/place`;
```

**Change 2**: Add the required `neo-fin-key: "neotradeapi"` header (required by all Kotak Neo API calls per the auth flow docs).

**Change 3**: Replace `kotakResponse.json()` with safe parsing:
```typescript
const responseText = await kotakResponse.text();
let kotakData;
try {
  kotakData = JSON.parse(responseText);
} catch {
  console.error("Non-JSON response from Kotak:", responseText.substring(0, 500));
  // return error with the raw text for debugging
}
```

**Change 4**: Add `base_url` fallback — if `session.base_url` is missing, fall back to the hardcoded URL as a last resort.

### Also fix: `transactionType` is always "BUY"

In `Dashboard.tsx` line 130, the `transactionType` is hardcoded to `'BUY'` regardless of what the user clicks in the trade ticket modal. The modal passes `transactionType` as a parameter but it's ignored. Fix: pass `params.transactionType` through.

### Files to modify
1. `supabase/functions/kotak-place-order/index.ts` — use dynamic `base_url`, add `neo-fin-key` header, safe JSON parsing
2. `src/pages/Dashboard.tsx` — pass `transactionType` from trade ticket params

### Technical details
- The `broker_sessions` row already contains `base_url` field (confirmed: `https://e41.kotaksecurities.com`)
- The `neo-fin-key: "neotradeapi"` header is required per Kotak Neo API docs (used in auth flow already)
- Kotak's `tt` field expects `"B"` or `"S"`, so map `BUY` → `"B"` and `SELL` → `"S"`

