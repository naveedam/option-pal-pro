import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const FALLBACK_BASE = "https://gw-napi.kotaksecurities.com";
const SCRIP_MASTER_PATH = "script-details/1.0/masterscrip/file-paths";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const headers = { ...corsHeaders, "Content-Type": "application/json" };

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401, headers });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401, headers });
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: session } = await adminClient
      .from("broker_sessions")
      .select("*")
      .eq("user_id", user.id)
      .eq("broker", "kotak_neo")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!session?.access_token) {
      return new Response(JSON.stringify({ success: false, error: "No active broker session" }), { headers });
    }

    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      return new Response(JSON.stringify({ success: false, error: "SESSION_EXPIRED" }), { headers });
    }

    const body = await req.json().catch(() => ({}));
    const symbol = (body.symbol || "NIFTY").toUpperCase();

    const baseUrl = (session.base_url || FALLBACK_BASE).replace(/\/$/, "");
    const accessToken = session.access_token;
    const sid = session.session_token || "";

    // Step 1: Get scrip master file paths
    const pathsUrl = `${baseUrl}/${SCRIP_MASTER_PATH}`;
    console.log(`[ScripMaster] GET ${pathsUrl}`);

    const pathsRes = await fetch(pathsUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "neo-fin-key": "neotradeapi",
        "sid": sid,
      },
    });

    if (!pathsRes.ok) {
      const text = await pathsRes.text();
      console.error(`[ScripMaster] Paths error ${pathsRes.status}: ${text.substring(0, 300)}`);
      return new Response(JSON.stringify({ success: false, error: "Failed to fetch scrip master paths" }), { headers });
    }

    const pathsData = await pathsRes.json();
    const fileList = pathsData?.filesPaths || pathsData?.data?.filesPaths || pathsData?.result || [];
    let nfoUrl = "";

    if (Array.isArray(fileList)) {
      for (const item of fileList) {
        const path = item?.path || item?.filePath || item?.url || "";
        if (typeof path === "string" && path.includes("nse_fo")) {
          nfoUrl = path;
          break;
        }
      }
    }

    if (!nfoUrl) {
      console.log("[ScripMaster] nse_fo URL not found:", JSON.stringify(pathsData).substring(0, 500));
      return new Response(JSON.stringify({ success: false, error: "NFO scrip master not found" }), { headers });
    }

    // Step 2: Download and parse CSV
    console.log(`[ScripMaster] Downloading CSV: ${nfoUrl}`);
    const csvRes = await fetch(nfoUrl);
    if (!csvRes.ok) {
      return new Response(JSON.stringify({ success: false, error: "CSV download failed" }), { headers });
    }

    const csvText = await csvRes.text();
    const lines = csvText.split("\n");
    console.log(`[ScripMaster] CSV lines: ${lines.length}`);

    const headerLine = lines[0]?.toLowerCase() || "";
    const cols = headerLine.split(",");

    const tokenIdx = cols.findIndex(h => h.includes("token") || h.includes("instrument_token") || h.includes("psymbol"));
    const symbolIdx = cols.findIndex(h => h.includes("symbol") || h.includes("trading_symbol") || h.includes("ptrdsymbol"));
    const strikeIdx = cols.findIndex(h => h.includes("strike") || h.includes("strike_price") || h.includes("dstrikeprice"));
    const optTypeIdx = cols.findIndex(h => h.includes("option") || h.includes("optiontype") || h.includes("poptiontype"));
    const expiryIdx = cols.findIndex(h => h.includes("expiry") || h.includes("pexpirydate") || h.includes("dexpiry"));
    const lotSizeIdx = cols.findIndex(h => h.includes("lot") || h.includes("lotsize") || h.includes("boardlotqty"));

    console.log(`[ScripMaster] Columns: token=${tokenIdx} symbol=${symbolIdx} strike=${strikeIdx} opt=${optTypeIdx} expiry=${expiryIdx} lot=${lotSizeIdx}`);
    console.log(`[ScripMaster] Headers: ${cols.slice(0, 20).join(", ")}`);

    if (tokenIdx < 0) {
      return new Response(JSON.stringify({ success: false, error: "Cannot parse scrip master CSV" }), { headers });
    }

    // Step 3: Extract NIFTY options with nearest expiry
    const instruments: any[] = [];
    let nearestExpiry = "";
    const allExpiries: Set<string> = new Set();

    // First pass: find nearest expiry
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(",");
      if (row.length < Math.max(tokenIdx, symbolIdx, strikeIdx, optTypeIdx, expiryIdx) + 1) continue;

      const sym = row[symbolIdx]?.trim().toUpperCase() || "";
      if (!sym.includes("NIFTY") || sym.includes("BANKNIFTY") || sym.includes("FINNIFTY")) continue;

      const optType = row[optTypeIdx]?.trim().toUpperCase() || "";
      if (optType !== "CE" && optType !== "PE") continue;

      const expiry = row[expiryIdx]?.trim() || "";
      if (expiry) allExpiries.add(expiry);
    }

    // Sort expiries and pick the nearest future one
    const sortedExpiries = Array.from(allExpiries).sort();
    const today = new Date().toISOString().split("T")[0];
    nearestExpiry = sortedExpiries.find(e => e >= today) || sortedExpiries[0] || "";
    console.log(`[ScripMaster] Nearest expiry: ${nearestExpiry} (total: ${sortedExpiries.length})`);

    // Second pass: extract instruments for nearest expiry
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(",");
      if (row.length < Math.max(tokenIdx, symbolIdx, strikeIdx, optTypeIdx, expiryIdx) + 1) continue;

      const sym = row[symbolIdx]?.trim().toUpperCase() || "";
      if (!sym.includes("NIFTY") || sym.includes("BANKNIFTY") || sym.includes("FINNIFTY")) continue;

      const optType = row[optTypeIdx]?.trim().toUpperCase() || "";
      if (optType !== "CE" && optType !== "PE") continue;

      const expiry = row[expiryIdx]?.trim() || "";
      if (expiry !== nearestExpiry) continue;

      const strike = parseFloat(row[strikeIdx] || "0");
      const normalizedStrike = strike > 100000 ? strike / 100 : strike;
      const token = row[tokenIdx]?.trim() || "";
      const lotSize = lotSizeIdx >= 0 ? parseInt(row[lotSizeIdx] || "25", 10) : 25;

      if (token && normalizedStrike > 0) {
        instruments.push({
          token,
          symbol: "NIFTY",
          strike: normalizedStrike,
          optionType: optType,
          expiry,
          lotSize: lotSize || 25,
          tradingSymbol: sym,
        });
      }
    }

    console.log(`[ScripMaster] Extracted ${instruments.length} instruments for expiry ${nearestExpiry}`);

    return new Response(JSON.stringify({
      success: true,
      instruments,
      expiry: nearestExpiry,
      count: instruments.length,
    }), { headers });

  } catch (error: any) {
    console.error("[ScripMaster] Error:", error);
    return new Response(JSON.stringify({ success: false, error: error.message || "Internal error" }), { status: 500, headers });
  }
});
