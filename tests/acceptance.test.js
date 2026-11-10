'use strict';

/**
 * 基准验收用例（对应任务书 4.1 AC-01 ~ AC-05）
 *
 * 这一组测试刻意只通过 HTTP 接口验证，不直接调用领域函数，
 * 保证「评审者按 README 启动后能看到的结果」与「自动化验收结果」是同一件事。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSandbox, startApp, stopApp, request } = require('./helpers');

async function withApp(fn) {
  const sandbox = await createSandbox();
  const started = await startApp(sandbox.dataDir);
  try {
    await fn(started, sandbox);
  } finally {
    await stopApp(started.app);
    await sandbox.cleanup();
  }
}

function positionOf(analysis, symbol) {
  return analysis.positions.find((item) => item.symbol === symbol);
}

function industryOf(analysis, industry) {
  return analysis.industries.find((item) => item.industry === industry);
}

test('AC-01 初始组合：总资产 100,000.00、现金 20,000.00、A01 40% 与科技 60% 均触发提醒', async () => {
  await withApp(async ({ baseUrl }) => {
    const { body } = await request(baseUrl, '/api/portfolio');

    assert.equal(body.analysis.totalAsset.display, '100,000.00');
    assert.equal(body.analysis.cash.display, '20,000.00');
    assert.equal(body.analysis.counts.heldInstruments, 6);
    assert.equal(body.analysis.counts.totalQuantity, 1050);
    assert.equal(body.analysis.counts.totalQuantityDisplay, '1,050');

    const a01 = positionOf(body.analysis, 'A01');
    assert.equal(a01.weight.display, '40.00%');
    assert.equal(a01.overThreshold, true);

    const tech = industryOf(body.analysis, '科技');
    assert.equal(tech.weight.display, '60.00%');
    assert.equal(tech.overThreshold, true);

    assert.equal(body.analysis.alerts.length, 2);
    const statements = body.analysis.alerts.map((alert) => alert.statement).join(' | ');
    assert.match(statements, /A01 星河科技 占比 40\.00%，超过阈值 30\.00%/);
    assert.match(statements, /行业「科技」合计占比 60\.00%，超过阈值 50\.00%/);

    // 其他标的/行业均不超限
    body.analysis.positions
      .filter((position) => position.symbol !== 'A01')
      .forEach((position) => assert.equal(position.overThreshold, false));
    body.analysis.industries
      .filter((bucket) => bucket.industry !== '科技')
      .forEach((bucket) => assert.equal(bucket.overThreshold, false));
  });
});

test('AC-02 阈值边界：卖 A01 100 股后，30%/50% 恰好等于阈值，两项提醒解除', async () => {
  await withApp(async ({ baseUrl }) => {
    const { body } = await request(baseUrl, '/api/simulate', {
      method: 'POST',
      body: { operations: [{ side: 'SELL', symbol: 'A01', quantity: 100 }] }
    });

    assert.equal(body.simulated.cash.display, '30,000.00');
    assert.equal(positionOf(body.simulated, 'A01').marketValue.display, '30,000.00');
    assert.equal(positionOf(body.simulated, 'A01').weight.display, '30.00%');
    assert.equal(positionOf(body.simulated, 'A01').overThreshold, false);
    assert.equal(industryOf(body.simulated, '科技').weight.display, '50.00%');
    assert.equal(industryOf(body.simulated, '科技').overThreshold, false);

    assert.equal(body.simulated.alerts.length, 0);
    assert.equal(body.diff.alerts.base.length, 2);
    assert.equal(body.diff.alerts.resolved.length, 2);
    assert.equal(body.diff.totalAsset.delta.display, '0.00');
    assert.equal(body.diff.totalAsset.invariantHolds, true);
  });
});

test('AC-03 连续操作：接 AC-02 再买 A02 100 股，现金 25,000.00、行业 55% 再次触发', async () => {
  await withApp(async ({ baseUrl }) => {
    const { body } = await request(baseUrl, '/api/simulate', {
      method: 'POST',
      body: {
        operations: [
          { side: 'SELL', symbol: 'A01', quantity: 100 },
          { side: 'BUY', symbol: 'A02', quantity: 100 }
        ]
      }
    });

    assert.equal(body.simulated.cash.display, '25,000.00');
    assert.equal(positionOf(body.simulated, 'A02').quantity, 500);
    assert.equal(positionOf(body.simulated, 'A02').marketValue.display, '25,000.00');
    assert.equal(industryOf(body.simulated, '科技').weight.display, '55.00%');
    assert.equal(industryOf(body.simulated, '科技').overThreshold, true);

    assert.equal(body.simulated.alerts.length, 1);
    assert.equal(body.simulated.alerts[0].type, 'industry');
    assert.equal(body.simulated.alerts[0].key, '科技');

    assert.equal(body.simulated.totalAsset.display, '100,000.00');
    assert.equal(body.diff.totalAsset.invariantHolds, true);
  });
});

test('AC-04 无效操作：从原组合测试 201 股买入、401 股卖出、0/负数/小数，后端全部拒绝且不改变有效结果', async () => {
  await withApp(async ({ baseUrl }) => {
    const cases = [
      { title: '买入 A01 201 股（现金不足）', operations: [{ side: 'BUY', symbol: 'A01', quantity: 201 }], code: 'INSUFFICIENT_CASH' },
      { title: '卖出 A01 401 股（超过持仓）', operations: [{ side: 'SELL', symbol: 'A01', quantity: 401 }], code: 'INSUFFICIENT_POSITION' },
      { title: '数量为 0', operations: [{ side: 'BUY', symbol: 'A01', quantity: 0 }], code: 'INVALID_QUANTITY' },
      { title: '数量为负数', operations: [{ side: 'BUY', symbol: 'A01', quantity: -10 }], code: 'INVALID_QUANTITY' },
      { title: '数量为小数', operations: [{ side: 'BUY', symbol: 'A01', quantity: 1.5 }], code: 'INVALID_QUANTITY' }
    ];

    for (const item of cases) {
      const response = await request(baseUrl, '/api/simulate', {
        method: 'POST',
        body: { operations: item.operations }
      });
      assert.equal(response.status, 422, `${item.title} 应返回 422`);
      assert.equal(response.body.error.code, item.code, `${item.title} 错误码`);
      assert.equal(response.body.error.details.operationIndex, 0, `${item.title} 应指出失败的操作序号`);
      assert.equal(typeof response.body.error.message, 'string');
      assert.equal(response.body.error.message.length > 0, true);
    }

    // 有效结果不因失败请求而改变
    const portfolio = await request(baseUrl, '/api/portfolio');
    assert.equal(portfolio.body.analysis.cash.display, '20,000.00');
    assert.equal(positionOf(portfolio.body.analysis, 'A01').quantity, 400);
    assert.equal(portfolio.body.analysis.alerts.length, 2);
    assert.equal(portfolio.body.analysis.totalAsset.display, '100,000.00');

    const plans = await request(baseUrl, '/api/plans');
    assert.equal(plans.body.plans.length, 0, '失败请求不应产生方案');
  });
});

test('AC-05 持久化与隔离：保存 AC-03 方案，重启后重开结果不变，原始组合仍为 20,000.00 / A01 400 / A02 400', async () => {
  const sandbox = await createSandbox();
  let started = await startApp(sandbox.dataDir);

  try {
    const created = await request(started.baseUrl, '/api/plans', {
      method: 'POST',
      body: {
        name: 'AC-03 降低科技集中度',
        operations: [
          { side: 'SELL', symbol: 'A01', quantity: 100 },
          { side: 'BUY', symbol: 'A02', quantity: 100 }
        ]
      }
    });
    assert.equal(created.status, 201);
    const planId = created.body.plan.id;
    const savedDiff = created.body.diff;

    const beforeRestart = await request(started.baseUrl, `/api/plans/${planId}`);
    assert.equal(beforeRestart.body.integrity.ok, true);

    // 模拟重启服务（关闭后重新创建应用，读取同一个数据目录）
    await stopApp(started.app);
    started = await startApp(sandbox.dataDir);

    const afterRestart = await request(started.baseUrl, `/api/plans/${planId}`);
    assert.equal(afterRestart.status, 200);
    assert.equal(afterRestart.body.plan.name, 'AC-03 降低科技集中度');
    assert.deepEqual(afterRestart.body.diff, savedDiff, '重开结果应与保存时一致');
    assert.equal(afterRestart.body.simulated.cash.display, '25,000.00');
    assert.equal(afterRestart.body.simulated.totalAsset.display, '100,000.00');
    assert.equal(afterRestart.body.integrity.ok, true);

    // 原始组合完全不受方案影响
    const portfolio = await request(started.baseUrl, '/api/portfolio');
    assert.equal(portfolio.body.analysis.cash.display, '20,000.00');
    assert.equal(positionOf(portfolio.body.analysis, 'A01').quantity, 400);
    assert.equal(positionOf(portfolio.body.analysis, 'A02').quantity, 400);
    assert.equal(portfolio.body.analysis.totalAsset.display, '100,000.00');
    assert.equal(portfolio.body.analysis.alerts.length, 2);

    const list = await request(started.baseUrl, '/api/plans');
    assert.equal(list.body.plans.length, 1);
  } finally {
    await stopApp(started.app);
    await sandbox.cleanup();
  }
});
