'use strict';

const { AppError, ERROR_CODES } = require('./errors');

/**
 * 金额 / 占比 / 阈值的精确计算工具。
 *
 * 内部约定（DESIGN.md「计算与异常」一节与此一致）：
 * 1. 金额一律用「分」为单位的整数（cents）。示例数据的价格是两位小数，
 *    数量是整数，因此市值、现金、总资产都能用整数精确表示，不存在浮点误差。
 * 2. 占比一律用「百分比 × 100」为单位的整数（pct2），例如 40.00% 记作 4000。
 *    展示时按整数插入小数点，不做浮点除法。
 * 3. 阈值用「万分比」（bps）表示，例如 0.30 → 3000，恰好等价于 30%。
 * 4. 「是否超限」用 BigInt 交叉相乘比较（市值 × 10000 与 总资产 × 阈值bps），
 *    完全不经过小数，因此「等于阈值不触发」是精确判定，而不是浮点近似判定。
 */

/** 金额上限：1e15 分 = 10 万亿元，远大于测评场景，同时保证安全整数运算。 */
const MAX_MONEY_CENTS = 1e15;

/** 交易数量上限，防止构造出天文数字导致后续计算溢出。 */
const MAX_QUANTITY = 1e9;

const MONEY_PATTERN = /^\d{1,15}(?:\.\d{1,2})?$/;
const RATIO_PATTERN = /^\d{1,3}(?:\.\d{1,4})?$/;

function invalidMoney(field, value) {
  return new AppError(
    ERROR_CODES.INVALID_PORTFOLIO_DATA,
    `${field} 不是合法的金额：${JSON.stringify(value)}（要求非负、最多两位小数）`,
    { details: { field, value } }
  );
}

/**
 * 把 JSON 中的金额（字符串 "20000.00"，或整数/两位小数数字）解析为整数分。
 * @param {string|number} value
 * @param {string} field 出错时用于定位的字段名
 * @returns {number} 整数分
 */
function parseMoneyToCents(value, field = 'amount') {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw invalidMoney(field, value);
    }
    const scaled = value * 100;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > 1e-6) {
      throw invalidMoney(field, value);
    }
    if (rounded > MAX_MONEY_CENTS) {
      throw invalidMoney(field, value);
    }
    return rounded;
  }

  if (typeof value !== 'string') {
    throw invalidMoney(field, value);
  }

  const text = value.trim();
  if (!MONEY_PATTERN.test(text)) {
    throw invalidMoney(field, value);
  }

  const [intPart, fracPart = ''] = text.split('.');
  const cents = BigInt(intPart) * 100n + BigInt((fracPart + '00').slice(0, 2));
  if (cents > BigInt(MAX_MONEY_CENTS)) {
    throw invalidMoney(field, value);
  }
  return Number(cents);
}

/**
 * 把阈值字符串（"0.30"）解析为万分比整数（3000）。
 * @param {string|number} value
 * @param {string} field
 * @returns {number}
 */
function parseRatioToBps(value, field = 'ratio') {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new AppError(ERROR_CODES.INVALID_PORTFOLIO_DATA, `${field} 不是合法的比例：${value}`, {
        details: { field, value }
      });
    }
    return Math.round(value * 10000);
  }

  if (typeof value !== 'string' || !RATIO_PATTERN.test(value.trim())) {
    throw new AppError(
      ERROR_CODES.INVALID_PORTFOLIO_DATA,
      `${field} 不是合法的比例：${JSON.stringify(value)}（要求形如 "0.30"）`,
      { details: { field, value } }
    );
  }

  const text = value.trim();
  const [intPart, fracPart = ''] = text.split('.');
  return Number(BigInt(intPart) * 10000n + BigInt((fracPart + '0000').slice(0, 4)));
}

/**
 * 把交易数量规范为正整数。
 * 明确拒绝：0、负数、小数、非数字、超出安全整数范围。
 * @param {unknown} value
 * @returns {number}
 */
function parseQuantity(value) {
  let quantity;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw invalidQuantity(value);
    }
    quantity = value;
  } else if (typeof value === 'string' && /^\d{1,10}$/.test(value.trim())) {
    quantity = Number(value.trim());
  } else {
    throw invalidQuantity(value);
  }

  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw invalidQuantity(value);
  }
  if (quantity > MAX_QUANTITY) {
    throw new AppError(
      ERROR_CODES.INVALID_QUANTITY,
      `交易数量超出允许范围（上限 ${MAX_QUANTITY}）`,
      { details: { value, max: MAX_QUANTITY }, httpStatus: 422 }
    );
  }
  return quantity;
}

function invalidQuantity(value) {
  return new AppError(
    ERROR_CODES.INVALID_QUANTITY,
    `交易数量必须为正整数，收到 ${JSON.stringify(value)}`,
    { details: { value, rule: 'positive_integer' }, httpStatus: 422 }
  );
}

/** 分 → 两位小数字符串（不含千分位），保证不经过浮点除法。 */
function centsToFixed(cents) {
  if (!Number.isSafeInteger(cents)) {
    throw new TypeError(`cents 必须是安全整数，收到 ${cents}`);
  }
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const intPart = Math.floor(abs / 100);
  const fracPart = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${intPart}.${fracPart}`;
}

/** 整数千分位分隔。 */
function groupThousands(digits) {
  return String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 分 → 带千分位的两位小数金额，例如 10000000 → "100,000.00"。 */
function formatMoney(cents) {
  const fixed = centsToFixed(cents);
  const negative = fixed.startsWith('-');
  const body = negative ? fixed.slice(1) : fixed;
  const [intPart, fracPart] = body.split('.');
  return `${negative ? '-' : ''}${groupThousands(intPart)}.${fracPart}`;
}

/** 数量 → 带千分位的字符串。 */
function formatQuantity(quantity) {
  return groupThousands(quantity);
}

/**
 * 计算占比（百分比 × 100，四舍五入到两位小数）。
 * @param {number} partCents 分子市值
 * @param {number} wholeCents 分母总资产
 * @returns {number} 例：4000 表示 40.00%
 */
function pct2Of(partCents, wholeCents) {
  if (!Number.isSafeInteger(partCents) || !Number.isSafeInteger(wholeCents)) {
    throw new TypeError('pct2Of 只接受整数分');
  }
  if (wholeCents <= 0) {
    return 0;
  }
  const numerator = BigInt(partCents) * 10000n;
  const denominator = BigInt(wholeCents);
  // 四舍五入（half up）：floor((2a + b) / 2b)
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}

/**
 * 精确比较「占比」与「阈值」。
 * @param {number} partCents 分子市值
 * @param {number} wholeCents 分母总资产
 * @param {number} thresholdBps 阈值（万分比，0.30 → 3000）
 * @returns {-1|0|1} 负数表示未达阈值，0 表示恰好等于，正数表示超过
 */
function compareToThreshold(partCents, wholeCents, thresholdBps) {
  if (wholeCents <= 0) {
    return partCents > 0 ? 1 : 0;
  }
  const lhs = BigInt(partCents) * 10000n;
  const rhs = BigInt(wholeCents) * BigInt(thresholdBps);
  if (lhs > rhs) return 1;
  if (lhs < rhs) return -1;
  return 0;
}

/**
 * 万分比阈值 → pct2（0.30 → 3000，即 30.00%）。
 * @param {number} bps
 * @returns {number}
 */
function bpsToPct2(bps) {
  return bps;
}

/** pct2 → "40.00%"（整数运算，不经过浮点）。 */
function formatPct2(pct2) {
  const negative = pct2 < 0;
  const abs = Math.abs(pct2);
  return `${negative ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}%`;
}

/** 万分比阈值 → "30.00%"。 */
function formatBpsAsPct(bps) {
  return formatPct2(bpsToPct2(bps));
}

module.exports = {
  MAX_MONEY_CENTS,
  MAX_QUANTITY,
  parseMoneyToCents,
  parseRatioToBps,
  parseQuantity,
  centsToFixed,
  formatMoney,
  formatQuantity,
  pct2Of,
  compareToThreshold,
  bpsToPct2,
  formatPct2,
  formatBpsAsPct
};
