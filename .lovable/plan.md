

## Minimal Kotak Neo WebSocket Test — Edge Function PoC

### Why an edge function
Kotak's WebSocket server (`wss://mlhsm.kotaksecurities.com`) blocks browser origins. All broker API calls in this project are already backend-only via edge functions. This PoC follows the same pattern.

### What to build

**Create `supabase/functions/kotak-ws-test/index.ts`**

A single edge function that:

1. Authenticates the caller, retrieves `access_token` and `session_token` from `broker_sessions`
2. Opens a WebSocket to `wss://mlhsm.kotaksecurities.com`
3. On open, sends a subscribe message for NIFTY (token 26000)
4. Collects up to 5 incoming messages or times out after 10 seconds
5. Returns a JSON response with: connection status, messages received, and any errors

```text
Client → invoke("kotak-ws-test")
       → Edge fn reads session from DB
       → Opens WSS to mlhsm.kotaksecurities.com
       → Sends: { type: "subscribe", instrument_tokens: [{ instrument_token: "26000", exchange_segment: "nse_cm" }], isIndex: true, isDepth: false }
       → Collects ticks for ≤10s
       → Returns { connected, tickCount, ticks[], errors[], logs[] }
```

**Key details:**
- Deno has native `WebSocket` — no dependencies needed
- Auth headers may need query params (`?access_token=X&sid=Y`) — try header approach first, fall back to query params
- The entire WebSocket lifecycle is wrapped in a single `Promise` with a 10s timeout
- All events (open, message, error, close) are logged and returned in the response for diagnosis
- Standard CORS headers included

### What NOT to build
- No frontend UI changes
- No retry/reconnect logic
- No option chain subscription
- No changes to existing `kotakMarketFeed.ts` or `useMarketData.ts`

### How to test after deployment
```javascript
const { data, error } = await supabase.functions.invoke('kotak-ws-test');
console.log(data);
// Expected: { connected: true, tickCount: N, ticks: [...], errors: [], logs: [...] }
```

### Files
- **Create:** `supabase/functions/kotak-ws-test/index.ts`
- No other files modified

