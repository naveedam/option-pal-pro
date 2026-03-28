

## Fix: Binary Protocol Format Mismatch Causing Connection Rejection

### Root Cause (from SDK source code analysis)

The server responds with `00 06 01 01 01 00 01 4e` — the last byte `4e` = ASCII "N" = NOT_OK. The connection is rejected because our binary frame format is wrong.

Comparing our implementation against the actual SDK `prepareConnectionRequest2`:

**SDK format:**
```text
[2: payload_len] [1: CONNECTION_TYPE=1] [1: field_count=3]
  [1: field_id=1] [2: jwt_len] [jwt_bytes]
  [1: field_id=2] [2: redis_len] [redis_bytes]
  [1: field_id=3] [2: src_len] [src_bytes]
```

**Our current format (broken):**
```text
[2: payload_len] [1: CONNECTION_TYPE=1]
  [2: jwt_len] [jwt_bytes]
  [2: sid_len] [sid_bytes]
  [2: src_len] [src_bytes]
```

We are missing:
1. The **field count byte** (`3`) after the type byte
2. **Field identifier bytes** (`1`, `2`, `3`) before each field's length

Additionally:
- Our `ACK_TYPE = 9` is wrong — SDK defines `ACK_TYPE = 3` (9 is SNAPSHOT)
- Our subscribe format is wrong — SDK uses `getScripByteArray` with a `[2-byte scrip_count][1-byte scrip_len][scrip_bytes]` structure plus field IDs and channel number
- Our response parser reads status from byte 3, but the response `00 06 01 01 01 00 01 4e` has the actual status at a different offset

### Plan

**Rewrite `supabase/functions/kotak-ws-test/index.ts`** binary helpers to match SDK exactly:

**1. Fix `buildConnectionRequest`** — Add field count byte (3) and field ID bytes (1, 2, 3) before each field, using the `ByteData` pattern from SDK's `prepareConnectionRequest2`

**2. Fix `buildSubscribeRequest`** — Port SDK's `prepareSubsUnSubsRequest` exactly:
- Uses `getScripByteArray` which formats scrips as `[2-byte count][1-byte len + scrip_bytes per scrip]`
- Includes field IDs (1 for scrips, 2 for channel), field count (2)
- Requires channel number parameter (default 1)

**3. Fix `buildAckRequest`** — Port SDK's `get_acknowledgement_req`:
- ACK_TYPE = 3 (not 9)
- Includes a counter parameter, field IDs, and 4-byte int payload

**4. Fix response parser** — Parse the connection response correctly based on SDK's actual response structure (the status byte position depends on the response format with field IDs)

**5. Fix constants** — `ACK_TYPE = 3`, keep `SUBSCRIBE_TYPE = 4`, `DATA_TYPE = 6`

### Files to modify
- `supabase/functions/kotak-ws-test/index.ts` — rewrite binary protocol helpers

### What stays the same
- No frontend changes
- No database changes
- Response format stays `{ connected, tickCount, ticks[], errors[], logs[] }`

### Expected result
- Connection accepted (status "K")
- Subscription processed
- Live tick data flows
- `MARKET_DATA_UNAVAILABLE` resolves

