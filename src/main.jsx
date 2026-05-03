import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, BarChart3, CalendarClock, Gauge, Play, ShieldAlert, Wallet } from "lucide-react";
import "./styles.css";

const BINANCE_BASE = "https://api.binance.com/api/v3/klines";
const BINANCE_LIMIT = 1000;
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

function buildGagokDecision({ candles, index, entryPrice }) {
  const closes = candles.map((candle) => candle.close);
  const dailyCloses = candles.filter((_, itemIndex) => itemIndex % 96 === 0).map((candle) => candle.close);
  const price = closes[index];
  const prev = candles[index - 1] ?? candles[index];
  const rsi14 = rsi(closes.slice(0, index + 1)).at(-1);
  const ema20 = ema(closes.slice(0, index + 1), 20).at(-1);
  const ema60 = ema(closes.slice(0, index + 1), 60).at(-1);
  const band = bollinger(closes.slice(0, index + 1), 20, 2).at(-1);
  const ma20 = sma(dailyCloses, 20).at(-1);
  const pnl = entryPrice ? ((price - entryPrice) / entryPrice) * 100 : null;
  const rebound = band ? prev.close < band.lower && price >= band.lower : false;
  const ma20Gap = ma20 ? ((price - ma20) / ma20) * 100 : null;
  const buyReasons = [];
  const sellReasons = [];
  let buyScore = 0;
  let sellScore = 0;

  if (rsi14) {
    if (rsi14 <= 38) {
      buyScore += 3;
      buyReasons.push(`RSI ${rsi14.toFixed(1)} 과매도`);
    } else if (rsi14 <= 52) {
      buyScore += 1;
      buyReasons.push(`RSI ${rsi14.toFixed(1)} 진입 후보`);
    }
    if (rsi14 >= 70) {
      sellScore += 2;
      sellReasons.push(`RSI ${rsi14.toFixed(1)} 과열`);
    }
  }

  if (band) {
    if (price <= band.lower * 1.006) {
      buyScore += 2;
      buyReasons.push("볼린저 하단 근접");
    }
    if (rebound) {
      buyScore += 2;
      buyReasons.push("볼린저 하단 이탈 후 회복");
    }
    if (price >= band.upper * 0.996) {
      sellScore += 2;
      sellReasons.push("볼린저 상단 근접");
    }
  }

  if (ema20 && ema60) {
    if (price >= ema60 * 0.985 && ema20 >= ema60 * 0.99) {
      buyScore += 1;
      buyReasons.push("EMA 20/60 추세 허용");
    } else {
      sellScore += 1;
      sellReasons.push("EMA 20/60 추세 약화");
    }
  }

  if (ma20Gap !== null) {
    if (ma20Gap <= 10) buyScore += 1;
    else sellScore += 1;
  }

  if (pnl !== null) {
    if (pnl >= 1.0) {
      sellScore += 5;
      sellReasons.push(`익절 ${pnl.toFixed(2)}%`);
    } else if (pnl <= -0.7) {
      sellScore += 5;
      sellReasons.push(`손절 ${pnl.toFixed(2)}%`);
    }
  }

  if (entryPrice && sellScore >= 4) return { side: "SELL", score: sellScore, reason: sellReasons.join(", ") };
  if (!entryPrice && buyScore >= 4) return { side: "BUY", score: buyScore, reason: buyReasons.join(", ") };
  return { side: "WAIT", score: Math.max(buyScore, sellScore), reason: [...buyReasons, ...sellReasons].join(", ") };
}

function runBacktest(candles, settings) {
  const feeRate = Number(settings.feeRate) / 100;
  const slippage = Number(settings.slippage) / 100;
  let cash = Number(settings.initialCash);
  let btc = 0;
  let entryPrice = null;
  let peakEquity = cash;
  let maxDrawdown = 0;
  const trades = [];
  const equityCurve = [];

  candles.forEach((candle, index) => {
    if (index < 80) return;
    const price = candle.close;
    const decision = buildGagokDecision({ candles, index, entryPrice });

    if (decision.side === "BUY" && cash > 0) {
      const spend = cash * (Number(settings.positionPct) / 100);
      const fillPrice = price * (1 + slippage);
      const fee = spend * feeRate;
      const amount = (spend - fee) / fillPrice;
      cash -= spend;
      btc += amount;
      entryPrice = fillPrice;
      trades.push({
        side: "BUY",
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
      const proceeds = gross - fee;
      const cost = btc * entryPrice;
      const pnl = proceeds - cost;
      const pnlPct = entryPrice ? ((fillPrice - entryPrice) / entryPrice) * 100 - Number(settings.feeRate) * 2 : 0;
      cash += proceeds;
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
      entryPrice = null;
    }

    const equity = cash + btc * price;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.min(maxDrawdown, ((equity - peakEquity) / peakEquity) * 100);
    equityCurve.push({ time: candle.time, equity });
  });

  const lastPrice = candles.at(-1)?.close ?? 0;
  const finalEquity = cash + btc * lastPrice;
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
          <circle cx={xAt(trade.time)} cy={yAt(trade.price)} r="5" fill={trade.side === "BUY" ? "#38bdf8" : "#fbbf24"} />
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

function App() {
  const [settings, setSettings] = useState({
    interval: "15m",
    days: 90,
    initialCash: 50000,
    feeRate: 0.04,
    slippage: 0.02,
    positionPct: 95,
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
            진입 비중 %
            <input type="number" value={settings.positionPct} onChange={(event) => updateSetting("positionPct", Number(event.target.value))} />
          </label>
          <label>
            수수료 %
            <input type="number" step="0.01" value={settings.feeRate} onChange={(event) => updateSetting("feeRate", Number(event.target.value))} />
          </label>
          <label>
            슬리피지 %
            <input type="number" step="0.01" value={settings.slippage} onChange={(event) => updateSetting("slippage", Number(event.target.value))} />
          </label>
          <div className="strategy-note">
            <strong>전략</strong>
            <span>RSI(14), Bollinger(20,2), EMA 20/60, 익절 +1.0%, 손절 -0.7%, 전량 청산</span>
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
                  <span className={trade.side === "BUY" ? "buy" : "sell"}>{trade.side}</span>
                  <span>{new Date(trade.time * 1000).toLocaleString()}</span>
                  <span>${formatUsd(trade.price)}</span>
                  <span>{trade.pnlPct === null || trade.pnlPct === undefined ? "--" : formatPct(trade.pnlPct)}</span>
                </div>
              )) : <div className="empty-list">아직 체결 내역이 없습니다.</div>}
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
