import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, BarChart3, CalendarClock, Gauge, Play, ShieldAlert, Wallet } from "lucide-react";
import "./styles.css";

const BINANCE_BASE = "https://api.binance.com/api/v3/klines";
const BINANCE_LIMIT = 1000;
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
  { value: 2, label: "롱만", description: "아랫꼬리 롱만" },
  { value: 3, label: "숏만", description: "윗꼬리 숏만" },
  { value: 4, label: "신중", description: "꼬리 후 다음봉 확인" },
];
const INTERVALS = [
  { value: "1m", label: "1분봉", ms: 60_000 },
  { value: "5m", label: "5분봉", ms: 5 * 60_000 },
  { value: "15m", label: "15분봉", ms: 15 * 60_000 },
  { value: "1h", label: "1시간봉", ms: 60 * 60_000 },
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

async function fetchHistoricalCandles({ interval, days }) {
  const timeframe = INTERVALS.find((item) => item.value === interval) ?? INTERVALS[2];
  const endTime = Date.now();
  let startTime = endTime - Number(days) * 24 * 60 * 60 * 1000;
  const candles = [];

  while (startTime < endTime) {
    const url = new URL(BINANCE_BASE);
    url.searchParams.set("symbol", "BTCUSDT");
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

  return candles.filter((candle, index, rows) => index === 0 || candle.time !== rows[index - 1].time);
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

function buildGagokDecision({ candles, index, entryPrice, positionSide, buyStrategy, takeProfitPct, stopLossPct }) {
  const candle = candles[index];
  const previous = candles[index - 1];
  const price = candle.close;
  const wick = analyzeWick(candle);
  const previousWick = previous ? analyzeWick(previous) : null;
  const strategy = Number(buyStrategy);
  const allowLong = strategy === 1 || strategy === 2 || strategy === 4;
  const allowShort = strategy === 1 || strategy === 3 || strategy === 4;
  const isConfirmLong = Boolean(previousWick?.hasLower && candle.close > candle.open);
  const isConfirmShort = Boolean(previousWick?.hasUpper && candle.close < candle.open);

  if (entryPrice && positionSide) {
    const pnl = positionSide === "LONG" ? ((price - entryPrice) / entryPrice) * 100 : ((entryPrice - price) / entryPrice) * 100;
    if (pnl >= Number(takeProfitPct)) return { side: `CLOSE_${positionSide}`, score: 5, reason: `익절 ${pnl.toFixed(2)}%` };
    if (Number(stopLossPct) > 0 && pnl <= -Number(stopLossPct)) return { side: `CLOSE_${positionSide}`, score: 5, reason: `손절 ${pnl.toFixed(2)}%` };
    return { side: "HOLD", score: 0, reason: `${positionSide} 보유 ${pnl.toFixed(2)}%` };
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
  let cash = Number(settings.initialCash);
  let positionAmount = 0;
  let positionSide = null;
  let marginUsed = 0;
  let entryPrice = null;
  let peakEquity = cash;
  let maxDrawdown = 0;
  const trades = [];
  const equityCurve = [];

  candles.forEach((candle, index) => {
    if (index < 80) return;
    const price = candle.close;
    const decision = buildGagokDecision({
      candles,
      index,
      entryPrice,
      positionSide,
      buyStrategy: settings.buyStrategy,
      takeProfitPct: settings.takeProfitPct,
      stopLossPct: settings.stopLossPct,
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
    } else if (decision.side.startsWith("CLOSE") && positionAmount > 0) {
      const fillPrice = positionSide === "LONG" ? price * (1 - slippage) : price * (1 + slippage);
      const gross = positionAmount * fillPrice;
      const fee = gross * feeRate;
      const cost = positionAmount * entryPrice;
      const pnl = (positionSide === "LONG" ? gross - cost : cost - gross) - fee;
      const pnlPct = marginUsed ? (pnl / marginUsed) * 100 : 0;
      cash += marginUsed + pnl;
      trades.push({
        side: decision.side,
        time: candle.time,
        price: fillPrice,
        amount: positionAmount,
        fee,
        pnl,
        pnlPct,
        reason: decision.reason,
      });
      positionAmount = 0;
      positionSide = null;
      marginUsed = 0;
      entryPrice = null;
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
  const exits = trades.filter((trade) => trade.side.startsWith("CLOSE"));
  const wins = exits.filter((trade) => trade.pnl > 0).length;
  const losses = exits.filter((trade) => trade.pnl < 0).length;
  return {
    candles,
    trades,
    equityCurve,
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

function BacktestChart({ result }) {
  const width = 980;
  const height = 360;
  const candles = result?.candles ?? [];
  const visible = candles.slice(-260);
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
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="BTCUSDT backtest chart">
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
  const lastDecision = testnetDetail?.decision?.side ?? "READY";
  const statusTone = testnetStatus.startsWith("실패") ? "bad" : lastDecision === "BUY" || lastDecision === "SELL" ? "good" : "neutral";

  async function invokeTestnet(action, quiet = false) {
    if (!canInvoke) {
      setTestnetStatus(".env.local에 VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY가 필요합니다.");
      return;
    }

    setTestnetLoading(true);
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
          symbol: "BTCUSDT",
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
      setTestnetStatus(`실패: ${error.message}`);
    } finally {
      setTestnetLoading(false);
    }
  }

  useEffect(() => {
    if (canInvoke) {
      invokeTestnet("check", true);
      invokeTestnet("events", true);
    }
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
            <div><span>심볼</span><strong>BTCUSDT</strong></div>
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
              <strong>15분마다</strong>
            </div>
            <div>
              <span>주문 모드</span>
              <strong>{testnetDetail?.dryRun ? "Dry-run" : "Testnet"}</strong>
            </div>
            <div>
              <span>적용 전략</span>
              <strong>{appliedSettings ? `${appliedSettings.interval} · ${appliedSettings.leverage}x` : "확인 전"}</strong>
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
            <p>Supabase Cron과 수동 적용에서 발생한 최근 로그입니다.</p>
          </div>
          <button className="refresh-status-button compact" type="button" disabled={!canInvoke || testnetLoading} onClick={() => invokeTestnet("events")}>새로고침</button>
        </div>
        <div className="testnet-event-list">
          {testnetEvents.length ? testnetEvents.map((event) => {
            const decision = event.payload?.decision;
            const order = event.payload?.order;
            const close = event.payload?.latestClose;
            return (
              <div className="testnet-event-row" key={event.id}>
                <span className={`event-type ${(decision?.side ?? event.event_type).toLowerCase()}`}>{decision?.side ?? event.event_type}</span>
                <div>
                  <strong>{event.message}</strong>
                  <small>{new Date(event.created_at).toLocaleString()} · {close ? `$${formatUsd(close)}` : "가격 --"} · {order ? "주문신호 있음" : "주문 없음"}</small>
                </div>
              </div>
            );
          }) : <div className="empty-list">아직 테스트넷 실행 내역이 없습니다.</div>}
        </div>
      </div>
    </section>
  );
}

function App() {
  const [settings, setSettings] = useState({
    interval: "15m",
    days: 90,
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

  function updateSetting(key, value) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  async function handleRun() {
    setLoading(true);
    setStatus("Binance BTCUSDT 과거 캔들을 가져오는 중...");
    try {
      const candles = await fetchHistoricalCandles({ interval: settings.interval, days: settings.days });
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
          <p>Binance BTCUSDT 과거 캔들로 15분봉 평균회귀 전략을 빠르게 검증합니다.</p>
        </div>
        <button className="run-button" onClick={handleRun} disabled={loading}>
          <Play size={18} />
          {loading ? "계산 중" : "백테스트 실행"}
        </button>
      </header>

      <section className="workspace">
        <aside className="panel controls">
          <h2>입력값</h2>
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
              <option value={90}>최근 90일</option>
              <option value={180}>최근 180일</option>
              <option value={365}>최근 1년</option>
            </select>
          </label>
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
          <div className="control-group">
            <span>익절률</span>
            <div className="segmented-control">
              {TAKE_PROFIT_OPTIONS.map((value) => (
                <button
                  key={value}
                  className={settings.takeProfitPct === value ? "active" : ""}
                  type="button"
                  onClick={() => updateSetting("takeProfitPct", value)}
                >
                  {value}%
                </button>
              ))}
            </div>
          </div>
          <div className="control-group">
            <span>손절률</span>
            <div className="segmented-control">
              {STOP_LOSS_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={settings.stopLossPct === option.value ? "active" : ""}
                  type="button"
                  onClick={() => updateSetting("stopLossPct", option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="strategy-note">
            <strong>전략</strong>
            <span>15분봉 꼬리 반전: 윗꼬리 기준 충족 시 숏, 아랫꼬리 기준 충족 시 롱, 익절/손절 0.2%</span>
          </div>
        </aside>

        <section className="main-grid">
          <div className="panel chart-panel">
            <div className="panel-head">
              <div>
                <h2>BTCUSDT 과거 차트</h2>
                <p>{status}</p>
              </div>
              <div className="source-pill">Binance API</div>
            </div>
            <BacktestChart result={result} />
          </div>

          <div className="stats-grid">
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
      <TestnetPanel settings={settings} />
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
