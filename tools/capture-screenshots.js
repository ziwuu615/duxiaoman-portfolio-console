'use strict';

/**
 * 关键页面截图（同时是一次端到端验证）
 *
 * 用真实浏览器（Edge / Chrome）通过 CDP 驱动页面完成：
 *   初始组合 → 顺序两笔调仓（AC-02/AC-03）→ 无效操作被拒（AC-04）
 *   → 保存方案 → 重启服务 + 刷新页面 + 重新打开（AC-05）
 * 每一步都断言预期结果，断言失败会抛错并且不产出截图，避免「截图看起来对、
 * 实际数字错」的情况。
 *
 * 用法：node tools/capture-screenshots.js
 *       BROWSER_PATH="C:\...\msedge.exe" node tools/capture-screenshots.js
 *
 * 该脚本只用于生成本仓库的验证材料，不参与运行时；
 * 它会使用临时数据目录，不会污染 data/plans.json。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { createApplication } = require('../src/app');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const SEED_FILE = path.join(ROOT, 'data', 'portfolio.json');
const VIEWPORT = { width: 1440, height: 1040, deviceScaleFactor: 1.5 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  process.stdout.write(`  ${message}\n`);
}

/* ---------------- 浏览器 ---------------- */

function findBrowser() {
  const candidates = [
    process.env.BROWSER_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome SxS', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('未找到 Edge/Chrome。请用 BROWSER_PATH 环境变量指定浏览器可执行文件路径。');
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

async function launchBrowser(executable, debuggingPort, userDataDir) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--metrics-recording-only',
    `--remote-debugging-port=${debuggingPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    'about:blank'
  ];

  const child = spawn(executable, args, { stdio: 'ignore', windowsHide: true });

  const deadline = Date.now() + 20000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const version = await fetchJson(`http://127.0.0.1:${debuggingPort}/json/version`);
      if (version.webSocketDebuggerUrl) {
        return { child, webSocketDebuggerUrl: version.webSocketDebuggerUrl };
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  child.kill();
  throw new Error(`浏览器调试端口未就绪：${lastError ? lastError.message : '超时'}`);
}

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();

    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          entry.reject(new Error(`CDP ${message.method || ''} ${message.error.message} (${message.error.code})`));
        } else {
          entry.resolve(message.result || {});
        }
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 调用超时：${method}`));
        }
      }, 30000);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function connectCdp(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const onOpen = () => resolve();
    const onError = () => reject(new Error('无法连接浏览器调试 WebSocket'));
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError, { once: true });
  });
  return new CdpConnection(ws);
}

/* ---------------- 主流程 ---------------- */

async function main() {
  if (!fs.existsSync(SEED_FILE)) {
    throw new Error(`缺少初始数据：${SEED_FILE}`);
  }

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'portfolio-capture-'));
  const dataDir = path.join(tempRoot, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.copyFile(SEED_FILE, path.join(dataDir, 'portfolio.json'));
  await fsp.writeFile(
    path.join(dataDir, 'plans.json'),
    `${JSON.stringify({ schemaVersion: 1, updatedAt: null, plans: [] }, null, 2)}\n`,
    'utf8'
  );

  await fsp.mkdir(OUT_DIR, { recursive: true });
  for (const name of fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR) : []) {
    if (name.endsWith('.png')) {
      await fsp.rm(path.join(OUT_DIR, name), { force: true });
    }
  }

  const logger = { log() {}, warn() {}, error: (...args) => console.error(...args) };
  let app = await createApplication({ dataDir, logger });
  let baseUrl = await listen(app, 0);
  log(`服务已启动：${baseUrl}（临时数据目录 ${dataDir}）`);

  const executable = findBrowser();
  log(`浏览器：${executable}`);

  const debuggingPort = 9333;
  const userDataDir = path.join(tempRoot, 'browser-profile');
  const browser = await launchBrowser(executable, debuggingPort, userDataDir);
  let cdp = null;

  try {
    cdp = await connectCdp(browser.webSocketDebuggerUrl);
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sessionId = attached.sessionId;

    const send = (method, params) => cdp.send(method, params, sessionId);

    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
      });
      if (result.exceptionDetails) {
        throw new Error(`页面脚本异常：${result.exceptionDetails.text} ${JSON.stringify(result.exceptionDetails.exception || {})}`);
      }
      return result.result.value;
    };

    const waitFor = async (expression, label, timeout = 20000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try {
          if (await evaluate(expression)) {
            return;
          }
        } catch {
          /* 页面可能正在导航，重试 */
        }
        await sleep(100);
      }
      throw new Error(`等待超时：${label}`);
    };

    const setSelect = (testId, value) =>
      evaluate(
        `(() => { const el = document.querySelector('[data-testid="${testId}"]');` +
          ` el.value = ${JSON.stringify(value)};` +
          ` el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`
      );

    const setInput = (testId, value) =>
      evaluate(
        `(() => { const el = document.querySelector('[data-testid="${testId}"]');` +
          ` el.value = ${JSON.stringify(value)};` +
          ` el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()`
      );

    const click = (testId, index = 0) =>
      evaluate(
        `(() => { const list = document.querySelectorAll('[data-testid="${testId}"]');` +
          ` const el = list[${index}]; if (!el) { throw new Error('找不到元素 ${testId}[${index}]'); }` +
          ` el.click(); return true; })()`
      );

    // 上一笔请求结束时按钮会短暂 disabled，直接点击会被浏览器忽略，因此先等按钮恢复可用。
    const clickWhenEnabled = async (testId, label) => {
      await waitFor(
        `!!document.querySelector('[data-testid="${testId}"]') && document.querySelector('[data-testid="${testId}"]').disabled === false`,
        `${label || testId} 按钮可用`
      );
      await click(testId);
    };

    const screenshot = async (fileName) => {
      // 轻提示是 fixed 定位，全页截图时位置会漂到页面中部遮住内容，截图前统一清理。
      await evaluate(`document.querySelectorAll('.toast').forEach((node) => node.remove()); true`);
      const metrics = await send('Page.getLayoutMetrics');
      const size = metrics.cssContentSize || metrics.contentSize;
      const width = Math.max(VIEWPORT.width, Math.ceil(size.width));
      const height = Math.max(640, Math.ceil(size.height));
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 }
      });
      const file = path.join(OUT_DIR, fileName);
      await fsp.writeFile(file, Buffer.from(shot.data, 'base64'));
      log(`截图 ${fileName}（${width}×${height} CSS px）`);
      return file;
    };

    const openPage = async (url) => {
      await send('Emulation.setDeviceMetricsOverride', {
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        deviceScaleFactor: VIEWPORT.deviceScaleFactor,
        mobile: false
      });
      await send('Page.enable');
      await send('Page.navigate', { url });
      await waitFor(`document.readyState === 'complete'`, '页面加载完成');
      await waitFor(`document.body.dataset.state === 'ready'`, '前端初始化完成');
      await sleep(250);
    };

    /* ---- 01 初始组合 ---- */
    await openPage(`${baseUrl}/`);
    const initial = await evaluate(`(() => ({
      total: document.querySelector('[data-testid="kpi-total"]').textContent.trim(),
      cash: document.querySelector('[data-testid="kpi-cash"]').textContent.trim(),
      alerts: document.querySelector('[data-testid="kpi-alert"]').textContent.trim()
    }))()`);
    assertEqual(initial.total, '100,000.00', 'AC-01 总资产');
    assertEqual(initial.cash, '20,000.00', 'AC-01 现金');
    assertEqual(initial.alerts, '2', 'AC-01 触发提醒数');
    await screenshot('01-overview.png');

    /* ---- 02 顺序调仓：卖 A01 100 → 买 A02 100（AC-02 + AC-03） ---- */
    await setSelect('op-symbol', 'A01');
    await setSelect('op-side', 'SELL');
    await setInput('op-quantity', '100');
    await clickWhenEnabled('op-add', '添加操作');
    await waitFor(`document.querySelectorAll('[data-testid="op-item"]').length === 1`, '第 1 笔操作生效');
    await waitFor(`document.querySelector('[data-testid="kpi-cash"]').textContent.trim() === '30,000.00'`, 'AC-02 现金 30,000.00');

    await setSelect('op-symbol', 'A02');
    await setSelect('op-side', 'BUY');
    await setInput('op-quantity', '100');
    await clickWhenEnabled('op-add', '添加操作');
    await waitFor(`document.querySelectorAll('[data-testid="op-item"]').length === 2`, '第 2 笔操作生效');
    await waitFor(`document.querySelector('[data-testid="kpi-cash"]').textContent.trim() === '25,000.00'`, 'AC-03 现金 25,000.00');
    await waitFor(`document.querySelector('[data-testid="kpi-total"]').textContent.trim() === '100,000.00'`, 'AC-03 总资产不变');
    await waitFor(`document.querySelectorAll('[data-testid="alert-card"]').length === 1`, 'AC-03 仅行业提醒');

    const compare = await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="holding-row"]')).map((row) => row.getAttribute('data-symbol'));
      const a01 = document.querySelector('[data-testid="holding-row"][data-symbol="A01"]').textContent.replace(/\\s+/g, ' ').trim();
      const a02 = document.querySelector('[data-testid="holding-row"][data-symbol="A02"]').textContent.replace(/\\s+/g, ' ').trim();
      const tech = Array.from(document.querySelectorAll('[data-testid="industry-row"]')).map((row) => row.textContent.replace(/\\s+/g, ' ').trim());
      return { rows, a01, a02, tech };
    })()`);
    assertContains(compare.a01, '300', 'AC-02 A01 模拟数量 300');
    assertContains(compare.a01, '原 400', 'AC-02 展示原始数量 400');
    assertContains(compare.a02, '500', 'AC-03 A02 模拟数量 500');
    assertContains(compare.tech.join(' '), '55.00%', 'AC-03 科技行业占比 55.00%');
    await screenshot('02-simulation-compare.png');

    /* ---- 03 无效操作：从原始组合出发，买入 A01 201 股（现金不足） ----
       任务书 AC-04 要求「分别从原组合测试」，因此先清空刚才的两笔操作。 */
    await evaluate(`document.querySelector('#op-reset').click()`);
    await waitFor(`document.querySelectorAll('[data-testid="op-item"]').length === 0`, '已清空操作序列');
    await waitFor(`document.querySelector('[data-testid="kpi-cash"]').textContent.trim() === '20,000.00'`, '回到原始现金 20,000.00');

    await setSelect('op-symbol', 'A01');
    await setSelect('op-side', 'BUY');
    await setInput('op-quantity', '201');
    await clickWhenEnabled('op-add', '添加操作');
    await waitFor(`document.querySelector('[data-testid="op-error"]').hidden === false`, 'AC-04 错误提示出现');
    const errorState = await evaluate(`(() => ({
      code: document.querySelector('[data-testid="op-error"]').querySelector('.op-error-code').textContent.trim(),
      message: document.querySelector('[data-testid="op-error"]').querySelector('.op-error-msg').textContent.trim(),
      opCount: document.querySelectorAll('[data-testid="op-item"]').length,
      cash: document.querySelector('[data-testid="kpi-cash"]').textContent.trim(),
      alerts: document.querySelector('[data-testid="kpi-alert"]').textContent.trim()
    }))()`);
    assertEqual(errorState.code, 'INSUFFICIENT_CASH', 'AC-04 错误码');
    assertEqual(errorState.opCount, 0, 'AC-04 无效操作未进入操作序列');
    assertEqual(errorState.cash, '20,000.00', 'AC-04 有效结果未被改变');
    assertEqual(errorState.alerts, '2', 'AC-04 原始组合提醒保持不变');
    await screenshot('03-invalid-operation.png');

    /* ---- 04 重建 AC-03 的两笔操作并保存方案 ---- */
    await setSelect('op-symbol', 'A01');
    await setSelect('op-side', 'SELL');
    await setInput('op-quantity', '100');
    await clickWhenEnabled('op-add', '添加操作');
    await waitFor(`document.querySelectorAll('[data-testid="op-item"]').length === 1`, '重建第 1 笔操作');
    await setSelect('op-symbol', 'A02');
    await setSelect('op-side', 'BUY');
    await setInput('op-quantity', '100');
    await clickWhenEnabled('op-add', '添加操作');
    await waitFor(`document.querySelectorAll('[data-testid="op-item"]').length === 2`, '重建第 2 笔操作');
    await waitFor(`document.querySelector('[data-testid="kpi-cash"]').textContent.trim() === '25,000.00'`, 'AC-03 现金复现');

    await setInput('save-name', 'AC-03 降低科技集中度');
    await clickWhenEnabled('save-button', '保存方案');
    await waitFor(`document.querySelectorAll('[data-testid="plan-item"]').length === 1`, '方案已出现在列表');
    await sleep(200);
    const planCards = await evaluate(`(() => ({
      count: document.querySelectorAll('[data-testid="plan-item"]').length,
      toasts: Array.from(document.querySelectorAll('.toast')).map((node) => node.textContent)
    }))()`);
    assertContains(planCards.toasts.join(' | '), '已保存', '保存成功提示');
    await screenshot('04-plan-saved.png');

    const planListBefore = await fetchJson(`${baseUrl}/api/plans`);
    const planId = planListBefore.plans[0].id;
    const detailBefore = await fetchJson(`${baseUrl}/api/plans/${planId}`);

    /* ---- 05 重启服务 → 刷新页面 → 重新打开方案（AC-05） ---- */
    await app.close();
    app = await createApplication({ dataDir, logger });
    baseUrl = await listen(app, 0);
    log(`服务已重启：${baseUrl}（端口变化不影响方案持久化）`);

    const detailAfter = await fetchJson(`${baseUrl}/api/plans/${planId}`);
    assertEqual(
      JSON.stringify(detailAfter.diff),
      JSON.stringify(detailBefore.diff),
      'AC-05 重启后复算结果与保存时一致'
    );

    await openPage(`${baseUrl}/`);
    await waitFor(`document.querySelectorAll('[data-testid="plan-open"]').length === 1`, '重启后方案仍在列表');
    await click('plan-open');
    await waitFor(`document.querySelector('#view-banner').hidden === false`, '进入方案查看模式');
    await waitFor(`document.querySelector('[data-testid="kpi-cash"]').textContent.trim() === '25,000.00'`, 'AC-05 方案现金 25,000.00');
    await sleep(250);

    const reopened = await evaluate(`(() => ({
      total: document.querySelector('[data-testid="kpi-total"]').textContent.trim(),
      cash: document.querySelector('[data-testid="kpi-cash"]').textContent.trim(),
      banner: document.querySelector('#view-banner-text').textContent.trim(),
      rows: Array.from(document.querySelectorAll('[data-testid="holding-row"]')).map((row) => row.getAttribute('data-symbol') + ':' + row.textContent.replace(/\\s+/g, ' ').trim()),
      plans: document.querySelectorAll('[data-testid="plan-item"]').length
    }))()`);
    assertEqual(reopened.total, '100,000.00', 'AC-05 方案总资产');
    assertEqual(reopened.plans, 1, 'AC-05 方案数量');
    assertContains(reopened.banner, 'AC-03 降低科技集中度', 'AC-05 显示方案名称');
    await screenshot('05-plan-reopened-after-restart.png');

    /* ---- 原始组合隔离校验 ---- */
    await evaluate(`document.querySelector('#exit-plan').click()`);
    await waitFor(`document.querySelector('#view-banner').hidden === true`, '退出方案查看');
    const portfolioAfter = await fetchJson(`${baseUrl}/api/portfolio`);
    assertEqual(portfolioAfter.analysis.cash.cents, 2000000, 'AC-05 原始现金仍为 20,000.00');
    assertEqual(portfolioAfter.analysis.positions[0].quantity, 400, 'AC-05 原始 A01 仍为 400 股');
    assertEqual(portfolioAfter.analysis.positions[1].quantity, 400, 'AC-05 原始 A02 仍为 400 股');
    assertEqual(portfolioAfter.analysis.totalAsset.cents, 10000000, 'AC-05 原始总资产 100,000.00');

    log('全部断言通过：AC-01 / AC-02 / AC-03 / AC-04 / AC-05');
    log(`截图输出目录：${OUT_DIR}`);
  } finally {
    if (cdp) {
      cdp.close();
    }
    try {
      browser.child.kill();
    } catch {
      /* ignore */
    }
    await app.close();
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function listen(app, port, attempt = 0) {
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      app.server.once('error', onError);
      app.server.listen(port, '127.0.0.1', () => {
        app.server.off('error', onError);
        resolve();
      });
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE' && attempt < 5) {
      await sleep(300);
      return listen(app, port, attempt + 1);
    }
    throw error;
  }
  const address = app.server.address();
  return `http://127.0.0.1:${address.port}`;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} 不符：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function assertContains(haystack, needle, label) {
  if (String(haystack).indexOf(needle) === -1) {
    throw new Error(`${label} 不符：期望包含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(haystack)}`);
  }
}

main().catch((error) => {
  console.error('\n截图/验证失败：');
  console.error(`  ${error.message}`);
  process.exitCode = 1;
});
