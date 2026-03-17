import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const KOTAK_BASE = "https://gw-napi.kotaksecurities.com";

interface QuoteRequest {
  instruments: string[];
  strikeRange?: number;
}

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

    // Get active broker session
    const { data: session, error: sessionError } = await adminClient
      .from("broker_sessions")
      .select("*")
      .eq("user_id", user.id)
      .eq("broker", "kotak_neo")
      .eq("is_active", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    console.log("Session lookup:", { userId: user.id, found: !!session, error: sessionError?.message });

    if (!session?.access_token) {
      return new Response(
        JSON.stringify({ success: false, error: "Broker not connected. Please login to Kotak Neo.", code: "NO_SESSION" }),
        { status: 200, headers }
      );
    }

    // Check expiry
    if (session.expires_at && new Date(session.expires_at) < new Date()) {
      await adminClient.from("broker_sessions")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("id", session.id);
      return new Response(
        JSON.stringify({ success: false, error: "Broker session expired. Please reconnect Kotak Neo.", code: "SESSION_EXPIRED" }),
        { status: 200, headers }
      );
    }

    const body: QuoteRequest = await req.json();
    const { instruments = ["NIFTY", "SENSEX"], strikeRange = 10 } = body;

    const kotakHeaders = {
      "Authorization": `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
      "sid": session.session_token || "",
    };

    // Fetch spot quotes
    console.log("Fetching spot quotes for:", instruments);
    const spotResponse = await fetch(`${KOTAK_BASE}/Quote/2.0/quote`, {
      method: "POST",
      headers: kotakHeaders,
      body: JSON.stringify({
        instrumentTokens: instruments.map(i => getInstrumentToken(i)),
        isIndex: true,
      }),
    });

    const spotData = await spotResponse.json();
    console.log("Kotak spot response:", { status: spotResponse.status, data: spotData });

    if (!spotResponse.ok) {
      return new Response(
        JSON.stringify({
          success: false,
          error: spotData?.errMsg || spotData?.message || "Failed to fetch spot data",
          code: "KOTAK_API_ERROR",
          details: spotData,
        }),
        { status: 200, headers }
      );
    }

    // Parse and build result
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

      const key = instrument.toLowerCase();
      result[`${key}Spot`] = spotPrice;
      result[`${key}Change`] = change;

      // Option chain around ATM
      const stepSize = instrument === "NIFTY" ? 50 : 100;
      const atmStrike = Math.round(spotPrice / stepSize) * stepSize;

      console.log(`Fetching ${instrument} chain: ATM=${atmStrike}, range=${strikeRange}`);
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
      console.log(`Kotak ${instrument} chain:`, { status: chainResponse.status, rows: chainData?.data?.length });

      if (!chainResponse.ok) {
        console.error(`Chain API error for ${instrument}:`, chainData);
        result[`${key}Chain`] = [];
        result[`${key}ATM`] = atmStrike;
        continue;
      }

      const chain = parseOptionChain(chainData, atmStrike);
      result[`${key}Chain`] = chain;
      result[`${key}ATM`] = atmStrike;

      // PCR
      const totalCallOI = chain.reduce((s: number, o: any) => s + (o.callOI || 0), 0);
      const totalPutOI = chain.reduce((s: number, o: any) => s + (o.putOI || 0), 0);
      result[`${key}PCR`] = totalCallOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : 0;
    }

    return new Response(JSON.stringify({ success: true, data: result }), { headers });

  } catch (error) {
    console.error("Market data error:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message || "Internal server error", code: "INTERNAL_ERROR" }),
      { status: 500, headers }
    );
  }
});

function getInstrumentToken(instrument: string): string {
  const tokens: Record<string, string> = {
    "NIFTY": "26000",
    "SENSEX": "26065",
  };
  return tokens[instrument] || instrument;
}

function findQuote(data: any, token: string): any {
  if (!data) return null;
  if (data.data && Array.isArray(data.data)) {
    return data.data.find((q: any) => String(q.instrumentToken) === token || String(q.token) === token);
  }
  if (data.data && typeof data.data === "object") {
    return data.data[token] || data.data;
  }
  return null;
}

function getNextExpiry(): string {
  const now = new Date();
  const day = now.getDay();
  const daysUntilThursday = (4 - day + 7) % 7 || 7;
  const thursday = new Date(now);
  thursday.setDate(now.getDate() + (day <= 4 ? (4 - day) : daysUntilThursday));
  return thursday.toISOString().split("T")[0];
}

function parseOptionChain(data: any, atmStrike: number): any[] {
  const chain: any[] = [];
  if (data?.data && Array.isArray(data.data)) {
    for (const row of data.data) {
      const strike = row.strikePrice || row.strike;
      if (!strike || strike <= 0) continue;
      chain.push({
        strike,
        callLTP: val(row.callLTP || row.CE?.ltp),
        putLTP: val(row.putLTP || row.PE?.ltp),
        callOI: val(row.callOI || row.CE?.openInterest),
        putOI: val(row.putOI || row.PE?.openInterest),
        callOIChange: val(row.callOIChange || row.CE?.oiChange),
        putOIChange: val(row.putOIChange || row.PE?.oiChange),
        callVolume: val(row.callVolume || row.CE?.volume),
        putVolume: val(row.putVolume || row.PE?.volume),
        callBid: val(row.callBid || row.CE?.bid),
        callAsk: val(row.callAsk || row.CE?.ask),
        putBid: val(row.putBid || row.PE?.bid),
        putAsk: val(row.putAsk || row.PE?.ask),
        isATM: strike === atmStrike,
      });
    }
  }
  return chain.sort((a, b) => a.strike - b.strike);
}

function val(v: any): number {
  const n = Number(v);
  return isFinite(n) && n >= 0 ? n : 0;
}
