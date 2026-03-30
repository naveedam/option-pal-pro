

## Enhance Market Data: Real OI Attempt + Price-Action Signals

### Constraint: NSE OI Access

The NSE option chain API (`nseindia.com/api/option-chain-indices`) was already tested and **blocks requests from non-Indian IPs**. The edge functions run in EU. This means direct NSE OI fetching will fail with 403.

**Approach:** Attempt NSE OI as a best-effort overlay. If it fails (expected), fall back to synthetic OI silently. This keeps the architecture ready for when a proxy or alternative source becomes available.

### Part 1: NSE OI Overlay (Best-Effort)

**Modify `supabase/functions/nse-market-data/index.ts`**

- Add `fetchNseOptionChain()` that tries the NSE API with proper headers/cookies
- If it succeeds, merge real OI into the synthetic chain: `callOI: nseRow?.CE?.openInterest ?? syntheticCallOI`
- If it fails (403/timeout), log the failure and return synthetic data unchanged
- Add a `source` field per chain row: `"nse"` or `"synthetic"` so the UI can indicate data quality

### Part 2: Price-Action Signal Engine

**Create price history tracker in `src/hooks/useMarketData.ts`**

- Maintain a rolling window of last 20 NIFTY spot prices (updated each poll cycle)
- Compute: `high20 = max(history)`, `low20 = min(history)`, `support/resistance` zones

**New signal strategies added to `generateSignals()`:**

| Signal | Condition | Type |
|--------|-----------|------|
| Breakout Buy | `spot > high20` | CE, HIGH confidence |
| Breakdown Sell | `spot < low20` | PE, HIGH confidence |
| Support Bounce | `spot within 0.3% of low20` and rising | CE, MEDIUM |
| Resistance Rejection | `spot within 0.3% of high20` and falling | PE, MEDIUM |

- Each signal includes `strategy`, `reason`, `confidence` (weighted scoring)
- Price history is passed as a ref to avoid re-renders

### Files to modify

1. `supabase/functions/nse-market-data/index.ts` — add NSE OI fetch attempt with silent fallback
2. `src/hooks/useMarketData.ts` — add price history tracking + 4 new price-action signal strategies

### Technical details

- Price history stored as `useRef<number[]>` (max 20 entries, FIFO)
- NSE fetch uses 3-second timeout to avoid slowing the main Yahoo response
- `Promise.allSettled` used so NSE failure never blocks Yahoo data
- Response adds `oiSource: "nse" | "synthetic"` field

