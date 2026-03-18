import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Kotak Neo uses different base URLs for different services
const KOTAK_GW_NAPI = "https://gw-napi.kotaksecurities.com";

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

    if (!session?.access_token || !session?.session_token) {
      return new Response(
        JSON.stringify({ success: false, error: "Broker session invalid — reconnect required", code: "NO_SESSION" }),
        { status: 200, headers }
      );
    }

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

    // Build result
    const result: Record<string, any> = { timestamp: Date.now() };

    for (const instrument of instruments) {
      const key = instrument.toLowerCase();
      const token = getInstrumentToken(instrument);
      const exchangeSegment = "nse_cm";

      // Kotak Neo quotes endpoint: GET /script-details/1.0/quotes/neosymbol/{neo_symbols}/{quote_type}
      // neo_symbols format: exchange_segment|instrument_token (URL-encoded)
      const neoSymbol = `${exchangeSegment}|${token}`;
      const encodedSymbol = encodeURIComponent(neoSymbol);
      const quoteUrl = `${KOTAK_GW_NAPI}/script-details/1.0/quotes/neosymbol/${encodedSymbol}/ltp`;

      console.log(`Fetching ${instrument} LTP:`, { url: quoteUrl, token, neoSymbol });

      const kotakHeaders: Record<string, string> = {
        "Authorization": `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      };
      // Add sid if available
      if (session.session_token) {
        kotakHeaders["sid"] = session.session_token;
      }

      const spotResponse = await fetch(quoteUrl, {
        method: "GET",
        headers: kotakHeaders,
      });

      const spotText = await spotResponse.text();
      console.log(`Kotak ${instrument} LTP status:`, spotResponse.status);
      console.log(`Kotak ${instrument} LTP raw:`, spotText.substring(0, 500));

      if (!spotResponse.ok) {
        console.error(`Kotak API error for ${instrument}: ${spotResponse.status}`);
        result[`${key}Spot`] = 0;
        result[`${key}Change`] = 0;
        result[`${key}Chain`] = [];
        result[`${key}ATM`] = 0;
        result[`${key}PCR`] = 0;

        // On first instrument failure, return the error to help debug
        if (instrument === instruments[0]) {
          return new Response(
            JSON.stringify({
              success: false,
              error: `Kotak API error (${spotResponse.status})`,
              code: "KOTAK_API_ERROR",
              status: spotResponse.status,
              raw: spotText.substring(0, 300),
              debug: { url: quoteUrl, method: "GET", neoSymbol },
            }),
            { status: 200, headers }
          );
        }
        continue;
      }

      let spotData: any;
      try {
        spotData = JSON.parse(spotText);
      } catch {
        result[`${key}Spot`] = 0;
        result[`${key}Change`] = 0;
        result[`${key}Chain`] = [];
        result[`${key}ATM`] = 0;
        result[`${key}PCR`] = 0;
        continue;
      }

      // Parse Kotak quote response
      // Response format: { message: [{ last_traded_price: "...", change: "...", ... }] }
      const quote = spotData?.message?.[0] || spotData?.data?.[0] || spotData;
      const spotPrice = parseFloat(quote?.last_traded_price || quote?.ltp || quote?.iv || "0");
      const change = parseFloat(quote?.change || quote?.cng || "0");

      result[`${key}Spot`] = spotPrice;
      result[`${key}Change`] = change;

      if (spotPrice <= 0) {
        console.warn(`No valid spot price for ${instrument}, skipping chain`);
        result[`${key}Chain`] = [];
        result[`${key}ATM`] = 0;
        result[`${key}PCR`] = 0;
        continue;
      }

      // Option chain: fetch multiple strikes around ATM
      const stepSize = instrument === "NIFTY" ? 50 : 100;
      const atmStrike = Math.round(spotPrice / stepSize) * stepSize;
      console.log(`${instrument} ATM: ${atmStrike}, spot: ${spotPrice}`);

      const chain = await fetchOptionChain(
        session, instrument, atmStrike, stepSize, strikeRange, kotakHeaders
      );

      result[`${key}Chain`] = chain;
      result[`${key}ATM`] = atmStrike;

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

async function fetchOptionChain(
  session: any,
  instrument: string,
  atmStrike: number,
  stepSize: number,
  strikeRange: number,
  kotakHeaders: Record<string, string>
): Promise<any[]> {
  const chain: any[] = [];
  const expiry = getNextExpiry();
  
  // Fetch CE and PE quotes for each strike around ATM
  for (let i = -strikeRange; i <= strikeRange; i++) {
    const strike = atmStrike + i * stepSize;
    const isATM = strike === atmStrike;

    // Build neo symbols for CE and PE of this strike
    // For options, we need to use nse_fo exchange segment
    // The instrument token for options needs to be looked up from scrip master
    // For now, try to fetch quotes for the strike if we have the token format
    
    // Kotak options format: we need the specific instrument tokens from scrip master
    // Since we don't have them, we'll construct a basic chain entry
    chain.push({
      strike,
      callLTP: 0,
      putLTP: 0,
      callOI: 0,
      putOI: 0,
      callOIChange: 0,
      putOIChange: 0,
      callVolume: 0,
      putVolume: 0,
      callBid: 0,
      callAsk: 0,
      putBid: 0,
      putAsk: 0,
      isATM,
    });
  }

  return chain.sort((a, b) => a.strike - b.strike);
}

function getInstrumentToken(instrument: string): string {
  // Kotak Neo instrument tokens for indices
  const tokens: Record<string, string> = {
    "NIFTY": "26000",
    "SENSEX": "26065",
  };
  return tokens[instrument] || instrument;
}

function getNextExpiry(): string {
  const now = new Date();
  const day = now.getDay();
  const daysUntilThursday = (4 - day + 7) % 7 || 7;
  const thursday = new Date(now);
  thursday.setDate(now.getDate() + (day <= 4 ? (4 - day) : daysUntilThursday));
  return thursday.toISOString().split("T")[0];
}
