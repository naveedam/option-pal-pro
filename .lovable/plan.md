

## Root Cause Analysis

The "Missing Credentials" error (code 900902) has persisted because we have been using the **wrong base URL, wrong endpoint paths, and missing required headers**. I traced through the official Kotak Neo SDK v2 source code (`totp_api.py`, `neo_utility.py`, `urls.py`, `settings.py`) and found three critical differences from our current implementation:

### What the SDK actually does vs what we have

```text
                     SDK (correct)                          Our code (broken)
─────────────────────────────────────────────────────────────────────────────
Base URL         mis.kotaksecurities.com              gw-napi.kotaksecurities.com
Login endpoint   login/1.0/tradeApiLogin              login/1.0/login/v6/totp/login
Validate endpt   login/1.0/tradeApiValidate           login/1.0/login/v6/totp/validate
neo-fin-key hdr  "neotradeapi" (required)             MISSING
Auth header      Authorization: {consumer_key}        Authorization: {consumer_key} (ok)
Validate Auth    Auth: {view_token} (separate hdr)    Authorization: Bearer {viewToken}
Validate sid     sid: {sid}                           sid: {sid} (ok)
```

The `gw-napi` domain is the **API gateway** which enforces its own auth layer (Bearer tokens), causing the 900902 error. The SDK uses `mis.kotaksecurities.com` for session init, which accepts the consumer key directly.

### Plan

**File: `supabase/functions/kotak-neo-auth/index.ts`**

1. Change base URL from `https://gw-napi.kotaksecurities.com` to `https://mis.kotaksecurities.com`
2. Change TOTP login path from `login/1.0/login/v6/totp/login` to `login/1.0/tradeApiLogin`
3. Change TOTP validate path from `login/1.0/login/v6/totp/validate` to `login/1.0/tradeApiValidate`
4. Add `neo-fin-key: "neotradeapi"` header to both requests
5. Fix validate step headers: use `Auth: {viewToken}` header (not `Authorization: Bearer`) and keep `Authorization: {consumerKey}` + `sid: {sid}`

No frontend changes needed -- the `BrokerLoginDialog` payload is already correct.

