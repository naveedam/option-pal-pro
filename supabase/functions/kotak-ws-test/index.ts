import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const WS_URL = "wss://mlhsm.kotaksecurities.com";
const MAX_TICKS = 5;
const TIMEOUT_MS = 30_000;

// Protocol constants from SDK
const CONNECTION_TYPE = 1;
const SUBSCRIBE_TYPE = 4;
const DATA_TYPE = 6;
const ACK_TYPE = 3; // SDK: 3 (NOT 9 which is SNAPSHOT)

// --- Binary helpers ---

function encodeUTF8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function decodeUTF8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function readUint16BE(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 8) | buf[offset + 1];
}

function readInt32BE(buf: Uint8Array, offset: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return view.getInt32(offset, false);
}

function hexDump(buf: Uint8Array, maxBytes = 64): string {
  return Array.from(buf.slice(0, maxBytes)).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

/**
 * SDK format for prepareConnectionRequest2:
 * [2: payload_len] [1: CONNECTION_TYPE=1] [1: field_count=3]
 *   [1: field_id=1] [2: jwt_len] [jwt_bytes]
 *   [1: field_id=2] [2: sid_len] [sid_bytes]
 *   [1: field_id=3] [2: src_len] [src_bytes]
 */
function buildConnectionRequest(jwt: string, sid: string): Uint8Array {
  const jwtBytes = encodeUTF8(jwt);
  const sidBytes = encodeUTF8(sid);
  const srcBytes = encodeUTF8("JS_API");

  // payload = type(1) + fieldCount(1) + 3 * (fieldId(1) + len(2) + data)
  const payloadLen = 1 + 1
    + 1 + 2 + jwtBytes.length
    + 1 + 2 + sidBytes.length
    + 1 + 2 + srcBytes.length;

  const buf = new Uint8Array(2 + payloadLen);
  let o = 0;

  // Length prefix
  buf[o++] = (payloadLen >> 8) & 0xff;
  buf[o++] = payloadLen & 0xff;

  // Type
  buf[o++] = CONNECTION_TYPE;

  // Field count
  buf[o++] = 3;

  // Field 1: JWT
  buf[o++] = 1;
  buf[o++] = (jwtBytes.length >> 8) & 0xff;
  buf[o++] = jwtBytes.length & 0xff;
  buf.set(jwtBytes, o);
  o += jwtBytes.length;

  // Field 2: SID (redis key)
  buf[o++] = 2;
  buf[o++] = (sidBytes.length >> 8) & 0xff;
  buf[o++] = sidBytes.length & 0xff;
  buf.set(sidBytes, o);
  o += sidBytes.length;

  // Field 3: Source
  buf[o++] = 3;
  buf[o++] = (srcBytes.length >> 8) & 0xff;
  buf[o++] = srcBytes.length & 0xff;
  buf.set(srcBytes, o);

  return buf;
}

/**
 * SDK format for prepareSubsUnSubsRequest:
 * [2: payload_len] [1: SUBSCRIBE_TYPE=4] [1: field_count=2]
 *   [1: field_id=1] [scrip_byte_array]
 *   [1: field_id=2] [1: channel_number]
 *
 * scrip_byte_array (getScripByteArray):
 *   [2: scrip_count]
 *   For each scrip: [1: scrip_len] [scrip_bytes]
 */
function buildSubscribeRequest(scrips: string[], channel = 1): Uint8Array {
  const scripBytesList = scrips.map(s => encodeUTF8(s));

  // Build scrip byte array
  let scripArrayLen = 2; // scrip_count (2 bytes)
  for (const sb of scripBytesList) {
    scripArrayLen += 1 + sb.length; // 1-byte len + data
  }

  // payload = type(1) + fieldCount(1) + fieldId(1) + scripArray + fieldId(1) + channel(1)
  const payloadLen = 1 + 1 + 1 + scripArrayLen + 1 + 1;

  const buf = new Uint8Array(2 + payloadLen);
  let o = 0;

  buf[o++] = (payloadLen >> 8) & 0xff;
  buf[o++] = payloadLen & 0xff;
  buf[o++] = SUBSCRIBE_TYPE;
  buf[o++] = 2; // field count

  // Field 1: scrips
  buf[o++] = 1;
  buf[o++] = (scrips.length >> 8) & 0xff;
  buf[o++] = scrips.length & 0xff;
  for (const sb of scripBytesList) {
    buf[o++] = sb.length;
    buf.set(sb, o);
    o += sb.length;
  }

  // Field 2: channel
  buf[o++] = 2;
  buf[o++] = channel;

  return buf;
}

/**
 * SDK format for get_acknowledgement_req:
 * [2: payload_len] [1: ACK_TYPE=3] [1: field_count=1]
 *   [1: field_id=1] [4: counter_int32_be]
 */
function buildAckRequest(counter = 1): Uint8Array {
  const payloadLen = 1 + 1 + 1 + 4; // type + fieldCount + fieldId + int32
  const buf = new Uint8Array(2 + payloadLen);
  let o = 0;

  buf[o++] = (payloadLen >> 8) & 0xff;
  buf[o++] = payloadLen & 0xff;
  buf[o++] = ACK_TYPE;
  buf[o++] = 1; // field count

  buf[o++] = 1; // field id
  // 4-byte BE counter
  const view = new DataView(buf.buffer);
  view.setInt32(o, counter, false);

  return buf;
}

/**
 * Parse connection response.
 * Response: [2: len] [1: type=1] [1: field_count] [1: field_id] [2: field_len] [status_byte]
 * e.g. 00 06 01 01 01 00 01 4e → status = "N"
 */
function parseConnectionStatus(buf: Uint8Array): string {
  // The status byte is the last byte of the message
  // Response format: 00 06 01 01 01 00 01 XX where XX is K or N
  if (buf.length < 5) return "?";
  return String.fromCharCode(buf[buf.length - 1]);
}

/**
 * Parse index tick data from binary DATA_TYPE message.
 */
function parseDataMessage(buf: Uint8Array, log: (m: string) => void): Record<string, unknown>[] {
  const ticks: Record<string, unknown>[] = [];
  try {
    if (buf.length < 4) return ticks;
    // [2: len] [1: type=6] [1: field_count or count]
    let o = 3;

    // Try to read field count
    const countOrFieldCount = buf[o++];

    // The data payload could vary. Try to parse scrip + numeric fields.
    // SDK parses based on INDEX_MAPPING or other mappings.
    // We'll try a flexible approach: read scrip name, then int32 fields.

    for (let i = 0; i < countOrFieldCount && o < buf.length; i++) {
      // Check if there's a field_id byte
      if (o >= buf.length) break;

      // Try reading scrip length (could be 1-byte or 2-byte)
      let scripLen = 0;
      let scrip = "";

      // Look for field_id pattern or direct scrip data
      if (o + 2 <= buf.length) {
        // Try 2-byte scrip length first
        scripLen = readUint16BE(buf, o);
        if (scripLen > 0 && scripLen < 100 && o + 2 + scripLen <= buf.length) {
          scrip = decodeUTF8(buf.slice(o + 2, o + 2 + scripLen));
          o += 2 + scripLen;
        } else if (buf[o] < 50 && o + 1 + buf[o] <= buf.length) {
          // 1-byte length
          scripLen = buf[o];
          scrip = decodeUTF8(buf.slice(o + 1, o + 1 + scripLen));
          o += 1 + scripLen;
        } else {
          break;
        }
      }

      // Read numeric fields (int32 each)
      const fields = ["ltp", "change", "changePercent", "open", "high", "low", "close", "yearlyHigh", "yearlyLow"];
      const tick: Record<string, unknown> = { scrip };

      for (const field of fields) {
        if (o + 4 > buf.length) break;
        tick[field] = readInt32BE(buf, o) / 100;
        o += 4;
      }

      ticks.push(tick);
    }
  } catch (e) {
    log(`Parse error: ${e}`);
  }
  return ticks;
}

// Scrip formats to try
const SCRIP_FORMATS = [
  ["if|26000"],
  ["nse_cm|26000"],
  ["if|NIFTY 50", "if|Nifty 50"],
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const headers = { ...corsHeaders, "Content-Type": "application/json" };
  const logs: string[] = [];
  const log = (msg: string) => { console.log(msg); logs.push(msg); };

  try {
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
    log(`Session found. access_token len=${session.access_token.length}, sid len=${sid.length}`);

    const ticks: unknown[] = [];
    const errors: string[] = [];
    let ackCounter = 0;

    const result = await new Promise<{ connected: boolean; closeCode?: number; closeReason?: string }>((resolve) => {
      const timeout = setTimeout(() => {
        log("Timeout reached, closing WebSocket");
        try { ws.close(); } catch { /* ignore */ }
        resolve({ connected: ticks.length > 0 });
      }, TIMEOUT_MS);

      let ws: WebSocket;
      let authenticated = false;
      let scripFormatIndex = 0;

      const sendNextSubscription = () => {
        if (scripFormatIndex >= SCRIP_FORMATS.length) {
          log("All scrip formats tried");
          return;
        }
        const scrips = SCRIP_FORMATS[scripFormatIndex];
        const subReq = buildSubscribeRequest(scrips);
        log(`Subscribe #${scripFormatIndex + 1}: ${JSON.stringify(scrips)} (${subReq.length}b) hex: ${hexDump(subReq)}`);
        ws.send(subReq.buffer);
        scripFormatIndex++;

        if (scripFormatIndex < SCRIP_FORMATS.length) {
          setTimeout(() => {
            if (ticks.length === 0 && authenticated) {
              sendNextSubscription();
            }
          }, 5000);
        }
      };

      try {
        log(`Connecting to ${WS_URL}`);
        ws = new WebSocket(WS_URL);
        ws.binaryType = "arraybuffer";
      } catch (e) {
        clearTimeout(timeout);
        errors.push(`WS error: ${e}`);
        resolve({ connected: false });
        return;
      }

      ws.onopen = () => {
        log("WS OPEN — sending connection request");
        const connReq = buildConnectionRequest(session.access_token!, sid);
        log(`ConnReq ${connReq.length}b hex: ${hexDump(connReq, 40)}`);
        ws.send(connReq.buffer);
      };

      ws.onmessage = (event) => {
        let buf: Uint8Array;
        if (event.data instanceof ArrayBuffer) {
          buf = new Uint8Array(event.data);
        } else if (typeof event.data === "string") {
          log(`TEXT: ${event.data.substring(0, 200)}`);
          return;
        } else {
          log(`Unknown msg type: ${typeof event.data}`);
          return;
        }

        log(`MSG ${buf.length}b hex: ${hexDump(buf)}`);

        if (buf.length < 3) return;
        const msgType = buf[2];

        if (msgType === CONNECTION_TYPE) {
          const status = parseConnectionStatus(buf);
          log(`Connection response: status="${status}"`);

          if (status === "K") {
            authenticated = true;
            log("AUTH OK — subscribing");
            sendNextSubscription();
          } else {
            log(`Connection REJECTED: "${status}"`);
            errors.push(`Connection rejected: ${status}`);
            clearTimeout(timeout);
            ws.close();
            resolve({ connected: false });
          }
          return;
        }

        if (msgType === DATA_TYPE) {
          const tickData = parseDataMessage(buf, log);
          if (tickData.length > 0) {
            for (const t of tickData) {
              log(`TICK: ${JSON.stringify(t)}`);
              ticks.push(t);
            }
            ackCounter++;
            const ack = buildAckRequest(ackCounter);
            ws.send(ack.buffer);
          }

          if (ticks.length >= MAX_TICKS) {
            log(`Got ${MAX_TICKS} ticks, closing`);
            clearTimeout(timeout);
            ws.close();
            resolve({ connected: true });
          }
          return;
        }

        // Log unknown message types with full hex
        log(`Unknown type=${msgType} (${buf.length}b)`);
      };

      ws.onerror = (event) => {
        const msg = `WS error: ${(event as ErrorEvent).message || "unknown"}`;
        log(msg);
        errors.push(msg);
      };

      ws.onclose = (event) => {
        log(`WS CLOSE code=${event.code} reason="${event.reason}"`);
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
    log(`Error: ${error.message}`);
    return new Response(JSON.stringify({ error: error.message, logs }), { status: 500, headers });
  }
});
