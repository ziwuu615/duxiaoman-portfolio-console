'use strict';

const { AppError, ERROR_CODES } = require('./errors');
const { isPlainObject, deepFreeze } = require('./util');
const { parseMoneyToCents, parseRatioToBps, formatBpsAsPct } = require('./money');

/**
 * 组合 / 行情快照的解析与校验。
 *
 * 这里做的是「启动期」校验：示例数据一旦不满足任务书约定的口径
 * （例如阈值比较方式不是 strictly_greater_than、现金不进入分母），
 * 程序应当立刻失败并给出可读原因，而不是带着错误口径继续算下去。
 */

const UNKNOWN_INDUSTRY = '未分类';
const SUPPORTED_COMPARISON = 'strictly_greater_than';

function dataError(message, details) {
  return new AppError(ERROR_CODES.INVALID_PORTFOLIO_DATA, message, { details });
}

function requireString(source, key, label) {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw dataError(`${label} 字段 ${key} 缺失或不是非空字符串`, { field: key, value });
  }
  return value.trim();
}

/**
 * 解析示例数据结构，得到内部组合模型。
 *
 * @param {unknown} raw 形如 data/portfolio.json 的原始对象
 * @returns {{
 *   meta: {id: string, name: string, currency: string, snapshotId: string, snapshotAt: string, snapshotAtDisplay: string},
 *   cashCents: number,
 *   instruments: Map<string, {symbol: string, name: string, industry: string, priceCents: number, initialQuantity: number}>,
 *   rules: {singleThresholdBps: number, industryThresholdBps: number, comparison: string},
 *   warnings: string[]
 * }}
 */
function createPortfolio(raw) {
  if (!isPlainObject(raw)) {
    throw dataError('组合数据必须是 JSON 对象');
  }

  const warnings = [];
  const meta = {
    id: requireString(raw, 'portfolio_id', '组合数据'),
    name: requireString(raw, 'name', '组合数据'),
    currency: requireString(raw, 'currency', '组合数据'),
    snapshotId: requireString(raw, 'snapshot_id', '组合数据'),
    snapshotAt: requireString(raw, 'snapshot_at', '组合数据'),
    snapshotAtDisplay: formatSnapshotAt(raw.snapshot_at)
  };

  if (meta.currency !== 'CNY') {
    throw dataError(`当前原型仅支持 CNY，收到 ${meta.currency}`, { currency: meta.currency });
  }

  const cashCents = parseMoneyToCents(raw.cash, 'cash');

  if (!Array.isArray(raw.instruments) || raw.instruments.length === 0) {
    throw dataError('instruments 必须是非空数组');
  }

  const instruments = new Map();
  raw.instruments.forEach((item, index) => {
    if (!isPlainObject(item)) {
      throw dataError(`instruments[${index}] 必须是对象`);
    }
    const symbol = requireString(item, 'symbol', `instruments[${index}]`);
    if (instruments.has(symbol)) {
      throw dataError(`标的代码重复：${symbol}`, { symbol, index });
    }

    let industry = typeof item.industry === 'string' ? item.industry.trim() : '';
    if (industry === '') {
      industry = UNKNOWN_INDUSTRY;
      warnings.push(`标的 ${symbol} 缺少行业信息，已归入「${UNKNOWN_INDUSTRY}」`);
    }

    const priceCents = parseMoneyToCents(item.price, `instruments[${index}].price`);
    const quantity = item.quantity;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw dataError(`instruments[${index}].quantity 必须为正整数，收到 ${JSON.stringify(quantity)}`, {
        symbol,
        quantity
      });
    }

    instruments.set(symbol, {
      symbol,
      name: requireString(item, 'name', `instruments[${index}]`),
      industry,
      priceCents,
      initialQuantity: quantity
    });
  });

  const rules = parseRules(raw.rules);

  return deepFreeze({
    meta,
    cashCents,
    instruments,
    rules,
    warnings
  });
}

/**
 * 校验并规范化 rules。
 * 任务书 2.1 / 2.2 明确的口径在此固化；不支持的规则组合直接拒绝。
 */
function parseRules(raw) {
  if (!isPlainObject(raw)) {
    throw dataError('rules 必须是对象');
  }

  const singleThresholdBps = parseRatioToBps(raw.single_instrument_threshold, 'rules.single_instrument_threshold');
  const industryThresholdBps = parseRatioToBps(raw.industry_threshold, 'rules.industry_threshold');

  if (singleThresholdBps <= 0 || singleThresholdBps > 10000) {
    throw dataError('rules.single_instrument_threshold 必须位于 (0, 1] 区间');
  }
  if (industryThresholdBps <= 0 || industryThresholdBps > 10000) {
    throw dataError('rules.industry_threshold 必须位于 (0, 1] 区间');
  }

  if (raw.comparison !== SUPPORTED_COMPARISON) {
    throw dataError(
      `仅支持 comparison="${SUPPORTED_COMPARISON}"（严格大于才提醒），收到 ${JSON.stringify(raw.comparison)}`,
      { comparison: raw.comparison }
    );
  }
  if (raw.cash_in_denominator !== true) {
    throw dataError('仅支持 cash_in_denominator=true（现金计入总资产分母）');
  }
  if (raw.cash_in_industry !== false) {
    throw dataError('仅支持 cash_in_industry=false（现金不归入任何行业）');
  }
  if (raw.quantity !== 'positive_integer') {
    throw dataError('仅支持 quantity="positive_integer"');
  }

  const feesCents = parseMoneyToCents(raw.fees === undefined ? '0.00' : raw.fees, 'rules.fees');
  if (feesCents !== 0) {
    throw dataError('当前原型不支持手续费（rules.fees 必须为 0.00）');
  }

  return {
    singleThresholdBps,
    industryThresholdBps,
    comparison: SUPPORTED_COMPARISON,
    singleThresholdLabel: formatBpsAsPct(singleThresholdBps),
    industryThresholdLabel: formatBpsAsPct(industryThresholdBps)
  };
}

/** 快照时间展示：保留原始时区下的日期时间（"2026-11-02T15:00:00+08:00" → "2026-11-02 15:00"）。 */
function formatSnapshotAt(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  return match ? `${match[1]} ${match[2]}` : value;
}

/**
 * 取出「冻结的基准快照」，写入方案记录。
 *
 * 为什么要把价格和原始数量一起冻结进方案：方案重新打开时不应依赖
 * data/portfolio.json 是否被改动过，否则「刷新/重启后结果不变」会退化
 * 成「只要没人改基准数据就不变」。冻结后方案完全自洽、可复算。
 */
function freezeBase(portfolio) {
  return {
    snapshotId: portfolio.meta.snapshotId,
    snapshotAt: portfolio.meta.snapshotAt,
    currency: portfolio.meta.currency,
    cashCents: portfolio.cashCents,
    holdings: Array.from(portfolio.instruments.values()).map((item) => ({
      symbol: item.symbol,
      name: item.name,
      industry: item.industry,
      priceCents: item.priceCents,
      quantity: item.initialQuantity
    }))
  };
}

/**
 * 从方案中冻结的基准数据还原出与 createPortfolio 同构的组合模型，
 * 保证「重开方案」与「首次模拟」走完全相同的计算路径。
 *
 * @param {{snapshotId: string, snapshotAt: string, currency: string, cashCents: number, holdings: Array<object>}} frozen
 * @param {{singleThresholdBps: number, industryThresholdBps: number}} rules
 * @param {{name?: string, id?: string}} [metaOverride]
 */
function createPortfolioFromFrozen(frozen, rules, metaOverride = {}) {
  if (!isPlainObject(frozen) || !Array.isArray(frozen.holdings)) {
    throw new AppError(ERROR_CODES.STORE_UNAVAILABLE, '方案中的基准快照已损坏，无法重新计算', {
      httpStatus: 500
    });
  }

  const instruments = new Map();
  for (const holding of frozen.holdings) {
    if (!isPlainObject(holding) || typeof holding.symbol !== 'string') {
      throw new AppError(ERROR_CODES.STORE_UNAVAILABLE, '方案中的持仓数据已损坏，无法重新计算', {
        httpStatus: 500
      });
    }
    instruments.set(holding.symbol, {
      symbol: holding.symbol,
      name: String(holding.name || holding.symbol),
      industry: String(holding.industry || UNKNOWN_INDUSTRY),
      priceCents: Number(holding.priceCents),
      initialQuantity: Number(holding.quantity)
    });
  }

  const singleThresholdBps = Number(rules.singleThresholdBps);
  const industryThresholdBps = Number(rules.industryThresholdBps);

  return deepFreeze({
    meta: {
      id: metaOverride.id || 'PLAN',
      name: metaOverride.name || '已保存方案',
      currency: frozen.currency || 'CNY',
      snapshotId: frozen.snapshotId || '',
      snapshotAt: frozen.snapshotAt || '',
      snapshotAtDisplay: formatSnapshotAt(frozen.snapshotAt)
    },
    cashCents: Number(frozen.cashCents),
    instruments,
    rules: {
      singleThresholdBps,
      industryThresholdBps,
      comparison: SUPPORTED_COMPARISON,
      singleThresholdLabel: formatBpsAsPct(singleThresholdBps),
      industryThresholdLabel: formatBpsAsPct(industryThresholdBps)
    },
    warnings: []
  });
}

module.exports = {
  UNKNOWN_INDUSTRY,
  createPortfolio,
  createPortfolioFromFrozen,
  freezeBase,
  formatSnapshotAt
};
