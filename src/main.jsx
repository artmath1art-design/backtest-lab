import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, BarChart3, CalendarClock, Database, Gauge, KeyRound, Play, ServerCog, ShieldAlert, Wallet } from "lucide-react";
import "./styles.css";

const BINANCE_BASE = "https://api.binance.com/api/v3/klines";
const BINANCE_LIMIT = 1000;
const RSI_OVERBOUGHT = 80;
const RSI_OVERSOLD = 20;
const TAKE_PROFIT_OPTIONS = [1, 2, 3, 4, 5];
const STOP_LOSS_OPTIONS = [
  { value: 0, label: "노손절" },
  { value: 1, label: "1%" },
  { value: 2, label: "2%" },
  { value: 3, label: "3%" },
  { value: 4, label: "4%" },
  { value: 5, label: "5%" },
];
const LEVERAGE_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20];
const BUY_STRATEGIES = [
  { value: 1, label: "1", description: "중단 풀매수" },
  { value: 2, label: "2", description: "중단/하단 반반" },
  { value: 3, label: "3", description: "중단/하단/하단-1%" },
];
const TESTNET_TASKS = [
  { icon: Database, title: "Supabase 프로젝트", body: "bot_runs, bot_events 테이블 생성 후 실행 로그를 저장합니다." },
  { icon: KeyRound, title: "시크릿 등록", body: "Binance Futures Testnet API Key/Secret은 Edge Function 환경변수로만 보관합니다." },
  { icon: ServerCog, title: "Edge Function", body: "캔들 조회, 신호 계산, 포지션 확인, 테스트넷 주문 요청을 서버에서 처리합니다." },
  { icon: ShieldAlert, title: "안전장치", body: "테스트넷 전용, 1캔들 1회 실행, 중복 진입 방지, 최대 포지션 1개로 제한합니다." },
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

function buildGagokDecision({ candles, index, entryPrice, entryStage, buyStrategy, takeProfitPct, stopLossPct }) {
  const closes = candles.map((candle) => candle.close);
  const historicalCloses = closes.slice(0, index + 1);
  const price = closes[index];
  const prev = candles[index - 1] ?? candles[index];
  const rsiSeries = rsi(historicalCloses, 14);
  const rsi14 = rsi(historicalCloses, 14).at(-1);
  const prevRsi14 = rsiSeries.at(-2);
  const bands = bollinger(historicalCloses, 20, 2);
  const band = bands.at(-1);
  const pnl = entryPrice ? ((price - entryPrice) / entryPrice) * 100 : null;
  const middleGap = band ? Math.abs(price - band.middle) / band.middle : null;
  const isMiddleTouch = middleGap !== null && middleGap <= 0.003;
  const isMiddleRecovery = Boolean(band && prev.close < band.middle && price >= band.middle);
  const isLowerTouch = Boolean(band && price <= band.lower * 1.003);
  const isLowerMinusOneTouch = Boolean(band && price <= band.lower * 0.99);
  const isRsiTurning = Boolean(rsi14 && prevRsi14 && rsi14 >= prevRsi14);
  const takeProfit = entryPrice ? entryPrice * (1 + Number(takeProfitPct) / 100) : null;
  const stopLoss = entryPrice && Number(stopLossPct) > 0 ? entryPrice * (1 - Number(stopLossPct) / 100) : null;
  const buyReasons = [];
  const sellReasons = [];
  let buyScore = 0;
  let sellScore = 0;

  if (entryStage === 0) {
    if (rsi14 && rsi14 <= 55) {
      buyScore += 2;
      buyReasons.push(`RSI(14) ${rsi14.toFixed(1)}`);
    }
    if (isRsiTurning) {
      buyScore += 1;
      buyReasons.push("RSI 반등");
    }
    if (isMiddleTouch || isMiddleRecovery) {
      buyScore += 2;
      buyReasons.push(isMiddleRecovery ? "볼린저 중단선 회복" : "볼린저 중단선 근접");
    }

    if (buyScore >= 4) return { side: buyStrategy === 1 ? "BUY_FULL" : "BUY_1", score: buyScore, reason: buyReasons.join(", ") };
    return { side: "WAIT", score: buyScore, reason: buyReasons.join(", ") };
  }

  if (entryStage === 1 && buyStrategy >= 2) {
    if (rsi14 && rsi14 <= 40) {
      buyScore += 2;
      buyReasons.push(`RSI(14) ${rsi14.toFixed(1)} 과매도`);
    }
    if (isLowerTouch) {
      buyScore += 3;
      buyReasons.push("볼린저 하단 터치");
    }

    if (buyScore >= 3) return { side: "BUY_2", score: buyScore, reason: buyReasons.join(", ") };
  }

  if (entryStage === 2 && buyStrategy === 3) {
    if (rsi14 && rsi14 <= 35) {
      buyScore += 2;
      buyReasons.push(`RSI(14) ${rsi14.toFixed(1)} 깊은 과매도`);
    }
    if (isLowerMinusOneTouch) {
      buyScore += 3;
      buyReasons.push("볼린저 하단 -1% 터치");
    }

    if (buyScore >= 3) return { side: "BUY_3", score: buyScore, reason: buyReasons.join(", ") };
  }

  if (entryPrice) {
    if (takeProfit !== null && price >= takeProfit) {
      sellScore += 5;
      sellReasons.push(`익절 ${pnl?.toFixed(2)}%`);
    }
    if (stopLoss !== null && price <= stopLoss) {
      sellScore += 5;
      sellReasons.push(`손절 ${pnl?.toFixed(2)}%`);
    }
  }

  if (sellScore >= 4) return { side: "SELL", score: sellScore, reason: sellReasons.join(", ") };
  return { side: "WAIT", score: Math.max(buyScore, sellScore), reason: [...buyReasons, ...sellReasons].join(", ") };
}

function runBacktest(candles, settings) {
  const feeRate = Number(settings.feeRate) / 100;
  const slippage = Number(settings.slippage) / 100;
  const leverage = Number(settings.leverage) || 1;
  let cash = Number(settings.initialCash);
  let btc = 0;
  let marginUsed = 0;
  let entryPrice = null;
  let entryStage = 0;
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
      entryStage,
      buyStrategy: settings.buyStrategy,
      takeProfitPct: settings.takeProfitPct,
      stopLossPct: settings.stopLossPct,
    });

    if (decision.side.startsWith("BUY") && cash > 0) {
      const buyStrategy = Number(settings.buyStrategy);
      const spendRatio = buyStrategy === 1 ? 1 : buyStrategy === 2 ? 0.5 : 1 / 3;
      const margin = Math.min(cash, Number(settings.initialCash) * spendRatio);
      const notional = margin * leverage;
      const fillPrice = price * (1 + slippage);
      const fee = notional * feeRate;
      const amount = notional / fillPrice;
      const previousCost = btc * (entryPrice ?? 0);
      cash -= margin + fee;
      marginUsed += margin;
      btc += amount;
      entryPrice = (previousCost + amount * fillPrice) / btc;
      entryStage = decision.side === "BUY_FULL" ? 3 : decision.side === "BUY_1" ? 1 : decision.side === "BUY_2" ? 2 : 3;
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
    } else if (decision.side === "SELL" && btc > 0) {
      const fillPrice = price * (1 - slippage);
      const gross = btc * fillPrice;
      const fee = gross * feeRate;
      const cost = btc * entryPrice;
      const pnl = gross - cost - fee;
      const pnlPct = marginUsed ? (pnl / marginUsed) * 100 : 0;
      cash += marginUsed + pnl;
      trades.push({
        side: "SELL",
        time: candle.time,
        price: fillPrice,
        amount: btc,
        fee,
        pnl,
        pnlPct,
        reason: decision.reason,
      });
      btc = 0;
      marginUsed = 0;
      entryPrice = null;
      entryStage = 0;
    }

    const equity = cash + (btc > 0 && entryPrice ? marginUsed + btc * (price - entryPrice) : 0);
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.min(maxDrawdown, ((equity - peakEquity) / peakEquity) * 100);
    equityCurve.push({ time: candle.time, equity });
  });

  const lastPrice = candles.at(-1)?.close ?? 0;
  const finalEquity = cash + (btc > 0 && entryPrice ? marginUsed + btc * (lastPrice - entryPrice) : 0);
  const sells = trades.filter((trade) => trade.side === "SELL");
  const wins = sells.filter((trade) => trade.pnl > 0).length;
  const losses = sells.filter((trade) => trade.pnl < 0).length;
  return {
    candles,
    trades,
    equityCurve,
    finalEquity,
    totalReturn: ((finalEquity - Number(settings.initialCash)) / Number(settings.initialCash)) * 100,
    maxDrawdown,
    wins,
    losses,
    winRate: sells.length ? (wins / sells.length) * 100 : null,
    sellCount: sells.length,
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
          <circle cx={xAt(trade.time)} cy={yAt(trade.price)} r="5" fill={trade.side.startsWith("BUY") ? "#38bdf8" : "#fbbf24"} />
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
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const canInvoke = Boolean(supabaseUrl && publishableKey);
  const diagnostics = testnetDetail?.decision?.diagnostics;

  async function invokeTestnet(action) {
    if (!canInvoke) {
      setTestnetStatus(".env.local에 VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY가 필요합니다.");
      return;
    }

    setTestnetLoading(true);
    setTestnetStatus(action === "check" ? "Supabase Edge Function 연결 확인 중..." : "테스트넷 전략 1회 실행 중...");
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
      setTestnetStatus(action === "check" ? `연결 확인 완료: dry-run ${data.dryRun ? "ON" : "OFF"}` : `${data.decision?.side}: ${data.decision?.reason}`);
    } catch (error) {
      setTestnetStatus(`실패: ${error.message}`);
    } finally {
      setTestnetLoading(false);
    }
  }

  return (
    <section className="panel testnet-panel">
      <div className="panel-head">
        <div>
          <h2>Supabase Binance 테스트넷</h2>
          <p>현재 백테스트 전략을 Supabase Edge Function으로 옮겨 테스트넷에서 운영하기 위한 준비 섹션입니다.</p>
        </div>
        <div className="source-pill">Testnet Ready</div>
      </div>

      <div className="testnet-layout">
        <div className="testnet-summary">
          <div className="summary-title">적용할 전략</div>
          <div className="summary-grid">
            <span>심볼</span><strong>BTCUSDT</strong>
            <span>봉 기준</span><strong>{settings.interval}</strong>
            <span>매수</span><strong>{buyStrategy?.description ?? "-"}</strong>
            <span>레버리지</span><strong>{settings.leverage}x</strong>
            <span>익절</span><strong>{settings.takeProfitPct}%</strong>
            <span>손절</span><strong>{stopLossLabel}</strong>
          </div>
        </div>

        <div className="testnet-actions">
          <button type="button" disabled={!canInvoke || testnetLoading} onClick={() => invokeTestnet("check")}>연결 확인</button>
          <button type="button" disabled={!canInvoke || testnetLoading} onClick={() => invokeTestnet("run-once")}>1회 실행</button>
          <button type="button" disabled>자동 운영 시작</button>
          <button type="button" disabled>중지</button>
          <p>{testnetStatus}</p>
        </div>
      </div>

      {diagnostics ? (
        <div className="diagnostic-panel">
          <div className="summary-title">마지막 신호 상세</div>
          <div className="diagnostic-grid">
            <span>현재가</span><strong>${formatUsd(diagnostics.price)}</strong>
            <span>RSI(14)</span><strong>{diagnostics.rsi14?.toFixed?.(1) ?? "--"}</strong>
            <span>직전 RSI</span><strong>{diagnostics.previousRsi14?.toFixed?.(1) ?? "--"}</strong>
            <span>볼밴 중단</span><strong>${formatUsd(diagnostics.bollinger?.middle)}</strong>
            <span>중단 이격</span><strong>{formatPct(diagnostics.middleGapPct, 2)}</strong>
            <span>하단 이격</span><strong>{formatPct(diagnostics.lowerGapPct, 2)}</strong>
            <span>포지션</span><strong>{Number(diagnostics.positionAmount ?? 0).toFixed(3)} BTC</strong>
            <span>진입가</span><strong>{diagnostics.entryPrice ? `$${formatUsd(diagnostics.entryPrice)}` : "--"}</strong>
            <span>점수</span><strong>{diagnostics.score ?? "--"} / 5</strong>
          </div>
          <div className="check-grid">
            <div className={diagnostics.checks?.rsiUnder55 ? "pass" : ""}>RSI 55 이하 <strong>{diagnostics.scoreParts?.rsi ?? 0}점</strong></div>
            <div className={diagnostics.checks?.rsiTurningUp ? "pass" : ""}>RSI 반등 <strong>{diagnostics.scoreParts?.rsiTurn ?? 0}점</strong></div>
            <div className={diagnostics.checks?.middleTouch || diagnostics.checks?.middleRecovery ? "pass" : ""}>볼밴 중단 근접/회복 <strong>{diagnostics.scoreParts?.bollingerMiddle ?? 0}점</strong></div>
          </div>
        </div>
      ) : null}

      <div className="testnet-tasks">
        {TESTNET_TASKS.map(({ icon: Icon, title, body }) => (
          <div className="testnet-task" key={title}>
            <Icon size={18} />
            <div>
              <strong>{title}</strong>
              <span>{body}</span>
            </div>
          </div>
        ))}
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
    buyStrategy: 2,
    leverage: 1,
    takeProfitPct: 1,
    stopLossPct: 1,
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
            <span>RSI(14) + Bollinger(20,2): 선택 매수전략과 레버리지로 진입, 평균단가 기준 선택 익절/손절</span>
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
                  <span className={trade.side.startsWith("BUY") ? "buy" : "sell"}>{trade.side}</span>
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
