import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BINANCE_BASE_URL = Deno.env.get("BINANCE_FUTURES_BASE_URL") ?? "https://testnet.binancefuture.com";
const BINANCE_API_KEY = Deno.env.get("BINANCE_TESTNET_API_KEY") ?? "";
const BINANCE_SECRET_KEY = Deno.env.get("BINANCE_TESTNET_SECRET_KEY") ?? "";
const DRY_RUN = (Deno.env.get("BINANCE_DRY_RUN") ?? "true").toLowerCase() !== "false";
const BOT_MARGIN_USDT = Number(Deno.env.get("BOT_MARGIN_USDT") ?? "10");

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type BotSettings = {
  symbol?: string;
  interval?: string;
  buyStrategy?: number;
  leverage?: number;
  takeProfitPct?: number;
  stopLossPct?: number;
  enabled?: boolean;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function parseKline(row: string[]): Candle {
  return {
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

function standardDeviation(values: number[]) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function bollinger(values: number[], period = 20, multiplier = 2) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const middle = slice.reduce((sum, value) => sum + value, 0) / period;
  const deviation = standardDeviation(slice);
  return { middle, upper: middle + deviation * multiplier, lower: middle - deviation * multiplier };
}

function rsi(values: number[], period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;

  for (let index = values.length - period; index < values.length; index += 1) {
    const diff = values[index] - values[index - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period || 1;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function buildDecision(candles: Candle[], settings: Required<BotSettings>, positionAmount: number, entryPrice: number) {
  const closes = candles.map((candle) => candle.close);
  const current = candles.at(-1)!;
  const previous = candles.at(-2) ?? current;
  const band = bollinger(closes, 20, 2);
  const rsi14 = rsi(closes, 14);
  const previousRsi14 = rsi(closes.slice(0, -1), 14);
  const hasPosition = Math.abs(positionAmount) > 0;
  const middleGapPct = band ? (Math.abs(current.close - band.middle) / band.middle) * 100 : null;
  const lowerGapPct = band ? ((current.close - band.lower) / band.lower) * 100 : null;
  const upperGapPct = band ? ((current.close - band.upper) / band.upper) * 100 : null;

  const diagnostics = {
    price: current.close,
    candleTime: current.time,
    rsi14,
    previousRsi14,
    bollinger: band,
    middleGapPct,
    lowerGapPct,
    upperGapPct,
    positionAmount,
    entryPrice,
    checks: {
      rsiUnder55: Boolean(rsi14 && rsi14 <= 55),
      rsiTurningUp: Boolean(rsi14 && previousRsi14 && rsi14 >= previousRsi14),
      middleTouch: Boolean(middleGapPct !== null && middleGapPct <= 0.3),
      middleRecovery: Boolean(band && previous.close < band.middle && current.close >= band.middle),
    },
  };

  if (hasPosition && entryPrice > 0) {
    const pnlPct = ((current.close - entryPrice) / entryPrice) * 100;
    if (pnlPct >= settings.takeProfitPct) return { side: "SELL", reason: `take profit ${pnlPct.toFixed(2)}%`, pnlPct, diagnostics };
    if (settings.stopLossPct > 0 && pnlPct <= -settings.stopLossPct) return { side: "SELL", reason: `stop loss ${pnlPct.toFixed(2)}%`, pnlPct, diagnostics };
    return { side: "HOLD", reason: `holding position ${pnlPct.toFixed(2)}%`, pnlPct, diagnostics };
  }

  if (!band || !rsi14 || !previousRsi14) return { side: "WAIT", reason: "indicator data is not ready", diagnostics };

  const middleGap = Math.abs(current.close - band.middle) / band.middle;
  const isMiddleTouch = middleGap <= 0.003;
  const isMiddleRecovery = previous.close < band.middle && current.close >= band.middle;
  const isRsiTurning = rsi14 >= previousRsi14;
  const scoreParts = {
    rsi: rsi14 <= 55 ? 2 : 0,
    rsiTurn: isRsiTurning ? 1 : 0,
    bollingerMiddle: isMiddleTouch || isMiddleRecovery ? 2 : 0,
  };
  const score = scoreParts.rsi + scoreParts.rsiTurn + scoreParts.bollingerMiddle;
  const detailDiagnostics = { ...diagnostics, scoreParts, score };

  if (score >= 4) return { side: "BUY", reason: `RSI(14) ${rsi14.toFixed(1)}, Bollinger middle touch/recovery`, score, diagnostics: detailDiagnostics };
  return { side: "WAIT", reason: `conditions not met score ${score}`, score, diagnostics: detailDiagnostics };
}

async function hmacSha256(secret: string, payload: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function binancePublic(path: string, params: Record<string, string | number>) {
  const url = new URL(`${BINANCE_BASE_URL}${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(`Binance public ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function binanceSigned(method: "GET" | "POST", path: string, params: Record<string, string | number> = {}) {
  if (!BINANCE_API_KEY || !BINANCE_SECRET_KEY) throw new Error("Binance testnet API key/secret is missing");
  const timestamp = Date.now();
  const query = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), timestamp: String(timestamp), recvWindow: "5000" });
  const signature = await hmacSha256(BINANCE_SECRET_KEY, query.toString());
  query.set("signature", signature);
  const response = await fetch(`${BINANCE_BASE_URL}${path}?${query.toString()}`, {
    method,
    headers: { "X-MBX-APIKEY": BINANCE_API_KEY },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Binance signed ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

function quantityFrom(price: number, leverage: number) {
  const raw = (BOT_MARGIN_USDT * leverage) / price;
  return Math.max(0.001, Math.floor(raw * 1000) / 1000).toFixed(3);
}

function normalizeSettings(row: Record<string, unknown> | null, fallback: Record<string, unknown> = {}): Required<BotSettings> {
  return {
    enabled: Boolean(row?.enabled ?? fallback.enabled ?? true),
    symbol: String(row?.symbol ?? fallback.symbol ?? "BTCUSDT"),
    interval: String(row?.interval ?? fallback.interval ?? "15m"),
    buyStrategy: Number(row?.buy_strategy ?? fallback.buyStrategy ?? 2),
    leverage: Number(row?.leverage ?? fallback.leverage ?? 1),
    takeProfitPct: Number(row?.take_profit_pct ?? fallback.takeProfitPct ?? 1),
    stopLossPct: Number(row?.stop_loss_pct ?? fallback.stopLossPct ?? 1),
  };
}

async function getStoredSettings(supabase: ReturnType<typeof createClient>, fallback: Record<string, unknown> = {}) {
  const { data, error } = await supabase.from("bot_settings").select("*").eq("id", "default").maybeSingle();
  if (error) throw error;
  return normalizeSettings(data, fallback);
}

async function saveStoredSettings(supabase: ReturnType<typeof createClient>, body: Record<string, unknown>) {
  const settings = normalizeSettings(null, body);
  const { data, error } = await supabase
    .from("bot_settings")
    .upsert({
      id: "default",
      enabled: settings.enabled,
      symbol: settings.symbol,
      interval: settings.interval,
      buy_strategy: settings.buyStrategy,
      leverage: settings.leverage,
      take_profit_pct: settings.takeProfitPct,
      stop_loss_pct: settings.stopLossPct,
      updated_at: new Date().toISOString(),
    })
    .select("*")
    .single();
  if (error) throw error;
  return normalizeSettings(data);
}

async function getRecentEvents(supabase: ReturnType<typeof createClient>) {
  const { data, error } = await supabase
    .from("bot_events")
    .select("id,event_type,message,payload,created_at")
    .order("created_at", { ascending: false })
    .limit(12);
  if (error) throw error;
  return data ?? [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action ?? "check";
    const settings = action === "save-settings"
      ? await saveStoredSettings(supabase, body)
      : await getStoredSettings(supabase, body);

    if (action === "events") {
      const events = await getRecentEvents(supabase);
      return json({ ok: true, dryRun: DRY_RUN, settings, events });
    }

    const { data: run } = await supabase
      .from("bot_runs")
      .insert({
        status: action,
        symbol: settings.symbol,
        interval: settings.interval,
        buy_strategy: settings.buyStrategy,
        leverage: settings.leverage,
        take_profit_pct: settings.takeProfitPct,
        stop_loss_pct: settings.stopLossPct,
      })
      .select("id")
      .single();

    if (action === "save-settings") {
      await supabase.from("bot_events").insert({
        run_id: run?.id,
        event_type: "settings_saved",
        message: "Bot settings saved",
        payload: { settings },
      });
      return json({ ok: true, dryRun: DRY_RUN, settings });
    }

    if (action === "check") {
      const balance = await binanceSigned("GET", "/fapi/v2/balance");
      await supabase.from("bot_events").insert({
        run_id: run?.id,
        event_type: "connection_check",
        message: "Binance Futures Testnet connection checked",
        payload: { dryRun: DRY_RUN },
      });
      return json({ ok: true, dryRun: DRY_RUN, settings, balances: balance.slice?.(0, 3) ?? balance });
    }

    if (!settings.enabled) {
      await supabase.from("bot_events").insert({
        run_id: run?.id,
        event_type: "strategy_skipped",
        message: "Bot is disabled",
        payload: { settings, dryRun: DRY_RUN },
      });
      return json({ ok: true, dryRun: DRY_RUN, settings, decision: { side: "DISABLED", reason: "auto trading is off" }, order: null });
    }

    const rows = await binancePublic("/fapi/v1/klines", { symbol: settings.symbol, interval: settings.interval, limit: 120 });
    const candles = rows.map(parseKline);
    const latest = candles.at(-1)!;
    const positions = await binanceSigned("GET", "/fapi/v2/positionRisk", { symbol: settings.symbol });
    const position = Array.isArray(positions) ? positions[0] : positions;
    const positionAmount = Number(position?.positionAmt ?? 0);
    const entryPrice = Number(position?.entryPrice ?? 0);
    const decision = buildDecision(candles, settings, positionAmount, entryPrice);

    let order = null;
    if (action === "run-once" && decision.side === "BUY") {
      const quantity = quantityFrom(latest.close, settings.leverage);
      await binanceSigned("POST", "/fapi/v1/leverage", { symbol: settings.symbol, leverage: settings.leverage });
      order = DRY_RUN ? { dryRun: true, side: "BUY", type: "MARKET", quantity } : await binanceSigned("POST", "/fapi/v1/order", { symbol: settings.symbol, side: "BUY", type: "MARKET", quantity });
    }

    if (action === "run-once" && decision.side === "SELL" && Math.abs(positionAmount) > 0) {
      const quantity = Math.abs(positionAmount).toFixed(3);
      order = DRY_RUN ? { dryRun: true, side: "SELL", type: "MARKET", quantity } : await binanceSigned("POST", "/fapi/v1/order", { symbol: settings.symbol, side: "SELL", type: "MARKET", quantity, reduceOnly: "true" });
    }

    await supabase.from("bot_events").insert({
      run_id: run?.id,
      event_type: "strategy_run",
      message: `${decision.side}: ${decision.reason}`,
      payload: { settings, latestCandleTime: latest.time, latestClose: latest.close, positionAmount, entryPrice, decision, order, dryRun: DRY_RUN },
    });

    return json({ ok: true, dryRun: DRY_RUN, settings, latestClose: latest.close, positionAmount, entryPrice, decision, order });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
