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
const BOT_MARGIN_USDT = parseNumberSecret(Deno.env.get("BOT_MARGIN_USDT"), 10);
const DEFAULT_SYMBOL = "ONDOUSDT";

function parseNumberSecret(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const normalized = value.includes("=") ? value.split("=").at(-1) : value;
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

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

function ema(values: number[], period: number) {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  const output: number[] = [];
  let previous = values[0];
  values.forEach((value, index) => {
    previous = index === 0 ? value : value * multiplier + previous * (1 - multiplier);
    output.push(previous);
  });
  return output;
}

function emaBollinger(values: number[], period = 20, multiplier = 2) {
  if (values.length < period) return null;
  const middle = ema(values, period).at(-1)!;
  const slice = values.slice(-period);
  const deviation = standardDeviation(slice);
  return { middle, upper: middle + deviation * multiplier, lower: middle - deviation * multiplier };
}

function atr(candles: Candle[], period = 10) {
  return candles.map((candle, index) => {
    if (index === 0 || index + 1 < period) return null;
    const slice = candles.slice(index + 1 - period, index + 1);
    const ranges = slice.map((item, itemIndex) => {
      const previous = candles[index + 1 - period + itemIndex - 1];
      if (!previous) return item.high - item.low;
      return Math.max(item.high - item.low, Math.abs(item.high - previous.close), Math.abs(item.low - previous.close));
    });
    return ranges.reduce((sum, value) => sum + value, 0) / period;
  });
}

function supertrend(candles: Candle[], period = 10, multiplier = 3) {
  const atrValues = atr(candles, period);
  const output: Array<null | { direction: "UP" | "DOWN"; line: number; upper: number; lower: number }> = [];
  let finalUpper: number | null = null;
  let finalLower: number | null = null;
  let direction: "UP" | "DOWN" = "UP";

  candles.forEach((candle, index) => {
    const atrValue = atrValues[index];
    if (!atrValue) {
      output.push(null);
      return;
    }
    const hl2 = (candle.high + candle.low) / 2;
    const basicUpper = hl2 + multiplier * atrValue;
    const basicLower = hl2 - multiplier * atrValue;
    const previousClose = candles[index - 1]?.close ?? candle.close;
    const previousUpper = finalUpper ?? basicUpper;
    const previousLower = finalLower ?? basicLower;

    finalUpper = basicUpper < previousUpper || previousClose > previousUpper ? basicUpper : previousUpper;
    finalLower = basicLower > previousLower || previousClose < previousLower ? basicLower : previousLower;

    if (direction === "DOWN" && candle.close > finalUpper) direction = "UP";
    else if (direction === "UP" && candle.close < finalLower) direction = "DOWN";

    output.push({ direction, line: direction === "UP" ? finalLower : finalUpper, upper: finalUpper, lower: finalLower });
  });

  return output;
}

function vaObv(candles: Candle[], signalPeriod = 20, lookback = 20) {
  let value = 0;
  const series = candles.map((candle, index) => {
    if (index === 0) return 0;
    const previous = candles[index - 1];
    const change = candle.close - previous.close;
    const trueRange = Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close), 0.00000001);
    const volatilityWeight = Math.min(2, Math.abs(change) / trueRange);
    value += Math.sign(change) * candle.volume * volatilityWeight;
    return value;
  });
  const signal = ema(series, signalPeriod);
  return series.map((item, index) => {
    const previousWindow = series.slice(Math.max(0, index - lookback), index);
    return {
      value: item,
      signal: signal[index],
      previousHigh: previousWindow.length ? Math.max(...previousWindow) : item,
      previousLow: previousWindow.length ? Math.min(...previousWindow) : item,
    };
  });
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

function analyzeWick(candle: Candle) {
  const range = Math.max(candle.high - candle.low, 0);
  const body = Math.abs(candle.close - candle.open);
  const upper = candle.high - Math.max(candle.open, candle.close);
  const lower = Math.min(candle.open, candle.close) - candle.low;
  const rangePct = range ? (range / candle.close) * 100 : 0;
  const upperPct = range ? upper / range : 0;
  const lowerPct = range ? lower / range : 0;
  const bodyFloor = Math.max(body, range * 0.08);
  const hasUpper = rangePct >= 0.05 && upperPct >= 0.45 && upper >= bodyFloor * 1.5 && upper > lower * 1.15;
  const hasLower = rangePct >= 0.05 && lowerPct >= 0.45 && lower >= bodyFloor * 1.5 && lower > upper * 1.15;

  return { range, body, upper, lower, rangePct, upperPct, lowerPct, hasUpper, hasLower };
}

function buildTrendVolumeDecision(
  candles: Candle[],
  settings: Required<BotSettings>,
  positionSide: "LONG" | "SHORT" | null,
  entryPrice: number,
  partialTaken: boolean,
  diagnostics: Record<string, unknown>,
  longOnly = false,
) {
  const closedCandles = candles.slice(0, -1);
  const current = closedCandles.at(-1) ?? candles.at(-1)!;
  const previous = closedCandles.at(-2);
  const closes = closedCandles.map((item) => item.close);
  const bands = emaBollinger(closes, 20, 2);
  const trendSeries = supertrend(closedCandles, 10, 3);
  const trend = trendSeries.at(-1);
  const flow = vaObv(closedCandles, 20, 20).at(-1);
  const previousBands = emaBollinger(closes.slice(0, -1), 20, 2);
  const trendDiagnostics = { ...diagnostics, bands, trend, vaObv: flow, partialTaken };

  if (!bands || !trend || !flow) {
    return { side: "WAIT", reason: "trend-volume indicators warming up", score: 0, diagnostics: { ...trendDiagnostics, score: 0 } };
  }

  const longEnergy = flow.value > flow.signal || flow.value > flow.previousHigh;
  const shortEnergy = flow.value < flow.signal || flow.value < flow.previousLow;
  const longPrice = current.close > bands.middle;
  const shortPrice = current.close < bands.middle;
  const crossedUp = Boolean(previous && previousBands && previous.close <= previousBands.middle && current.close > bands.middle);
  const crossedDown = Boolean(previous && previousBands && previous.close >= previousBands.middle && current.close < bands.middle);

  if (positionSide && entryPrice > 0) {
    const pnlPct = positionSide === "LONG" ? ((current.close - entryPrice) / entryPrice) * 100 : ((entryPrice - current.close) / entryPrice) * 100;
    if (longOnly && positionSide === "SHORT") {
      return { side: "CLOSE_SHORT", reason: "VA long-only: close existing SHORT position", pnlPct, diagnostics: { ...trendDiagnostics, score: 5 } };
    }
    if (positionSide === "LONG") {
      if (!partialTaken && current.close >= bands.upper) return { side: "TRIM_LONG", reason: "first take profit: upper Bollinger touch, reduce 50%", pnlPct, diagnostics: { ...trendDiagnostics, score: 5 } };
      if (trend.direction === "DOWN") return { side: "CLOSE_LONG", reason: "second exit: SuperTrend flipped bearish", pnlPct, diagnostics: { ...trendDiagnostics, score: 5 } };
      if (current.close < trend.line || current.close < bands.lower) return { side: "CLOSE_LONG", reason: "stop loss: broke SuperTrend line or lower Bollinger", pnlPct, diagnostics: { ...trendDiagnostics, score: 5 } };
      return { side: "HOLD", reason: `holding trend-volume LONG ${pnlPct.toFixed(2)}%`, pnlPct, diagnostics: { ...trendDiagnostics, score: 0 } };
    }

    if (!partialTaken && current.close <= bands.lower) return { side: "TRIM_SHORT", reason: "first take profit: lower Bollinger touch, reduce 50%", pnlPct, diagnostics: { ...trendDiagnostics, score: 5 } };
    if (trend.direction === "UP") return { side: "CLOSE_SHORT", reason: "second exit: SuperTrend flipped bullish", pnlPct, diagnostics: { ...trendDiagnostics, score: 5 } };
    if (current.close > trend.line || current.close > bands.upper) return { side: "CLOSE_SHORT", reason: "stop loss: broke SuperTrend line or upper Bollinger", pnlPct, diagnostics: { ...trendDiagnostics, score: 5 } };
    return { side: "HOLD", reason: `holding trend-volume SHORT ${pnlPct.toFixed(2)}%`, pnlPct, diagnostics: { ...trendDiagnostics, score: 0 } };
  }

  if (trend.direction === "UP" && longEnergy && longPrice) {
    return { side: "LONG", reason: crossedUp ? "SuperTrend bullish + VA-OBV breakout + EMA20 cross" : "SuperTrend bullish + VA-OBV strong + above EMA20", score: 5, diagnostics: { ...trendDiagnostics, score: 5 } };
  }
  if (!longOnly && trend.direction === "DOWN" && shortEnergy && shortPrice) {
    return { side: "SHORT", reason: crossedDown ? "SuperTrend bearish + VA-OBV breakdown + EMA20 cross" : "SuperTrend bearish + VA-OBV weak + below EMA20", score: 5, diagnostics: { ...trendDiagnostics, score: 5 } };
  }

  return { side: "WAIT", reason: `${longOnly ? "VA long-only" : "trend-volume"} conditions not met: ST ${trend.direction}, VA ${flow.value > flow.signal ? "strong" : "weak"}, EMA ${current.close > bands.middle ? "above" : "below"}`, score: 0, diagnostics: { ...trendDiagnostics, score: 0 } };
}

function buildWickSupertrendDecision(
  candles: Candle[],
  positionSide: "LONG" | "SHORT" | null,
  entryPrice: number,
  diagnostics: Record<string, unknown>,
) {
  const closedCandles = candles.slice(0, -1);
  const current = closedCandles.at(-1) ?? candles.at(-1)!;
  const wick = analyzeWick(current);
  const trend = supertrend(closedCandles, 10, 3).at(-1);
  const detail = { ...diagnostics, wick, trend };

  if (!trend) {
    return { side: "WAIT", reason: "SuperTrend warming up", score: 0, diagnostics: { ...detail, score: 0 } };
  }

  if (positionSide && entryPrice > 0) {
    const stopDistance = Math.abs(entryPrice - trend.line);
    const safeDistance = stopDistance > entryPrice * 0.0005 ? stopDistance : entryPrice * 0.002;
    const longTarget = entryPrice + safeDistance * 1.5;
    const shortTarget = entryPrice - safeDistance * 1.5;
    const pnlPct = positionSide === "LONG" ? ((current.close - entryPrice) / entryPrice) * 100 : ((entryPrice - current.close) / entryPrice) * 100;

    if (positionSide === "LONG") {
      if (current.close >= longTarget) return { side: "CLOSE_LONG", reason: "take profit: 1.5R from SuperTrend stop distance", pnlPct, diagnostics: { ...detail, score: 5 } };
      if (current.close <= trend.line || trend.direction === "DOWN") return { side: "CLOSE_LONG", reason: "stop loss: broke SuperTrend line or flipped bearish", pnlPct, diagnostics: { ...detail, score: 5 } };
      return { side: "HOLD", reason: `holding wick-ST LONG ${pnlPct.toFixed(2)}%`, pnlPct, diagnostics: { ...detail, score: 0 } };
    }

    if (current.close <= shortTarget) return { side: "CLOSE_SHORT", reason: "take profit: 1.5R from SuperTrend stop distance", pnlPct, diagnostics: { ...detail, score: 5 } };
    if (current.close >= trend.line || trend.direction === "UP") return { side: "CLOSE_SHORT", reason: "stop loss: broke SuperTrend line or flipped bullish", pnlPct, diagnostics: { ...detail, score: 5 } };
    return { side: "HOLD", reason: `holding wick-ST SHORT ${pnlPct.toFixed(2)}%`, pnlPct, diagnostics: { ...detail, score: 0 } };
  }

  if (wick.hasUpper && trend.direction === "DOWN" && current.close < trend.line) {
    return { side: "SHORT", reason: `upper wick ${(wick.upperPct * 100).toFixed(0)}% + SuperTrend bearish`, score: 5, diagnostics: { ...detail, score: 5 } };
  }
  if (wick.hasLower && trend.direction === "UP" && current.close > trend.line) {
    return { side: "LONG", reason: `lower wick ${(wick.lowerPct * 100).toFixed(0)}% + SuperTrend bullish`, score: 5, diagnostics: { ...detail, score: 5 } };
  }

  return { side: "WAIT", reason: `wick-ST conditions not met: ST ${trend.direction}, upper ${(wick.upperPct * 100).toFixed(0)}%, lower ${(wick.lowerPct * 100).toFixed(0)}%`, score: 0, diagnostics: { ...detail, score: 0 } };
}

function buildTrendHoldDecision(
  candles: Candle[],
  positionSide: "LONG" | "SHORT" | null,
  entryPrice: number,
  diagnostics: Record<string, unknown>,
) {
  const closedCandles = candles.slice(0, -1);
  const current = closedCandles.at(-1) ?? candles.at(-1)!;
  const previous = closedCandles.at(-2);
  const closes = closedCandles.map((item) => item.close);
  const ema20Series = ema(closes, 20);
  const ema20 = ema20Series.at(-1);
  const previousEma20 = ema20Series.at(-2);
  const trend = supertrend(closedCandles, 10, 3).at(-1);
  const flow = vaObv(closedCandles, 20, 20).at(-1);
  const detail = { ...diagnostics, trend, ema20, vaObv: flow };

  if (!trend || !ema20 || !flow) {
    return { side: "WAIT", reason: "trend-hold indicators warming up", score: 0, diagnostics: { ...detail, score: 0 } };
  }

  const aboveEma = current.close > ema20;
  const previousAboveEma = previous && previousEma20 ? previous.close > previousEma20 : false;
  const belowEmaTwoCloses = Boolean(previous && previousEma20 && current.close < ema20 && previous.close < previousEma20);
  const volumeStrong = flow.value > flow.signal || flow.value > flow.previousHigh;
  const crossedUp = Boolean(previous && previousEma20 && previous.close <= previousEma20 && current.close > ema20);

  if (positionSide === "LONG" && entryPrice > 0) {
    const pnlPct = ((current.close - entryPrice) / entryPrice) * 100;
    if (trend.direction === "DOWN") return { side: "CLOSE_LONG", reason: `trend-hold exit: SuperTrend flipped bearish ${pnlPct.toFixed(2)}%`, pnlPct, diagnostics: { ...detail, score: 5 } };
    if (belowEmaTwoCloses) return { side: "CLOSE_LONG", reason: `trend-hold exit: 2 closes below EMA20 ${pnlPct.toFixed(2)}%`, pnlPct, diagnostics: { ...detail, score: 5 } };
    return { side: "HOLD", reason: `holding trend-hold LONG ${pnlPct.toFixed(2)}%`, pnlPct, diagnostics: { ...detail, score: 0 } };
  }

  if (!positionSide && trend.direction === "UP" && aboveEma && volumeStrong) {
    return { side: "LONG", reason: crossedUp || !previousAboveEma ? "trend-hold entry: SuperTrend bullish + EMA20 reclaim + VA-OBV strong" : "trend-hold entry: SuperTrend bullish + above EMA20 + VA-OBV strong", score: 5, diagnostics: { ...detail, score: 5 } };
  }

  return { side: "WAIT", reason: `trend-hold conditions not met: ST ${trend.direction}, EMA ${aboveEma ? "above" : "below"}, VA ${volumeStrong ? "strong" : "weak"}`, score: 0, diagnostics: { ...detail, score: 0 } };
}

function buildDecision(candles: Candle[], settings: Required<BotSettings>, positionAmount: number, entryPrice: number, partialTaken = false) {
  const current = candles.at(-2) ?? candles.at(-1)!;
  const previous = candles.at(-3);
  const hasPosition = Math.abs(positionAmount) > 0;
  const positionSide = positionAmount > 0 ? "LONG" : positionAmount < 0 ? "SHORT" : null;
  const wick = analyzeWick(current);
  const previousWick = previous ? analyzeWick(previous) : null;
  const strategy = Number(settings.buyStrategy);
  const allowLong = strategy === 1 || strategy === 2 || strategy === 4;
  const allowShort = strategy === 1 || strategy === 3 || strategy === 4;
  const isConfirmLong = Boolean(previousWick?.hasLower && current.close > current.open);
  const isConfirmShort = Boolean(previousWick?.hasUpper && current.close < current.open);

  const diagnostics = {
    price: current.close,
    candleTime: current.time,
    wick,
    previousWick,
    positionAmount,
    entryPrice,
    checks: {
      upperWickShort: wick.hasUpper,
      lowerWickLong: wick.hasLower,
      confirmShort: isConfirmShort,
      confirmLong: isConfirmLong,
    },
  };

  if (strategy === 6 || strategy === 7) {
    return buildTrendVolumeDecision(candles, settings, positionSide, entryPrice, partialTaken, diagnostics, strategy === 7);
  }
  if (strategy === 9) {
    return hasPosition
      ? { side: "HOLD", reason: `holding benchmark ${positionSide}`, score: 0, diagnostics: { ...diagnostics, score: 0 } }
      : { side: "LONG", reason: "holding benchmark long entry", score: 5, diagnostics: { ...diagnostics, score: 5 } };
  }
  if (strategy === 8) {
    return buildWickSupertrendDecision(candles, positionSide, entryPrice, diagnostics);
  }
  if (strategy === 10) {
    return buildTrendHoldDecision(candles, positionSide, entryPrice, diagnostics);
  }

  if (hasPosition && entryPrice > 0) {
    const pnlPct = positionSide === "LONG" ? ((current.close - entryPrice) / entryPrice) * 100 : ((entryPrice - current.close) / entryPrice) * 100;
    if (strategy === 5) return { side: `CLOSE_${positionSide}`, reason: `one minute test close ${positionSide}`, pnlPct, diagnostics };
    if (pnlPct >= settings.takeProfitPct) return { side: `CLOSE_${positionSide}`, reason: `take profit ${pnlPct.toFixed(2)}%`, pnlPct, diagnostics };
    if (settings.stopLossPct > 0 && pnlPct <= -settings.stopLossPct) return { side: `CLOSE_${positionSide}`, reason: `stop loss ${pnlPct.toFixed(2)}%`, pnlPct, diagnostics };
    return { side: "HOLD", reason: `holding ${positionSide} ${pnlPct.toFixed(2)}%`, pnlPct, diagnostics };
  }

  if (strategy === 5) return { side: "LONG", reason: "one minute test long entry", score: 5, diagnostics: { ...diagnostics, score: 5 } };
  if (strategy === 4 && allowShort && isConfirmShort) return { side: "SHORT", reason: `cautious short: upper wick then bearish candle`, score: 5, diagnostics: { ...diagnostics, score: 5 } };
  if (strategy === 4 && allowLong && isConfirmLong) return { side: "LONG", reason: `cautious long: lower wick then bullish candle`, score: 5, diagnostics: { ...diagnostics, score: 5 } };
  if (strategy !== 4 && allowShort && wick.hasUpper) return { side: "SHORT", reason: `upper wick ${(wick.upperPct * 100).toFixed(0)}%`, score: 5, diagnostics: { ...diagnostics, score: 5 } };
  if (strategy !== 4 && allowLong && wick.hasLower) return { side: "LONG", reason: `lower wick ${(wick.lowerPct * 100).toFixed(0)}%`, score: 5, diagnostics: { ...diagnostics, score: 5 } };
  if (strategy === 4) return { side: "WAIT", reason: `cautious wick confirmation not met`, score: 0, diagnostics: { ...diagnostics, score: 0 } };
  return { side: "WAIT", reason: `wick/direction filter not met upper ${(wick.upperPct * 100).toFixed(0)}%, lower ${(wick.lowerPct * 100).toFixed(0)}%`, score: 0, diagnostics: { ...diagnostics, score: 0 } };
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

function quantityStep(symbol: string) {
  return symbol === "BTCUSDT" ? 0.001 : 1;
}

function formatQuantity(raw: number, symbol: string) {
  const step = quantityStep(symbol);
  const quantity = Math.max(step, Math.floor(raw / step) * step);
  return step >= 1 ? String(Math.floor(quantity)) : quantity.toFixed(3);
}

function quantityFrom(price: number, leverage: number, symbol: string) {
  if (!Number.isFinite(price) || price <= 0) return formatQuantity(quantityStep(symbol), symbol);
  const raw = (BOT_MARGIN_USDT * leverage) / price;
  return formatQuantity(raw, symbol);
}

function normalizeSettings(row: Record<string, unknown> | null, fallback: Record<string, unknown> = {}): Required<BotSettings> {
  return {
    enabled: Boolean(row?.enabled ?? fallback.enabled ?? true),
    symbol: String(row?.symbol ?? fallback.symbol ?? DEFAULT_SYMBOL),
    interval: String(row?.interval ?? fallback.interval ?? "15m"),
    buyStrategy: Number(row?.buy_strategy ?? fallback.buyStrategy ?? 1),
    leverage: Number(row?.leverage ?? fallback.leverage ?? 1),
    takeProfitPct: Number(row?.take_profit_pct ?? fallback.takeProfitPct ?? 0.2),
    stopLossPct: Number(row?.stop_loss_pct ?? fallback.stopLossPct ?? 0.2),
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

function hasOpenPartialTaken(events: Array<Record<string, unknown>>) {
  for (const event of events) {
    const payload = event.payload as Record<string, unknown> | undefined;
    const decision = payload?.decision as Record<string, unknown> | undefined;
    const side = String(decision?.side ?? "");
    if (side.startsWith("TRIM")) return true;
    if (side === "LONG" || side === "SHORT" || side.startsWith("CLOSE")) return false;
  }
  return false;
}

function buildMetrics(events: Array<Record<string, unknown>>, position: Record<string, unknown> | null) {
  const pnlEvents = events
    .map((event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      const decision = payload?.decision as Record<string, unknown> | undefined;
      return Number(decision?.pnlPct);
    })
    .filter((value) => Number.isFinite(value));
  const closedPnlEvents = events
    .map((event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      const decision = payload?.decision as Record<string, unknown> | undefined;
      return String(decision?.side ?? "").startsWith("CLOSE") ? Number(decision.pnlPct) : null;
    })
    .filter((value): value is number => Number.isFinite(value));
  const unrealizedProfit = Number(position?.unRealizedProfit ?? position?.unrealizedProfit ?? 0);
  const currentReturnPct = BOT_MARGIN_USDT ? (unrealizedProfit / BOT_MARGIN_USDT) * 100 : 0;
  const wins = closedPnlEvents.filter((value) => value > 0).length;
  const losses = closedPnlEvents.filter((value) => value < 0).length;

  return {
    marginUsdt: BOT_MARGIN_USDT,
    finalEquityUsdt: BOT_MARGIN_USDT + unrealizedProfit,
    totalReturnPct: currentReturnPct,
    maxDrawdownPct: pnlEvents.length ? Math.min(0, ...pnlEvents) : 0,
    winRatePct: wins + losses ? (wins / (wins + losses)) * 100 : null,
    wins,
    losses,
    positionAmount: Number(position?.positionAmt ?? 0),
    entryPrice: Number(position?.entryPrice ?? 0),
    unrealizedProfit,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  let runId: string | null = null;

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action ?? "check";
    const settings = action === "save-settings"
      ? await saveStoredSettings(supabase, body)
      : await getStoredSettings(supabase, body);

    if (action === "events") {
      const events = await getRecentEvents(supabase);
      let position = null;
      try {
        const positions = await binanceSigned("GET", "/fapi/v2/positionRisk", { symbol: settings.symbol });
        position = Array.isArray(positions) ? positions[0] : positions;
      } catch (_) {
        position = null;
      }
      return json({ ok: true, dryRun: DRY_RUN, settings, events, metrics: buildMetrics(events, position) });
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
    runId = run?.id ?? null;

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
    const recentEvents = await getRecentEvents(supabase);
    const partialTaken = hasOpenPartialTaken(recentEvents);
    const decision = buildDecision(candles, settings, positionAmount, entryPrice, partialTaken);

    let order = null;
    if (action === "run-once" && (decision.side === "LONG" || decision.side === "SHORT")) {
      const quantity = quantityFrom(latest.close, settings.leverage, settings.symbol);
      await binanceSigned("POST", "/fapi/v1/leverage", { symbol: settings.symbol, leverage: settings.leverage });
      const orderSide = decision.side === "LONG" ? "BUY" : "SELL";
      order = DRY_RUN ? { dryRun: true, side: orderSide, strategySide: decision.side, type: "MARKET", quantity } : await binanceSigned("POST", "/fapi/v1/order", { symbol: settings.symbol, side: orderSide, type: "MARKET", quantity });
    }

    if (action === "run-once" && (decision.side.startsWith("CLOSE") || decision.side.startsWith("TRIM")) && Math.abs(positionAmount) > 0) {
      const closeRatio = decision.side.startsWith("TRIM") ? 0.5 : 1;
      const quantity = formatQuantity(Math.abs(positionAmount) * closeRatio, settings.symbol);
      const orderSide = decision.side.endsWith("LONG") ? "SELL" : "BUY";
      order = DRY_RUN ? { dryRun: true, side: orderSide, strategySide: decision.side, type: "MARKET", quantity } : await binanceSigned("POST", "/fapi/v1/order", { symbol: settings.symbol, side: orderSide, type: "MARKET", quantity, reduceOnly: "true" });
    }

    await supabase.from("bot_events").insert({
      run_id: run?.id,
      event_type: "strategy_run",
      message: `${decision.side}: ${decision.reason}`,
      payload: { settings, latestCandleTime: latest.time, latestClose: latest.close, positionAmount, entryPrice, decision, order, dryRun: DRY_RUN },
    });

    return json({ ok: true, dryRun: DRY_RUN, settings, latestClose: latest.close, positionAmount, entryPrice, decision, order });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await supabase.from("bot_events").insert({
        run_id: runId,
        event_type: "order_error",
        message,
        payload: { error: message, dryRun: DRY_RUN },
      });
    } catch (_) {
      // Ignore logging failures so the original error can be returned.
    }
    return json({ ok: false, error: message }, 500);
  }
});
