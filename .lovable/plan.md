

## Fix: Price-Action Signals Not Firing + Add Buy/Sell Buttons

### Root Cause: Signals Never Trigger

In `useMarketData.ts` line 309, the current spot price is pushed into `priceHistoryRef` **before** `generateSignals()` is called on line 313. This means `high20 = Math.max(...history)` always includes the current spot, so `spot > high20` is **always false**. Same for `spot < low20`. The price-action engine is dead code.

### Fix 1: Push price history AFTER signal generation

**File: `src/hooks/useMarketData.ts`**

Reorder lines 307-313: call `generateSignals` first using the existing history, then push the new spot price. This way the current spot can actually exceed the previous 20-period high/low.

### Fix 2: Add BUY and SELL buttons to SignalPanel

**File: `src/components/trading/SignalPanel.tsx`**

Currently every signal shows "CONFIRM BUY" regardless of option type. Change to:
- CE signals: show green **BUY CE** button (variant `buy`)
- PE signals: show red **SELL / BUY PE** button (variant `sell`)
- Add a strategy-type badge distinguishing OI-based vs Price-Action signals (e.g. tag showing "Price Action" or "OI Analysis")

### Fix 3: Lower breakout threshold for realistic triggering

The current condition `range > 10` is fine, but with 5-second polling and only 20 samples (~100 seconds of data), breakouts are rare. Add a `Momentum` signal that fires when recent 3 prices show consistent directional movement > 0.1% — this provides more frequent actionable signals.

### Files to modify
1. `src/hooks/useMarketData.ts` — reorder history push; add momentum signal
2. `src/components/trading/SignalPanel.tsx` — CE/PE-aware buy/sell buttons; strategy type badge

