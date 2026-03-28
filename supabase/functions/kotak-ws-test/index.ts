import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const WS_URL = "wss://mlhsm.kotaksecurities.com";
const MAX_TICKS = 5;
const TIMEOUT_MS = 30_000; // increased to 30s for slow feeds

// All scrip formats to try — server silently ignores wrong ones
const SCRIP_FORMATS = [
  ["if|26000"],                          // index prefix (SDK default)
  ["nse_cm|26000"],                      // exchange segment prefix
  ["if|NIFTY 50", "if|Nifty 50"],       // name-based index
];

// Protocol constants (from Kotak Neo Python SDK HSWebSocketLib.py)
const CONNECTION_TYPE = 1;
const SUBSCRIBE_TYPE = 4;
const DATA_TYPE = 6;
const ACK_TYPE = 9;
const INDEX_PREFIX = "if";

// --- Binary protocol helpers ported from Python SDK ---

function encodeUTF8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function decodeUTF8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Pack a 16-bit big-endian unsigned int */
function packUint16BE(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  buf[0] = (value >> 8) & 0xff;
  buf[1] = value & 0xff;
  return buf;
}

/** Read a 16-bit big-endian unsigned int */
function readUint16BE(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 8) | buf[offset + 1];
}

/** Pack a 32-bit big-endian signed int */
function packInt32BE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  const view = new DataView(buf.buffer);
  view.setInt32(0, value, false);
  return buf;
}

/** Read a 32-bit big-endian signed int */
function readInt32BE(buf: Uint8Array, offset: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return view.getInt32(offset, false);
}

/** Read a 64-bit big-endian signed int as number */
function readInt64BE(buf: Uint8Array, offset: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const hi = view.getInt32(offset, false);
  const lo = view.getUint32(offset + 4, false);
  return hi * 0x100000000 + lo;
}

/**
 * Build binary connection request (prepareConnectionRequest2 from SDK).
 * Format:
 *   [2 bytes: total_len] [1 byte: CONNECTION_TYPE]
 *   [2 bytes: jwt_len] [jwt bytes]
 *   [2 bytes: sid_len] [sid bytes]
 *   [2 bytes: source_len] [source bytes]
 */
function buildConnectionRequest(jwt: string, sid: string): Uint8Array {
  const jwtBytes = encodeUTF8(jwt);
  const sidBytes = encodeUTF8(sid);
  const sourceBytes = encodeUTF8("JS_API");

  const payloadLen = 1 + 2 + jwtBytes.length + 2 + sidBytes.length + 2 + sourceBytes.length;
  const totalLen = 2 + payloadLen; // 2 bytes for length prefix + payload

  const buf = new Uint8Array(totalLen);
  let offset = 0;

  // Total length (excluding the 2-byte length field itself)
  buf[offset++] = (payloadLen >> 8) & 0xff;
  buf[offset++] = payloadLen & 0xff;

  // Type
  buf[offset++] = CONNECTION_TYPE;

  // JWT
  buf[offset++] = (jwtBytes.length >> 8) & 0xff;
  buf[offset++] = jwtBytes.length & 0xff;
  buf.set(jwtBytes, offset);
  offset += jwtBytes.length;

  // SID
  buf[offset++] = (sidBytes.length >> 8) & 0xff;
  buf[offset++] = sidBytes.length & 0xff;
  buf.set(sidBytes, offset);
  offset += sidBytes.length;

  // Source
  buf[offset++] = (sourceBytes.length >> 8) & 0xff;
  buf[offset++] = sourceBytes.length & 0xff;
  buf.set(sourceBytes, offset);

  return buf;
}

/**
 * Build binary subscribe/unsubscribe request (prepareSubsUnSubsRequest from SDK).
 * Format:
 *   [2 bytes: total_len] [1 byte: SUBSCRIBE_TYPE or UNSUBSCRIBE_TYPE]
 *   [1 byte: scrip_count]
 *   For each scrip:
 *     [2 bytes: scrip_len] [scrip bytes]  (e.g. "if|26000")
 */
function buildSubscribeRequest(scrips: string[]): Uint8Array {
  const scripBytesList = scrips.map((s) => encodeUTF8(s));
  let payloadLen = 1 + 1; // type + count
  for (const sb of scripBytesList) {
    payloadLen += 2 + sb.length;
  }
  const totalLen = 2 + payloadLen;
  const buf = new Uint8Array(totalLen);
  let offset = 0;

  buf[offset++] = (payloadLen >> 8) & 0xff;
  buf[offset++] = payloadLen & 0xff;
  buf[offset++] = SUBSCRIBE_TYPE;
  buf[offset++] = scrips.length;

  for (const sb of scripBytesList) {
    buf[offset++] = (sb.length >> 8) & 0xff;
    buf[offset++] = sb.length & 0xff;
    buf.set(sb, offset);
    offset += sb.length;
  }

  return buf;
}

/**
 * Build ACK request.
 * Format: [2 bytes: len=1] [1 byte: ACK_TYPE]
 */
function buildAckRequest(): Uint8Array {
  return new Uint8Array([0, 1, ACK_TYPE]);
}

/**
 * Parse connection response.
 * Returns status char: "K" = OK, "N" = NOT_OK
 */
function parseConnectionResponse(buf: Uint8Array): { type: number; status: string } {
  if (buf.length < 3) return { type: 0, status: "?" };
  // [2 bytes len] [1 byte type] [1 byte status]
  const type = buf[2];
  const status = buf.length > 3 ? String.fromCharCode(buf[3]) : "?";
  return { type, status };
}

/**
 * Parse index tick data from binary message.
 * Index data fields (from SDK INDEX_MAPPING):
 *   Field order after header: token(str), ltp(int), change(int), changePercent(int),
 *   open(int), high(int), low(int), close(int), yearlyHigh(int), yearlyLow(int)
 */
function parseIndexData(buf: Uint8Array, offset: number): Record<string, unknown> | null {
  try {
    // Read scrip name length + name
    if (offset + 2 > buf.length) return null;
    const scripLen = readUint16BE(buf, offset);
    offset += 2;
    if (offset + scripLen > buf.length) return null;
    const scrip = decodeUTF8(buf.slice(offset, offset + scripLen));
    offset += scripLen;

    // Read numeric fields - each is 4 bytes (int32)
    // SDK divides by 100 for price fields
    const fields: string[] = ["ltp", "change", "changePercent", "open", "high", "low", "close", "yearlyHigh", "yearlyLow"];
    const result: Record<string, unknown> = { scrip };

    for (const field of fields) {
      if (offset + 4 > buf.length) break;
      const raw = readInt32BE(buf, offset);
      offset += 4;
      // Prices are in paisa (x100), percentages in x100
      result[field] = raw / 100;
    }

    return result;
  } catch {
    return null;
  }
}

/**
 * Parse incoming binary message.
 */
function parseMessage(buf: Uint8Array, log: (msg: string) => void): { type: number; data: unknown } {
  if (buf.length < 3) {
    return { type: -1, data: null };
  }

  const msgLen = readUint16BE(buf, 0);
  const msgType = buf[2];

  if (msgType === CONNECTION_TYPE) {
    const status = buf.length > 3 ? String.fromCharCode(buf[3]) : "?";
    return { type: CONNECTION_TYPE, data: { status } };
  }

  if (msgType === DATA_TYPE) {
    // Data message: [2 len] [1 type] [1 count] [data...]
    if (buf.length < 4) return { type: DATA_TYPE, data: null };
    const count = buf[3];
    const ticks: Record<string, unknown>[] = [];
    let offset = 4;

    for (let i = 0; i < count; i++) {
      const tick = parseIndexData(buf, offset);
      if (tick) {
        ticks.push(tick);
        // Advance offset - estimate based on scrip name + 9 int32 fields
        if (offset + 2 <= buf.length) {
          const scripLen = readUint16BE(buf, offset);
          offset += 2 + scripLen + 9 * 4;
        }
      } else {
        break;
      }
    }

    return { type: DATA_TYPE, data: ticks };
  }

  // Other types: try to decode as text for logging
  try {
    const text = decodeUTF8(buf.slice(2));
    return { type: msgType, data: text };
  } catch {
    return { type: msgType, data: `[binary ${buf.length}b]` };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const headers = { ...corsHeaders, "Content-Type": "application/json" };
  const logs: string[] = [];
  const log = (msg: string) => { console.log(msg); logs.push(msg); };

  try {
    // 1. Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }

    // 2. Get session
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: session } = await adminClient
      .from("broker_sessions")
      .select("access_token, session_token, consumer_key, base_url")
      .eq("user_id", user.id)
      .eq("broker", "kotak_neo")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!session?.access_token) {
      return new Response(JSON.stringify({ error: "NO_SESSION", logs }), { status: 200, headers });
    }

    const sid = session.session_token || "";
    log(`Session found. access_token present, sid=${sid ? "present" : "missing"}`);

    // 3. Open WebSocket with binary protocol
    const ticks: unknown[] = [];
    const errors: string[] = [];

    const result = await new Promise<{ connected: boolean; closeCode?: number; closeReason?: string }>((resolve) => {
      const timeout = setTimeout(() => {
        log("Timeout reached, closing WebSocket");
        try { ws.close(); } catch { /* ignore */ }
        resolve({ connected: ticks.length > 0 });
      }, TIMEOUT_MS);

      let ws: WebSocket;
      let authenticated = false;
      let scripFormatIndex = 0;

      const hexDump = (buf: Uint8Array, maxBytes = 64): string => {
        const slice = buf.slice(0, maxBytes);
        return Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ');
      };

      const sendNextSubscription = () => {
        if (scripFormatIndex >= SCRIP_FORMATS.length) {
          log(`All scrip formats tried, waiting for data...`);
          return;
        }
        const scrips = SCRIP_FORMATS[scripFormatIndex];
        const subReq = buildSubscribeRequest(scrips);
        log(`Subscribe attempt ${scripFormatIndex + 1}: scrips=${JSON.stringify(scrips)} (${subReq.length} bytes)`);
        log(`Subscribe hex: ${hexDump(subReq)}`);
        ws.send(subReq.buffer);
        scripFormatIndex++;

        // Try next format after a delay if no data arrives
        if (scripFormatIndex < SCRIP_FORMATS.length) {
          setTimeout(() => {
            if (ticks.length === 0 && authenticated) {
              log(`No ticks from format ${scripFormatIndex}, trying next...`);
              sendNextSubscription();
            }
          }, 5000);
        }
      };

      try {
        log(`Connecting to WebSocket: ${WS_URL}`);
        ws = new WebSocket(WS_URL);
        ws.binaryType = "arraybuffer";
      } catch (e) {
        clearTimeout(timeout);
        errors.push(`WebSocket constructor error: ${e}`);
        log(`WebSocket constructor error: ${e}`);
        resolve({ connected: false });
        return;
      }

      ws.onopen = () => {
        log("WebSocket OPEN — sending binary connection request");
        const connReq = buildConnectionRequest(session.access_token!, sid);
        log(`Connection request: ${connReq.length} bytes`);
        log(`ConnReq hex: ${hexDump(connReq, 32)}`);
        ws.send(connReq.buffer);
      };

      ws.onmessage = (event) => {
        let buf: Uint8Array;
        if (event.data instanceof ArrayBuffer) {
          buf = new Uint8Array(event.data);
        } else if (typeof event.data === "string") {
          log(`TEXT message: ${event.data.substring(0, 500)}`);
          return;
        } else {
          log(`Unknown message type: ${typeof event.data}`);
          return;
        }

        log(`RAW MSG ${buf.length}b hex: ${hexDump(buf)}`);

        const parsed = parseMessage(buf, log);
        log(`PARSED type=${parsed.type} data=${JSON.stringify(parsed.data).substring(0, 300)}`);

        if (parsed.type === CONNECTION_TYPE) {
          const connData = parsed.data as { status: string };
          log(`Connection response: status="${connData.status}"`);

          if (connData.status === "K") {
            authenticated = true;
            log("AUTH SUCCESS — sending first subscription");
            sendNextSubscription();
          } else {
            log(`Connection REJECTED: status="${connData.status}"`);
            errors.push(`Connection rejected: ${connData.status}`);
            clearTimeout(timeout);
            ws.close();
            resolve({ connected: false });
          }
          return;
        }

        if (parsed.type === DATA_TYPE) {
          const tickData = parsed.data as Record<string, unknown>[];
          if (tickData && tickData.length > 0) {
            for (const t of tickData) {
              log(`TICK: ${JSON.stringify(t)}`);
              ticks.push(t);
            }
            // Send ACK
            ws.send(buildAckRequest().buffer);
            log(`ACK sent after ${tickData.length} ticks`);
          }

          if (ticks.length >= MAX_TICKS) {
            log(`Collected ${MAX_TICKS} ticks, closing`);
            clearTimeout(timeout);
            ws.close();
            resolve({ connected: true });
          }
          return;
        }

        log(`Other message type=${parsed.type}: ${JSON.stringify(parsed.data).substring(0, 300)}`);
      };

      ws.onerror = (event) => {
        const errMsg = `WebSocket error: ${(event as ErrorEvent).message || "unknown"}`;
        log(errMsg);
        errors.push(errMsg);
      };

      ws.onclose = (event) => {
        log(`WebSocket CLOSE code=${event.code} reason="${event.reason}"`);
        clearTimeout(timeout);
        resolve({ connected: ticks.length > 0, closeCode: event.code, closeReason: event.reason });
      };
    });

    return new Response(JSON.stringify({
      connected: result.connected,
      tickCount: ticks.length,
      ticks,
      errors,
      logs,
      closeCode: result.closeCode,
      closeReason: result.closeReason,
    }), { headers });

  } catch (error) {
    log(`Unhandled error: ${error.message}`);
    return new Response(JSON.stringify({ error: error.message, logs }), { status: 500, headers });
  }
});
