'use strict';

const { AppError, ERROR_CODES } = require('./errors');
const { isPlainObject } = require('./util');
const {
  parseQuantity,
  pct2Of,
  compareToThreshold,
  formatMoney,
  MAX_MONEY_CENTS,
  MAX_QUANTITY
} = require('./money');

/**
 * 估值、集中度与调仓模拟的核心计算引擎（纯函数，无 I/O）。
 *
 * 关键约束（对应任务书 2.2）：
 * - 所有操作基于同一份冻结的行情快照（价格来自 portfolio.instruments，全程不变）。
 * - 现金不得为负；卖出数量不得超过当前模拟持仓。
 * - 操作按顺序依次生效，后一笔使用前一笔的结果。
 * - 固定价格、无手续费条件下，模拟前后总资产必须保持不变 —— 这一点由
 *   simulate() 末尾的自检断言强制保证，任何未来改动破坏了它都会立刻暴露。
 */

const MAX_OPERATIONS = 50;

const SIDE_BUY = 'BUY';
const SIDE_SELL = 'SELL';

/** 原始组合对应的初始模拟状态。与基准数据完全分离，模拟不会写回。 */
function createInitialState(portfolio) {
  const quantities = new Map();
  for (const instrument of portfolio.instruments.values()) {
    quantities.set(instrument.symbol, instrument.initialQuantity);
  }
  return { cashCents: portfolio.cashCents, quantities };
}

/** 该标的在给定状态下是否可交易 / 是否存在。 */
function getInstrument(portfolio, symbol) {
  return portfolio.instruments.get(symbol);
}

/**
 * 计算给定状态的估值与集中度。
 *
 * @param {{cashCents: number, quantities: Map<string, number>}} state
 * @param {object} portfolio
 */
function analyze(state, portfolio) {
  const { singleThresholdBps, industryThresholdBps } = portfolio.rules;

  const positions = [];
  let marketValueCents = 0;

  // 固定按行情快照的顺序输出，保证「原始 vs 模拟」两列逐行对齐。
  for (const instrument of portfolio.instruments.values()) {
    const quantity = state.quantities.get(instrument.symbol) || 0;
    const positionMarketValueCents = quantity * instrument.priceCents;
    marketValueCents += positionMarketValueCents;
    positions.push({
      symbol: instrument.symbol,
      name: instrument.name,
      industry: instrument.industry,
      priceCents: instrument.priceCents,
      quantity,
      marketValueCents: positionMarketValueCents
    });
  }

  const totalAssetCents = marketValueCents + state.cashCents;

  for (const position of positions) {
    position.weightPct2 = pct2Of(position.marketValueCents, totalAssetCents);
    position.overSingleThreshold =
      position.marketValueCents > 0 &&
      compareToThreshold(position.marketValueCents, totalAssetCents, singleThresholdBps) > 0;
  }

  // 行业分布：现金不归入任何行业，分母仍是「总资产（含现金）」。
  const industryMap = new Map();
  for (const instrument of portfolio.instruments.values()) {
    if (!industryMap.has(instrument.industry)) {
      industryMap.set(instrument.industry, { industry: instrument.industry, marketValueCents: 0 });
    }
  }
  for (const position of positions) {
    const bucket = industryMap.get(position.industry);
    bucket.marketValueCents += position.marketValueCents;
  }

  const industries = Array.from(industryMap.values()).map((bucket) => ({
    industry: bucket.industry,
    marketValueCents: bucket.marketValueCents,
    weightPct2: pct2Of(bucket.marketValueCents, totalAssetCents),
    overIndustryThreshold:
      bucket.marketValueCents > 0 &&
      compareToThreshold(bucket.marketValueCents, totalAssetCents, industryThresholdBps) > 0
  }));

  const alerts = [];
  for (const position of positions) {
    if (position.overSingleThreshold) {
      alerts.push({
        id: `instrument:${position.symbol}`,
        type: 'instrument',
        key: position.symbol,
        label: `${position.symbol} ${position.name}`,
        subject: position.name,
        industry: position.industry,
        marketValueCents: position.marketValueCents,
        pct2: position.weightPct2,
        thresholdBps: singleThresholdBps,
        overByPct2: position.weightPct2 - singleThresholdBps
      });
    }
  }
  alerts.sort((a, b) => b.pct2 - a.pct2);

  const industryAlerts = [];
  for (const bucket of industries) {
    if (bucket.overIndustryThreshold) {
      industryAlerts.push({
        id: `industry:${bucket.industry}`,
        type: 'industry',
        key: bucket.industry,
        label: `${bucket.industry}行业`,
        subject: bucket.industry,
        industry: bucket.industry,
        marketValueCents: bucket.marketValueCents,
        pct2: bucket.weightPct2,
        thresholdBps: industryThresholdBps,
        overByPct2: bucket.weightPct2 - industryThresholdBps
      });
    }
  }
  industryAlerts.sort((a, b) => b.pct2 - a.pct2);

  return {
    cashCents: state.cashCents,
    marketValueCents,
    totalAssetCents,
    positions,
    industries,
    alerts: [...alerts, ...industryAlerts],
    counts: {
      heldInstruments: positions.filter((item) => item.quantity > 0).length,
      industries: industries.filter((item) => item.marketValueCents > 0).length,
      // 「持仓数量」有两义：标的个数与总股数。两者都给出，避免口径歧义。
      totalQuantity: positions.reduce((sum, item) => sum + item.quantity, 0)
    }
  };
}

/**
 * 规范化一笔操作：只接受 BUY/SELL、已知标的、正整数数量。
 * @param {unknown} raw
 * @param {number} index
 */
function normalizeOperation(raw, index) {
  if (!isPlainObject(raw)) {
    throw new AppError(ERROR_CODES.INVALID_OPERATION, `第 ${index + 1} 笔操作必须是对象`, {
      details: { operationIndex: index },
      httpStatus: 422
    });
  }

  const sideText = typeof raw.side === 'string' ? raw.side.trim().toUpperCase() : '';
  if (sideText !== SIDE_BUY && sideText !== SIDE_SELL) {
    throw new AppError(
      ERROR_CODES.INVALID_SIDE,
      `第 ${index + 1} 笔操作方向必须是 BUY 或 SELL，收到 ${JSON.stringify(raw.side)}`,
      { details: { operationIndex: index, side: raw.side, allowed: [SIDE_BUY, SIDE_SELL] }, httpStatus: 422 }
    );
  }

  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim() : '';
  if (symbol === '') {
    throw new AppError(ERROR_CODES.INVALID_OPERATION, `第 ${index + 1} 笔操作缺少标的代码`, {
      details: { operationIndex: index },
      httpStatus: 422
    });
  }

  let quantity;
  try {
    quantity = parseQuantity(raw.quantity);
  } catch (error) {
    if (error instanceof AppError) {
      error.message = `第 ${index + 1} 笔操作：${error.message}`;
      error.details = { ...(error.details || {}), operationIndex: index };
    }
    throw error;
  }

  return { side: sideText, symbol, quantity };
}

/**
 * 在状态上执行一笔操作，返回新状态（不改动入参，便于失败时保留「有效结果」）。
 *
 * @param {{cashCents: number, quantities: Map<string, number>}} state
 * @param {{side: string, symbol: string, quantity: number}} operation
 * @param {object} portfolio
 * @param {number} index
 */
function applyOperation(state, operation, portfolio, index) {
  const instrument = getInstrument(portfolio, operation.symbol);
  if (!instrument) {
    throw new AppError(
      ERROR_CODES.UNKNOWN_SYMBOL,
      `第 ${index + 1} 笔操作：标的 ${operation.symbol} 不在当前行情快照中`,
      {
        details: {
          operationIndex: index,
          symbol: operation.symbol,
          allowedSymbols: Array.from(portfolio.instruments.keys())
        },
        httpStatus: 422
      }
    );
  }

  const amountCents = instrument.priceCents * operation.quantity;
  if (!Number.isSafeInteger(amountCents) || amountCents > MAX_MONEY_CENTS) {
    throw new AppError(ERROR_CODES.INVALID_QUANTITY, `第 ${index + 1} 笔操作金额超出允许范围`, {
      details: { operationIndex: index, maxQuantity: MAX_QUANTITY },
      httpStatus: 422
    });
  }

  const currentQuantity = state.quantities.get(operation.symbol) || 0;
  let nextCashCents;
  let nextQuantity;

  if (operation.side === SIDE_BUY) {
    if (amountCents > state.cashCents) {
      throw new AppError(
        ERROR_CODES.INSUFFICIENT_CASH,
        `第 ${index + 1} 笔操作：现金不足，买入 ${operation.quantity} 股 ${operation.symbol} 需要 ` +
          `${formatMoney(amountCents)} 元，可用现金仅 ${formatMoney(state.cashCents)} 元`,
        {
          details: {
            operationIndex: index,
            symbol: operation.symbol,
            side: SIDE_BUY,
            requiredCents: amountCents,
            availableCents: state.cashCents,
            shortfallCents: amountCents - state.cashCents
          },
          httpStatus: 422
        }
      );
    }
    nextCashCents = state.cashCents - amountCents;
    nextQuantity = currentQuantity + operation.quantity;
  } else {
    if (operation.quantity > currentQuantity) {
      throw new AppError(
        ERROR_CODES.INSUFFICIENT_POSITION,
        `第 ${index + 1} 笔操作：持仓不足，卖出 ${operation.quantity} 股 ${operation.symbol}，` +
          `当前模拟持仓仅 ${currentQuantity} 股`,
        {
          details: {
            operationIndex: index,
            symbol: operation.symbol,
            side: SIDE_SELL,
            requestedQuantity: operation.quantity,
            availableQuantity: currentQuantity,
            shortfallQuantity: operation.quantity - currentQuantity
          },
          httpStatus: 422
        }
      );
    }
    nextCashCents = state.cashCents + amountCents;
    nextQuantity = currentQuantity - operation.quantity;
  }

  const quantities = new Map(state.quantities);
  quantities.set(operation.symbol, nextQuantity);

  return {
    state: { cashCents: nextCashCents, quantities },
    amountCents,
    cashAfterCents: nextCashCents,
    quantityAfter: nextQuantity
  };
}

/**
 * 顺序执行整组操作。
 *
 * 语义（重要，DESIGN.md 有对应说明）：整组操作是「原子」的 —— 任何一笔校验失败，
 * 整组都不会生效，调用方拿到的仍是上一版有效结果。这样方案永远只包含
 * 全部通过校验的操作序列，不会出现「方案里一半生效」的歧义状态。
 *
 * @param {object} portfolio
 * @param {unknown} rawOperations
 * @param {{maxOperations?: number}} [options]
 */
function simulate(portfolio, rawOperations, options = {}) {
  const maxOperations = options.maxOperations || MAX_OPERATIONS;

  if (!Array.isArray(rawOperations)) {
    throw new AppError(ERROR_CODES.INVALID_BODY, 'operations 必须是数组', {
      details: { field: 'operations' }
    });
  }
  if (rawOperations.length > maxOperations) {
    throw new AppError(
      ERROR_CODES.TOO_MANY_OPERATIONS,
      `方案最多支持 ${maxOperations} 笔操作，收到 ${rawOperations.length} 笔`,
      { details: { count: rawOperations.length, max: maxOperations }, httpStatus: 422 }
    );
  }

  const baseState = createInitialState(portfolio);
  let state = baseState;
  const steps = [];
  const operations = [];

  rawOperations.forEach((raw, index) => {
    const operation = normalizeOperation(raw, index);
    const result = applyOperation(state, operation, portfolio, index);
    state = result.state;
    operations.push(operation);
    steps.push({
      index,
      side: operation.side,
      symbol: operation.symbol,
      name: portfolio.instruments.get(operation.symbol).name,
      quantity: operation.quantity,
      priceCents: portfolio.instruments.get(operation.symbol).priceCents,
      amountCents: result.amountCents,
      cashAfterCents: result.cashAfterCents,
      quantityAfter: result.quantityAfter
    });
  });

  const baseAnalysis = analyze(baseState, portfolio);
  const analysis = analyze(state, portfolio);

  // 自检：固定价格、无手续费下，总资产必须守恒。若未来改动破坏了这一点，
  // 应当立刻暴露为 500，而不是悄悄给用户一个「资产蒸发了」的模拟结果。
  if (analysis.totalAssetCents !== baseAnalysis.totalAssetCents) {
    throw new AppError(
      ERROR_CODES.INVARIANT_VIOLATION,
      '内部校验失败：模拟前后总资产不一致（固定价格、无手续费条件下总资产应守恒）',
      {
        details: {
          baseTotalAssetCents: baseAnalysis.totalAssetCents,
          simulatedTotalAssetCents: analysis.totalAssetCents
        },
        httpStatus: 500
      }
    );
  }

  return { operations, steps, state, baseAnalysis, analysis };
}

module.exports = {
  MAX_OPERATIONS,
  SIDE_BUY,
  SIDE_SELL,
  createInitialState,
  analyze,
  simulate,
  normalizeOperation,
  applyOperation
};
