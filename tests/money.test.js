'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseMoneyToCents,
  parseRatioToBps,
  parseQuantity,
  centsToFixed,
  formatMoney,
  formatQuantity,
  pct2Of,
  compareToThreshold,
  formatPct2,
  formatBpsAsPct
} = require('../src/domain/money');

const { expectAppError } = require('./helpers');

test('金额解析：字符串金额精确转成整数分', () => {
  assert.equal(parseMoneyToCents('20000.00'), 2000000);
  assert.equal(parseMoneyToCents('100'), 10000);
  assert.equal(parseMoneyToCents('0.05'), 5);
  assert.equal(parseMoneyToCents('0.1'), 10);
  assert.equal(parseMoneyToCents(50), 5000);
  assert.equal(parseMoneyToCents(0), 0);
});

test('金额解析：拒绝超过两位小数、负数与非数字', () => {
  expectAppError(() => parseMoneyToCents('1.234'), 'INVALID_PORTFOLIO_DATA');
  expectAppError(() => parseMoneyToCents('-1.00'), 'INVALID_PORTFOLIO_DATA');
  expectAppError(() => parseMoneyToCents('abc'), 'INVALID_PORTFOLIO_DATA');
  expectAppError(() => parseMoneyToCents(1.234), 'INVALID_PORTFOLIO_DATA');
  expectAppError(() => parseMoneyToCents(null), 'INVALID_PORTFOLIO_DATA');
});

test('金额格式化：两位小数 + 千分位', () => {
  assert.equal(centsToFixed(10000000), '100000.00');
  assert.equal(formatMoney(10000000), '100,000.00');
  assert.equal(formatMoney(0), '0.00');
  assert.equal(formatMoney(5), '0.05');
  assert.equal(formatMoney(-123456), '-1,234.56');
  assert.equal(formatQuantity(1234), '1,234');
});

test('占比计算：整数运算四舍五入到两位小数', () => {
  assert.equal(pct2Of(4000000, 10000000), 4000); // 40.00%
  assert.equal(pct2Of(1, 3), 3333); // 33.33%
  assert.equal(pct2Of(2, 3), 6667); // 66.67%（不是 66.66%）
  assert.equal(pct2Of(1, 8), 1250); // 12.50%
  assert.equal(pct2Of(0, 100), 0);
  assert.equal(pct2Of(100, 100), 10000); // 100.00%
  assert.equal(pct2Of(1, 0), 0); // 分母为 0 时不炸，返回 0

  assert.equal(formatPct2(4000), '40.00%');
  assert.equal(formatPct2(3333), '33.33%');
  assert.equal(formatPct2(5), '0.05%');
  assert.equal(formatPct2(-500), '-5.00%');
  assert.equal(formatPct2(10000), '100.00%');
});

test('阈值比较：严格大于，等于阈值不触发', () => {
  const total = 10000000; // 100,000.00
  const singleBps = 3000; // 30.00%

  assert.equal(compareToThreshold(3000000, total, singleBps), 0, '恰好 30% 应判为等于');
  assert.equal(compareToThreshold(3000001, total, singleBps), 1, '30.00001% 应判为超过');
  assert.equal(compareToThreshold(2999999, total, singleBps), -1, '29.99999% 应判为未达');

  const industryBps = 5000;
  assert.equal(compareToThreshold(5000000, total, industryBps), 0, '恰好 50% 应判为等于');
  assert.equal(compareToThreshold(5000001, total, industryBps), 1);
});

test('阈值比较：不会因为浮点误差误判（0.1 + 0.2 场景）', () => {
  // 用整分构造一个「比例恰好等于阈值」的极端例子
  const total = 3000003; // 30,000.03
  const part = 900000; // 恰好 29.99997%…（不足 30%）
  assert.equal(compareToThreshold(part, total, 3000), -1);
  // 900001 分对应比例略高于 30%
  assert.equal(compareToThreshold(900001, total, 3000), 1);
});

test('比例阈值解析：0.30 → 3000 万分比', () => {
  assert.equal(parseRatioToBps('0.30'), 3000);
  assert.equal(parseRatioToBps('0.5'), 5000);
  assert.equal(parseRatioToBps('1'), 10000);
  assert.equal(parseRatioToBps('0.305'), 3050);
  assert.equal(formatBpsAsPct(3000), '30.00%');
  assert.equal(formatBpsAsPct(5000), '50.00%');
  expectAppError(() => parseRatioToBps('abc'), 'INVALID_PORTFOLIO_DATA');
  expectAppError(() => parseRatioToBps('0.30001'), 'INVALID_PORTFOLIO_DATA');
});

test('数量解析：只接受正整数', () => {
  assert.equal(parseQuantity(100), 100);
  assert.equal(parseQuantity('100'), 100);

  ['0', -1, 1.5, '1.5', '', 'abc', null, undefined].forEach((value) => {
    expectAppError(() => parseQuantity(value), 'INVALID_QUANTITY');
  });
  expectAppError(() => parseQuantity(0), 'INVALID_QUANTITY');
  expectAppError(() => parseQuantity(-5), 'INVALID_QUANTITY');
  expectAppError(() => parseQuantity(1.5), 'INVALID_QUANTITY');
  expectAppError(() => parseQuantity(Number.NaN), 'INVALID_QUANTITY');
  expectAppError(() => parseQuantity(1e10), 'INVALID_QUANTITY');
});
