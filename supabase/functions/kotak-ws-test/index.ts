import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const WS_URL = "wss://mlhsm.kotaksecurities.com";
const MAX_TICKS = 5;
const TIMEOUT_MS = 10_000;

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

    log(`Session found. access_token present, sid=${session.session_token ? "present" : "missing"}`);

    // 3. Open WebSocket
    const ticks: unknown[] = [];
    const errors: string[] = [];

    const result = await new Promise<{ connected: boolean; closeCode?: number; closeReason?: string }>((resolve) => {
      const timeout = setTimeout(() => {
        log("Timeout reached, closing WebSocket");
        try { ws.close(); } catch { /* ignore */ }
        resolve({ connected: ticks.length > 0 || errors.length === 0 });
      }, TIMEOUT_MS);

      let ws: WebSocket;
      try {
        // Try with query params for auth
        const wsUrl = `${WS_URL}?access_token=${encodeURIComponent(session.access_token!)}&sid=${encodeURIComponent(session.session_token || "")}`;
        log(`Connecting to WebSocket: ${WS_URL} (with query auth)`);
        ws = new WebSocket(wsUrl);
      } catch (e) {
        clearTimeout(timeout);
        errors.push(`WebSocket constructor error: ${e}`);
        log(`WebSocket constructor error: ${e}`);
        resolve({ connected: false });
        return;
      }

      ws.onopen = () => {
        log("WebSocket OPEN");

        const subscribeMsg = JSON.stringify({
          type: "subscribe",
          instrument_tokens: [
            { instrument_token: "26000", exchange_segment: "nse_cm" }
          ],
          isIndex: true,
          isDepth: false,
        });

        log(`Sending subscribe: ${subscribeMsg}`);
        ws.send(subscribeMsg);
      };

      ws.onmessage = (event) => {
        const data = typeof event.data === "string" ? event.data : `[binary ${(event.data as ArrayBuffer).byteLength}b]`;
        log(`TICK: ${data.substring(0, 500)}`);

        try {
          ticks.push(typeof event.data === "string" ? JSON.parse(event.data) : data);
        } catch {
          ticks.push(data);
        }

        if (ticks.length >= MAX_TICKS) {
          log(`Collected ${MAX_TICKS} ticks, closing`);
          clearTimeout(timeout);
          ws.close();
          resolve({ connected: true });
        }
      };

      ws.onerror = (event) => {
        const errMsg = `WebSocket error: ${(event as ErrorEvent).message || "unknown"}`;
        log(errMsg);
        errors.push(errMsg);
      };

      ws.onclose = (event) => {
        log(`WebSocket CLOSE code=${event.code} reason=${event.reason}`);
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
