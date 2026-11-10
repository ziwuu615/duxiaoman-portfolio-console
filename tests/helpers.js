'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createApplication } = require('../src/app');

const ROOT = path.resolve(__dirname, '..');
const SEED_FILE = path.join(ROOT, 'data', 'portfolio.json');

const silentLogger = {
  log() {},
  warn() {},
  error() {}
};

/**
 * 每个测试文件使用独立的临时数据目录：复制一份基准组合 + 空的方案库，
 * 保证测试之间、测试与仓库内 data/plans.json 之间互不影响。
 */
async function createSandbox(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portfolio-test-'));
  const dataDir = path.join(dir, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.copyFile(SEED_FILE, path.join(dataDir, 'portfolio.json'));
  await fs.writeFile(
    path.join(dataDir, 'plans.json'),
    `${JSON.stringify({ schemaVersion: 1, updatedAt: null, plans: [] }, null, 2)}\n`,
    'utf8'
  );

  return {
    dir,
    dataDir,
    async cleanup() {
      await fs.rm(dir, { recursive: true, force: true });
    },
    ...options
  };
}

async function startApp(dataDir) {
  const app = await createApplication({ dataDir, logger: silentLogger });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', () => {
      app.server.off('error', reject);
      resolve();
    });
  });
  const { port } = app.server.address();
  return { app, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopApp(app) {
  if (app) {
    await app.close();
  }
}

/**
 * 发一个 JSON 请求并返回 { status, headers, body }。
 * 4xx/5xx 不抛错，交给测试自行断言状态码与错误码。
 */
async function request(baseUrl, pathname, options = {}) {
  const init = {
    method: options.method || 'GET',
    headers: {}
  };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  if (options.headers) {
    Object.assign(init.headers, options.headers);
  }

  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, headers: response.headers, body };
}

/** 断言抛出的是带指定 code 的 AppError。 */
function expectAppError(fn, code) {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (!thrown) {
    throw new Error(`期望抛出 ${code}，但没有抛出任何错误`);
  }
  if (thrown.code !== code) {
    throw new Error(`期望错误码 ${code}，实际 ${thrown.code}（${thrown.message}）`);
  }
  return thrown;
}

module.exports = { ROOT, SEED_FILE, createSandbox, startApp, stopApp, request, expectAppError };
