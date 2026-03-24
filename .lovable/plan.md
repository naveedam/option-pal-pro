
Goal: fix the persistent “Market feed unavailable / MARKET_DATA_UNAVAILABLE” state by aligning the backend quote call with Kotak’s real SDK flow instead of the current hybrid implementation.

What I found
- Login/auth is succeeding: `kotak-neo-auth` stores `access_token`, `session_token`, `consumer_key`, `base_url`, and status checks report auth connected.
- The failure is isolated to `supabase/functions/kotak-market-data/index.ts`.
- Current quote requests are being sent to:
  - `https://e41.kotaksecurities.com/apimarketdata/instruments/quote`
  - `https://e41.kotaksecurities.com/apimarketdata/quote`
- Edge logs show those calls repeatedly return HTTP 503, even though token + SID are present.
- The same file already contains SDK-style constants like `script-details/1.0/quotes/neosymbol/...`, but they are unused. So the function currently mixes two incompatible approaches.
- The quote request builder also strips payloads down to `instrumentTokens: ["26000"]`, which may not match the route/parser logic Kotak expects for the SDK-backed flow.

Implementation plan
1. Rework `kotak-market-data` to use one SDK-aligned quote strategy only
- Remove the current `/apimarketdata/*` primary path logic from `fetchQuotes`.
- Replace it with the SDK-aligned quote path already hinted in the file (`script-details/1.0/quotes/neosymbol/...`) and build requests exactly around that route.
- Keep request logging, but log the final URL, auth field presence, and parsed response shape instead of retrying incompatible endpoints.

2. Fix instrument mapping for index validation
- Stop treating index validation as “numeric token first, string fallback”.
- Use the identifier format Kotak expects for index quotes consistently in one place.
- Centralize the symbol mapper so `validateOnly`, full market fetch, and future quote calls all use the same symbol resolution.

3. Tighten session contract between auth and market-data functions
- Verify `kotak-neo-auth` persists every quote-required session field returned by login.
- If the SDK-aligned quote flow requires an additional field beyond `access_token`, `session_token`, and `base_url`, extend the stored session shape and save it during login.
- Only return `SESSION_EXPIRED` / `NO_SESSION` for true session problems; keep market failures as `MARKET_DATA_UNAVAILABLE`.

4. Improve backend diagnostics without changing auth state
- In `kotak-market-data`, return structured debug details on non-auth failures:
  - attempted URL
  - upstream status
  - short response body snippet
- In `validateOnly`, include those details in the response so the frontend can show a meaningful failure reason while keeping broker auth as connected.

5. Keep frontend behavior stable, but surface the real backend error
- `useBrokerConnection.ts`: preserve the current auth/market-data split, but capture backend `details` during validation failure.
- `Dashboard.tsx` and `BrokerLoginDialog.tsx`: keep “authenticated but feed unavailable” messaging, but show the specific backend reason instead of a generic unavailable message.
- No auto-reconnect loop should be added back.

Technical details
- Main files to update:
  - `supabase/functions/kotak-market-data/index.ts`
  - `supabase/functions/kotak-neo-auth/index.ts` (only if extra session fields are required)
  - `src/hooks/useBrokerConnection.ts`
  - `src/pages/Dashboard.tsx`
  - `src/components/trading/BrokerLoginDialog.tsx`
- Likely root cause:
  - auth flow is on the correct stack (`mis.kotaksecurities.com`)
  - market-data flow is still calling the wrong upstream interface (`/apimarketdata/*`)
  - logs confirm valid credentials but wrong quote transport/path
- Database changes:
  - probably none
  - only add a migration if the SDK quote flow requires storing an extra session field not already in `broker_sessions`

Verification after implementation
- Login should still succeed.
- Post-login validation should call one SDK-aligned quote route for `NIFTY`.
- Expected validation result:
  - `auth = connected`
  - `marketData = connected`
  - no more repeated 503-based `MARKET_DATA_UNAVAILABLE`
- If upstream still fails, UI should remain authenticated and display the exact quote-layer error, not flip connection state.
