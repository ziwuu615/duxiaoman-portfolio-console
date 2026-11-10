'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

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

const AC03_OPERATIONS = [
  { side: 'SELL', symbol: 'A01', quantity: 100 },
  { side: 'BUY', symbol: 'A02', quantity: 100 }
];

test('健康检查与组合概览接口', async () => {
  await withApp(async ({ baseUrl }) => {
    const health = await request(baseUrl, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.planCount, 0);

    const response = await request(baseUrl, '/api/portfolio');
    assert.equal(response.status, 200);

    const body = response.body;
    assert.equal(body.portfolio.id, 'DEMO-001');
    assert.equal(body.portfolio.currency, 'CNY');
    assert.equal(body.portfolio.snapshotAtDisplay, '2026-11-02 15:00');
    assert.equal(body.analysis.totalAsset.display, '100,000.00');
    assert.equal(body.analysis.cash.display, '20,000.00');
    assert.equal(body.analysis.marketValue.display, '80,000.00');
    assert.equal(body.analysis.weights.cash.display, '20.00%');
    assert.equal(body.analysis.positions.length, 6);
    assert.equal(body.analysis.positions[0].symbol, 'A01');
    assert.equal(body.analysis.positions[0].weight.display, '40.00%');
    assert.equal(body.analysis.positions[0].overThreshold, true);
    assert.equal(body.analysis.industries[0].industry, '科技');
    assert.equal(body.analysis.industries[0].weight.display, '60.00%');
    assert.equal(body.analysis.industries[0].overThreshold, true);
    assert.equal(body.analysis.alerts.length, 2);
    assert.equal(body.analysis.alerts[0].type, 'instrument');
    assert.equal(body.analysis.alerts[0].actual.display, '40.00%');
    assert.equal(body.analysis.alerts[0].threshold.display, '30.00%');
    assert.equal(body.thresholds.single.display, '30.00%');
    assert.equal(body.thresholds.industry.display, '50.00%');
    assert.equal(body.instruments.length, 6);
  });
});

test('模拟接口：顺序两笔操作的对比结果', async () => {
  await withApp(async ({ baseUrl }) => {
    const response = await request(baseUrl, '/api/simulate', {
      method: 'POST',
      body: { operations: AC03_OPERATIONS }
    });
    assert.equal(response.status, 200);

    const body = response.body;
    assert.equal(body.operations.length, 2);
    assert.match(body.operations[0].text, /卖出 A01/);
    assert.equal(body.simulated.cash.display, '25,000.00');
    assert.equal(body.diff.cash.base.display, '20,000.00');
    assert.equal(body.diff.cash.current.display, '25,000.00');
    assert.equal(body.diff.cash.delta.display, '5,000.00');
    assert.equal(body.diff.totalAsset.delta.cents, 0);
    assert.equal(body.diff.totalAsset.invariantHolds, true);

    const a01 = body.diff.positions.find((item) => item.symbol === 'A01');
    assert.equal(a01.baseQuantity, 400);
    assert.equal(a01.currentQuantity, 300);
    assert.equal(a01.quantityDelta, -100);
    assert.equal(a01.currentWeight.display, '30.00%');

    const a02 = body.diff.positions.find((item) => item.symbol === 'A02');
    assert.equal(a02.currentQuantity, 500);
    assert.equal(a02.currentMarketValue.display, '25,000.00');

    const tech = body.diff.industries.find((item) => item.industry === '科技');
    assert.equal(tech.currentWeight.display, '55.00%');
    assert.equal(tech.baseWeight.display, '60.00%');

    assert.equal(body.simulated.alerts.length, 1);
    assert.equal(body.simulated.alerts[0].id, 'industry:科技');
    assert.equal(body.diff.alerts.resolved.length, 1);
    assert.equal(body.diff.alerts.resolved[0].id, 'instrument:A01');
  });
});

test('模拟接口：非法操作返回 422 与可定位的错误码', async () => {
  await withApp(async ({ baseUrl }) => {
    const cases = [
      {
        operations: [{ side: 'BUY', symbol: 'A01', quantity: 201 }],
        status: 422,
        code: 'INSUFFICIENT_CASH'
      },
      {
        operations: [{ side: 'SELL', symbol: 'A01', quantity: 401 }],
        status: 422,
        code: 'INSUFFICIENT_POSITION'
      },
      { operations: [{ side: 'BUY', symbol: 'A01', quantity: 0 }], status: 422, code: 'INVALID_QUANTITY' },
      { operations: [{ side: 'BUY', symbol: 'A01', quantity: -5 }], status: 422, code: 'INVALID_QUANTITY' },
      { operations: [{ side: 'BUY', symbol: 'A01', quantity: 1.5 }], status: 422, code: 'INVALID_QUANTITY' },
      { operations: [{ side: 'BUY', symbol: 'ZZZ', quantity: 1 }], status: 422, code: 'UNKNOWN_SYMBOL' },
      { operations: [{ side: 'HOLD', symbol: 'A01', quantity: 1 }], status: 422, code: 'INVALID_SIDE' },
      { operations: 'not-an-array', status: 400, code: 'INVALID_BODY' }
    ];

    for (const item of cases) {
      const response = await request(baseUrl, '/api/simulate', {
        method: 'POST',
        body: { operations: item.operations }
      });
      assert.equal(response.status, item.status, JSON.stringify(item.operations));
      assert.equal(response.body.error.code, item.code, JSON.stringify(item.operations));
      if (item.status === 422) {
        assert.equal(response.body.error.details.operationIndex, 0);
        assert.equal(typeof response.body.error.message, 'string');
      }
    }

    // 请求体不是合法 JSON
    const badJson = await request(baseUrl, '/api/simulate', { method: 'POST', body: '{"operations": [' });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, 'INVALID_JSON');

    // 失败请求不应留下任何副作用
    const portfolio = await request(baseUrl, '/api/portfolio');
    assert.equal(portfolio.body.analysis.cash.display, '20,000.00');
    assert.equal(portfolio.body.analysis.alerts.length, 2);
  });
});

test('方案接口：创建、列表、详情与名称规范化', async () => {
  await withApp(async ({ baseUrl }, sandbox) => {
    const created = await request(baseUrl, '/api/plans', {
      method: 'POST',
      body: { name: '  AC-03   降低科技集中度  ', operations: AC03_OPERATIONS }
    });
    assert.equal(created.status, 201);
    assert.match(created.body.plan.id, /^PLAN-\d{14}-[A-Z0-9]{4}$/);
    assert.equal(created.body.plan.name, 'AC-03 降低科技集中度');
    assert.equal(created.body.plan.operationCount, 2);
    assert.equal(created.body.plan.summary.cash.display, '25,000.00');
    assert.equal(created.body.plan.summary.alertCount, 1);
    assert.equal(created.body.plan.operationSummary, '卖出 A01×100 → 买入 A02×100');
    assert.equal(created.body.diff.totalAsset.invariantHolds, true);

    const list = await request(baseUrl, '/api/plans');
    assert.equal(list.status, 200);
    assert.equal(list.body.plans.length, 1);
    assert.equal(list.body.plans[0].id, created.body.plan.id);

    const detail = await request(baseUrl, `/api/plans/${created.body.plan.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.integrity.ok, true);
    assert.equal(detail.body.simulated.cash.display, '25,000.00');
    assert.equal(detail.body.diff.totalAsset.delta.cents, 0);
    assert.equal(detail.body.base.cash.display, '20,000.00');
    assert.equal(detail.body.operations.length, 2);

    // 方案写入文件后，原始组合接口不受影响
    const portfolio = await request(baseUrl, '/api/portfolio');
    assert.equal(portfolio.body.analysis.cash.display, '20,000.00');
    assert.equal(portfolio.body.analysis.positions[0].quantity, 400);

    const stored = JSON.parse(await fs.readFile(path.join(sandbox.dataDir, 'plans.json'), 'utf8'));
    assert.equal(stored.plans.length, 1);
    assert.equal(stored.plans[0].base.holdings.length, 6, '方案内冻结了完整基准快照');
    assert.equal(stored.plans[0].summary.cashCents, 2500000);
  });
});

test('方案接口：参数错误与不存在资源', async () => {
  await withApp(async ({ baseUrl }) => {
    const emptyName = await request(baseUrl, '/api/plans', {
      method: 'POST',
      body: { name: '   ', operations: AC03_OPERATIONS }
    });
    assert.equal(emptyName.status, 400);
    assert.equal(emptyName.body.error.code, 'INVALID_PLAN_NAME');

    const longName = await request(baseUrl, '/api/plans', {
      method: 'POST',
      body: { name: 'x'.repeat(41), operations: AC03_OPERATIONS }
    });
    assert.equal(longName.status, 400);
    assert.equal(longName.body.error.code, 'INVALID_PLAN_NAME');

    const noOperations = await request(baseUrl, '/api/plans', {
      method: 'POST',
      body: { name: '空方案', operations: [] }
    });
    assert.equal(noOperations.status, 422);
    assert.equal(noOperations.body.error.code, 'EMPTY_PLAN');

    const invalidOperation = await request(baseUrl, '/api/plans', {
      method: 'POST',
      body: { name: '非法方案', operations: [{ side: 'BUY', symbol: 'A01', quantity: 201 }] }
    });
    assert.equal(invalidOperation.status, 422);
    assert.equal(invalidOperation.body.error.code, 'INSUFFICIENT_CASH');

    const missing = await request(baseUrl, '/api/plans/PLAN-NOT-EXIST');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'PLAN_NOT_FOUND');

    const methodNotAllowed = await request(baseUrl, '/api/plans', { method: 'DELETE' });
    assert.equal(methodNotAllowed.status, 405);
    assert.match(methodNotAllowed.headers.get('allow'), /GET/);

    const unknownApi = await request(baseUrl, '/api/nope');
    assert.equal(unknownApi.status, 404);
    assert.equal(unknownApi.body.error.code, 'NOT_FOUND');
  });
});

test('持久化：重启服务后方案仍可读取且复算一致', async () => {
  const sandbox = await createSandbox();
  let started = await startApp(sandbox.dataDir);

  try {
    const created = await request(started.baseUrl, '/api/plans', {
      method: 'POST',
      body: { name: '重启验证', operations: AC03_OPERATIONS }
    });
    assert.equal(created.status, 201);
    const planId = created.body.plan.id;
    const before = await request(started.baseUrl, `/api/plans/${planId}`);

    await stopApp(started.app);
    started = await startApp(sandbox.dataDir);

    const after = await request(started.baseUrl, `/api/plans/${planId}`);
    assert.equal(after.status, 200);
    assert.deepEqual(after.body.diff, before.body.diff, '重启后复算结果应与保存时完全一致');
    assert.equal(after.body.integrity.ok, true);

    const list = await request(started.baseUrl, '/api/plans');
    assert.equal(list.body.plans.length, 1);
  } finally {
    await stopApp(started.app);
    await sandbox.cleanup();
  }
});

test('方案文件损坏时隔离备份并以空方案列表启动', async () => {
  const sandbox = await createSandbox();
  await fs.writeFile(path.join(sandbox.dataDir, 'plans.json'), '{ 这不是 JSON', 'utf8');

  const started = await startApp(sandbox.dataDir);
  try {
    const list = await request(started.baseUrl, '/api/plans');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.plans, []);

    const files = await fs.readdir(sandbox.dataDir);
    assert.equal(
      files.some((name) => name.startsWith('plans.json.corrupt-')),
      true,
      '损坏文件应被备份'
    );

    // 仍可正常保存新方案
    const created = await request(started.baseUrl, '/api/plans', {
      method: 'POST',
      body: { name: '损坏后新建', operations: [{ side: 'BUY', symbol: 'A06', quantity: 1 }] }
    });
    assert.equal(created.status, 201);
  } finally {
    await stopApp(started.app);
    await sandbox.cleanup();
  }
});

test('并发保存不丢方案', async () => {
  await withApp(async ({ baseUrl }, sandbox) => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        request(baseUrl, '/api/plans', {
          method: 'POST',
          body: {
            name: `并发方案 ${index + 1}`,
            operations: [{ side: 'BUY', symbol: 'A06', quantity: index + 1 }]
          }
        })
      )
    );

    responses.forEach((response) => assert.equal(response.status, 201));
    const ids = new Set(responses.map((response) => response.body.plan.id));
    assert.equal(ids.size, 5, '方案编号不能重复');

    const list = await request(baseUrl, '/api/plans');
    assert.equal(list.body.plans.length, 5);

    const stored = JSON.parse(await fs.readFile(path.join(sandbox.dataDir, 'plans.json'), 'utf8'));
    assert.equal(stored.plans.length, 5);
  });
});

test('数据文件带 UTF-8 BOM 时仍能正常启动', async () => {
  const sandbox = await createSandbox();
  const seed = require('../data/portfolio.json');
  const bom = '\uFEFF';
  await fs.writeFile(
    path.join(sandbox.dataDir, 'portfolio.json'),
    `${bom}${JSON.stringify(seed, null, 2)}`,
    'utf8'
  );
  await fs.writeFile(
    path.join(sandbox.dataDir, 'plans.json'),
    `${bom}${JSON.stringify({ schemaVersion: 1, updatedAt: null, plans: [] }, null, 2)}`,
    'utf8'
  );

  const started = await startApp(sandbox.dataDir);
  try {
    const portfolio = await request(started.baseUrl, '/api/portfolio');
    assert.equal(portfolio.status, 200);
    assert.equal(portfolio.body.analysis.totalAsset.display, '100,000.00');

    const plans = await request(started.baseUrl, '/api/plans');
    assert.equal(plans.status, 200);
    assert.deepEqual(plans.body.plans, []);
  } finally {
    await stopApp(started.app);
    await sandbox.cleanup();
  }
});

test('方案完整性校验：指纹不一致时 integrity.ok=false', async () => {
  const sandbox = await createSandbox();
  let started = await startApp(sandbox.dataDir);

  try {
    const created = await request(started.baseUrl, '/api/plans', {
      method: 'POST',
      body: { name: '指纹校验', operations: AC03_OPERATIONS }
    });
    assert.equal(created.status, 201);
    const planId = created.body.plan.id;

    // 直接篡改文件中的提醒数指纹，模拟"数据被手改/口径漂移"
    const file = path.join(sandbox.dataDir, 'plans.json');
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    stored.plans[0].summary.alertCount = 99;
    await fs.writeFile(file, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');

    await stopApp(started.app);
    started = await startApp(sandbox.dataDir);

    const detail = await request(started.baseUrl, `/api/plans/${planId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.integrity.ok, false);
    assert.equal(detail.body.integrity.recomputedAlertCount, 1);
    assert.equal(detail.body.integrity.storedAlertCount, 99);
  } finally {
    await stopApp(started.app);
    await sandbox.cleanup();
  }
});

test('静态资源与路径安全', async () => {
  await withApp(async ({ baseUrl }) => {
    const index = await fetch(`${baseUrl}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    const html = await index.text();
    assert.match(html, /投资组合分析与调仓模拟/);

    const css = await fetch(`${baseUrl}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const script = await fetch(`${baseUrl}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);

    const traversal = await fetch(`${baseUrl}/%2e%2e/data/portfolio.json`);
    assert.notEqual(traversal.status, 200);
    const traversalText = await traversal.text();
    assert.equal(traversalText.includes('DEMO-001'), false, '不应能读到数据目录文件');

    const missingPage = await fetch(`${baseUrl}/pages/nope.html`);
    assert.equal(missingPage.status, 404);
  });
});
