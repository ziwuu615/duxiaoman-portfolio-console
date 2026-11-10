'use strict';

const {
  formatMoney,
  formatPct2,
  formatQuantity,
  formatBpsAsPct,
  pct2Of
} = require('./money');

/**
 * 领域模型 → API DTO。
 *
 * 这一层是「前后端口径一致」的落点：
 * - 所有金额、占比、阈值的展示字符串都在后端生成，前端只负责摆放，不再做一次
 *   除法或舍入。这样只要后端口径对，页面就不可能因为前端重新计算而漂移。
 * - DTO 同时保留 cents / pct2 整数值，方便前端做排序、差值等简单逻辑时
 *   不必解析字符串。
 */

function money(cents) {
  return {
    cents,
    display: formatMoney(cents),
    sign: cents > 0 ? 1 : cents < 0 ? -1 : 0
  };
}

function pct(pct2) {
  return { pct2, display: formatPct2(pct2) };
}

/** 万分比 → 比例字符串（3000 → "0.30"，3050 → "0.305"）。 */
function bpsToRatioText(bps) {
  const intPart = Math.floor(bps / 10000);
  const frac = String(bps % 10000).padStart(4, '0').replace(/0+$/, '');
  const padded = frac.length === 0 ? '00' : frac.length === 1 ? `${frac}0` : frac;
  return `${intPart}.${padded}`;
}

function serializeThresholds(rules) {
  return {
    single: {
      ratio: bpsToRatioText(rules.singleThresholdBps),
      bps: rules.singleThresholdBps,
      pct2: rules.singleThresholdBps,
      display: formatBpsAsPct(rules.singleThresholdBps)
    },
    industry: {
      ratio: bpsToRatioText(rules.industryThresholdBps),
      bps: rules.industryThresholdBps,
      pct2: rules.industryThresholdBps,
      display: formatBpsAsPct(rules.industryThresholdBps)
    },
    comparison: rules.comparison,
    comparisonLabel: '严格大于阈值才提醒（等于阈值不提醒）',
    cashInDenominator: true,
    cashInIndustry: false
  };
}

function alertStatement(alert) {
  if (alert.type === 'instrument') {
    return `单一标的 ${alert.label} 占比 ${formatPct2(alert.pct2)}，超过阈值 ${formatPct2(alert.thresholdBps)}`;
  }
  return `行业「${alert.subject}」合计占比 ${formatPct2(alert.pct2)}，超过阈值 ${formatPct2(alert.thresholdBps)}`;
}

function serializeAlert(alert) {
  return {
    id: alert.id,
    type: alert.type,
    key: alert.key,
    label: alert.label,
    subject: alert.subject,
    industry: alert.industry,
    marketValue: money(alert.marketValueCents),
    actual: pct(alert.pct2),
    threshold: pct(alert.thresholdBps),
    overBy: pct(alert.overByPct2),
    statement: alertStatement(alert)
  };
}

function serializeAlerts(alerts) {
  return alerts.map(serializeAlert);
}

/**
 * @param {ReturnType<import('./engine').analyze>} analysis
 * @param {object} portfolio
 */
function serializeAnalysis(analysis, portfolio) {
  const thresholds = serializeThresholds(portfolio.rules);

  return {
    cash: money(analysis.cashCents),
    marketValue: money(analysis.marketValueCents),
    totalAsset: money(analysis.totalAssetCents),
    weights: {
      cash: pct(pct2Of(analysis.cashCents, analysis.totalAssetCents)),
      marketValue: pct(pct2Of(analysis.marketValueCents, analysis.totalAssetCents))
    },
    counts: {
      heldInstruments: analysis.counts.heldInstruments,
      industries: analysis.counts.industries,
      totalInstruments: portfolio.instruments.size,
      totalQuantity: analysis.counts.totalQuantity,
      totalQuantityDisplay: formatQuantity(analysis.counts.totalQuantity),
      alertCount: analysis.alerts.length
    },
    thresholds,
    positions: analysis.positions.map((position) => ({
      symbol: position.symbol,
      name: position.name,
      industry: position.industry,
      price: money(position.priceCents),
      quantity: position.quantity,
      quantityDisplay: formatQuantity(position.quantity),
      marketValue: money(position.marketValueCents),
      weight: pct(position.weightPct2),
      overThreshold: position.overSingleThreshold,
      threshold: thresholds.single
    })),
    industries: analysis.industries.map((bucket) => ({
      industry: bucket.industry,
      marketValue: money(bucket.marketValueCents),
      weight: pct(bucket.weightPct2),
      overThreshold: bucket.overIndustryThreshold,
      threshold: thresholds.industry
    })),
    alerts: serializeAlerts(analysis.alerts)
  };
}

const SIDE_LABELS = { BUY: '买入', SELL: '卖出' };

function serializeSteps(steps) {
  return steps.map((step) => ({
    index: step.index,
    side: step.side,
    sideLabel: SIDE_LABELS[step.side],
    symbol: step.symbol,
    name: step.name,
    quantity: step.quantity,
    quantityDisplay: formatQuantity(step.quantity),
    price: money(step.priceCents),
    amount: money(step.amountCents),
    cashAfter: money(step.cashAfterCents),
    quantityAfter: step.quantityAfter,
    text: `${SIDE_LABELS[step.side]} ${step.symbol} ${step.name} × ${formatQuantity(step.quantity)}`
  }));
}

/** 操作摘要（用于方案列表一行展示）。 */
function summarizeOperations(operations) {
  return operations
    .map((operation) => `${SIDE_LABELS[operation.side] || operation.side} ${operation.symbol}×${operation.quantity}`)
    .join(' → ');
}

/**
 * 「原始 vs 模拟」对比数据。
 */
function serializeDiff(baseAnalysis, analysis, steps) {
  const baseById = new Map(baseAnalysis.alerts.map((alert) => [alert.id, alert]));
  const currentById = new Map(analysis.alerts.map((alert) => [alert.id, alert]));

  const triggered = analysis.alerts.filter((alert) => !baseById.has(alert.id));
  const resolved = baseAnalysis.alerts.filter((alert) => !currentById.has(alert.id));

  return {
    cash: {
      base: money(baseAnalysis.cashCents),
      current: money(analysis.cashCents),
      delta: money(analysis.cashCents - baseAnalysis.cashCents)
    },
    totalAsset: {
      base: money(baseAnalysis.totalAssetCents),
      current: money(analysis.totalAssetCents),
      delta: money(analysis.totalAssetCents - baseAnalysis.totalAssetCents),
      invariantHolds: analysis.totalAssetCents === baseAnalysis.totalAssetCents
    },
    positions: analysis.positions.map((position) => {
      const basePosition = baseAnalysis.positions.find((item) => item.symbol === position.symbol);
      return {
        symbol: position.symbol,
        name: position.name,
        industry: position.industry,
        price: money(position.priceCents),
        baseQuantity: basePosition.quantity,
        currentQuantity: position.quantity,
        quantityDelta: position.quantity - basePosition.quantity,
        baseMarketValue: money(basePosition.marketValueCents),
        currentMarketValue: money(position.marketValueCents),
        marketValueDelta: money(position.marketValueCents - basePosition.marketValueCents),
        baseWeight: pct(basePosition.weightPct2),
        currentWeight: pct(position.weightPct2),
        weightDelta: pct(position.weightPct2 - basePosition.weightPct2),
        overThreshold: position.overSingleThreshold
      };
    }),
    industries: analysis.industries.map((bucket) => {
      const baseBucket = baseAnalysis.industries.find((item) => item.industry === bucket.industry);
      return {
        industry: bucket.industry,
        baseMarketValue: money(baseBucket.marketValueCents),
        currentMarketValue: money(bucket.marketValueCents),
        baseWeight: pct(baseBucket.weightPct2),
        currentWeight: pct(bucket.weightPct2),
        weightDelta: pct(bucket.weightPct2 - baseBucket.weightPct2),
        overThreshold: bucket.overIndustryThreshold
      };
    }),
    alerts: {
      base: serializeAlerts(baseAnalysis.alerts),
      current: serializeAlerts(analysis.alerts),
      triggered: serializeAlerts(triggered),
      resolved: serializeAlerts(resolved)
    },
    steps: serializeSteps(steps)
  };
}

/**
 * GET /api/portfolio 的返回体。
 */
function serializePortfolio(portfolio, analysis) {
  return {
    portfolio: {
      id: portfolio.meta.id,
      name: portfolio.meta.name,
      currency: portfolio.meta.currency,
      snapshotId: portfolio.meta.snapshotId,
      snapshotAt: portfolio.meta.snapshotAt,
      snapshotAtDisplay: portfolio.meta.snapshotAtDisplay,
      baseLabel: '原始组合'
    },
    thresholds: serializeThresholds(portfolio.rules),
    rules: {
      currency: portfolio.meta.currency,
      quantityRule: '正整数',
      fees: '0.00',
      cashInDenominator: true,
      cashInIndustry: false,
      comparison: portfolio.rules.comparison
    },
    instruments: Array.from(portfolio.instruments.values()).map((instrument) => ({
      symbol: instrument.symbol,
      name: instrument.name,
      industry: instrument.industry,
      price: money(instrument.priceCents),
      initialQuantity: instrument.initialQuantity
    })),
    analysis: serializeAnalysis(analysis, portfolio),
    warnings: portfolio.warnings
  };
}

function serializePlanSummary(record) {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    createdAtDisplay: formatDateTime(record.createdAt),
    snapshotId: record.base.snapshotId,
    currency: record.base.currency,
    operationCount: record.operations.length,
    operationSummary: summarizeOperations(record.operations),
    summary: {
      totalAsset: money(record.summary.totalAssetCents),
      cash: money(record.summary.cashCents),
      alertCount: record.summary.alertCount
    }
  };
}

function serializePlanDetail(record, baseAnalysis, analysis, steps, portfolio) {
  return {
    plan: serializePlanSummary(record),
    operations: record.operations.map((operation, index) => ({
      index,
      side: operation.side,
      sideLabel: SIDE_LABELS[operation.side],
      symbol: operation.symbol,
      name: portfolio.instruments.get(operation.symbol)?.name || operation.symbol,
      quantity: operation.quantity
    })),
    base: serializeAnalysis(baseAnalysis, portfolio),
    simulated: serializeAnalysis(analysis, portfolio),
    diff: serializeDiff(baseAnalysis, analysis, steps)
  };
}

/** ISO 时间 → "2026-11-10 15:32"（本地时区展示，方案保存时间用）。 */
function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return String(iso || '');
  }
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

module.exports = {
  serializeAnalysis,
  serializeDiff,
  serializePortfolio,
  serializePlanSummary,
  serializePlanDetail,
  serializeSteps,
  serializeThresholds,
  summarizeOperations,
  formatDateTime,
  money,
  pct
};
