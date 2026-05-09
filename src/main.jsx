import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, BarChart3, CalendarClock, Gauge, Play, RotateCcw, ShieldAlert, Wallet, ZoomIn, ZoomOut } from "lucide-react";
import "./styles.css";

const BINANCE_BASE = "https://api.binance.com/api/v3/klines";
const BINANCE_LIMIT = 1000;
const TRADE_SYMBOL = "ONDOUSDT";
const SYMBOL_OPTIONS = [
  { value: "BTCUSDT", label: "BTC USDT" },
  { value: "ONDOUSDT", label: "ONDO USDT" },
  { value: "ZECUSDT", label: "ZEC USDT" },
  { value: "SUIUSDT", label: "SUI USDT" },
];
const TAKE_PROFIT_OPTIONS = [0.2, 1, 2, 3, 4, 5];
const STOP_LOSS_OPTIONS = [
  { value: 0, label: "노손절" },
  { value: 0.2, label: "0.2%" },
  { value: 1, label: "1%" },
  { value: 2, label: "2%" },
  { value: 3, label: "3%" },
  { value: 4, label: "4%" },
  { value: 5, label: "5%" },
];
const LEVERAGE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20];
const BUY_STRATEGIES = [
  { value: 1, label: "롱숏", description: "윗꼬리 숏 / 아랫꼬리 롱" },
  { value: 4, label: "신중", description: "꼬리 후 다음봉 확인" },
  { value: 6, label: "VA추세", description: "SuperTrend + VA-OBV + EMA 볼밴" },
  { value: 7, label: "VA롱", description: "VA추세 롱 전용" },
  { value: 8, label: "꼬리ST", description: "꼬리 진입 + SuperTrend 손익" },
  { value: 9, label: "홀딩", description: "기간 시작 즉시 매수 후 보유" },
  { value: 10, label: "추세홀딩", description: "상승추세 롱 보유 전용" },
];
const SIM_BOTS = [
  { id: "bot-wick", strategy: 1, name: "꼬리 롱숏", accent: "cyan" },
  { id: "bot-confirm", strategy: 4, name: "신중 꼬리", accent: "emerald" },
  { id: "bot-va", strategy: 6, name: "VA추세", accent: "amber" },
  { id: "bot-va-long", strategy: 7, name: "VA롱", accent: "cyan" },
  { id: "bot-wick-st", strategy: 8, name: "꼬리ST", accent: "rose" },
  { id: "bot-trend-hold", strategy: 10, name: "추세홀딩", accent: "emerald" },
];
const SIM_BOT_CASH = 10000;
const INTERVALS = [
  { value: "1m", label: "1분봉", ms: 60_000 },
  { value: "5m", label: "5분봉", ms: 5 * 60_000 },
  { value: "15m", label: "15분봉", ms: 15 * 60_000 },
  { value: "1h", label: "1시간봉", ms: 60 * 60_000 },
  { value: "4h", label: "4시간봉", ms: 4 * 60 * 60_000 },
  { value: "1d", label: "일봉", ms: 24 * 60 * 60_000 },
];

function formatUsd(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return number.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function formatPct(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}%`;
}

function sma(values, period) {
  return values.map((_, index) => {
    if (index + 1 < period) return null;
    const slice = values.slice(index + 1 - period, index + 1);
    return slice.reduce((sum, value) => sum + value, 0) / period;
  });
}

function ema(values, period) {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  const output = [];
  let previous = values[0];
  values.forEach((value, index) => {
    previous = index === 0 ? value : value * multiplier + previous * (1 - multiplier);
    output.push(previous);
  });
  return output;
}

function rsi(values, period = 14) {
  if (values.length < period + 1) return [];
  const output = Array(period).fill(null);
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const diff = values[index] - values[index - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  output.push(100 - 100 / (1 + avgGain / (avgLoss || 1)));
  for (let index = period + 1; index < values.length; index += 1) {
    const diff = values[index] - values[index - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    output.push(100 - 100 / (1 + avgGain / (avgLoss || 1)));
  }
  return output;
}

function standardDeviation(values) {
  if (!values.length) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function bollinger(values, period = 20, multiplier = 2) {
  return values.map((_, index) => {
    if (index + 1 < period) return null;
    const slice = values.slice(index + 1 - period, index + 1);
    const middle = slice.reduce((sum, value) => sum + value, 0) / period;
    const deviation = standardDeviation(slice);
    return {
      middle,
      upper: middle + deviation * multiplier,
      lower: middle - deviation * multiplier,
    };
  });
}

function emaBollinger(values, period = 20, multiplier = 2) {
  const emaMiddle = ema(values, period);
  return values.map((_, index) => {
    if (index + 1 < period) return null;
    const slice = values.slice(index + 1 - period, index + 1);
    const middle = emaMiddle[index];
    const deviation = standardDeviation(slice);
    return {
      middle,
      upper: middle + deviation * multiplier,
      lower: middle - deviation * multiplier,
    };
  });
}

function atr(candles, period = 14) {
  return candles.map((candle, index) => {
    if (index === 0 || index + 1 < period) return null;
    const slice = candles.slice(index + 1 - period, index + 1);
    const trueRanges = slice.map((item, itemIndex) => {
      const previous = candles[index + 1 - period + itemIndex - 1];
      if (!previous) return item.high - item.low;
      return Math.max(item.high - item.low, Math.abs(item.high - previous.close), Math.abs(item.low - previous.close));
    });
    return trueRanges.reduce((sum, value) => sum + value, 0) / period;
  });
}

function supertrend(candles, period = 10, multiplier = 3) {
  const atrValues = atr(candles, period);
  const output = [];
  let finalUpper = null;
  let finalLower = null;
  let direction = "UP";

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

    output.push({
      direction,
      line: direction === "UP" ? finalLower : finalUpper,
      upper: finalUpper,
      lower: finalLower,
    });
  });

  return output;
}

function vaObv(candles, signalPeriod = 20, lookback = 20) {
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

function sessionVwap(candles, index) {
  const current = candles[index];
  if (!current) return null;
  const sessionDate = new Date(current.time * 1000).toISOString().slice(0, 10);
  let volumePrice = 0;
  let volume = 0;

  for (let itemIndex = index; itemIndex >= 0; itemIndex -= 1) {
    const candle = candles[itemIndex];
    if (new Date(candle.time * 1000).toISOString().slice(0, 10) !== sessionDate) break;
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    volumePrice += typicalPrice * candle.volume;
    volume += candle.volume;
  }

  return volume ? volumePrice / volume : current.close;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseKline(row) {
  return {
    time: Math.floor(Number(row[0]) / 1000),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
  };
}

async function fetchHistoricalCandles({ symbol, interval, days, startDate, endDate }) {
  const timeframe = INTERVALS.find((item) => item.value === interval) ?? INTERVALS[2];
  const hasCustomRange = Boolean(startDate && endDate);
  const endTime = hasCustomRange ? new Date(`${endDate}T23:59:59`).getTime() : Date.now();
  let startTime = hasCustomRange ? new Date(`${startDate}T00:00:00`).getTime() : endTime - Number(days) * 24 * 60 * 60 * 1000;
  const candles = [];

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime > endTime) {
    throw new Error("기간설정의 시작일과 종료일을 확인해주세요.");
  }

  while (startTime < endTime) {
    const url = new URL(BINANCE_BASE);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(BINANCE_LIMIT));
    url.searchParams.set("startTime", String(startTime));
    url.searchParams.set("endTime", String(endTime));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Binance ${response.status}: ${response.statusText}`);
    const rows = await response.json();
    if (!rows.length) break;
    candles.push(...rows.map(parseKline));
    const nextStart = Number(rows.at(-1)[0]) + timeframe.ms;
    if (nextStart <= startTime) break;
    startTime = nextStart;
    if (candles.length > 22000) break;
  }

  const uniqueCandles = candles.filter((candle, index, rows) => index === 0 || candle.time !== rows[index - 1].time);
  if (!uniqueCandles.length) throw new Error("선택한 기간에 가져올 수 있는 캔들이 없습니다.");
  return uniqueCandles;
}

async function fetchRecentCandles({ symbol, interval, limit = 180 }) {
  const url = new URL(BINANCE_BASE);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Binance ${response.status}: ${response.statusText}`);
  const rows = await response.json();
  return rows.map(parseKline);
}

function analyzeWick(candle) {
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

function buildTrendVolumeDecision({ candles, index, entryPrice, positionSide, partialTaken, longOnly = false }) {
  const current = candles[index];
  const previous = candles[index - 1];
  const closes = candles.slice(0, index + 1).map((item) => item.close);
  const bb = emaBollinger(closes, 20, 2);
  const bands = bb[index];
  const previousBands = bb[index - 1];
  const superTrend = supertrend(candles.slice(0, index + 1), 10, 3);
  const trend = superTrend[index];
  const volumeFlow = vaObv(candles.slice(0, index + 1), 20, 20);
  const flow = volumeFlow[index];
  const price = current.close;

  if (!bands || !trend || !flow) {
    return { side: "WAIT", score: 0, reason: "VA추세 지표 준비 중" };
  }

  const longEnergy = flow.value > flow.signal || flow.value > flow.previousHigh;
  const shortEnergy = flow.value < flow.signal || flow.value < flow.previousLow;
  const longPrice = price > bands.middle;
  const shortPrice = price < bands.middle;
  const crossedUp = Boolean(previous && previousBands && previous.close <= previousBands.middle && price > bands.middle);
  const crossedDown = Boolean(previous && previousBands && previous.close >= previousBands.middle && price < bands.middle);

  if (entryPrice && positionSide) {
    if (longOnly && positionSide === "SHORT") {
      return { side: "CLOSE_SHORT", score: 5, reason: "VA롱 전용: 기존 숏 포지션 정리" };
    }
    if (positionSide === "LONG") {
      if (!partialTaken && price >= bands.upper) return { side: "TRIM_LONG", score: 5, reason: "1차 익절: 볼밴 상단 터치 50% 정리" };
      if (trend.direction === "DOWN") return { side: "CLOSE_LONG", score: 5, reason: "2차 청산: SuperTrend 매도 전환" };
      if (price < trend.line || price < bands.lower) return { side: "CLOSE_LONG", score: 5, reason: "손절: SuperTrend/볼밴 하단 이탈" };
      return { side: "HOLD", score: 0, reason: "VA추세 롱 보유" };
    }

    if (!partialTaken && price <= bands.lower) return { side: "TRIM_SHORT", score: 5, reason: "1차 익절: 볼밴 하단 터치 50% 정리" };
    if (trend.direction === "UP") return { side: "CLOSE_SHORT", score: 5, reason: "2차 청산: SuperTrend 매수 전환" };
    if (price > trend.line || price > bands.upper) return { side: "CLOSE_SHORT", score: 5, reason: "손절: SuperTrend/볼밴 상단 돌파" };
    return { side: "HOLD", score: 0, reason: "VA추세 숏 보유" };
  }

  if (trend.direction === "UP" && longEnergy && longPrice) {
    return { side: "LONG", score: 5, reason: crossedUp ? "SuperTrend 매수 + VA-OBV 강세 + EMA20 상향 안착" : "SuperTrend 매수 + VA-OBV 강세 + EMA20 위" };
  }
  if (!longOnly && trend.direction === "DOWN" && shortEnergy && shortPrice) {
    return { side: "SHORT", score: 5, reason: crossedDown ? "SuperTrend 매도 + VA-OBV 약세 + EMA20 하향 안착" : "SuperTrend 매도 + VA-OBV 약세 + EMA20 아래" };
  }

  return { side: "WAIT", score: 0, reason: `${longOnly ? "VA롱" : "VA추세"} 대기: ST ${trend.direction}, VA ${flow.value > flow.signal ? "강세" : "약세"}, EMA20 ${price > bands.middle ? "위" : "아래"}` };
}

function buildWickSupertrendDecision({ candles, index, entryPrice, positionSide }) {
  const candle = candles[index];
  const price = candle.close;
  const wick = analyzeWick(candle);
  const trend = supertrend(candles.slice(0, index + 1), 10, 3)[index];

  if (!trend) {
    return { side: "WAIT", score: 0, reason: "SuperTrend 준비 중" };
  }

  if (entryPrice && positionSide) {
    const stopDistance = Math.abs(entryPrice - trend.line);
    const safeDistance = stopDistance > entryPrice * 0.0005 ? stopDistance : entryPrice * 0.002;
    const longTarget = entryPrice + safeDistance * 1.5;
    const shortTarget = entryPrice - safeDistance * 1.5;

    if (positionSide === "LONG") {
      if (price >= longTarget) return { side: "CLOSE_LONG", score: 5, reason: "익절: SuperTrend 손절폭 기준 1.5R 도달" };
      if (price <= trend.line || trend.direction === "DOWN") return { side: "CLOSE_LONG", score: 5, reason: "손절: SuperTrend 라인 이탈 또는 매도 전환" };
      return { side: "HOLD", score: 0, reason: "꼬리ST 롱 보유" };
    }

    if (price <= shortTarget) return { side: "CLOSE_SHORT", score: 5, reason: "익절: SuperTrend 손절폭 기준 1.5R 도달" };
    if (price >= trend.line || trend.direction === "UP") return { side: "CLOSE_SHORT", score: 5, reason: "손절: SuperTrend 라인 돌파 또는 매수 전환" };
    return { side: "HOLD", score: 0, reason: "꼬리ST 숏 보유" };
  }

  if (wick.hasUpper && trend.direction === "DOWN" && price < trend.line) {
    return { side: "SHORT", score: 5, reason: `윗꼬리 ${(wick.upperPct * 100).toFixed(0)}% + SuperTrend 매도: 숏 진입` };
  }
  if (wick.hasLower && trend.direction === "UP" && price > trend.line) {
    return { side: "LONG", score: 5, reason: `아랫꼬리 ${(wick.lowerPct * 100).toFixed(0)}% + SuperTrend 매수: 롱 진입` };
  }

  return { side: "WAIT", score: 0, reason: `꼬리ST 대기: ST ${trend.direction}, 윗꼬리 ${(wick.upperPct * 100).toFixed(0)}%, 아랫꼬리 ${(wick.lowerPct * 100).toFixed(0)}%` };
}

function buildTrendHoldDecision({ candles, index, entryPrice, positionSide }) {
  const current = candles[index];
  const previous = candles[index - 1];
  const closes = candles.slice(0, index + 1).map((item) => item.close);
  const middle = ema(closes, 20);
  const ema20 = middle[index];
  const previousEma20 = middle[index - 1];
  const trend = supertrend(candles.slice(0, index + 1), 10, 3)[index];
  const flow = vaObv(candles.slice(0, index + 1), 20, 20)[index];

  if (!trend || !ema20 || !flow) {
    return { side: "WAIT", score: 0, reason: "추세홀딩 지표 준비 중" };
  }

  const aboveEma = current.close > ema20;
  const previousAboveEma = previous && previousEma20 ? previous.close > previousEma20 : false;
  const belowEmaTwoCloses = Boolean(previous && previousEma20 && current.close < ema20 && previous.close < previousEma20);
  const volumeStrong = flow.value > flow.signal || flow.value > flow.previousHigh;
  const crossedUp = Boolean(previous && previousEma20 && previous.close <= previousEma20 && current.close > ema20);

  if (entryPrice && positionSide === "LONG") {
    const pnl = ((current.close - entryPrice) / entryPrice) * 100;
    if (trend.direction === "DOWN") return { side: "CLOSE_LONG", score: 5, reason: `청산: SuperTrend 매도 전환 ${pnl.toFixed(2)}%` };
    if (belowEmaTwoCloses) return { side: "CLOSE_LONG", score: 5, reason: `청산: EMA20 아래 2캔들 마감 ${pnl.toFixed(2)}%` };
    return { side: "HOLD", score: 0, reason: `추세홀딩 롱 보유 ${pnl.toFixed(2)}%` };
  }

  if (trend.direction === "UP" && aboveEma && volumeStrong) {
    return { side: "LONG", score: 5, reason: crossedUp || !previousAboveEma ? "SuperTrend 매수 + EMA20 회복 + VA-OBV 강세" : "SuperTrend 매수 + EMA20 위 + VA-OBV 강세" };
  }

  return { side: "WAIT", score: 0, reason: `추세홀딩 대기: ST ${trend.direction}, EMA20 ${aboveEma ? "위" : "아래"}, VA ${volumeStrong ? "강세" : "약세"}` };
}

function buildGagokDecision({ candles, index, entryPrice, positionSide, buyStrategy, takeProfitPct, stopLossPct, partialTaken }) {
  const candle = candles[index];
  const previous = candles[index - 1];
  const price = candle.close;
  const wick = analyzeWick(candle);
  const previousWick = previous ? analyzeWick(previous) : null;
  const strategy = Number(buyStrategy);
  if (strategy === 9) {
    return entryPrice && positionSide
      ? { side: "HOLD", score: 0, reason: "홀딩 전략: 기간 끝까지 보유" }
      : { side: "LONG", score: 5, reason: "홀딩 전략: 기간 시작 매수" };
  }
  if (strategy === 6 || strategy === 7) {
    return buildTrendVolumeDecision({ candles, index, entryPrice, positionSide, partialTaken, longOnly: strategy === 7 });
  }
  if (strategy === 8) {
    return buildWickSupertrendDecision({ candles, index, entryPrice, positionSide });
  }
  if (strategy === 10) {
    return buildTrendHoldDecision({ candles, index, entryPrice, positionSide });
  }
  const allowLong = strategy === 1 || strategy === 2 || strategy === 4;
  const allowShort = strategy === 1 || strategy === 3 || strategy === 4;
  const isConfirmLong = Boolean(previousWick?.hasLower && candle.close > candle.open);
  const isConfirmShort = Boolean(previousWick?.hasUpper && candle.close < candle.open);

  if (entryPrice && positionSide) {
    const pnl = positionSide === "LONG" ? ((price - entryPrice) / entryPrice) * 100 : ((entryPrice - price) / entryPrice) * 100;
    if (strategy === 5) return { side: `CLOSE_${positionSide}`, score: 5, reason: "1분 테스트 청산" };
    if (pnl >= Number(takeProfitPct)) return { side: `CLOSE_${positionSide}`, score: 5, reason: `익절 ${pnl.toFixed(2)}%` };
    if (Number(stopLossPct) > 0 && pnl <= -Number(stopLossPct)) return { side: `CLOSE_${positionSide}`, score: 5, reason: `손절 ${pnl.toFixed(2)}%` };
    return { side: "HOLD", score: 0, reason: `${positionSide} 보유 ${pnl.toFixed(2)}%` };
  }

  if (strategy === 5) {
    return { side: "LONG", score: 5, reason: "1분 테스트 롱 진입" };
  }
  if (strategy === 4 && allowShort && isConfirmShort) {
    return { side: "SHORT", score: 5, reason: `신중 숏: 직전 윗꼬리 후 음봉 확인` };
  }
  if (strategy === 4 && allowLong && isConfirmLong) {
    return { side: "LONG", score: 5, reason: `신중 롱: 직전 아랫꼬리 후 양봉 확인` };
  }
  if (strategy !== 4 && allowShort && wick.hasUpper) {
    return { side: "SHORT", score: 5, reason: `윗꼬리 ${(wick.upperPct * 100).toFixed(0)}%: 숏 진입` };
  }
  if (strategy !== 4 && allowLong && wick.hasLower) {
    return { side: "LONG", score: 5, reason: `아랫꼬리 ${(wick.lowerPct * 100).toFixed(0)}%: 롱 진입` };
  }
  if (strategy === 4) {
    return { side: "WAIT", score: 0, reason: `신중 조건 대기: 직전 상단 ${previousWick ? (previousWick.upperPct * 100).toFixed(0) : "--"}%, 직전 하단 ${previousWick ? (previousWick.lowerPct * 100).toFixed(0) : "--"}%` };
  }
  return { side: "WAIT", score: 0, reason: `꼬리 조건/방향 필터 미충족: 상단 ${(wick.upperPct * 100).toFixed(0)}%, 하단 ${(wick.lowerPct * 100).toFixed(0)}%` };
}

function runBacktest(candles, settings) {
  const feeRate = Number(settings.feeRate) / 100;
  const slippage = Number(settings.slippage) / 100;
  const leverage = Number(settings.leverage) || 1;
  const warmupCandles = Number(settings.buyStrategy) === 9 ? 0 : [6, 7, 8, 10].includes(Number(settings.buyStrategy)) ? 45 : 5;
  const strategyInfo = BUY_STRATEGIES.find((strategy) => strategy.value === Number(settings.buyStrategy));
  let cash = Number(settings.initialCash);
  let positionAmount = 0;
  let positionSide = null;
  let marginUsed = 0;
  let entryPrice = null;
  let partialTaken = false;
  let peakEquity = cash;
  let maxDrawdown = 0;
  const trades = [];
  const equityCurve = [];

  candles.forEach((candle, index) => {
    if (index < warmupCandles) return;
    const price = candle.close;
    const decision = buildGagokDecision({
      candles,
      index,
      entryPrice,
      positionSide,
      buyStrategy: settings.buyStrategy,
      takeProfitPct: settings.takeProfitPct,
      stopLossPct: settings.stopLossPct,
      partialTaken,
    });

    if ((decision.side === "LONG" || decision.side === "SHORT") && cash > 0 && !positionSide) {
      const margin = Math.min(cash, Number(settings.initialCash));
      const notional = margin * leverage;
      const fillPrice = decision.side === "LONG" ? price * (1 + slippage) : price * (1 - slippage);
      const fee = notional * feeRate;
      const amount = notional / fillPrice;
      cash -= margin + fee;
      marginUsed += margin;
      positionAmount = amount;
      positionSide = decision.side;
      entryPrice = fillPrice;
      partialTaken = false;
      trades.push({
        side: decision.side,
        time: candle.time,
        price: fillPrice,
        amount,
        fee,
        pnl: null,
        pnlPct: null,
        reason: decision.reason,
      });
    } else if ((decision.side.startsWith("CLOSE") || decision.side.startsWith("TRIM")) && positionAmount > 0) {
      const closeRatio = decision.side.startsWith("TRIM") ? 0.5 : 1;
      const closeAmount = positionAmount * closeRatio;
      const releasedMargin = marginUsed * closeRatio;
      const fillPrice = positionSide === "LONG" ? price * (1 - slippage) : price * (1 + slippage);
      const gross = closeAmount * fillPrice;
      const fee = gross * feeRate;
      const cost = closeAmount * entryPrice;
      const pnl = (positionSide === "LONG" ? gross - cost : cost - gross) - fee;
      const pnlPct = releasedMargin ? (pnl / releasedMargin) * 100 : 0;
      cash += releasedMargin + pnl;
      trades.push({
        side: decision.side,
        time: candle.time,
        price: fillPrice,
        amount: closeAmount,
        fee,
        pnl,
        pnlPct,
        reason: decision.reason,
      });
      if (decision.side.startsWith("TRIM")) {
        positionAmount -= closeAmount;
        marginUsed -= releasedMargin;
        partialTaken = true;
      } else {
        positionAmount = 0;
        positionSide = null;
        marginUsed = 0;
        entryPrice = null;
        partialTaken = false;
      }
    }

    const unrealized = positionSide === "LONG" ? positionAmount * (price - entryPrice) : positionSide === "SHORT" ? positionAmount * (entryPrice - price) : 0;
    const equity = cash + (positionAmount > 0 && entryPrice ? marginUsed + unrealized : 0);
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.min(maxDrawdown, ((equity - peakEquity) / peakEquity) * 100);
    equityCurve.push({ time: candle.time, equity });
  });

  const lastPrice = candles.at(-1)?.close ?? 0;
  const finalUnrealized = positionSide === "LONG" ? positionAmount * (lastPrice - entryPrice) : positionSide === "SHORT" ? positionAmount * (entryPrice - lastPrice) : 0;
  const finalEquity = cash + (positionAmount > 0 && entryPrice ? marginUsed + finalUnrealized : 0);
  const exits = trades.filter((trade) => trade.side.startsWith("CLOSE") || trade.side.startsWith("TRIM"));
  const wins = exits.filter((trade) => trade.pnl > 0).length;
  const losses = exits.filter((trade) => trade.pnl < 0).length;
  return {
    candles,
    trades,
    equityCurve,
    strategyLabel: strategyInfo?.label ?? `전략 ${settings.buyStrategy}`,
    strategyDescription: strategyInfo?.description ?? "",
    symbol: settings.symbol,
    interval: settings.interval,
    days: settings.days,
    rangeLabel: settings.startDate && settings.endDate ? `${settings.startDate} ~ ${settings.endDate}` : `최근 ${settings.days}일`,
    finalEquity,
    totalReturn: ((finalEquity - Number(settings.initialCash)) / Number(settings.initialCash)) * 100,
    maxDrawdown,
    wins,
    losses,
    winRate: exits.length ? (wins / exits.length) * 100 : null,
    sellCount: exits.length,
    totalFees: trades.reduce((sum, trade) => sum + trade.fee, 0),
  };
}

function createSimBot(bot) {
  const strategy = BUY_STRATEGIES.find((item) => item.value === bot.strategy);
  return {
    ...bot,
    strategyLabel: strategy?.label ?? bot.name,
    strategyDescription: strategy?.description ?? "",
    cash: SIM_BOT_CASH,
    positionAmount: 0,
    positionSide: null,
    marginUsed: 0,
    entryPrice: null,
    partialTaken: false,
    lastCandleTime: null,
    lastDecision: "READY",
    lastReason: "가상 봇 대기",
    latestPrice: null,
    equity: SIM_BOT_CASH,
    trades: [],
  };
}

function simulateBotTick(bot, candles, settings) {
  const index = candles.length - 2;
  const candle = candles[index];
  if (!candle) return bot;
  const warmupCandles = [6, 7, 8, 10].includes(Number(bot.strategy)) ? 45 : 5;
  if (index < warmupCandles) {
    return { ...bot, latestPrice: candle.close, lastReason: "지표 준비 중", equity: bot.cash + bot.marginUsed };
  }
  if (bot.lastCandleTime === candle.time) {
    const unrealized = bot.positionSide === "LONG" ? bot.positionAmount * (candle.close - bot.entryPrice) : bot.positionSide === "SHORT" ? bot.positionAmount * (bot.entryPrice - candle.close) : 0;
    return { ...bot, latestPrice: candle.close, equity: bot.cash + (bot.positionAmount > 0 ? bot.marginUsed + unrealized : 0) };
  }

  const feeRate = Number(settings.feeRate) / 100;
  const slippage = Number(settings.slippage) / 100;
  const leverage = Number(settings.leverage) || 1;
  const decision = buildGagokDecision({
    candles,
    index,
    entryPrice: bot.entryPrice,
    positionSide: bot.positionSide,
    buyStrategy: bot.strategy,
    takeProfitPct: settings.takeProfitPct,
    stopLossPct: settings.stopLossPct,
    partialTaken: bot.partialTaken,
  });

  let next = { ...bot, latestPrice: candle.close, lastCandleTime: candle.time, lastDecision: decision.side, lastReason: decision.reason };

  if ((decision.side === "LONG" || decision.side === "SHORT") && next.cash > 0 && !next.positionSide) {
    const margin = Math.min(next.cash, SIM_BOT_CASH);
    const notional = margin * leverage;
    const fillPrice = decision.side === "LONG" ? candle.close * (1 + slippage) : candle.close * (1 - slippage);
    const fee = notional * feeRate;
    const amount = notional / fillPrice;
    next = {
      ...next,
      cash: next.cash - margin - fee,
      marginUsed: margin,
      positionAmount: amount,
      positionSide: decision.side,
      entryPrice: fillPrice,
      partialTaken: false,
      trades: [{ side: decision.side, time: candle.time, price: fillPrice, pnl: null, reason: decision.reason }, ...next.trades].slice(0, 8),
    };
  } else if ((decision.side.startsWith("CLOSE") || decision.side.startsWith("TRIM")) && next.positionAmount > 0) {
    const closeRatio = decision.side.startsWith("TRIM") ? 0.5 : 1;
    const closeAmount = next.positionAmount * closeRatio;
    const releasedMargin = next.marginUsed * closeRatio;
    const fillPrice = next.positionSide === "LONG" ? candle.close * (1 - slippage) : candle.close * (1 + slippage);
    const gross = closeAmount * fillPrice;
    const fee = gross * feeRate;
    const cost = closeAmount * next.entryPrice;
    const pnl = (next.positionSide === "LONG" ? gross - cost : cost - gross) - fee;

    if (decision.side.startsWith("TRIM")) {
      next = {
        ...next,
        cash: next.cash + releasedMargin + pnl,
        marginUsed: next.marginUsed - releasedMargin,
        positionAmount: next.positionAmount - closeAmount,
        partialTaken: true,
        trades: [{ side: decision.side, time: candle.time, price: fillPrice, pnl, reason: decision.reason }, ...next.trades].slice(0, 8),
      };
    } else {
      next = {
        ...next,
        cash: next.cash + next.marginUsed + pnl,
        marginUsed: 0,
        positionAmount: 0,
        positionSide: null,
        entryPrice: null,
        partialTaken: false,
        trades: [{ side: decision.side, time: candle.time, price: fillPrice, pnl, reason: decision.reason }, ...next.trades].slice(0, 8),
      };
    }
  }

  const unrealized = next.positionSide === "LONG" ? next.positionAmount * (candle.close - next.entryPrice) : next.positionSide === "SHORT" ? next.positionAmount * (next.entryPrice - candle.close) : 0;
  return { ...next, equity: next.cash + (next.positionAmount > 0 ? next.marginUsed + unrealized : 0) };
}

function BacktestChart({ result }) {
  const [visibleCount, setVisibleCount] = useState(260);
  const width = 980;
  const height = 360;
  const candles = result?.candles ?? [];
  const normalizedVisibleCount = Math.min(Math.max(visibleCount, 40), Math.max(candles.length, 40));
  const visible = candles.slice(-normalizedVisibleCount);
  if (!visible.length) return <div className="empty-chart">백테스트를 실행하면 차트가 표시됩니다.</div>;
  const start = visible[0].time;
  const end = visible.at(-1).time;
  const high = Math.max(...visible.map((item) => item.high));
  const low = Math.min(...visible.map((item) => item.low));
  const range = high - low || 1;
  const xAt = (time) => ((time - start) / Math.max(end - start, 1)) * (width - 70) + 20;
  const yAt = (price) => 20 + ((high - price) / range) * (height - 60);
  const trades = (result?.trades ?? []).filter((trade) => trade.time >= start);
  const candleWidth = Math.max(2, Math.min(7, (width - 90) / visible.length) * 0.58);

  return (
    <div className="chart-shell">
      <div className="chart-tools" aria-label="차트 확대 축소">
        <button type="button" title="확대" onClick={() => setVisibleCount((current) => Math.max(40, Math.floor(current * 0.65)))}>
          <ZoomIn size={15} />
        </button>
        <button type="button" title="축소" onClick={() => setVisibleCount((current) => Math.min(candles.length || 260, Math.ceil(current * 1.45)))}>
          <ZoomOut size={15} />
        </button>
        <button type="button" title="초기화" onClick={() => setVisibleCount(260)}>
          <RotateCcw size={15} />
        </button>
        <span>{visible.length}개 캔들</span>
      </div>
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${result?.symbol ?? TRADE_SYMBOL} backtest chart`}>
        <rect width={width} height={height} rx="8" fill="#11161c" />
        {visible.map((candle) => {
          const x = xAt(candle.time);
          const openY = yAt(candle.open);
          const closeY = yAt(candle.close);
          const color = candle.close >= candle.open ? "#3ddc97" : "#ff6b7a";
          return (
            <g key={candle.time}>
              <line x1={x} x2={x} y1={yAt(candle.high)} y2={yAt(candle.low)} stroke={color} strokeWidth="1.1" />
              <rect
                x={x - candleWidth / 2}
                y={Math.min(openY, closeY)}
                width={candleWidth}
                height={Math.max(2, Math.abs(openY - closeY))}
                rx="1"
                fill={color}
              />
            </g>
          );
        })}
        {trades.map((trade) => (
          <g key={`${trade.side}-${trade.time}-${trade.price}`}>
            <circle cx={xAt(trade.time)} cy={yAt(trade.price)} r="5" fill={trade.side === "LONG" ? "#38bdf8" : trade.side === "SHORT" ? "#ff6b7a" : "#fbbf24"} />
            <text x={xAt(trade.time) + 7} y={yAt(trade.price) - 7} fill="#dbeafe" fontSize="11">
              {trade.side}
            </text>
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const price = high - range * ratio;
          return (
            <g key={ratio}>
              <line x1="20" x2={width - 45} y1={yAt(price)} y2={yAt(price)} stroke="rgba(148,163,184,.12)" />
              <text x={width - 38} y={yAt(price) + 4} fill="#94a3b8" fontSize="11">
                {formatUsd(price, 0)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function StatCard({ icon: Icon, title, value, caption, tone = "" }) {
  return (
    <div className="stat-card">
      <div className="stat-title">{Icon ? <Icon size={15} /> : null}{title}</div>
      <strong className={tone}>{value}</strong>
      <span>{caption}</span>
    </div>
  );
}

function TestnetPanel({ settings }) {
  const buyStrategy = BUY_STRATEGIES.find((strategy) => strategy.value === settings.buyStrategy);
  const stopLossLabel = settings.stopLossPct === 0 ? "노손절" : `${settings.stopLossPct}%`;
  const [testnetStatus, setTestnetStatus] = useState("Supabase URL과 Publishable key를 .env.local에 넣으면 연결 테스트를 시작할 수 있습니다.");
  const [testnetLoading, setTestnetLoading] = useState(false);
  const [testnetDetail, setTestnetDetail] = useState(null);
  const [appliedSettings, setAppliedSettings] = useState(null);
  const [testnetEvents, setTestnetEvents] = useState([]);
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const canInvoke = Boolean(supabaseUrl && publishableKey);
  const diagnostics = testnetDetail?.decision?.diagnostics;
  const testnetMetrics = testnetDetail?.metrics;
  const latestRunEvent = testnetEvents.find((event) => event.event_type === "strategy_run");
  const runEvents = testnetEvents.filter((event) => event.event_type === "strategy_run").slice(0, 6);
  const tradeEvents = testnetEvents.filter((event) => {
    const side = event.payload?.decision?.side;
    return event.event_type === "order_error" || ["LONG", "SHORT", "TRIM_LONG", "TRIM_SHORT", "CLOSE_LONG", "CLOSE_SHORT"].includes(side);
  });
  const lastDecision = testnetDetail?.decision?.side ?? "READY";
  const statusTone = testnetStatus.startsWith("실패") ? "bad" : lastDecision === "BUY" || lastDecision === "SELL" ? "good" : "neutral";

  async function invokeTestnet(action, quiet = false) {
    if (!canInvoke) {
      setTestnetStatus(".env.local에 VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY가 필요합니다.");
      return;
    }

    if (!quiet) setTestnetLoading(true);
    if (!quiet) {
      setTestnetStatus(action === "check" ? "Supabase Edge Function 연결 확인 중..." : "테스트넷 전략 1회 실행 중...");
    }
    try {
      const response = await fetch(`${supabaseUrl}/functions/v1/run-testnet-strategy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${publishableKey}`,
          apikey: publishableKey,
        },
        body: JSON.stringify({
          action,
          symbol: settings.symbol,
          interval: settings.interval,
          buyStrategy: settings.buyStrategy,
          leverage: settings.leverage,
          takeProfitPct: settings.takeProfitPct,
          stopLossPct: settings.stopLossPct,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error ?? response.statusText);
      setTestnetDetail(data);
      if (data.settings) setAppliedSettings(data.settings);
      if (data.events) setTestnetEvents(data.events);
      setTestnetStatus(action === "check" ? `연결됨: dry-run ${data.dryRun ? "ON" : "OFF"}` : action === "save-settings" ? "현재 전략이 자동운영 설정으로 저장되었습니다." : `${data.decision?.side}: ${data.decision?.reason}`);
    } catch (error) {
      if (!quiet) setTestnetStatus(`실패: ${error.message}`);
    } finally {
      if (!quiet) setTestnetLoading(false);
    }
  }

  useEffect(() => {
    if (canInvoke) {
      invokeTestnet("check", true);
      invokeTestnet("events", true);
    }
  }, [canInvoke]);

  useEffect(() => {
    if (!canInvoke) return undefined;
    const timer = window.setInterval(() => {
      invokeTestnet("events", true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [canInvoke]);

  return (
    <section className="panel testnet-panel">
      <div className="testnet-head">
        <div>
          <div className="eyebrow">Binance Futures Testnet</div>
          <h2>Supabase Binance 테스트넷</h2>
          <p>현재 선택한 백테스트 전략을 Edge Function과 Cron으로 실행합니다.</p>
        </div>
        <div className={`live-badge ${statusTone}`}>
          <span></span>
          {testnetLoading ? "RUNNING" : lastDecision}
        </div>
      </div>

      <div className="testnet-sections">
        <div className="testnet-summary testnet-section-block">
          <div className="summary-title">운영 설정</div>
          <div className="settings-list">
            <div><span>심볼</span><strong>{settings.symbol}</strong></div>
            <div><span>봉 기준</span><strong>{settings.interval}</strong></div>
            <div><span>매수</span><strong>{buyStrategy?.description ?? "-"}</strong></div>
            <div><span>레버리지</span><strong>{settings.leverage}x</strong></div>
            <div><span>익절</span><strong>{settings.takeProfitPct}%</strong></div>
            <div><span>손절</span><strong>{stopLossLabel}</strong></div>
          </div>
          <button className="apply-strategy-button" type="button" disabled={!canInvoke || testnetLoading} onClick={() => invokeTestnet("save-settings")}>
            현재 전략 적용
          </button>
        </div>

        <div className="testnet-actions testnet-section-block">
          <div className="summary-title">자동 운영 상태</div>
          <div className="auto-status-grid">
            <div>
              <span>연결</span>
              <strong>{canInvoke ? (testnetDetail?.ok ? "연결됨" : "확인 중") : "환경변수 필요"}</strong>
            </div>
            <div>
              <span>실행 방식</span>
              <strong>Supabase Cron</strong>
            </div>
            <div>
              <span>주기</span>
              <strong>1분마다</strong>
            </div>
            <div>
              <span>주문 모드</span>
              <strong>{testnetDetail?.dryRun ? "Dry-run" : "Testnet"}</strong>
            </div>
            <div>
              <span>적용 전략</span>
              <strong>{appliedSettings ? `${appliedSettings.interval} · ${appliedSettings.leverage}x` : "확인 전"}</strong>
            </div>
            <div>
              <span>최근 실행</span>
              <strong>{latestRunEvent ? new Date(latestRunEvent.created_at).toLocaleTimeString() : "대기 중"}</strong>
            </div>
          </div>
          <div className={`status-box ${statusTone}`}>
            <strong>{testnetLoading ? "처리 중" : "상태"}</strong>
            <span>{testnetStatus}</span>
          </div>
          <button className="refresh-status-button" type="button" disabled={!canInvoke || testnetLoading} onClick={() => invokeTestnet("check")}>상태 갱신</button>
        </div>
      </div>

      {diagnostics ? (
        <div className="diagnostic-panel">
          <div className="diagnostic-head">
            <div>
              <div className="summary-title">마지막 신호 상세</div>
              <p>{testnetDetail?.decision?.reason}</p>
            </div>
            <strong>{diagnostics.score ?? "--"} / 5</strong>
          </div>
          <div className="diagnostic-grid">
            <span>현재가</span><strong>${formatUsd(diagnostics.price)}</strong>
            <span>윗꼬리</span><strong>{diagnostics.wick?.upperPct === undefined ? "--" : `${(diagnostics.wick.upperPct * 100).toFixed(0)}%`}</strong>
            <span>아랫꼬리</span><strong>{diagnostics.wick?.lowerPct === undefined ? "--" : `${(diagnostics.wick.lowerPct * 100).toFixed(0)}%`}</strong>
            <span>캔들폭</span><strong>{formatPct(diagnostics.wick?.rangePct, 2)}</strong>
            <span>몸통</span><strong>${formatUsd(diagnostics.wick?.body)}</strong>
            <span>직전 윗꼬리</span><strong>{diagnostics.previousWick?.upperPct === undefined ? "--" : `${(diagnostics.previousWick.upperPct * 100).toFixed(0)}%`}</strong>
            <span>직전 아랫꼬리</span><strong>{diagnostics.previousWick?.lowerPct === undefined ? "--" : `${(diagnostics.previousWick.lowerPct * 100).toFixed(0)}%`}</strong>
            <span>꼬리기준</span><strong>45% / 몸통 1.5x</strong>
            <span>포지션</span><strong>{Number(diagnostics.positionAmount ?? 0).toFixed(3)} BTC</strong>
            <span>진입가</span><strong>{diagnostics.entryPrice ? `$${formatUsd(diagnostics.entryPrice)}` : "--"}</strong>
            <span>Dry-run</span><strong>{testnetDetail?.dryRun ? "ON" : "OFF"}</strong>
          </div>
          <div className="check-grid">
            <div className={diagnostics.checks?.upperWickShort ? "pass" : ""}>윗꼬리 숏 <strong>{diagnostics.checks?.upperWickShort ? "충족" : "대기"}</strong></div>
            <div className={diagnostics.checks?.lowerWickLong ? "pass" : ""}>아랫꼬리 롱 <strong>{diagnostics.checks?.lowerWickLong ? "충족" : "대기"}</strong></div>
            <div className={diagnostics.checks?.confirmShort || diagnostics.checks?.confirmLong ? "pass" : ""}>확인봉 <strong>{diagnostics.checks?.confirmShort ? "음봉" : diagnostics.checks?.confirmLong ? "양봉" : "대기"}</strong></div>
          </div>
        </div>
      ) : null}

      <div className="testnet-performance-panel">
        <div className="summary-title">테스트넷 운영 요약</div>
        <div className="testnet-stat-grid">
          <StatCard icon={Wallet} title="증거금" value={`$${formatUsd(testnetMetrics?.marginUsdt)}`} caption="BOT_MARGIN_USDT 기준" />
          <StatCard icon={Gauge} title="평가금" value={`$${formatUsd(testnetMetrics?.finalEquityUsdt)}`} caption={`미실현 $${formatUsd(testnetMetrics?.unrealizedProfit)}`} />
          <StatCard icon={BarChart3} title="수익률" value={formatPct(testnetMetrics?.totalReturnPct)} caption="현재 포지션 기준" tone={Number(testnetMetrics?.totalReturnPct ?? 0) >= 0 ? "good" : "bad"} />
          <StatCard icon={ShieldAlert} title="낙폭" value={formatPct(testnetMetrics?.maxDrawdownPct)} caption="최근 이벤트 기준" tone="bad" />
          <StatCard icon={Activity} title="승률" value={testnetMetrics?.winRatePct === null || testnetMetrics?.winRatePct === undefined ? "--" : `${testnetMetrics.winRatePct.toFixed(1)}%`} caption={`승 ${testnetMetrics?.wins ?? 0} / 패 ${testnetMetrics?.losses ?? 0}`} />
        </div>
      </div>

        <div className="testnet-events-panel">
          <div className="diagnostic-head">
            <div>
              <div className="summary-title">테스트넷 실행 내역</div>
              <p>최근 판단은 실시간으로 보이고, 실제 주문 체결은 아래에 따로 표시합니다.</p>
            </div>
            <button className="refresh-status-button compact" type="button" disabled={!canInvoke || testnetLoading} onClick={() => invokeTestnet("events")}>새로고침</button>
          </div>
          <div className="testnet-run-list">
            {runEvents.length ? runEvents.map((event) => {
              const decision = event.payload?.decision;
              return (
                <div className="testnet-run-row" key={event.id}>
                  <span>{decision?.side ?? "RUN"}</span>
                  <strong>{decision?.reason ?? event.message}</strong>
                  <em>{new Date(event.created_at).toLocaleTimeString()}</em>
                </div>
              );
            }) : <div className="empty-list">아직 전략 판단 기록이 없습니다.</div>}
          </div>
          <div className="testnet-event-list">
          {tradeEvents.length ? tradeEvents.map((event) => {
            const decision = event.payload?.decision;
            const order = event.payload?.order;
            const sideLabel = event.event_type === "order_error" ? "주문 실패" : decision?.side === "LONG" ? "롱 진입" : decision?.side === "SHORT" ? "숏 진입" : decision?.side === "TRIM_LONG" ? "롱 50% 정리" : decision?.side === "TRIM_SHORT" ? "숏 50% 정리" : decision?.side === "CLOSE_LONG" ? "롱 청산" : "숏 청산";
            const dotClass = event.event_type === "order_error" ? "error" : (decision?.side ?? "").toLowerCase();
            const quantity = Number(order?.origQty ?? order?.quantity ?? 0);
            const referencePrice = Number(order?.avgPrice && Number(order.avgPrice) > 0 ? order.avgPrice : event.payload?.latestClose ?? decision?.diagnostics?.price ?? 0);
            const notional = quantity && referencePrice ? quantity * referencePrice : null;
            const priceLabel = decision?.side?.startsWith("CLOSE") || decision?.side?.startsWith("TRIM") ? "청산가" : "진입가";
            return (
              <div className="testnet-event-row" key={event.id}>
                <span className={`event-dot ${dotClass}`} title={sideLabel} aria-label={sideLabel}></span>
                <span>{notional ? `$${formatUsd(notional)}` : "-- USDT"}</span>
                <span>{referencePrice ? `${priceLabel} $${formatUsd(referencePrice)}` : `${priceLabel} --`}</span>
                <span>{new Date(event.created_at).toLocaleString()}</span>
              </div>
            );
          }) : <div className="empty-list">아직 매매 신호가 없습니다.</div>}
        </div>
      </div>
    </section>
  );
}

function AiBotSimulationPanel({ settings }) {
  const [bots, setBots] = useState(() => SIM_BOTS.map(createSimBot));
  const [running, setRunning] = useState(true);
  const [status, setStatus] = useState("가상 봇 초기화 중");
  const [lastUpdated, setLastUpdated] = useState(null);

  async function refreshBots(quiet = false) {
    if (!quiet) setStatus("최신 캔들 확인 중...");
    try {
      const candles = await fetchRecentCandles({ symbol: settings.symbol, interval: settings.interval, limit: 180 });
      setBots((current) => current.map((bot) => simulateBotTick(bot, candles, settings)));
      setLastUpdated(new Date());
      if (!quiet) setStatus(`${settings.symbol} ${settings.interval} 기준 가상 체결 갱신 완료`);
    } catch (error) {
      setStatus(`실패: ${error.message}`);
    }
  }

  useEffect(() => {
    setBots(SIM_BOTS.map(createSimBot));
    setStatus(`${settings.symbol} ${settings.interval} 기준으로 봇 6개 리셋`);
  }, [settings.symbol, settings.interval]);

  useEffect(() => {
    if (!running) return undefined;
    refreshBots(true);
    const timer = window.setInterval(() => refreshBots(true), 15000);
    return () => window.clearInterval(timer);
  }, [running, settings.symbol, settings.interval, settings.leverage, settings.takeProfitPct, settings.stopLossPct]);

  const bestBot = bots.reduce((best, bot) => (bot.equity > best.equity ? bot : best), bots[0]);

  return (
    <section className="panel ai-bot-panel">
      <div className="ai-bot-head">
        <div>
          <div className="eyebrow">AI Paper Bot Lab</div>
          <h2>AI봇 모의투자</h2>
          <p>각 전략 봇이 독립 가상 계좌로 실시간 캔들을 확인하고 가상 체결합니다.</p>
        </div>
        <div className="ai-bot-actions">
          <div className={`connection ${running ? "live" : "offline"}`}><span></span>{running ? "AUTO" : "PAUSED"}</div>
          <button className="refresh-status-button compact" type="button" onClick={() => setRunning((value) => !value)}>{running ? "정지" : "시작"}</button>
          <button className="refresh-status-button compact" type="button" onClick={() => refreshBots()}>갱신</button>
          <button className="refresh-status-button compact" type="button" onClick={() => setBots(SIM_BOTS.map(createSimBot))}>리셋</button>
        </div>
      </div>

      <div className="bot-status-strip">
        <span className="bot-pulse"></span>
        <div>
          <strong>{bestBot?.name ?? "--"} 선두</strong>
          <small>{status} · {lastUpdated ? lastUpdated.toLocaleTimeString() : "대기 중"}</small>
        </div>
        <div className="bot-status-meta">
          <span>{settings.symbol}</span>
          <strong>{settings.interval}</strong>
        </div>
      </div>

      <div className="ai-bot-grid">
        {bots.map((bot) => {
          const returnPct = ((bot.equity - SIM_BOT_CASH) / SIM_BOT_CASH) * 100;
          const latestTrade = bot.trades[0];
          return (
            <article className={`ai-bot-card ${bot.accent}`} key={bot.id}>
              <div className="ai-bot-card-top">
                <div>
                  <span>{bot.strategyLabel}</span>
                  <strong>{bot.name}</strong>
                </div>
                <em className={bot.positionSide ? bot.positionSide.toLowerCase() : "wait"}>{bot.positionSide ?? "WAIT"}</em>
              </div>
              <div className="bot-metrics">
                <div><span>평가금</span><strong>${formatUsd(bot.equity)}</strong></div>
                <div><span>수익률</span><strong className={returnPct >= 0 ? "good" : "bad"}>{formatPct(returnPct)}</strong></div>
                <div><span>진입가</span><strong>{bot.entryPrice ? `$${formatUsd(bot.entryPrice)}` : "--"}</strong></div>
                <div><span>최근가</span><strong>{bot.latestPrice ? `$${formatUsd(bot.latestPrice)}` : "--"}</strong></div>
              </div>
              <div className="bot-decision">
                <span>{bot.lastDecision}</span>
                <p>{bot.lastReason}</p>
              </div>
              <div className="bot-last-trade">
                <span>최근 체결</span>
                <strong>{latestTrade ? `${latestTrade.side} · $${formatUsd(latestTrade.price)}` : "체결 없음"}</strong>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function App() {
  const [settings, setSettings] = useState({
    symbol: TRADE_SYMBOL,
    interval: "15m",
    days: 14,
    startDate: "",
    endDate: "",
    initialCash: 50000,
    feeRate: 0.04,
    slippage: 0.02,
    buyStrategy: 1,
    leverage: 1,
    takeProfitPct: 0.2,
    stopLossPct: 0.2,
  });
  const [status, setStatus] = useState("조건을 입력하고 백테스트를 실행하세요.");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const recentTrades = useMemo(() => (result?.trades ?? []).slice(-18).reverse(), [result]);
  const usesBuiltInRisk = [6, 7, 8, 9, 10].includes(settings.buyStrategy);
  const today = new Date().toISOString().slice(0, 10);

  function updateSetting(key, value) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  useEffect(() => {
    if (!BUY_STRATEGIES.some((strategy) => strategy.value === settings.buyStrategy)) {
      updateSetting("buyStrategy", 1);
    }
  }, [settings.buyStrategy]);

  async function handleRun() {
    setLoading(true);
    setStatus(`Binance ${settings.symbol} 과거 캔들을 가져오는 중...`);
    try {
      const candles = await fetchHistoricalCandles({
        symbol: settings.symbol,
        interval: settings.interval,
        days: settings.days,
        startDate: settings.startDate,
        endDate: settings.endDate,
      });
      setStatus(`${candles.length.toLocaleString("ko-KR")}개 캔들로 가곡대광v1.0 전략 계산 중...`);
      const output = runBacktest(candles, settings);
      setResult(output);
      setStatus(`완료: ${candles.length.toLocaleString("ko-KR")}개 캔들 · ${output.trades.length.toLocaleString("ko-KR")}개 체결`);
    } catch (error) {
      setStatus(`실패: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <header className="hero">
        <div>
          <div className="eyebrow">BTC Backtest Lab</div>
          <h1>가곡대광v1.0 백테스트</h1>
          <p>Binance {settings.symbol} 과거 캔들로 꼬리 반전 전략을 빠르게 검증합니다.</p>
        </div>
        <button className="run-button" onClick={handleRun} disabled={loading}>
          <Play size={18} />
          {loading ? "계산 중" : "백테스트 실행"}
        </button>
      </header>

      <section className="workspace">
        <aside className="panel controls">
          <h2>입력값</h2>
          <div className="control-group">
            <span>페어</span>
            <div className="symbol-tabs">
              {SYMBOL_OPTIONS.map((symbol) => (
                <button
                  key={symbol.value}
                  className={settings.symbol === symbol.value ? "active" : ""}
                  type="button"
                  onClick={() => updateSetting("symbol", symbol.value)}
                >
                  {symbol.label}
                </button>
              ))}
            </div>
          </div>
          <label>
            봉 기준
            <select value={settings.interval} onChange={(event) => updateSetting("interval", event.target.value)}>
              {INTERVALS.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </label>
          <label>
            기간
            <select value={settings.days} onChange={(event) => updateSetting("days", Number(event.target.value))}>
              <option value={1}>최근 1일</option>
              <option value={2}>최근 2일</option>
              <option value={3}>최근 3일</option>
              <option value={4}>최근 4일</option>
              <option value={5}>최근 5일</option>
              <option value={6}>최근 6일</option>
              <option value={7}>최근 7일</option>
              <option value={8}>최근 8일</option>
              <option value={9}>최근 9일</option>
              <option value={10}>최근 10일</option>
              <option value={11}>최근 11일</option>
              <option value={12}>최근 12일</option>
              <option value={13}>최근 13일</option>
              <option value={14}>최근 14일</option>
              <option value={30}>최근 30일</option>
            </select>
          </label>
          <div className="control-group">
            <span>기간설정</span>
            <div className="date-range-grid">
              <label>
                시작일
                <input
                  type="date"
                  max={settings.endDate || today}
                  value={settings.startDate}
                  onChange={(event) => updateSetting("startDate", event.target.value)}
                />
              </label>
              <label>
                종료일
                <input
                  type="date"
                  min={settings.startDate || undefined}
                  max={today}
                  value={settings.endDate}
                  onChange={(event) => updateSetting("endDate", event.target.value)}
                />
              </label>
            </div>
            <small>{settings.startDate && settings.endDate ? "직접 설정한 날짜 구간으로 백테스트합니다." : "비워두면 위의 최근 기간으로 백테스트합니다."}</small>
          </div>
          <label>
            초기 자본
            <input type="number" value={settings.initialCash} onChange={(event) => updateSetting("initialCash", Number(event.target.value))} />
          </label>
          <label>
            수수료 %
            <input type="number" step="0.01" value={settings.feeRate} onChange={(event) => updateSetting("feeRate", Number(event.target.value))} />
          </label>
          <label>
            슬리피지 %
            <input type="number" step="0.01" value={settings.slippage} onChange={(event) => updateSetting("slippage", Number(event.target.value))} />
          </label>
          <div className="control-group">
            <span>매수전략</span>
            <div className="strategy-tabs">
              {BUY_STRATEGIES.map((strategy) => (
                <button
                  key={strategy.value}
                  className={settings.buyStrategy === strategy.value ? "active" : ""}
                  type="button"
                  onClick={() => updateSetting("buyStrategy", strategy.value)}
                >
                  <strong>{strategy.label}</strong>
                  <span>{strategy.description}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="control-group">
            <span>레버리지</span>
            <div className="leverage-control">
              {LEVERAGE_OPTIONS.map((value) => (
                <button
                  key={value}
                  className={settings.leverage === value ? "active" : ""}
                  type="button"
                  onClick={() => updateSetting("leverage", value)}
                >
                  {value}x
                </button>
              ))}
            </div>
          </div>
          <div className={`control-group ${usesBuiltInRisk ? "disabled-control" : ""}`}>
            <span>익절률</span>
            {usesBuiltInRisk ? <small>{settings.buyStrategy === 10 ? "추세홀딩은 짧은 익절 없이 상승추세를 길게 보유합니다." : settings.buyStrategy === 9 ? "홀딩은 선택 기간 시작에 매수하고 끝까지 보유합니다." : settings.buyStrategy === 8 ? "꼬리ST는 SuperTrend 손절폭 기준 1.5R 익절을 사용합니다." : "VA 전략은 볼밴 50% 익절 + SuperTrend 청산을 사용합니다."}</small> : null}
            <div className="segmented-control">
              {TAKE_PROFIT_OPTIONS.map((value) => (
                <button
                  key={value}
                  className={settings.takeProfitPct === value ? "active" : ""}
                  type="button"
                  disabled={usesBuiltInRisk}
                  onClick={() => updateSetting("takeProfitPct", value)}
                >
                  {value}%
                </button>
              ))}
            </div>
          </div>
          <div className={`control-group ${usesBuiltInRisk ? "disabled-control" : ""}`}>
            <span>손절률</span>
            {usesBuiltInRisk ? <small>{settings.buyStrategy === 10 ? "추세홀딩은 SuperTrend 매도 전환 또는 EMA20 아래 2캔들 마감으로 청산합니다." : settings.buyStrategy === 9 ? "홀딩은 손절 없이 기간 종료 평가금으로 수익률을 계산합니다." : settings.buyStrategy === 8 ? "꼬리ST는 SuperTrend 라인 이탈 또는 반대 전환으로 손절합니다." : "VA 전략은 SuperTrend 라인 또는 볼밴 반대선 이탈로 손절합니다."}</small> : null}
            <div className="segmented-control">
              {STOP_LOSS_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={settings.stopLossPct === option.value ? "active" : ""}
                  type="button"
                  disabled={usesBuiltInRisk}
                  onClick={() => updateSetting("stopLossPct", option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="strategy-note">
            <strong>전략</strong>
            {settings.buyStrategy === 10 ? (
              <span>
                추세홀딩: 상승추세 전용 롱 전략입니다. SuperTrend가 매수 방향이고 가격이 EMA20 위에 있으며 VA-OBV가 Signal 위 또는 직전 고점을 돌파하면 롱 진입합니다.
                볼밴 상단 익절 없이 계속 보유하고, SuperTrend가 매도 전환되거나 EMA20 아래로 2캔들 연속 마감하면 청산합니다.
              </span>
            ) : settings.buyStrategy === 9 ? (
              <span>
                홀딩: 선택한 최근 기간의 첫 캔들에서 바로 롱 매수하고, 중간 청산 없이 마지막 캔들까지 그대로 보유합니다.
                매매전략 성과가 단순 보유보다 나은지 비교하는 기준 전략입니다.
              </span>
            ) : settings.buyStrategy === 8 ? (
              <span>
                꼬리ST: 윗꼬리가 나오고 SuperTrend가 매도 방향이며 가격이 SuperTrend 라인 아래에 있으면 숏,
                아랫꼬리가 나오고 SuperTrend가 매수 방향이며 가격이 SuperTrend 라인 위에 있으면 롱 진입합니다.
                손절은 SuperTrend 라인 이탈 또는 반대 전환, 익절은 진입가와 SuperTrend 손절선 사이 거리의 1.5배입니다.
              </span>
            ) : usesBuiltInRisk ? (
              <span>
                {settings.buyStrategy === 7 ? "VA롱" : "VA추세"}: SuperTrend가 방향을 잡고, VA-OBV가 Signal 돌파 또는 직전 고점/저점 돌파로 거래량 에너지를 확인합니다.
                {settings.buyStrategy === 7 ? " 캔들이 EMA20 볼밴 중간선 위에 안착할 때 롱 진입만 봅니다." : " 캔들이 EMA20 볼밴 중간선 위면 롱, 아래면 숏 진입을 봅니다."} 1차 익절은 볼밴 상단/하단 터치 시 50% 정리,
                남은 물량은 SuperTrend 반대 전환까지 보유합니다. 손절은 SuperTrend 라인 또는 볼밴 반대선 이탈 기준입니다.
              </span>
            ) : (
              <span>꼬리 반전: 윗꼬리 기준 충족 시 숏, 아랫꼬리 기준 충족 시 롱. 선택한 익절/손절률 적용</span>
            )}
          </div>
        </aside>

        <section className="main-grid">
          <div className="panel chart-panel">
            <div className="panel-head">
              <div>
                <h2>{result?.symbol ?? settings.symbol} 과거 차트</h2>
                <p>{status}</p>
              </div>
              <div className="source-pill">{result ? `${result.symbol} · ${result.strategyLabel} · ${result.interval} · ${result.rangeLabel}` : "Binance API"}</div>
            </div>
            <BacktestChart result={result} />
          </div>

          <div className="stats-grid">
            <div className="stat-card strategy-result-card">
              <div className="stat-title">사용 전략</div>
              <strong>{result?.strategyLabel ?? "--"}</strong>
              <span>{result?.strategyDescription ?? "백테스트 실행 후 표시"}</span>
            </div>
            <StatCard icon={Wallet} title="최종 평가금" value={`$${formatUsd(result?.finalEquity)}`} caption={`초기 $${formatUsd(settings.initialCash)}`} />
            <StatCard icon={Gauge} title="총 수익률" value={formatPct(result?.totalReturn)} caption="수수료·슬리피지 반영" tone={Number(result?.totalReturn ?? 0) >= 0 ? "good" : "bad"} />
            <StatCard icon={ShieldAlert} title="최대 낙폭" value={formatPct(result?.maxDrawdown)} caption="MDD" tone="bad" />
            <StatCard icon={Activity} title="승률" value={result?.winRate === null || result?.winRate === undefined ? "--" : `${result.winRate.toFixed(1)}%`} caption={`승 ${result?.wins ?? 0} / 패 ${result?.losses ?? 0}`} />
            <StatCard icon={BarChart3} title="체결 횟수" value={String(result?.trades.length ?? "--")} caption={`청산 ${result?.sellCount ?? 0}회`} />
            <StatCard icon={CalendarClock} title="총 수수료" value={`$${formatUsd(result?.totalFees)}`} caption="가정값 기준" />
          </div>

          <div className="panel trades-panel">
            <div className="panel-head">
              <div>
                <h2>체결 내역</h2>
                <p>최근 체결 18건</p>
              </div>
            </div>
            <div className="trade-list">
              {recentTrades.length ? recentTrades.map((trade) => (
                <div className="trade-row" key={`${trade.side}-${trade.time}-${trade.price}`}>
                  <span className={trade.side === "LONG" ? "buy" : "sell"}>{trade.side}</span>
                  <span>{new Date(trade.time * 1000).toLocaleString()}</span>
                  <span>${formatUsd(trade.price)}</span>
                  <span>{trade.pnlPct === null || trade.pnlPct === undefined ? "--" : formatPct(trade.pnlPct)}</span>
                </div>
              )) : <div className="empty-list">아직 체결 내역이 없습니다.</div>}
            </div>
          </div>
        </section>
      </section>
      <AiBotSimulationPanel settings={settings} />
      <TestnetPanel settings={settings} />
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
