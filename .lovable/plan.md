

## Replace REST Market Data with WebSocket Source

### Problem
The UI calls `kotak-market-data` (REST) which consistently fails. A working WebSocket test function (`kotak-ws-test`) already exists and can deliver live ticks.

### Plan

**1. Update `marketDataProvider.ts` — switch to `kotak-ws-test`**
- In `doFetch()`, replace `supabase.functions.invoke('kotak-market-data', ...)` with `supabase.functions.invoke('kotak-ws-test')`
- No request body needed (the WS test function reads session from DB automatically)
- Parse response: extract LTP from `data.ticks[0]` (try `ltp`, then `last_traded_price`, then raw numeric parse)
- Build a `MarketData` object with `niftySpot: ltp` and zeroed-out fields for option chain (since WS test only streams index quotes)
- Mark success when `data.connected === true && data.tickCount > 0`
- Keep circuit breaker, cache, rate limiter, and dedup logic unchanged

**2. Update `useBrokerConnection.ts` — switch validation call**
- In `validateMarketData()`, replace `supabase.functions.invoke('kotak-market-data', { body: { validateOnly: true } })` with `supabase.functions.invoke('kotak-ws-test')`
- Success condition: `data.connected === true && data.tickCount > 0`
- Extract quote price from ticks for the validation log

**3. No changes needed to:**
- `kotakMarketFeed.ts` (it calls `marketDataProvider` which we're fixing)
- `useMarketData.ts` (it uses `KotakMarketFeed` which uses `marketDataProvider`)
- Dashboard or UI components (they already handle the market data states correctly)

### Files to modify
- `src/services/marketDataProvider.ts` — swap invoke target, parse WS response
- `src/hooks/useBrokerConnection.ts` — swap validation invoke target

### Expected result
- `MARKET_DATA_UNAVAILABLE` disappears after login
- NIFTY spot price shows in the ticker
- Option chain remains empty until a dedicated WS subscription is built later

