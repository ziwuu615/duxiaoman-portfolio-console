'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPortfolio, createPortfolioFromFrozen, freezeBase, UNKNOWN_INDUSTRY } = require('../src/domain/portfolio');
const { analyze, createInitialState, simulate, MAX_OPERATIONS } = require('../src/domain/engine');
const seedData = require('../data/portfolio.json');

const { expectAppError } = require('./helpers');
const { serializeAnalysis } = require('../src/domain/serialize');

const portfolio = createPortfolio(seedData);
const baseAnalysis = analyze(createInitialState(portfolio), portfolio);

function cloneSeed(mutator) {
  const raw = JSON.parse(JSON.stringify(seedData));
  mutator(raw);
  return raw;
}

test('AC-01 初始组合：总资产 100,000.00、现金 20,000.00、两项提醒', () => {
  assert.equal(baseAnalysis.totalAssetCents, 10000000);
  assert.equal(baseAnalysis.cashCents, 2000000);
  assert.equal(baseAnalysis.marketValueCents, 8000000);

  const a01 = baseAnalysis.positions.find((item) => item.symbol === 'A01');
  assert.equal(a01.quantity, 400);
  assert.equal(a01.marketValueCents, 4000000);
  assert.equal(a01.weightPct2, 4000, 'A01 占比应为 40.00%');
  assert.equal(a01.overSingleThreshold, true);

  const a02 = baseAnalysis.positions.find((item) => item.symbol === 'A02');
  assert.equal(a02.weightPct2, 2000);
  assert.equal(a02.overSingleThreshold, false, 'A02 20% 不应触发');

  const tech = baseAnalysis.industries.find((item) => item.industry === '科技');
  assert.equal(tech.marketValueCents, 6000000);
  assert.equal(tech.weightPct2, 6000);
  assert.equal(tech.overIndustryThreshold, true);

  const untouched = baseAnalysis.industries.filter((item) => item.industry !== '科技');
  assert.deepEqual(
    untouched.map((item) => item.weightPct2),
    [1000, 500, 300, 200],
    '医疗/消费/能源/工业分别为 10%/5%/3%/2%'
  );
  untouched.forEach((item) => assert.equal(item.overIndustryThreshold, false));

  assert.equal(baseAnalysis.alerts.length, 2);
  assert.deepEqual(
    baseAnalysis.alerts.map((item) => item.id),
    ['instrument:A01', 'industry:科技']
  );
  assert.equal(baseAnalysis.counts.heldInstruments, 6);
  assert.equal(baseAnalysis.counts.industries, 5);
});

test('AC-02 阈值边界：卖出 A01 100 股后 30%/50% 恰好等于阈值，提醒全部解除', () => {
  const result = simulate(portfolio, [{ side: 'SELL', symbol: 'A01', quantity: 100 }]);
  const analysis = result.analysis;

  assert.equal(analysis.cashCents, 3000000, '现金应为 30,000.00');
  assert.equal(analysis.totalAssetCents, 10000000, '总资产不变');

  const a01 = analysis.positions.find((item) => item.symbol === 'A01');
  assert.equal(a01.quantity, 300);
  assert.equal(a01.marketValueCents, 3000000);
  assert.equal(a01.weightPct2, 3000);
  assert.equal(a01.overSingleThreshold, false, '占比 30.00% 等于阈值，不提醒');

  const tech = analysis.industries.find((item) => item.industry === '科技');
  assert.equal(tech.marketValueCents, 5000000);
  assert.equal(tech.weightPct2, 5000);
  assert.equal(tech.overIndustryThreshold, false, '行业 50.00% 等于阈值，不提醒');

  assert.equal(analysis.alerts.length, 0);
});

test('AC-03 连续操作：再买入 A02 100 股后行业占比 55%，再次触发行业提醒', () => {
  const result = simulate(portfolio, [
    { side: 'SELL', symbol: 'A01', quantity: 100 },
    { side: 'BUY', symbol: 'A02', quantity: 100 }
  ]);
  const analysis = result.analysis;

  assert.equal(analysis.cashCents, 2500000, '现金应为 25,000.00');
  assert.equal(analysis.totalAssetCents, 10000000, '总资产不变');

  const a02 = analysis.positions.find((item) => item.symbol === 'A02');
  assert.equal(a02.quantity, 500);
  assert.equal(a02.marketValueCents, 2500000);

  const tech = analysis.industries.find((item) => item.industry === '科技');
  assert.equal(tech.weightPct2, 5500);
  assert.equal(tech.overIndustryThreshold, true);

  assert.equal(analysis.alerts.length, 1);
  assert.equal(analysis.alerts[0].id, 'industry:科技');

  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].cashAfterCents, 3000000);
  assert.equal(result.steps[1].cashAfterCents, 2500000);
});

test('AC-04 无效操作：201 股 / 401 股 / 0 / 负数 / 小数 均被拒绝', () => {
  const cashError = expectAppError(
    () => simulate(portfolio, [{ side: 'BUY', symbol: 'A01', quantity: 201 }]),
    'INSUFFICIENT_CASH'
  );
  assert.equal(cashError.details.operationIndex, 0);
  assert.equal(cashError.details.requiredCents, 2010000);
  assert.equal(cashError.details.availableCents, 2000000);
  assert.equal(cashError.details.shortfallCents, 10000);

  const positionError = expectAppError(
    () => simulate(portfolio, [{ side: 'SELL', symbol: 'A01', quantity: 401 }]),
    'INSUFFICIENT_POSITION'
  );
  assert.equal(positionError.details.availableQuantity, 400);
  assert.equal(positionError.details.requestedQuantity, 401);

  [0, -5, 1.5, '1.5', '', null].forEach((quantity) => {
    expectAppError(() => simulate(portfolio, [{ side: 'BUY', symbol: 'A01', quantity }]), 'INVALID_QUANTITY');
  });

  expectAppError(() => simulate(portfolio, [{ side: 'BUY', symbol: 'A99', quantity: 1 }]), 'UNKNOWN_SYMBOL');
  expectAppError(() => simulate(portfolio, [{ side: 'HOLD', symbol: 'A01', quantity: 1 }]), 'INVALID_SIDE');

  // 失败后原始组合与基准分析都不应被改动
  assert.equal(portfolio.cashCents, 2000000);
  assert.equal(portfolio.instruments.get('A01').initialQuantity, 400);
  const after = analyze(createInitialState(portfolio), portfolio);
  assert.equal(after.totalAssetCents, 10000000);
  assert.equal(after.alerts.length, 2);
});

test('整组操作的原子性：中间一笔失败时整组不生效，并指出失败序号', () => {
  const error = expectAppError(
    () =>
      simulate(portfolio, [
        { side: 'SELL', symbol: 'A01', quantity: 100 },
        { side: 'SELL', symbol: 'A01', quantity: 401 }
      ]),
    'INSUFFICIENT_POSITION'
  );
  assert.equal(error.details.operationIndex, 1, '应指出第 2 笔操作失败');
  assert.equal(error.details.availableQuantity, 300, '失败时应使用前一笔之后的状态判断');
});

test('顺序执行：后一笔操作使用前一笔的结果', () => {
  const result = simulate(portfolio, [
    { side: 'SELL', symbol: 'A01', quantity: 400 },
    { side: 'BUY', symbol: 'A01', quantity: 200 }
  ]);
  const a01 = result.analysis.positions.find((item) => item.symbol === 'A01');
  assert.equal(a01.quantity, 200);
  assert.equal(result.analysis.cashCents, 4000000, '20,000 + 40,000 - 20,000 = 40,000.00');

  // 先卖光再卖 1 股必须失败，说明后续操作确实基于前序结果
  expectAppError(
    () =>
      simulate(portfolio, [
        { side: 'SELL', symbol: 'A01', quantity: 400 },
        { side: 'SELL', symbol: 'A01', quantity: 1 }
      ]),
    'INSUFFICIENT_POSITION'
  );
});

test('现金与总资产守恒：任意合法操作序列都不改变总资产', () => {
  const sequences = [
    [{ side: 'BUY', symbol: 'A03', quantity: 50 }],
    [{ side: 'SELL', symbol: 'A02', quantity: 400 }],
    [
      { side: 'SELL', symbol: 'A01', quantity: 100 },
      { side: 'SELL', symbol: 'A01', quantity: 100 },
      { side: 'BUY', symbol: 'A04', quantity: 100 }
    ]
  ];
  for (const operations of sequences) {
    const result = simulate(portfolio, operations);
    assert.equal(result.analysis.totalAssetCents, baseAnalysis.totalAssetCents);
    assert.equal(result.analysis.cashCents >= 0, true);
  }
});

test('现金刚好够买：买入 A06 200 股后现金为 0，总资产不变', () => {
  const result = simulate(portfolio, [{ side: 'BUY', symbol: 'A06', quantity: 200 }]);
  assert.equal(result.analysis.cashCents, 0, '200 × 100.00 = 20,000.00，正好用完全部现金');
  assert.equal(result.analysis.positions.find((item) => item.symbol === 'A06').quantity, 220);
  assert.equal(result.analysis.totalAssetCents, baseAnalysis.totalAssetCents);
  // 现金为 0 时现金占比应为 0.00%，且不应出现除以 0 的异常
  assert.equal(serializeAnalysis(result.analysis, portfolio).weights.cash.display, '0.00%');
});

test('操作数量上限', () => {
  const tooMany = Array.from({ length: MAX_OPERATIONS + 1 }, () => ({ side: 'BUY', symbol: 'A06', quantity: 1 }));
  expectAppError(() => simulate(portfolio, tooMany), 'TOO_MANY_OPERATIONS');
});

test('模拟与原始组合隔离：simulate 不修改 portfolio 与基准分析', () => {
  const before = JSON.stringify(Array.from(portfolio.instruments.values()));
  simulate(portfolio, [{ side: 'BUY', symbol: 'A05', quantity: 10 }]);
  const after = JSON.stringify(Array.from(portfolio.instruments.values()));
  assert.equal(after, before);
  assert.equal(portfolio.cashCents, 2000000);
});

test('冻结快照可复算：方案重开走同一条计算路径且结果一致', () => {
  const operations = [
    { side: 'SELL', symbol: 'A01', quantity: 100 },
    { side: 'BUY', symbol: 'A02', quantity: 100 }
  ];
  const original = simulate(portfolio, operations);
  const frozen = freezeBase(portfolio);
  const restored = createPortfolioFromFrozen(frozen, {
    singleThresholdBps: portfolio.rules.singleThresholdBps,
    industryThresholdBps: portfolio.rules.industryThresholdBps
  });
  const replayed = simulate(restored, operations);

  assert.deepEqual(replayed.analysis, original.analysis);
  assert.deepEqual(
    serializeAnalysis(replayed.analysis, restored),
    serializeAnalysis(original.analysis, portfolio)
  );
});

test('行业缺失时归入「未分类」并给出警告', () => {
  const raw = cloneSeed((data) => {
    data.instruments[3].industry = '';
    delete data.instruments[4].industry;
  });
  const parsed = createPortfolio(raw);
  assert.equal(parsed.instruments.get('A04').industry, UNKNOWN_INDUSTRY);
  assert.equal(parsed.instruments.get('A05').industry, UNKNOWN_INDUSTRY);
  assert.equal(parsed.warnings.length, 2);
});

test('不支持的规则口径在启动期直接失败', () => {
  expectAppError(
    () => createPortfolio(cloneSeed((data) => (data.rules.comparison = 'greater_or_equal'))),
    'INVALID_PORTFOLIO_DATA'
  );
  expectAppError(
    () => createPortfolio(cloneSeed((data) => (data.rules.cash_in_denominator = false))),
    'INVALID_PORTFOLIO_DATA'
  );
  expectAppError(
    () => createPortfolio(cloneSeed((data) => (data.rules.fees = '1.00'))),
    'INVALID_PORTFOLIO_DATA'
  );
  expectAppError(
    () => createPortfolio(cloneSeed((data) => (data.instruments[0].quantity = 0))),
    'INVALID_PORTFOLIO_DATA'
  );
  expectAppError(
    () => createPortfolio(cloneSeed((data) => (data.instruments[1].symbol = 'A01'))),
    'INVALID_PORTFOLIO_DATA'
  );
});
