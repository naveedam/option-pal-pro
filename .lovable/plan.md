

## Fix: Kotak WebSocket Requires Binary Protocol Handshake

### Root Cause

The edge function sends a **JSON text** subscribe message, but the Kotak HSM WebSocket server uses a **custom binary protocol**. The SDK source code (`HSWebSocketLib.py`) confirms:

1. After WebSocket opens, the client must send a **binary connection request** containing `access_token` and `sid` encoded in a specific byte format (`prepareConnectionRequest2`)
2. The server responds with a binary connection acknowledgment
3. Only after receiving `stat: "Ok"` can subscription requests be sent — also in binary format (`prepareSubsUnSubsRequest`)
4. All messages use opcode `0x2` (binary), not text

The current code sends `{"type": "subscribe", ...}` as JSON text — the server accepts the WebSocket connection but ignores all text-frame messages, resulting in 0 ticks and a timeout.

### Plan

**Update `supabase/functions/kotak-ws-test/index.ts`** to implement the SDK's binary protocol:

**Step 1 — Binary connection handshake**
After `ws.onopen`, build and send a binary connection request containing:
- `access_token` (as JWT field)
- `session_token` / sid (as redis key field)
- Source identifier `"JS_API"`

Port the `prepareConnectionRequest2(jwt, redisKey)` function from the Python SDK to TypeScript. This creates a byte array with a specific header format.

**Step 2 — Parse binary connection response**
In `ws.onmessage`, detect the connection response (binary, type byte = 1 = CONNECTION_TYPE). Parse status from it. If status is `"K"` (OK), proceed to subscribe. If `"N"` (NOT_OK), log failure and close.

**Step 3 — Binary subscribe request**
After successful connection, build an index subscription request for NIFTY (token `26000`):
- Port `prepareSubsUnSubsRequest` to TypeScript
- Use `SUBSCRIBE_TYPE` (4) with `INDEX_PREFIX` ("if")
- Scrip format: `"if|26000"` 
- Send as binary frame

**Step 4 — Parse binary tick data**
Incoming data messages (type 6 = DATA_TYPE) contain packed binary fields. Port the `parseData` method from `HSWrapper` to extract:
- LTP (index 2 in INDEX_MAPPING, field name "iv")
- Change, percent change, high, low, open, close

**Step 5 — Send acknowledgments**
The server expects periodic ACK messages after receiving data batches. Port `get_acknowledgement_req` to keep the connection alive.

### Files to modify
- `supabase/functions/kotak-ws-test/index.ts` — rewrite to use binary protocol

### What stays the same
- No frontend changes needed
- `marketDataProvider.ts` and `useBrokerConnection.ts` already read from `kotak-ws-test`
- Response format stays `{ connected, tickCount, ticks[], errors[], logs[] }`

### Expected result
- Binary handshake authenticates successfully
- Index subscription for NIFTY is accepted
- Live tick data (LTP, change, etc.) flows back as parsed JSON
- `MARKET_DATA_UNAVAILABLE` resolves

