import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const KOTAK_BASE = "https://gw-napi.kotaksecurities.com";

interface QuoteRequest {
  instruments: string[]; // e.g. ["NIFTY", "SENSEX"]
  strikeRange?: number;  // ATM ± N strikes
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const headers = { ...corsHeaders, "Content-Type": "application/json" };

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

    // Get active broker session
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
      return new Response(
        JSON.stringify({ error: "No active broker session. Please connect Kotak Neo." }),
        { status: 401, headers }
      );
    }

    // Check expiry
    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      await adminClient.from("broker_sessions")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", session.id);
      return new Response(
        JSON.stringify({ error: "Broker session expired. Please reconnect." }),
        { status: 401, headers }
      );
    }

    const body: QuoteRequest = await req.json();
    const { instruments = ["NIFTY", "SENSEX"], strikeRange = 10 } = body;

    const kotakHeaders = {
      "Authorization": `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
      "sid": session.session_token || "",
    };

    // Fetch spot quotes for indices
    const spotResponse = await fetch(`${KOTAK_BASE}/Quote/2.0/quote`, {
      method: "POST",
      headers: kotakHeaders,
      body: JSON.stringify({
        instrumentTokens: instruments.map(i => getInstrumentToken(i)),
        isIndex: true,
      }),
    });

    const spotData = await spotResponse.json();
    console.log("Kotak spot response status:", spotResponse.status);

    if (!spotResponse.ok) {
      console.error("Kotak spot API error:", spotData);
      return new Response(
        JSON.stringify({
          error: spotData?.errMsg || spotData?.message || "Failed to fetch spot data",
          kotakStatus: spotResponse.status,
        }),
        { status: 502, headers }
      );
    }

    // Parse spot prices
    const result: Record<string, any> = { timestamp: Date.now() };
    
    for (const instrument of instruments) {
      const token = getInstrumentToken(instrument);
      const quote = findQuote(spotData, token);
      const spotPrice = quote?.ltp || 0;
      const change = quote?.change || 0;
      
      if (spotPrice <= 0) {
        console.warn(`Invalid spot price for ${instrument}:`, quote);
        continue;
      }

      result[`${instrument.toLowerCase()}Spot`] = spotPrice;
      result[`${instrument.toLowerCase()}Change`] = change;

      // Fetch option chain around ATM
      const stepSize = instrument === "NIFTY" ? 50 : 100;
      const atmStrike = Math.round(spotPrice / stepSize) * stepSize;
      
      const chainResponse = await fetch(`${KOTAK_BASE}/Quote/2.0/optionchain`, {
        method: "POST",
        headers: kotakHeaders,
        body: JSON.stringify({
          instrumentToken: token,
          expiryDate: getNextExpiry(),
          strikeFrom: atmStrike - strikeRange * stepSize,
          strikeTo: atmStrike + strikeRange * stepSize,
        }),
      });

      const chainData = await chainResponse.json();
      console.log(`Kotak ${instrument} chain status:`, chainResponse.status);

      if (!chainResponse.ok) {
        console.error(`Kotak chain API error for ${instrument}:`, chainData);
        result[`${instrument.toLowerCase()}Chain`] = [];
        result[`${instrument.toLowerCase()}ATM`] = atmStrike;
        continue;
      }

      // Parse option chain
      const chain = parseOptionChain(chainData, atmStrike, stepSize, strikeRange);
      result[`${instrument.toLowerCase()}Chain`] = chain;
      result[`${instrument.toLowerCase()}ATM`] = atmStrike;

      // Compute PCR
      const totalCallOI = chain.reduce((s: number, o: any) => s + (o.callOI || 0), 0);
      const totalPutOI = chain.reduce((s: number, o: any) => s + (o.putOI || 0), 0);
      result[`${instrument.toLowerCase()}PCR`] = totalCallOI > 0
        ? Math.round((totalPutOI / totalCallOI) * 100) / 100
        : 0;
    }

    return new Response(JSON.stringify({ success: true, data: result }), { headers });

  } catch (error) {
    console.error("Market data error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers }
    );
  }
});

// Instrument token mapping for Kotak Neo
function getInstrumentToken(instrument: string): string {
  const tokens: Record<string, string> = {
    "NIFTY": "26000",    // NSE NIFTY 50 index token
    "SENSEX": "26001",   // BSE SENSEX index token
  };
  return tokens[instrument] || instrument;
}

// Find quote in Kotak response
function findQuote(data: any, token: string): any {
  if (!data) return null;
  // Kotak returns quotes in different formats depending on endpoint
  if (data.data && Array.isArray(data.data)) {
    return data.data.find((q: any) => String(q.instrumentToken) === token || String(q.token) === token);
  }
  if (data.data && typeof data.data === "object") {
    return data.data[token] || data.data;
  }
  return null;
}

// Get next Thursday expiry
function getNextExpiry(): string {
  const now = new Date();
  const day = now.getDay();
  const daysUntilThursday = (4 - day + 7) % 7 || 7;
  const thursday = new Date(now);
  thursday.setDate(now.getDate() + (day <= 4 ? (4 - day) : daysUntilThursday));
  return thursday.toISOString().split("T")[0];
}

// Parse Kotak option chain response into our format
function parseOptionChain(data: any, atmStrike: number, stepSize: number, range: number): any[] {
  const chain: any[] = [];

  // If Kotak returned structured data
  if (data?.data && Array.isArray(data.data)) {
    for (const row of data.data) {
      const strike = row.strikePrice || row.strike;
      if (!strike || strike <= 0) continue;

      chain.push({
        strike,
        callLTP: validate(row.callLTP || row.CE?.ltp, 0),
        putLTP: validate(row.putLTP || row.PE?.ltp, 0),
        callOI: validate(row.callOI || row.CE?.openInterest, 0),
        putOI: validate(row.putOI || row.PE?.openInterest, 0),
        callOIChange: validate(row.callOIChange || row.CE?.oiChange, 0),
        putOIChange: validate(row.putOIChange || row.PE?.oiChange, 0),
        callVolume: validate(row.callVolume || row.CE?.volume, 0),
        putVolume: validate(row.putVolume || row.PE?.volume, 0),
        callBid: validate(row.callBid || row.CE?.bid, 0),
        callAsk: validate(row.callAsk || row.CE?.ask, 0),
        putBid: validate(row.putBid || row.PE?.bid, 0),
        putAsk: validate(row.putAsk || row.PE?.ask, 0),
        isATM: strike === atmStrike,
      });
    }
  }

  // If no data came from API, return empty (no mock fallback)
  return chain.sort((a, b) => a.strike - b.strike);
}

function validate(value: any, fallback: number): number {
  const n = Number(value);
  return isFinite(n) && n >= 0 ? n : fallback;
}
