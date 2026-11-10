'use strict';

const path = require('node:path');
const { createApplication } = require('./src/app');

/**
 * 启动入口。
 *
 * 用法：
 *   node server.js                 # 默认 http://127.0.0.1:3000
 *   node server.js --port 4000     # 指定端口
 *   PORT=4000 node server.js       # 也可以走环境变量
 *
 * 只监听 127.0.0.1（本机），符合任务书「无需公网部署」的边界。
 */
function parsePort() {
  const args = process.argv.slice(2);
  const flagIndex = args.findIndex((arg) => arg === '--port' || arg === '-p');
  const raw = flagIndex >= 0 ? args[flagIndex + 1] : process.env.PORT;
  if (raw === undefined || raw === '') {
    return 3000;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`端口不合法：${raw}`);
  }
  return port;
}

async function main() {
  const port = parsePort();
  const host = process.env.HOST || '127.0.0.1';

  const app = await createApplication();

  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, () => {
      app.server.off('error', reject);
      resolve();
    });
  }).catch((error) => {
    if (error && error.code === 'EADDRINUSE') {
      throw new Error(`端口 ${port} 已被占用，请用 --port 指定其他端口，例如：node server.js --port 3000`);
    }
    throw error;
  });

  const address = app.server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const planCount = app.planStore.list().length;

  console.log('');
  console.log('  投资组合分析与调仓模拟 · 本地原型');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  访问地址    http://${host}:${actualPort}`);
  console.log(`  组合        ${app.portfolio.meta.id} ${app.portfolio.meta.name} · 快照 ${app.portfolio.meta.snapshotId}`);
  console.log(`  币种        ${app.portfolio.meta.currency}`);
  console.log(`  数据目录    ${path.join(app.rootDir, 'data')}`);
  console.log(`  已保存方案  ${planCount} 个`);
  if (app.portfolio.warnings.length > 0) {
    for (const warning of app.portfolio.warnings) {
      console.log(`  数据提示    ${warning}`);
    }
  }
  console.log('  ─────────────────────────────────────────────');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) {
      return;
    }
    closing = true;
    console.log(`\n收到 ${signal}，正在关闭服务…`);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandledRejection', reason);
  });
}

main().catch((error) => {
  console.error('\n启动失败：');
  console.error(`  ${error.message}`);
  if (error.details) {
    console.error(`  详情：${JSON.stringify(error.details)}`);
  }
  console.error('');
  process.exitCode = 1;
});
