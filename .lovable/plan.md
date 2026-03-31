

## Upgrade: Max Pain, OI Badges, Auto-Trade, Signal Panel Fixes

### Part 1: Max Pain Calculation + Display

**Edge function (`supabase/functions/nse-market-data/index.ts`)**
- Add `calculateMaxPain(chain)` — iterate all strikes, for each candidate compute total pain (call holders lose when settling above strike, put holders lose when settling below), return strike with minimum total pain
- Add `niftyMaxPain` and `sensexMaxPain` to response payload

**Frontend (`src/hooks/useMarketData.ts`)**
- Add `niftyMaxPain` and `sensexMaxPain` to `MarketData` interface

**UI (`src/components/trading/AnalyticsPanels.tsx`)**
- Add a 4th analytics card: **MAX PAIN** showing strike value, distance from spot in points and %, and directional bias (spot > maxPain = bearish pull, spot < maxPain = bullish pull)
- Change grid from `grid-cols-3` to `grid-cols-4`

### Part 2: OI Source Badges in Option Chain

**Frontend (`src/hooks/useMarketData.ts`)**
- Add `oiSource?: 'nse' | 'synthetic'` to `OptionData` interface
- Pass through from API response

**UI (`src/components/trading/OptionChainTable.tsx`)**
- Add a small dot indicator next to OI values: green dot for real NSE data, yellow dot for synthetic
- Add legend entry: `🟢=Real OI  🟡=Est`

### Part 3: Auto-Trade Execution

**Frontend (`src/hooks/useMarketData.ts`)**
- Add `autoTradeEnabled` state (default `false`)
- In `handleMarketData`, after generating signals: if `autoTradeEnabled && !isPaperTrading`, filter signals with `confidence > 75` and `strength === 'HIGH'`, call an `onAutoTrade` callback
- Safety checks: respect existing risk limits (daily loss, max trades, cooldown)

**Dashboard (`src/pages/Dashboard.tsx`)**
- Add auto-trade toggle switch in header (only visible when broker connected + live mode)
- Wire auto-trade callback to invoke `kotak-place-order` edge function (same flow as manual confirm)
- Show toast for each auto-executed trade
- Add `autoTradeEnabled` to `useMarketData` hook export

### Part 4: Fix Signal Panel Visibility

**Dashboard (`src/pages/Dashboard.tsx`)**
- The signal panel container at line 229 has `w-[300px]` but sits inside a `flex min-h-0` parent — if no signals exist and the panel has no min-height, it can collapse
- Add `min-h-[200px]` to the signal panel wrapper
- Ensure the signal panel's parent flex container uses `overflow-visible` or proper `min-h-0` cascading

**SignalPanel (`src/components/trading/SignalPanel.tsx`)**
- Already has buy/sell buttons from previous work — verify they render correctly
- Add `min-h-[200px]` to the panel root to prevent collapse when empty
- Ensure `overflow-y: auto` and `max-h` work together properly inside the flex layout

### Part 5: Signal Type Labels + Strength Colors

Already partially implemented. Verify and ensure:
- Strategy badges ("Price Action" / "OI Analysis") render in each signal card
- Confidence badge colors: ≥75 green, ≥50 yellow, <50 gray (already in `ConfidenceBadge`)
- Strength badge: HIGH = green bg, MEDIUM = yellow bg (already implemented)

### Files to modify

1. `supabase/functions/nse-market-data/index.ts` — add `calculateMaxPain()`, include in response
2. `src/hooks/useMarketData.ts` — add `maxPain` + `oiSource` to types, add `autoTradeEnabled` state
3. `src/components/trading/AnalyticsPanels.tsx` — add Max Pain card, 4-col grid
4. `src/components/trading/OptionChainTable.tsx` — OI source dot indicators
5. `src/components/trading/SignalPanel.tsx` — min-height fix
6. `src/pages/Dashboard.tsx` — auto-trade toggle, wire auto-execution, signal panel min-height

### Technical details

- Max Pain formula: for each candidate strike S, pain = Σ max(0, S - row.strike) × row.callOI + Σ max(0, row.strike - S) × row.putOI; pick S with minimum pain
- Auto-trade only fires when: `autoTradeEnabled && !isPaperTrading && broker.trading === 'connected' && signal.confidence > 75 && riskLimits.ok`
- Auto-traded signals get auto-dismissed from the panel after execution
- OI source field already exists in edge function response — just needs to be threaded through to the frontend types

