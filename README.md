# OPTIQ.TRADE

A live options trading analytics platform for Indian markets (NSE), built on Kotak Neo API with real-time option chain data, smart money signals, and one-click order execution.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Setup & Installation](#setup--installation)
- [Environment Variables](#environment-variables)
- [Supabase Setup](#supabase-setup)
- [Edge Functions](#edge-functions)
- [Frontend Components](#frontend-components)
- [Hooks & Services](#hooks--services)
- [Kotak Neo API Integration](#kotak-neo-api-integration)
- [Trading Signals](#trading-signals)
- [Risk Management](#risk-management)
- [Deployment](#deployment)
- [Disclaimer](#disclaimer)

---

## Overview

OPTIQ.TRADE is a personal options trading dashboard that connects to Kotak Neo's brokerage API to provide:

- **Live option chain** for NIFTY with real LTP, OI, Bid/Ask, Volume
- **Smart money analytics** — Gamma Wall, Dealer Positioning, Max Pain, OI Change
- **Trade signal generation** — PCR Reversal, Breakout, Support/Resistance, Multi-timeframe
- **Risk controls** — per-trade capital limits, daily loss cap, cooldown timers
- **Paper trading mode** — test signals without real money
- **Live order placement** — market orders via Kotak Neo API

---

## Architecture

```
Browser (Vercel)
    │
    ├── React Frontend (Vite + TypeScript)
    │       ├── useMarketData hook (signals, positions, feed)
    │       ├── useBrokerConnection hook (auth state)
    │       └── KotakMarketFeed service (polling every 5s)
    │
    └── Supabase Edge Functions
            ├── kotak-neo-auth      — login / session management
            ├── kotak-market-data   — option chain + spot price
            ├── kotak-place-order   — order execution
            ├── kotak-scrip-master  — instrument token resolver
            ├── nse-market-data     — market validation (Yahoo Finance)
            └── kotak-ws-test       — WebSocket test utility
```

Data flows:
1. User authenticates via Supabase Auth (email/password)
2. User connects Kotak Neo broker (Consumer Key + Mobile + UCC + TOTP + MPIN)
3. Kotak session stored in `broker_sessions` table
4. Frontend polls `kotak-market-data` every 5 seconds
5. Edge function fetches spot price + builds option chain via Kotak Quote API
6. Frontend renders chain, generates signals, tracks positions

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite |
| Styling | Tailwind CSS, shadcn/ui |
| State | React hooks (useState, useCallback, useRef) |
| Backend | Supabase Edge Functions (Deno) |
| Database | Supabase PostgreSQL |
| Auth | Supabase Auth (email/password) |
| Broker API | Kotak Neo REST API |
| Hosting | Vercel (frontend), Supabase (functions + DB) |

---

## Project Structure

```
option-pal-pro/
├── src/
│   ├── components/
│   │   ├── trading/
│   │   │   ├── OptionChainTable.tsx     # Main option chain display
│   │   │   ├── SignalPanel.tsx          # Trade signals list
│   │   │   ├── AnalyticsPanels.tsx      # Gamma Wall, Max Pain, OI panels
│   │   │   ├── BrokerLoginDialog.tsx    # Kotak Neo login modal
│   │   │   ├── BrokerStatus.tsx         # Connection status indicator
│   │   │   ├── RiskControls.tsx         # Risk settings panel
│   │   │   ├── PositionsPanel.tsx       # Open positions + P&L
│   │   │   ├── TradeTicketModal.tsx     # Order confirmation modal
│   │   │   ├── SpotTicker.tsx           # NIFTY/SENSEX spot display
│   │   │   └── FeedStatus.tsx           # Feed health indicator
│   │   └── ui/                          # shadcn/ui components
│   ├── hooks/
│   │   ├── useMarketData.ts             # Core data + signal generation
│   │   ├── useBrokerConnection.ts       # Broker auth state
│   │   ├── useTradeStore.ts             # Trade history (Supabase)
│   │   ├── useSmartMoney.ts             # OI analysis algorithms
│   │   ├── usePositionSizing.ts         # Kelly/fixed-fraction sizing
│   │   └── useBacktest.ts               # Backtest on closed trades
│   ├── services/
│   │   ├── kotakMarketFeed.ts           # Polling orchestrator + health
│   │   ├── marketDataProvider.ts        # Circuit breaker + rate limiter
│   │   ├── instrumentStore.ts           # Instrument token cache
│   │   └── brokerSession.ts             # Session state helpers
│   ├── pages/
│   │   ├── Dashboard.tsx                # Main trading dashboard
│   │   ├── AuthPage.tsx                 # Login / signup
│   │   └── Index.tsx                    # Root redirect
│   └── integrations/
│       └── supabase/
│           ├── client.ts                # Supabase client init
│           └── types.ts                 # Generated DB types
├── supabase/
│   └── functions/
│       ├── kotak-neo-auth/index.ts
│       ├── kotak-market-data/index.ts
│       ├── kotak-place-order/index.ts
│       ├── kotak-scrip-master/index.ts
│       ├── nse-market-data/index.ts
│       └── kotak-ws-test/index.ts
├── .env                                 # Local env vars (git-ignored)
└── vercel.json                          # Vercel deployment config
```

---

## Setup & Installation

### Prerequisites

- Node.js 18+
- Supabase CLI (`npm install -g supabase`)
- A Supabase project
- A Kotak Neo trading account with API access enabled

### Local Development

```bash
# Clone the repo
git clone https://github.com/naveedam/option-pal-pro
cd option-pal-pro

# Install dependencies
npm install

# Set up environment variables (see below)
cp .env.example .env

# Start dev server
npm run dev
```

The app will be available at `http://localhost:5173`.

---

## Environment Variables

Create a `.env` file in the project root:

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-anon-key
VITE_SUPABASE_PROJECT_ID=your-project-ref
```

These are the only frontend env vars needed. The edge functions automatically receive `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` from Supabase's runtime.

---

## Supabase Setup

### Database Schema

Run the following SQL in your Supabase SQL editor:

```sql
-- Broker sessions (stores Kotak Neo tokens)
CREATE TABLE public.broker_sessions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  broker text NOT NULL DEFAULT 'kotak_neo',
  access_token text,
  session_token text,
  consumer_key text,
  base_url text,
  is_active boolean NOT NULL DEFAULT true,
  connected_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, broker)
);

ALTER TABLE public.broker_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own sessions" ON public.broker_sessions
  FOR ALL USING (auth.uid() = user_id);

-- User profiles
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own profile" ON public.profiles
  FOR ALL USING (auth.uid() = id);

-- Trade history
CREATE TABLE public.trades (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  order_id text,
  symbol text,
  strike integer,
  option_type text,
  quantity integer,
  entry_price numeric,
  exit_price numeric,
  pnl numeric,
  is_paper boolean DEFAULT true,
  strategy text,
  confidence integer,
  stop_loss numeric,
  status text DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own trades" ON public.trades
  FOR ALL USING (auth.uid() = user_id);
```

### Deploy Edge Functions

```bash
# Link to your Supabase project
npx supabase link --project-ref your-project-ref

# Deploy all functions
npx supabase functions deploy
```

---

## Edge Functions

### `kotak-neo-auth`

Handles the 3-step Kotak Neo authentication flow and session management.

**Actions:**
- `login` — TOTP login → MPIN validation → store session in `broker_sessions`
- `status` — check if session is active and not expired
- `disconnect` — deactivate session, clear tokens

**Auth flow:**
```
POST /kotak-neo-auth { action: "login", consumerKey, mobileNumber, ucc, totp, mpin }
  → Step 1: POST https://mis.kotaksecurities.com/login/1.0/tradeApiLogin
  → Step 2: POST https://mis.kotaksecurities.com/login/1.0/tradeApiValidate
  → Store tokens in broker_sessions
```

---

### `kotak-market-data`

Fetches live NIFTY spot price and builds the option chain.

**Flow:**
1. Fetch NIFTY spot via `GET /script-details/1.0/quotes/neosymbol/nse_cm|Nifty 50/ltp`
2. Calculate ATM strike (`round(spot / 50) * 50`)
3. Load option tokens from public Kotak scrip master CSV (cached in memory for 6 hours)
4. Batch-fetch quotes for ±10 strikes (42 tokens) in batches of 20
5. Build option chain with LTP, OI, Volume, Bid/Ask per strike
6. Return: `{ niftySpot, niftyATM, niftyPCR, niftyChain[], niftyMaxPain }`

**Scrip master:** Uses public URL `https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/{date}/transformed/nse_fo.csv` — no auth required, cached for 6 hours.

**Token format:** Numeric tokens from scrip master (e.g. `nse_fo|51315`), not trading symbols.

---

### `kotak-place-order`

Places a market order via Kotak Neo.

```json
POST /kotak-place-order {
  "symbol": "NIFTY",
  "strike": 23650,
  "optionType": "CE",
  "quantity": 65,
  "orderType": "MARKET",
  "product": "MIS",
  "transactionType": "BUY",
  "instrumentToken": "51315",
  "tradingSymbol": "NIFTY22MAY2623650CE"
}
```

---

### `kotak-scrip-master`

Standalone scrip master loader used by the instrument token resolver on the frontend for order placement validation.

---

## Frontend Components

### `OptionChainTable`

Renders the full NIFTY option chain with:
- Call side: SM label, OI, OI Change, Volume, Bid, Ask, LTP
- Strike column (highlighted for ATM, gamma wall)
- Put side: LTP, Bid, Ask, Volume, OI Change, OI, SM label
- Heat map overlays based on OI intensity
- Smart money labels: CW (Call Writing), PW (Put Writing), LB, SB, SC, LU

### `SignalPanel`

Displays generated trade signals with:
- Direction (BUY/SELL), instrument, strike, confidence %
- Entry price, stop loss, target (auto-calculated)
- Strategy name and reasoning
- Execute Trade button (paper or live)
- Chain button (scrolls option chain to that strike)

### `AnalyticsPanels`

Five analytics panels:
- **Gamma Wall** — strike with highest combined OI
- **Dealer Positioning** — dealer gamma (long/short), expected trending moves
- **OI Change** — major call/put writing strikes
- **Max Pain** — strike where options sellers lose least
- **Performance** — closed trade P&L history

---

## Hooks & Services

### `useMarketData`

Core hook that orchestrates:
- Feed lifecycle (start/stop `KotakMarketFeed`)
- Signal generation from incoming chain data
- Position P&L updates
- Risk limit enforcement
- Paper trade execution

**Signal generators:**
- `generateOiSignals` — PCR extremes, OI buildup at ATM
- `generatePriceActionSignals` — breakout/breakdown, support bounce, resistance rejection, momentum
- `generateMultiTimeframeSignals` — trend alignment across short/medium/long windows

### `KotakMarketFeed`

Polling service that calls `kotak-market-data` every 5 seconds with:
- Circuit breaker (3 failures → 20s cooldown)
- Rate limiter (min 3s between requests)
- Deduplicator (no concurrent requests)
- Exponential backoff after 5 consecutive errors
- Health reporting: status, latency, last tick time, session errors

### `marketDataProvider`

Singleton that wraps the Supabase edge function call with resilience patterns. Caches last good data for stale returns during rate-limited periods.

### `instrumentStore`

Singleton that loads and caches NIFTY option instruments from `kotak-scrip-master` edge function. Used to resolve signal → numeric token before placing live orders. Refreshes every 6 hours.

---

## Kotak Neo API Integration

### Authentication Headers

All Kotak API calls require:

```
Authorization: {consumer_key}
Auth: {access_token}
sid: {session_token}
neo-fin-key: neotradeapi
```

### Quote API

```
GET {base_url}/script-details/1.0/quotes/neosymbol/{encoded_symbols}/{quote_type}
```

- `encoded_symbols`: URL-encoded comma-separated `exchange_segment|token` pairs
- `quote_type`: `ltp`, `ohlc`, or `all`
- Response field for LTP: `exchange_token` (token), `ltp` or `lstup_t` (price)

### Base URL

Obtained from the MPIN validation response (`data.baseUrl`). Falls back to `https://gw-napi.kotaksecurities.com`.

---

## Trading Signals

### Signal Types

| Strategy | Trigger | Direction |
|----------|---------|-----------|
| PCR Reversal | PCR < 0.8 with put OI building | PE buy |
| PCR Reversal | PCR > 1.2 with call OI building | CE buy |
| Call Wall Breakdown | Spot breaks above max call OI strike | CE buy |
| Put Support Breakdown | Spot breaks below max put OI strike | PE buy |
| ATM Volatility Spike | ATM CE+PE volume > 7000 each | CE/PE based on relative volume |
| Breakout Buy | Spot breaks 20-period high | CE buy |
| Breakdown Sell | Spot breaks 20-period low | PE buy |
| Support Bounce | Spot near 20-period low, rising | CE buy |
| Resistance Rejection | Spot near 20-period high, falling | PE buy |
| Momentum Up/Down | 3 consecutive rising/falling ticks | CE/PE |
| MTF Strong Buy/Sell | Breakout confirmed across all timeframes | CE/PE |
| Trend Continuation | Uptrend + PCR bullish + short-term rising | CE buy |

### Confidence Scoring

Each signal uses weighted confidence factors:
- OI change magnitude
- PCR extremity
- Gamma wall proximity
- Dealer gamma direction
- Price momentum
- Volume surge

Confidence 0-100%. Signals with `confidence > 75` and `strength === 'HIGH'` are eligible for auto-trading.

### Position Sizing

Uses fixed-fraction risk sizing:
```
qty = floor((capital × riskPerTrade) / (stopLossPoints × lotSize)) × lotSize
```

NIFTY lot size: **65**. Quantities always rounded to lot size multiples.

---

## Risk Management

Configurable risk controls enforced before every trade:

| Setting | Default | Description |
|---------|---------|-------------|
| Max Trades/Day | 10 | Daily trade limit |
| Max Daily Loss | ₹3,000 | Stop trading if P&L hits this |
| Cooldown (min) | 5 | Minimum minutes between trades |
| Capital | ₹1,00,000 | Total capital for sizing |
| Risk/Trade (%) | 2% | Max capital risked per trade |
| Stop Loss (%) | 2% | Stop loss as % of entry price |

Auto-trading is only enabled for HIGH confidence signals when live trading mode is on and broker is fully connected.

---

## Deployment

### Vercel (Frontend)

```bash
# Install Vercel CLI
npm install -g vercel

# Login and deploy
vercel login
vercel --prod
```

Set environment variables in Vercel dashboard or via CLI:
```bash
vercel env add VITE_SUPABASE_URL production
vercel env add VITE_SUPABASE_PUBLISHABLE_KEY production
vercel env add VITE_SUPABASE_PROJECT_ID production
```

### Supabase (Edge Functions)

```bash
# Link project
npx supabase link --project-ref your-project-ref

# Deploy all functions
npx supabase functions deploy

# Deploy single function
npx supabase functions deploy kotak-market-data
```

### Continuous Deployment

Vercel auto-deploys on every push to `main`. Edge functions must be manually deployed via CLI after changes.

---

## Disclaimer

This platform is built for **personal use only**. It is not registered as an Investment Adviser or Research Analyst with SEBI. All signals and analytics are for informational purposes only and do not constitute investment advice. Trading options involves substantial risk of loss. Past performance of signals does not guarantee future results.

For commercial/SaaS use, SEBI Investment Adviser (IA) registration under SEBI (Investment Advisers) Regulations, 2013 is required.
