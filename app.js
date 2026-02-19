const DEFAULT_STARTING_EQUITY = 10000;
const DEFAULT_BET_SIZE = 100;
const PERFORMANCE_START_ISO = "2025-01-01";
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TRADE_LOG_PAGE_SIZE = 25;

const BACKTEST_STRATEGIES = [
  {
    id: "time_add20_1230_1430",
    label: "Time Add 20% (12:30, 14:30)",
    file: "./reports/cp12_continuous_backtest_100usd_add20_1230_add20_1430_futgtcp2.trades.csv",
    pnlColumns: ["new_total_pnl_usd", "pnl_usd_100", "base_pnl_usd"]
  }
];

const MC_FILES = {
  stats: "./reports/mc_1y_time_add20_stats.csv",
  paths: "./reports/mc_trade_by_trade_p1_p5_p95_paths.csv",
  percentiles: "./reports/mc_1y_time_add20_equity_percentiles.csv"
};

let equityChartRef = null;
let mcPathChartRef = null;
let tradeLogCurrentPage = 1;
let currentInitialCapital = DEFAULT_STARTING_EQUITY;
let currentBetSize = DEFAULT_BET_SIZE;
let currentAssetFilter = "both";

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    const row = {};
    headers.forEach((key, index) => {
      row[key] = values[index] ?? "";
    });
    return row;
  });
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function toBool(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function fmtCurrency(value) {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2
  }).format(value);
}

function fmtPercent(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(digits)}%`;
}

function fmtNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return "-";
  return value.toFixed(digits);
}

function setTextById(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
}

function dayDiffIso(startIso, endIso) {
  const start = parseIsoAsUtcDate(startIso);
  const end = parseIsoAsUtcDate(endIso);
  if (!start || !end) return NaN;
  return Math.max(Math.round((end.getTime() - start.getTime()) / 86400000), 0);
}

function toIsoDateString(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "";
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseUtcTimestamp(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function getPerformanceWindow() {
  const startDate = new Date(`${PERFORMANCE_START_ISO}T00:00:00Z`);
  const now = new Date();
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
  return { startDate, endDate };
}

async function fetchCsv(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${path}: HTTP ${response.status}`);
  }
  return parseCsv(await response.text());
}

function monthKeyFromUtc(value) {
  if (!value) return "";
  return String(value).slice(0, 7);
}

function formatMarketTraded(row) {
  const asset = String(row.asset || "").trim().toUpperCase();
  const rawDate = row.market_end_time_utc || row.entry_time_utc;
  const parsed = rawDate ? new Date(rawDate) : null;
  const prettyDate = parsed && Number.isFinite(parsed.getTime())
    ? parsed.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
    : String(rawDate || "").slice(0, 10);
  if (asset && prettyDate) return `${asset} Up or Down on ${prettyDate}`;
  return row.slug || `${asset} ${row.market_id || ""}`.trim() || "Unknown";
}

function computeCagr(periodStart, periodEnd, endingEquity, startingEquity = DEFAULT_STARTING_EQUITY) {
  const startTs = new Date(periodStart).getTime();
  const endTs = new Date(periodEnd).getTime();
  const days = Number.isFinite(startTs) && Number.isFinite(endTs) ? Math.max((endTs - startTs) / 86400000, 1) : 1;
  const growth = endingEquity / startingEquity;
  if (!Number.isFinite(growth) || growth <= 0) return NaN;
  return (Math.pow(growth, 365 / days) - 1) * 100;
}

function computeCagrFromEquity(periodStart, periodEnd, startEquity, endEquity) {
  const startTs = new Date(periodStart).getTime();
  const endTs = new Date(periodEnd).getTime();
  const days = Number.isFinite(startTs) && Number.isFinite(endTs) ? Math.max((endTs - startTs) / 86400000, 1) : 1;
  const growth = startEquity > 0 ? endEquity / startEquity : NaN;
  if (!Number.isFinite(growth) || growth <= 0) return NaN;
  return (Math.pow(growth, 365 / days) - 1) * 100;
}

function computeDisplayRateOfReturn(periodStart, periodEnd, startEquity, endEquity) {
  const startTs = new Date(periodStart).getTime();
  const endTs = new Date(periodEnd).getTime();
  const days = Number.isFinite(startTs) && Number.isFinite(endTs) ? Math.max((endTs - startTs) / 86400000, 1) : 1;
  if (!Number.isFinite(startEquity) || !Number.isFinite(endEquity) || startEquity <= 0) {
    return { label: "Rate of Return", valuePct: NaN };
  }

  if (days < 365) {
    const cumulativePct = ((endEquity - startEquity) / startEquity) * 100;
    return { label: "Cumulative Return", valuePct: cumulativePct };
  }

  const ageInYears = days / 365;
  const annualizedPct = (Math.pow(endEquity / startEquity, 1 / ageInYears) - 1) * 100;
  return { label: "Annualized Return (Compounded)", valuePct: annualizedPct };
}

function computeScaledTradeFromRow(row, pnlColumn, targetBetSize) {
  const addFraction = 0.2;
  const baseTargetStake = targetBetSize;
  const add1230Triggered = toBool(row.add20_1230_triggered);
  const add1430Triggered = toBool(row.add20_1430_triggered);
  const add1230TargetStake = add1230Triggered ? targetBetSize * addFraction : 0;
  const add1430TargetStake = add1430Triggered ? targetBetSize * addFraction : 0;

  const rawBaseStake = toNumber(row.base_stake_usd ?? row.stake_usd);
  const rawAdd1230Stake = toNumber(row.add20_1230_stake_usd);
  const rawAdd1430Stake = toNumber(row.add20_1430_stake_usd);
  const rawBasePnl = toNumber(row.base_pnl_usd);
  const rawAdd1230Pnl = toNumber(row.add20_1230_pnl_usd);
  const rawAdd1430Pnl = toNumber(row.add20_1430_pnl_usd);
  let scaledPnl = 0;
  let usedLegScaling = false;

  if (Number.isFinite(rawBasePnl) && Number.isFinite(rawBaseStake) && rawBaseStake > 0) {
    scaledPnl += rawBasePnl * (baseTargetStake / rawBaseStake);
    usedLegScaling = true;
  }

  if (add1230Triggered && Number.isFinite(rawAdd1230Pnl) && Number.isFinite(rawAdd1230Stake) && rawAdd1230Stake > 0) {
    scaledPnl += rawAdd1230Pnl * (add1230TargetStake / rawAdd1230Stake);
    usedLegScaling = true;
  }

  if (add1430Triggered && Number.isFinite(rawAdd1430Pnl) && Number.isFinite(rawAdd1430Stake) && rawAdd1430Stake > 0) {
    scaledPnl += rawAdd1430Pnl * (add1430TargetStake / rawAdd1430Stake);
    usedLegScaling = true;
  }

  if (!usedLegScaling) {
    const rawPnl = toNumber(row[pnlColumn]);
    const rawStake = toNumber(row.new_total_stake_usd ?? row.base_stake_usd ?? row.stake_usd);
    const scale = Number.isFinite(rawStake) && rawStake > 0 ? (baseTargetStake / rawStake) : (baseTargetStake / DEFAULT_BET_SIZE);
    scaledPnl = Number.isFinite(rawPnl) ? rawPnl * scale : NaN;
  }

  const targetTotalStake = baseTargetStake + add1230TargetStake + add1430TargetStake;
  const baseEntry = toNumber(row.entry_price);
  const add1230Entry = toNumber(row.add20_1230_entry_price);
  const add1430Entry = toNumber(row.add20_1430_entry_price);
  let weightedPriceSum = 0;
  let weightedStakeSum = 0;
  if (baseTargetStake > 0 && Number.isFinite(baseEntry)) {
    weightedPriceSum += baseEntry * baseTargetStake;
    weightedStakeSum += baseTargetStake;
  }
  if (add1230TargetStake > 0 && Number.isFinite(add1230Entry)) {
    weightedPriceSum += add1230Entry * add1230TargetStake;
    weightedStakeSum += add1230TargetStake;
  }
  if (add1430TargetStake > 0 && Number.isFinite(add1430Entry)) {
    weightedPriceSum += add1430Entry * add1430TargetStake;
    weightedStakeSum += add1430TargetStake;
  }

  return {
    pnlUsd: scaledPnl,
    totalStakeUsd: targetTotalStake,
    entryPrice: weightedStakeSum > 0 ? (weightedPriceSum / weightedStakeSum) : baseEntry
  };
}

function computeBacktestMetrics(label, rows, pnlColumn, startingEquity = DEFAULT_STARTING_EQUITY, targetBetSize = DEFAULT_BET_SIZE) {
  const { endDate: windowEnd } = getPerformanceWindow();
  const windowStartIso = PERFORMANCE_START_ISO;
  const windowEndIso = toIsoDateString(windowEnd);
  const extractIsoDate = (row) => String(row.market_end_time_utc || row.entry_time_utc || "").slice(0, 10);
  const sorted = [...rows].sort((a, b) => {
    const aDate = extractIsoDate(a);
    const bDate = extractIsoDate(b);
    if (aDate !== bDate) return String(aDate).localeCompare(String(bDate));
    return String(a.asset).localeCompare(String(b.asset));
  });
  const bounded = sorted.filter((row) => {
    const isoDate = extractIsoDate(row);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return false;
    return isoDate >= windowStartIso && isoDate <= windowEndIso;
  });

  let runningEquity = startingEquity;
  let maxEquity = startingEquity;
  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;
  let peakEquityForDd = startingEquity;
  let peakDateForDd = PERFORMANCE_START_ISO;
  let maxDdStartDate = "";
  let maxDdEndDate = "";
  let maxDdDurationDays = NaN;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLossAbs = 0;
  const equity = [];
  const labels = [];
  const drawdownPctSeries = [];
  const monthlyReturns = [];
  const addTriggerPattern = [];

  let currentMonth = "";
  let monthStartEquity = startingEquity;
  let monthPnl = 0;

  bounded.forEach((row, idx) => {
    const scaledTrade = computeScaledTradeFromRow(row, pnlColumn, targetBetSize);
    const pnl = scaledTrade.pnlUsd;
    if (!Number.isFinite(pnl)) return;
    addTriggerPattern.push({
      add1230: toBool(row.add20_1230_triggered),
      add1430: toBool(row.add20_1430_triggered)
    });

    const monthKey = monthKeyFromUtc(row.market_end_time_utc);
    if (!currentMonth) {
      currentMonth = monthKey;
      monthStartEquity = runningEquity;
    } else if (monthKey !== currentMonth) {
      monthlyReturns.push({
        monthKey: currentMonth,
        startEquity: monthStartEquity,
        pnl: monthPnl,
        returnPct: monthStartEquity !== 0 ? (monthPnl / monthStartEquity) * 100 : NaN
      });
      currentMonth = monthKey;
      monthStartEquity = runningEquity;
      monthPnl = 0;
    }

    monthPnl += pnl;
    runningEquity += pnl;
    maxEquity = Math.max(maxEquity, runningEquity);
    const rowDateIso = extractIsoDate(row);
    if (runningEquity >= peakEquityForDd) {
      peakEquityForDd = runningEquity;
      peakDateForDd = rowDateIso || peakDateForDd;
    }
    const drawdownUsd = maxEquity - runningEquity;
    maxDrawdownUsd = Math.max(maxDrawdownUsd, drawdownUsd);
    const drawdownPctAbs = peakEquityForDd > 0 ? (drawdownUsd / peakEquityForDd) * 100 : 0;
    if (drawdownPctAbs > maxDrawdownPct) {
      maxDrawdownPct = drawdownPctAbs;
      maxDrawdownUsd = drawdownUsd;
      maxDdStartDate = peakDateForDd;
      maxDdEndDate = rowDateIso;
      maxDdDurationDays = dayDiffIso(maxDdStartDate, maxDdEndDate);
    }
    const drawdownPct = -drawdownPctAbs;

    if (pnl >= 0) {
      wins += 1;
      grossProfit += pnl;
    } else {
      losses += 1;
      grossLossAbs += Math.abs(pnl);
    }

    labels.push((row.market_end_time_utc || `T${idx + 1}`).slice(0, 10));
    equity.push(runningEquity);
    drawdownPctSeries.push(drawdownPct);
  });

  if (currentMonth) {
    monthlyReturns.push({
      monthKey: currentMonth,
      startEquity: monthStartEquity,
      pnl: monthPnl,
      returnPct: monthStartEquity !== 0 ? (monthPnl / monthStartEquity) * 100 : NaN
    });
  }

  const trades = wins + losses;
  const netPnl = grossProfit - grossLossAbs;
  const profitFactor = grossLossAbs > 0 ? grossProfit / grossLossAbs : NaN;
  const winRatePct = trades > 0 ? (wins / trades) * 100 : NaN;
  const endingEquity = equity.length ? equity[equity.length - 1] : startingEquity;
  const cagrPct = computeCagr(
    bounded[0] ? extractIsoDate(bounded[0]) : windowStartIso,
    bounded[bounded.length - 1] ? extractIsoDate(bounded[bounded.length - 1]) : windowEndIso,
    endingEquity,
    startingEquity
  );
  const tradeLog = [...bounded]
    .map((row) => {
      const scaledTrade = computeScaledTradeFromRow(row, pnlColumn, targetBetSize);
      const pnl = scaledTrade.pnlUsd;
      const signal = String(row.signal || "").trim();
      const resolved = String(row.resolved_label || "").trim();
      let result = "Open";
      if (resolved && signal) result = resolved.toLowerCase() === signal.toLowerCase() ? "Win" : "Loss";
      else if (Number.isFinite(pnl)) result = pnl >= 0 ? "Win" : "Loss";

      return {
        date: String(row.market_end_time_utc || row.entry_time_utc || "").slice(0, 10),
        market: formatMarketTraded(row),
        direction: signal || "-",
        betSizeUsd: scaledTrade.totalStakeUsd,
        entryPrice: scaledTrade.entryPrice,
        result,
        pnlUsd: pnl
      };
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  return {
    label,
    startingEquity,
    betSizeUsd: targetBetSize,
    trades,
    wins,
    losses,
    netPnl,
    profitFactor,
    winRatePct,
    maxDrawdownUsd,
    maxDrawdownPct,
    maxDdStartDate,
    maxDdEndDate,
    maxDdDurationDays,
    endingEquity,
    cagrPct,
    equity,
    labels,
    drawdownPctSeries,
    monthlyReturns,
    tradeLog,
    addTriggerPattern,
    periodStart: PERFORMANCE_START_ISO,
    periodEnd: bounded[bounded.length - 1] ? extractIsoDate(bounded[bounded.length - 1]) : windowEndIso
  };
}

async function loadBacktestDatasets() {
  const loaded = await Promise.all(
    BACKTEST_STRATEGIES.map(async (config) => {
      try {
        const rows = await fetchCsv(config.file);
        if (!rows.length) return null;
        const headerKeys = Object.keys(rows[0]);
        const pnlColumn = config.pnlColumns.find((key) => headerKeys.includes(key));
        if (!pnlColumn) return null;
        return { label: config.label, rows, pnlColumn };
      } catch (error) {
        console.warn(`Skipping strategy ${config.label}:`, error.message);
        return null;
      }
    })
  );

  return loaded.filter(Boolean);
}

function computeBacktestsFromDatasets(backtestDatasets, startingEquity, targetBetSize) {
  const assetFilter = String(currentAssetFilter || "both").toLowerCase();
  const filterRows = (rows) => {
    if (assetFilter === "both") return rows;
    return rows.filter((row) => String(row.asset || "").trim().toLowerCase() === assetFilter);
  };

  return backtestDatasets.map((dataset) => computeBacktestMetrics(
    dataset.label,
    filterRows(dataset.rows),
    dataset.pnlColumn,
    startingEquity,
    targetBetSize
  ));
}

function renderDatasetWindow(metricsRows) {
  const starts = metricsRows.map((m) => m.periodStart).filter(Boolean).sort();
  const ends = metricsRows.map((m) => m.periodEnd).filter(Boolean).sort();
  const start = starts[0] ? starts[0].slice(0, 10) : "-";
  const end = ends.length ? ends[ends.length - 1].slice(0, 10) : "-";
  setTextById("datasetWindow", `Dataset window: ${start} to ${end}`);
}

function renderTopKpis(strategy) {
  const profitableMonths = strategy.monthlyReturns.filter((m) => m.returnPct > 0).length;
  const totalMonths = strategy.monthlyReturns.length;
  const maxDrawdownText = Number.isFinite(strategy.maxDrawdownPct)
    ? `-${fmtPercent(strategy.maxDrawdownPct, 1)}`
    : "-";
  const returnMetric = computeDisplayRateOfReturn(
    strategy.periodStart,
    strategy.periodEnd,
    strategy.startingEquity,
    strategy.endingEquity
  );
  const returnLabelEl = document.getElementById("rateOfReturnLabel");

  if (returnLabelEl) returnLabelEl.textContent = returnMetric.label;
  setTextById("annualReturn", fmtPercent(returnMetric.valuePct, 1));
  setTextById("maxDrawdown", maxDrawdownText);
  const maxDrawdownEl = document.getElementById("maxDrawdown");
  const maxDrawdownCard = maxDrawdownEl?.closest(".kpi-card");
  if (maxDrawdownEl) {
    const hasDdInfo = Number.isFinite(strategy.maxDrawdownUsd)
      && Number.isFinite(strategy.maxDdDurationDays)
      && strategy.maxDdStartDate
      && strategy.maxDdEndDate;
    if (hasDdInfo) {
      maxDrawdownEl.title = [
        `Amount: ${fmtCurrency(strategy.maxDrawdownUsd)}`,
        `Started: ${strategy.maxDdStartDate}`,
        `Ended: ${strategy.maxDdEndDate}`,
        `Duration: ${strategy.maxDdDurationDays} day${strategy.maxDdDurationDays === 1 ? "" : "s"}`
      ].join("\n");
      if (maxDrawdownCard) maxDrawdownCard.title = maxDrawdownEl.title;
    } else {
      maxDrawdownEl.removeAttribute("title");
      if (maxDrawdownCard) maxDrawdownCard.removeAttribute("title");
    }
  }
  setTextById("numTrades", strategy.trades.toLocaleString("en-US"));
  setTextById("winRate", fmtPercent(strategy.winRatePct, 1));
  setTextById("winMonths", `${profitableMonths}/${totalMonths}`);
  setTextById("profitFactor", fmtNumber(strategy.profitFactor, 2));
}

function buildMonthlyReturnsFromEquityPoints(points) {
  const monthlyReturns = [];
  if (!Array.isArray(points) || points.length < 2) return monthlyReturns;

  let currentMonth = "";
  let monthStartEquity = NaN;
  let monthPnl = 0;

  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    if (!Number.isFinite(prev.equity) || !Number.isFinite(curr.equity)) continue;
    const monthKey = monthKeyFromUtc(toIsoDateString(curr.date));
    const pnl = curr.equity - prev.equity;

    if (!currentMonth) {
      currentMonth = monthKey;
      monthStartEquity = prev.equity;
      monthPnl = 0;
    } else if (monthKey !== currentMonth) {
      monthlyReturns.push({
        monthKey: currentMonth,
        startEquity: monthStartEquity,
        pnl: monthPnl,
        returnPct: monthStartEquity !== 0 ? (monthPnl / monthStartEquity) * 100 : NaN
      });
      currentMonth = monthKey;
      monthStartEquity = prev.equity;
      monthPnl = 0;
    }

    monthPnl += pnl;
  }

  if (currentMonth) {
    monthlyReturns.push({
      monthKey: currentMonth,
      startEquity: monthStartEquity,
      pnl: monthPnl,
      returnPct: monthStartEquity !== 0 ? (monthPnl / monthStartEquity) * 100 : NaN
    });
  }

  return monthlyReturns;
}

function buildTopStatsFromEquitySeries(points) {
  const cleanPoints = (Array.isArray(points) ? points : [])
    .filter((p) => p?.date instanceof Date && Number.isFinite(p.date.getTime()) && Number.isFinite(p.equity))
    .sort((a, b) => a.date - b.date);

  if (cleanPoints.length < 2) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      netPnl: 0,
      maxDrawdownUsd: 0,
      maxDdStartDate: "",
      maxDdEndDate: "",
      maxDdDurationDays: NaN,
      endingEquity: NaN,
      cagrPct: NaN,
      maxDrawdownPct: NaN,
      winRatePct: NaN,
      profitFactor: NaN,
      monthlyReturns: [],
      periodStart: "",
      periodEnd: ""
    };
  }

  const startEquity = cleanPoints[0].equity;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLossAbs = 0;
  let peak = startEquity;
  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;
  let peakDate = toIsoDateString(cleanPoints[0].date);
  let maxDdStartDate = "";
  let maxDdEndDate = "";
  let maxDdDurationDays = NaN;

  for (let i = 1; i < cleanPoints.length; i += 1) {
    const currentEquity = cleanPoints[i].equity;
    const currentDateIso = toIsoDateString(cleanPoints[i].date);
    if (currentEquity >= peak) {
      peak = currentEquity;
      peakDate = currentDateIso || peakDate;
    }
    const ddUsd = peak - currentEquity;
    const ddPct = peak > 0 ? (ddUsd / peak) * 100 : 0;
    if (ddPct > maxDrawdownPct) {
      maxDrawdownPct = ddPct;
      maxDrawdownUsd = ddUsd;
      maxDdStartDate = peakDate;
      maxDdEndDate = currentDateIso;
      maxDdDurationDays = dayDiffIso(maxDdStartDate, maxDdEndDate);
    }
    const pnl = cleanPoints[i].equity - cleanPoints[i - 1].equity;
    if (!Number.isFinite(pnl)) continue;
    if (pnl >= 0) {
      wins += 1;
      grossProfit += pnl;
    } else {
      losses += 1;
      grossLossAbs += Math.abs(pnl);
    }
  }

  const trades = wins + losses;
  const periodStart = toIsoDateString(cleanPoints[0].date);
  const periodEnd = toIsoDateString(cleanPoints[cleanPoints.length - 1].date);
  const endingEquity = cleanPoints[cleanPoints.length - 1].equity;
  const netPnl = endingEquity - startEquity;
  const cagrPct = computeCagrFromEquity(
    periodStart,
    periodEnd,
    startEquity,
    endingEquity
  );

  return {
    trades,
    wins,
    losses,
    netPnl,
    maxDrawdownUsd,
    maxDdStartDate,
    maxDdEndDate,
    maxDdDurationDays,
    endingEquity,
    cagrPct,
    maxDrawdownPct,
    winRatePct: trades > 0 ? (wins / trades) * 100 : NaN,
    profitFactor: grossLossAbs > 0 ? grossProfit / grossLossAbs : NaN,
    monthlyReturns: buildMonthlyReturnsFromEquityPoints(cleanPoints),
    periodStart,
    periodEnd
  };
}

function parseIsoAsUtcDate(isoDate) {
  if (!isoDate) return null;
  const parsed = new Date(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function addUtcDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function buildBacktestEquityPoints(strategy) {
  return strategy.labels
    .map((label, idx) => {
      const date = parseIsoAsUtcDate(label);
      const equity = strategy.equity[idx];
      if (!date || !Number.isFinite(equity)) return null;
      return { date, equity };
    })
    .filter(Boolean)
    .sort((a, b) => a.date - b.date);
}

function buildMcSeriesFromPaths(mcPathRows, key) {
  const anchorDate = new Date("2025-01-01T00:00:00Z");
  return mcPathRows
    .map((row) => {
      const step = toNumber(row.trade_number);
      const equity = toNumber(row[key]);
      if (!Number.isFinite(step) || !Number.isFinite(equity)) return null;
      return { date: addUtcDays(anchorDate, step - 1), equity };
    })
    .filter(Boolean)
    .sort((a, b) => a.date - b.date);
}

function buildMcSeriesFromPathMidpoint(mcPathRows, lowKey, highKey) {
  const anchorDate = new Date("2025-01-01T00:00:00Z");
  return mcPathRows
    .map((row) => {
      const step = toNumber(row.trade_number);
      const low = toNumber(row[lowKey]);
      const high = toNumber(row[highKey]);
      if (!Number.isFinite(step) || !Number.isFinite(low) || !Number.isFinite(high)) return null;
      return { date: addUtcDays(anchorDate, step - 1), equity: low + (high - low) * 0.5 };
    })
    .filter(Boolean)
    .sort((a, b) => a.date - b.date);
}

function buildMcBackfillTradeTemplate(strategy) {
  const entryPrices = strategy.tradeLog.map((t) => toNumber(t.entryPrice)).filter(Number.isFinite);
  const avgEntryPrice = entryPrices.length ? entryPrices.reduce((acc, v) => acc + v, 0) / entryPrices.length : 0.5;
  return {
    // MC synthetic rows should always respect the configured base bet size input.
    avgBetSize: Math.max(currentBetSize, 1),
    avgEntryPrice: Math.min(Math.max(avgEntryPrice, 0.01), 0.99)
  };
}

function buildMcDailyDeltaMap(mcSeries) {
  const sorted = [...(Array.isArray(mcSeries) ? mcSeries : [])]
    .filter((p) => p?.date instanceof Date && Number.isFinite(p.date.getTime()) && Number.isFinite(p.equity))
    .sort((a, b) => a.date - b.date);
  const map = new Map();
  for (let i = 1; i < sorted.length; i += 1) {
    const iso = toIsoDateString(sorted[i].date);
    const delta = sorted[i].equity - sorted[i - 1].equity;
    if (iso && Number.isFinite(delta)) map.set(iso, delta);
  }
  return map;
}

function stitchBacktestWithMcBackfill(strategy, mcSeries, sourceLabel) {
  const { startDate: windowStart, endDate: windowEnd } = getPerformanceWindow();
  if (!Array.isArray(mcSeries) || mcSeries.length < 2) {
    return {
      ...strategy,
      label: `${strategy.label} + ${sourceLabel}`,
      topStatsLabel: sourceLabel
    };
  }

  const mcDeltaByDate = buildMcDailyDeltaMap(mcSeries);
  const historicalTradesAsc = [...strategy.tradeLog]
    .filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(String(t.date || "")))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const firstHistoricalIso = historicalTradesAsc[0]?.date || null;
  const historicalByDate = new Map();
  historicalTradesAsc.forEach((trade) => {
    const key = String(trade.date);
    if (!historicalByDate.has(key)) historicalByDate.set(key, []);
    historicalByDate.get(key).push(trade);
  });

  const stitchedPoints = [{ date: new Date(windowStart.getTime()), equity: strategy.startingEquity }];
  const combinedTradeEvents = [];
  let stitchedEquity = strategy.startingEquity;
  const tradeTemplate = buildMcBackfillTradeTemplate(strategy);
  const addPattern = Array.isArray(strategy.addTriggerPattern) ? strategy.addTriggerPattern : [];
  let syntheticIdx = 0;

  for (let day = new Date(windowStart.getTime()); day <= windowEnd; day = addUtcDays(day, 1)) {
    const dayIso = toIsoDateString(day);
    const historicalTrades = historicalByDate.get(dayIso) || [];

    if (historicalTrades.length) {
      historicalTrades.forEach((trade) => {
        const pnl = toNumber(trade.pnlUsd);
        if (!Number.isFinite(pnl)) return;
        stitchedEquity += pnl;
        stitchedPoints.push({ date: new Date(day.getTime()), equity: stitchedEquity });
        combinedTradeEvents.push(trade);
      });
      continue;
    }

    // MC backfill is allowed only before the backtest window starts.
    if (!firstHistoricalIso || dayIso >= firstHistoricalIso) continue;

    const rawDelta = mcDeltaByDate.get(dayIso);
    if (!Number.isFinite(rawDelta)) continue;
    const pattern = addPattern.length ? addPattern[syntheticIdx % addPattern.length] : null;
    const add1230 = Boolean(pattern?.add1230);
    const add1430 = Boolean(pattern?.add1430);
    const effectiveStakeMult = 1 + (add1230 ? 0.2 : 0) + (add1430 ? 0.2 : 0);
    const betSizeUsd = tradeTemplate.avgBetSize * effectiveStakeMult;
    const scaledDelta = rawDelta * effectiveStakeMult;
    const delta = Math.max(scaledDelta, -betSizeUsd);
    stitchedEquity += delta;
    stitchedPoints.push({ date: new Date(day.getTime()), equity: stitchedEquity });
    const direction = delta >= 0 ? "Up" : "Down";
    const inferredEntryFromPnl = delta >= 0 && betSizeUsd > 0 ? betSizeUsd / (betSizeUsd + delta) : NaN;
    const entryPrice = Number.isFinite(inferredEntryFromPnl)
      ? Math.min(Math.max(inferredEntryFromPnl, 0.01), 0.99)
      : tradeTemplate.avgEntryPrice;

    combinedTradeEvents.push({
      date: dayIso,
      market: `MC Backfill (${sourceLabel})`,
      direction,
      betSizeUsd,
      entryPrice,
      result: delta >= 0 ? "Win" : "Loss",
      pnlUsd: delta
    });
    syntheticIdx += 1;
  }

  const topStats = buildTopStatsFromEquitySeries(stitchedPoints);
  const combinedTradeLog = [...combinedTradeEvents].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const combinedWins = combinedTradeLog.filter((t) => t.result === "Win").length;
  const combinedLosses = combinedTradeLog.filter((t) => t.result === "Loss").length;
  const combinedTradeCount = combinedWins + combinedLosses;
  const combinedGrossProfit = combinedTradeLog
    .map((t) => toNumber(t.pnlUsd))
    .filter((v) => Number.isFinite(v) && v >= 0)
    .reduce((acc, v) => acc + v, 0);
  const combinedGrossLossAbs = combinedTradeLog
    .map((t) => toNumber(t.pnlUsd))
    .filter((v) => Number.isFinite(v) && v < 0)
    .reduce((acc, v) => acc + Math.abs(v), 0);
  const stitchedLabels = stitchedPoints.map((p) => toIsoDateString(p.date));
  const stitchedEquitySeries = stitchedPoints.map((p) => p.equity);
  const stitchedStart = stitchedLabels[0] || strategy.periodStart;
  const stitchedEnd = stitchedLabels[stitchedLabels.length - 1] || strategy.periodEnd;
  const endingEquity = stitchedEquity;
  const netPnl = endingEquity - strategy.startingEquity;

  return {
    ...strategy,
    ...topStats,
    trades: combinedTradeCount,
    wins: combinedWins,
    losses: combinedLosses,
    netPnl,
    endingEquity,
    winRatePct: combinedTradeCount > 0 ? (combinedWins / combinedTradeCount) * 100 : NaN,
    profitFactor: combinedGrossLossAbs > 0 ? combinedGrossProfit / combinedGrossLossAbs : NaN,
    labels: stitchedLabels,
    equity: stitchedEquitySeries,
    periodStart: stitchedStart,
    periodEnd: stitchedEnd,
    label: `${strategy.label} + ${sourceLabel}`,
    topStatsLabel: sourceLabel,
    tradeLog: combinedTradeLog
  };
}

function buildMcTopSources(strategy, mcPercentileRows, mcPathRows) {
  const optimisticSeries = buildMcSeriesFromPaths(mcPathRows, "equity_p95_path");
  const middleSeries = buildMcSeriesFromPathMidpoint(mcPathRows, "equity_p5_path", "equity_p95_path");
  const pessimisticSeries = buildMcSeriesFromPaths(mcPathRows, "equity_p1_path");

  return {
    backtest: strategy,
    mc_p95: stitchBacktestWithMcBackfill(strategy, optimisticSeries, "95% Percentile MC Sim (Optimistic)"),
    mc_p50: stitchBacktestWithMcBackfill(strategy, middleSeries, "50% Percentile MC Sim (Middle Ground)"),
    mc_p1: stitchBacktestWithMcBackfill(strategy, pessimisticSeries, "1% Percentile MC Sim (Pessimistic)")
  };
}

function buildMonthlyMatrix(strategy) {
  const yearMap = new Map();
  strategy.monthlyReturns.forEach((month) => {
    const [year, monthNum] = month.monthKey.split("-");
    if (!yearMap.has(year)) {
      yearMap.set(year, {
        months: Array(12).fill(null),
        pnl: 0,
        startEquity: month.startEquity
      });
    }
    const yearRow = yearMap.get(year);
    const idx = Number(monthNum) - 1;
    if (idx >= 0 && idx < 12) yearRow.months[idx] = month.returnPct;
    yearRow.pnl += month.pnl;
  });

  return [...yearMap.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([year, row]) => ({
      year,
      months: row.months,
      ytd: row.startEquity !== 0 ? (row.pnl / row.startEquity) * 100 : NaN
    }));
}

function monthClass(value) {
  if (!Number.isFinite(value)) return "month-flat";
  if (value > 0) return "month-pos";
  if (value < 0) return "month-neg";
  return "month-flat";
}

function renderMonthlyTable(strategy) {
  const tbody = document.querySelector("#monthlyReturnsTable tbody");
  tbody.innerHTML = "";
  const rows = buildMonthlyMatrix(strategy);

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const yearCell = document.createElement("td");
    yearCell.textContent = row.year;
    tr.appendChild(yearCell);

    row.months.forEach((monthValue) => {
      const td = document.createElement("td");
      td.className = monthClass(monthValue);
      td.textContent = Number.isFinite(monthValue) ? fmtPercent(monthValue, 1) : "-";
      tr.appendChild(td);
    });

    const ytd = document.createElement("td");
    ytd.className = monthClass(row.ytd);
    ytd.textContent = Number.isFinite(row.ytd) ? fmtPercent(row.ytd, 1) : "-";
    tr.appendChild(ytd);
    tbody.appendChild(tr);
  });
}

function renderSummaryPanel(strategy) {
  const profitableMonths = strategy.monthlyReturns.filter((m) => m.returnPct > 0).length;
  const totalMonths = strategy.monthlyReturns.length;

  setTextById("activeStrategyLabel", `Strategy: ${strategy.label}`);
  setTextById("sumTrades", strategy.trades.toLocaleString("en-US"));
  setTextById("sumInitial", fmtCurrency(strategy.startingEquity));
  setTextById("sumCurrent", fmtCurrency(strategy.endingEquity));
  setTextById("sumWinRate", fmtPercent(strategy.winRatePct, 1));
  setTextById("sumWins", `${strategy.wins}/${strategy.trades}`);
  setTextById("sumMonths", `${profitableMonths}/${totalMonths}`);
  const netProfitPct = strategy.startingEquity > 0 ? (strategy.netPnl / strategy.startingEquity) * 100 : NaN;
  setTextById("sumNetProfit", `${fmtCurrency(strategy.netPnl)} (${fmtPercent(netProfitPct, 1)})`);
  setTextById("sumDrawdown", `-${fmtPercent(strategy.maxDrawdownPct, 2)} (${fmtCurrency(strategy.maxDrawdownUsd)})`);
  setTextById("sumProfitFactor", fmtNumber(strategy.profitFactor, 2));
}

function renderTradeLog(strategy) {
  const tbody = document.querySelector("#tradeLogTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const totalRows = strategy.tradeLog.length;
  const totalPages = Math.max(Math.ceil(totalRows / TRADE_LOG_PAGE_SIZE), 1);
  tradeLogCurrentPage = Math.min(Math.max(tradeLogCurrentPage, 1), totalPages);
  const start = (tradeLogCurrentPage - 1) * TRADE_LOG_PAGE_SIZE;
  const end = start + TRADE_LOG_PAGE_SIZE;
  const rows = strategy.tradeLog.slice(start, end);

  rows.forEach((trade) => {
    const tr = document.createElement("tr");
    const cells = [
      trade.date || "-",
      trade.market || "-",
      trade.direction || "-",
      fmtCurrency(trade.betSizeUsd),
      Number.isFinite(trade.entryPrice) ? trade.entryPrice.toFixed(3) : "-",
      trade.result || "-",
      fmtCurrency(trade.pnlUsd)
    ];
    cells.forEach((value, idx) => {
      const td = document.createElement("td");
      td.textContent = String(value);
      if (idx === 5) td.className = trade.result === "Win" ? "positive" : trade.result === "Loss" ? "negative" : "";
      if (idx === 6) td.className = Number.isFinite(trade.pnlUsd)
        ? trade.pnlUsd >= 0
          ? "positive"
          : "negative"
        : "";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  const prevBtn = document.getElementById("tradeLogPrev");
  const nextBtn = document.getElementById("tradeLogNext");
  const pageInfo = document.getElementById("tradeLogPageInfo");
  if (pageInfo) pageInfo.textContent = `Page ${tradeLogCurrentPage} / ${totalPages}`;
  if (prevBtn) {
    prevBtn.disabled = tradeLogCurrentPage <= 1;
    prevBtn.onclick = () => {
      if (tradeLogCurrentPage <= 1) return;
      tradeLogCurrentPage -= 1;
      renderTradeLog(strategy);
    };
  }
  if (nextBtn) {
    nextBtn.disabled = tradeLogCurrentPage >= totalPages;
    nextBtn.onclick = () => {
      if (tradeLogCurrentPage >= totalPages) return;
      tradeLogCurrentPage += 1;
      renderTradeLog(strategy);
    };
  }
}

function drawEquityChart(strategy) {
  const ctx = document.getElementById("equityChart");

  equityChartRef?.destroy();
  equityChartRef = new Chart(ctx, {
    type: "line",
    data: {
      labels: strategy.labels,
      datasets: [
        {
          label: strategy.label,
          data: strategy.equity,
          borderColor: "#26d07c",
          backgroundColor: (context) => {
            const chart = context.chart;
            const { ctx: chartCtx, chartArea } = chart;
            if (
              !chartArea ||
              !Number.isFinite(chartArea.top) ||
              !Number.isFinite(chartArea.bottom) ||
              !Number.isFinite(chartArea.height)
            ) {
              return "rgba(38, 208, 124, 0)";
            }
            const gradient = chartCtx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
            gradient.addColorStop(0, "rgba(38, 208, 124, 0.42)");
            gradient.addColorStop(0.45, "rgba(38, 208, 124, 0.18)");
            gradient.addColorStop(0.75, "rgba(38, 208, 124, 0.07)");
            gradient.addColorStop(1, "rgba(38, 208, 124, 0)");
            return gradient;
          },
          fill: "start",
          tension: 0.22,
          pointRadius: 0,
          borderWidth: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { maxTicksLimit: 10, color: "#9eb0d6" }, grid: { color: "rgba(158,176,214,0.1)" } },
        y: { ticks: { color: "#9eb0d6" }, grid: { color: "rgba(158,176,214,0.1)" } }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
}

function renderMcSummary(mcStatsRows) {
  const row = mcStatsRows[0] || {};
  setTextById("mcMedianReturn", fmtPercent(toNumber(row.median_return_pct), 2));
  setTextById("mcP05Return", fmtPercent(toNumber(row.p05_return_pct), 2));
  setTextById("mcP95Return", fmtPercent(toNumber(row.p95_return_pct), 2));
  setTextById("mcLossProb", fmtPercent(toNumber(row.probability_loss_pct), 2));
}

function drawMonteCarloChart(mcRows) {
  const labels = mcRows.map((r) => toNumber(r.trade_number));
  const p1 = mcRows.map((r) => toNumber(r.equity_p1_path));
  const p5 = mcRows.map((r) => toNumber(r.equity_p5_path));
  const p95 = mcRows.map((r) => toNumber(r.equity_p95_path));
  const p25 = p5.map((v, i) => (Number.isFinite(v) && Number.isFinite(p95[i]) ? v + 0.25 * (p95[i] - v) : NaN));
  const p50 = p5.map((v, i) => (Number.isFinite(v) && Number.isFinite(p95[i]) ? v + 0.5 * (p95[i] - v) : NaN));
  const p75 = p5.map((v, i) => (Number.isFinite(v) && Number.isFinite(p95[i]) ? v + 0.75 * (p95[i] - v) : NaN));

  const ctx = document.getElementById("mcPathChart");
  mcPathChartRef?.destroy();
  mcPathChartRef = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "P1 Path", data: p1, borderColor: "#ff8e8e", tension: 0.12, pointRadius: 0, borderWidth: 2 },
        { label: "P5 Path", data: p5, borderColor: "#ffd166", tension: 0.12, pointRadius: 0, borderWidth: 2 },
        {
          label: "P25 Path",
          data: p25,
          borderColor: "rgba(173, 216, 230, 0.55)",
          borderDash: [6, 4],
          tension: 0.12,
          pointRadius: 0,
          borderWidth: 1.4
        },
        {
          label: "P50 Path",
          data: p50,
          borderColor: "rgba(173, 216, 230, 0.75)",
          tension: 0.12,
          pointRadius: 0,
          borderWidth: 1.6
        },
        {
          label: "P75 Path",
          data: p75,
          borderColor: "rgba(173, 216, 230, 0.55)",
          borderDash: [6, 4],
          tension: 0.12,
          pointRadius: 0,
          borderWidth: 1.4
        },
        { label: "P95 Path", data: p95, borderColor: "#66e3c4", tension: 0.12, pointRadius: 0, borderWidth: 2 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { maxTicksLimit: 12, color: "#9eb0d6" }, grid: { color: "rgba(158,176,214,0.1)" } },
        y: { ticks: { color: "#9eb0d6" }, grid: { color: "rgba(158,176,214,0.1)" } }
      },
      plugins: {
        legend: { labels: { color: "#e8eefc" } }
      }
    }
  });
}

function computeDrawdownPct(equitySeries) {
  let peak = -Infinity;
  let maxDrawdownPct = 0;
  equitySeries.forEach((v) => {
    if (!Number.isFinite(v)) return;
    if (v > peak) peak = v;
    if (peak > 0) {
      const ddPct = ((peak - v) / peak) * 100;
      if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    }
  });
  return maxDrawdownPct;
}

function renderMcPathStats(percentileRows) {
  const pathSelect = document.getElementById("mcPathSelect");
  const startInput = document.getElementById("mcStartDate");
  const endInput = document.getElementById("mcEndDate");
  const loadBtn = document.getElementById("mcLoadStats");

  if (!pathSelect || !startInput || !endInput || !loadBtn) return;

  const defaultStart = "2025-01-01";
  const todayIso = toIsoDateString(new Date());
  startInput.value = defaultStart;
  endInput.value = todayIso;
  pathSelect.value = "p50";

  const writeStat = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  const anchorDate = new Date(`${defaultStart}T00:00:00Z`);
  const load = () => {
    const pathKey = pathSelect.value;
    const startDate = new Date(`${startInput.value}T00:00:00Z`);
    const endDate = new Date(`${endInput.value}T23:59:59Z`);
    if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime()) || startDate > endDate) {
      writeStat("mcPathStartEquity", "-");
      writeStat("mcPathEndEquity", "-");
      writeStat("mcPathReturnPct", "Invalid date range");
      writeStat("mcPathMaxDdPct", "-");
      writeStat("mcPathCagrPct", "-");
      writeStat("mcPathDaysUsed", "-");
      return;
    }

    const filtered = percentileRows
      .map((row) => {
        const dayNum = toNumber(row.day);
        if (!Number.isFinite(dayNum)) return null;
        const date = new Date(anchorDate.getTime() + (dayNum - 1) * 86400000);
        const equity = toNumber(row[pathKey]);
        if (!Number.isFinite(equity)) return null;
        return { date, equity };
      })
      .filter(Boolean)
      .filter((p) => p.date >= startDate && p.date <= endDate);

    if (!filtered.length) {
      writeStat("mcPathStartEquity", "-");
      writeStat("mcPathEndEquity", "-");
      writeStat("mcPathReturnPct", "No data");
      writeStat("mcPathMaxDdPct", "-");
      writeStat("mcPathCagrPct", "-");
      writeStat("mcPathDaysUsed", "0");
      return;
    }

    const startEq = filtered[0].equity;
    const endEq = filtered[filtered.length - 1].equity;
    const retPct = startEq !== 0 ? ((endEq - startEq) / startEq) * 100 : NaN;
    const maxDdPct = computeDrawdownPct(filtered.map((p) => p.equity));
    const days = Math.max((filtered[filtered.length - 1].date - filtered[0].date) / 86400000, 1);
    const cagrPct = startEq > 0 ? (Math.pow(endEq / startEq, 365 / days) - 1) * 100 : NaN;

    writeStat("mcPathStartEquity", fmtCurrency(startEq));
    writeStat("mcPathEndEquity", fmtCurrency(endEq));
    writeStat("mcPathReturnPct", fmtPercent(retPct, 2));
    writeStat("mcPathMaxDdPct", fmtPercent(maxDdPct, 2));
    writeStat("mcPathCagrPct", fmtPercent(cagrPct, 2));
    writeStat("mcPathDaysUsed", String(filtered.length));
  };

  loadBtn.onclick = load;
  load();
}

function showError(message) {
  const headerMeta = document.getElementById("generatedAt");
  if (headerMeta) {
    headerMeta.textContent = "Data load failed";
    headerMeta.className = "error";
  }
  const main = document.querySelector("main");
  const panel = document.createElement("section");
  panel.className = "panel";
  panel.innerHTML = `<p class="error">${message}</p>`;
  main.prepend(panel);
}

async function init() {
  try {
    const [backtestDatasets, mcStatsRows, mcPathRows, mcPercentileRows] = await Promise.all([
      loadBacktestDatasets(),
      fetchCsv(MC_FILES.stats),
      fetchCsv(MC_FILES.paths),
      fetchCsv(MC_FILES.percentiles)
    ]);

    if (!backtestDatasets.length) {
      throw new Error("No backtest trade files could be loaded.");
    }

    const topStatsSelect = document.getElementById("topStatsSourceSelect");
    const assetFilterSelect = document.getElementById("assetFilterSelect");
    const initialCapitalInput = document.getElementById("initialCapitalInput");
    const betSizeInput = document.getElementById("betSizeInput");
    const applySizingBtn = document.getElementById("applySizingBtn");
    if (assetFilterSelect) assetFilterSelect.value = currentAssetFilter;
    if (initialCapitalInput) initialCapitalInput.value = String(currentInitialCapital);
    if (betSizeInput) betSizeInput.value = String(currentBetSize);

    let active = null;
    let topSources = null;

    const getSelectedSource = () => {
      const selected = topStatsSelect?.value || "backtest";
      return topSources?.[selected] || topSources?.backtest || active;
    };

    const renderActive = () => {
      const selectedSource = getSelectedSource();
      if (!selectedSource || !active) return;
      renderTopKpis(selectedSource);
      renderMonthlyTable(selectedSource);
      renderSummaryPanel(selectedSource);
      drawEquityChart(selectedSource);
      renderTradeLog(selectedSource);
    };

    const applySizing = () => {
      const nextInitial = toNumber(initialCapitalInput?.value);
      const nextBet = toNumber(betSizeInput?.value);
      const nextAssetFilter = String(assetFilterSelect?.value || "both").toLowerCase();
      currentInitialCapital = Number.isFinite(nextInitial) && nextInitial > 0 ? nextInitial : DEFAULT_STARTING_EQUITY;
      currentBetSize = Number.isFinite(nextBet) && nextBet > 0 ? nextBet : DEFAULT_BET_SIZE;
      currentAssetFilter = ["both", "spx", "ndx"].includes(nextAssetFilter) ? nextAssetFilter : "both";
      if (assetFilterSelect) assetFilterSelect.value = currentAssetFilter;
      if (initialCapitalInput) initialCapitalInput.value = String(Math.round(currentInitialCapital * 100) / 100);
      if (betSizeInput) betSizeInput.value = String(Math.round(currentBetSize * 100) / 100);

      const backtests = computeBacktestsFromDatasets(backtestDatasets, currentInitialCapital, currentBetSize);
      active = backtests[0];
      topSources = buildMcTopSources(active, mcPercentileRows, mcPathRows);
      tradeLogCurrentPage = 1;
      renderDatasetWindow(backtests);
      renderActive();
    };

    if (applySizingBtn) applySizingBtn.onclick = applySizing;
    if (assetFilterSelect) assetFilterSelect.onchange = applySizing;
    if (initialCapitalInput) initialCapitalInput.onkeydown = (event) => {
      if (event.key === "Enter") applySizing();
    };
    if (betSizeInput) betSizeInput.onkeydown = (event) => {
      if (event.key === "Enter") applySizing();
    };

    applySizing();

    if (topStatsSelect) {
      topStatsSelect.onchange = () => {
        tradeLogCurrentPage = 1;
        const selectedSource = getSelectedSource();
        renderTopKpis(selectedSource);
        renderMonthlyTable(selectedSource);
        renderSummaryPanel(selectedSource);
        drawEquityChart(selectedSource);
        renderTradeLog(selectedSource);
      };
    }

    let resizeFrame = null;
    let resizeDebounceTimer = null;
    const applyViewportClasses = () => {
      const width = window.innerWidth || document.documentElement.clientWidth || 0;
      document.body.classList.toggle("vp-tablet", width <= 1150);
      document.body.classList.toggle("vp-mobile", width <= 760);
      document.body.classList.toggle("vp-mobile-sm", width <= 600);
    };

    const onViewportResize = () => {
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
      resizeFrame = requestAnimationFrame(() => {
        applyViewportClasses();
        // Let layout settle, then resize charts once.
        resizeDebounceTimer = setTimeout(() => {
          equityChartRef?.resize();
          mcPathChartRef?.resize();
        }, 120);
      });
    };
    window.addEventListener("resize", onViewportResize);
    window.visualViewport?.addEventListener("resize", onViewportResize);
    window.addEventListener("orientationchange", onViewportResize);

    const breakpointMqls = [
      window.matchMedia("(max-width: 1150px)"),
      window.matchMedia("(max-width: 760px)"),
      window.matchMedia("(max-width: 600px)")
    ];
    breakpointMqls.forEach((mql) => mql.addEventListener("change", onViewportResize));

    const resizeTarget = document.querySelector(".page-shell");
    if (resizeTarget && "ResizeObserver" in window) {
      const observer = new ResizeObserver(() => {
        onViewportResize();
      });
      observer.observe(resizeTarget);
    }

    applyViewportClasses();

    setTextById("generatedAt", `Loaded ${new Date().toLocaleString()}`);
  } catch (error) {
    console.error(error);
    showError(error.message);
  }
}

init();
