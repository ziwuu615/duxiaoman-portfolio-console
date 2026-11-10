'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');

const { AppError, ERROR_CODES } = require('./domain/errors');
const { isPlainObject } = require('./domain/util');
const { loadPortfolio } = require('./store/portfolioStore');
const { PlanStore } = require('./store/planStore');
const { createHandlers } = require('./api/handlers');
const { version: VERSION } = require('../package.json');

/**
 * 极简 HTTP 服务：路由 + 静态资源 + 统一错误映射。
 *
 * 刻意不引入 Web 框架：整个后端只依赖 Node 标准库，评审者 `node server.js`
 * 即可启动，不需要 npm install / 构建步骤，也不会因为 lockfile 与镜像源
 * 问题而卡在环境上。路由表只有 7 条，手写比引入依赖更可控。
 */

const MAX_BODY_BYTES = 256 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * @param {{rootDir?: string, logger?: Console}} [options]
 * @returns {Promise<{server: import('node:http').Server, portfolio: object, planStore: PlanStore, handlers: object, close: () => Promise<void>}>}
 */
async function createApplication(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, '..');
  const dataDir = options.dataDir || path.join(rootDir, 'data');
  const publicDir = path.join(rootDir, 'public');
  const logger = options.logger || console;
  const startedAt = Date.now();

  const portfolio = await loadPortfolio(path.join(dataDir, 'portfolio.json'));
  const planStore = new PlanStore({ filePath: path.join(dataDir, 'plans.json'), logger });
  await planStore.init();

  const handlers = createHandlers({ portfolio, planStore, startedAt, version: VERSION });

  /** @type {Array<{method: string, pattern: RegExp, handler: Function}>} */
  const routes = [
    { method: 'GET', pattern: /^\/api\/health\/?$/, handler: handlers.health },
    { method: 'GET', pattern: /^\/api\/portfolio\/?$/, handler: handlers.getPortfolio },
    { method: 'GET', pattern: /^\/api\/instruments\/?$/, handler: handlers.getInstruments },
    { method: 'POST', pattern: /^\/api\/simulate\/?$/, handler: handlers.simulate },
    { method: 'GET', pattern: /^\/api\/plans\/?$/, handler: handlers.listPlans },
    { method: 'POST', pattern: /^\/api\/plans\/?$/, handler: handlers.createPlan },
    { method: 'GET', pattern: /^\/api\/plans\/(?<id>[^/]+)\/?$/, handler: handlers.getPlan }
  ];

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      logger.error('[server] 未捕获异常', error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: { code: ERROR_CODES.INTERNAL_ERROR, message: '服务内部错误' } });
      }
    });
  });

  async function handleRequest(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, url);
      return;
    }
    await serveStatic(req, res, pathname, publicDir);
  }

  async function handleApi(req, res, pathname, url) {
    const method = (req.method || 'GET').toUpperCase();
    const matched = [];
    for (const route of routes) {
      const match = route.pattern.exec(pathname);
      if (match) {
        matched.push({ route, match });
      }
    }

    if (matched.length === 0) {
      sendJson(res, 404, {
        error: {
          code: ERROR_CODES.NOT_FOUND,
          message: `接口不存在：${method} ${pathname}`,
          details: { method, path: pathname }
        }
      });
      return;
    }

    const byMethod = matched.find((item) => item.route.method === method);
    if (!byMethod) {
      const allow = matched.map((item) => item.route.method).join(', ');
      sendJson(
        res,
        405,
        {
          error: {
            code: ERROR_CODES.METHOD_NOT_ALLOWED,
            message: `接口不支持 ${method} 方法`,
            details: { method, path: pathname, allow }
          }
        },
        { Allow: allow }
      );
      return;
    }

    try {
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const payload = await byMethod.route.handler({
          req,
          res,
          body,
          params: byMethod.match.groups || {},
          url
        });
        sendResult(res, payload);
      } else {
        const payload = await byMethod.route.handler({
          req,
          res,
          params: byMethod.match.groups || {},
          url
        });
        sendResult(res, payload);
      }
    } catch (error) {
      if (error instanceof AppError) {
        if (error.httpStatus >= 500) {
          logger.error(`[api] ${method} ${pathname} → ${error.code}`, error.details || '');
        }
        sendJson(res, error.httpStatus, { error: error.toPayload() });
        return;
      }
      logger.error(`[api] ${method} ${pathname} 未处理异常`, error);
      sendJson(res, 500, {
        error: { code: ERROR_CODES.INTERNAL_ERROR, message: '服务内部错误，请查看服务端日志' }
      });
    }
  }

  function sendResult(res, payload) {
    if (isPlainObject(payload) && Number.isInteger(payload.status) && 'payload' in payload) {
      sendJson(res, payload.status, payload.payload);
      return;
    }
    sendJson(res, 200, payload);
  }

  function sendJson(res, status, payload, extraHeaders = {}) {
    const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    });
    res.end(body);
    logger.log?.(`${res.req?.method || ''} ${res.req?.url || ''} → ${status}`);
  }

  async function serveStatic(req, res, pathname, root) {
    let relativePath;
    try {
      relativePath = decodeURIComponent(pathname);
    } catch {
      sendJson(res, 400, { error: { code: 'BAD_PATH', message: '请求路径编码不合法' } });
      return;
    }

    if (relativePath === '/' || relativePath === '') {
      relativePath = '/index.html';
    }

    const normalized = path.posix.normalize(relativePath);
    if (normalized.includes('\0') || normalized.startsWith('../') || normalized === '..') {
      sendJson(res, 403, { error: { code: 'FORBIDDEN', message: '非法路径' } });
      return;
    }

    const filePath = path.join(root, normalized);
    if (!filePath.startsWith(root)) {
      sendJson(res, 403, { error: { code: 'FORBIDDEN', message: '非法路径' } });
      return;
    }

    try {
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) {
        sendJson(res, 404, { error: { code: ERROR_CODES.NOT_FOUND, message: '目录不可直接访问' } });
        return;
      }
      const content = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Length': content.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(content);
      logger.log?.(`${req.method} ${req.url} → 200`);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        sendJson(res, 404, { error: { code: ERROR_CODES.NOT_FOUND, message: `页面不存在：${normalized}` } });
        return;
      }
      logger.error('[static] 读取失败', error);
      sendJson(res, 500, { error: { code: ERROR_CODES.INTERNAL_ERROR, message: '静态资源读取失败' } });
    }
  }

  return {
    server,
    portfolio,
    planStore,
    handlers,
    rootDir,
    close: () =>
      new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new AppError(ERROR_CODES.PAYLOAD_TOO_LARGE, '请求体超过 256KB 限制', {
        details: { maxBytes: MAX_BODY_BYTES },
        httpStatus: 413
      });
    }
    chunks.push(chunk);
  }

  if (size === 0) {
    return {};
  }

  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AppError(ERROR_CODES.INVALID_JSON, `请求体不是合法 JSON：${error.message}`, {
      details: { field: 'body' }
    });
  }
}

module.exports = { createApplication, MAX_BODY_BYTES };
