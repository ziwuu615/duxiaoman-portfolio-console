'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { AppError, ERROR_CODES } = require('../domain/errors');
const { isPlainObject } = require('../domain/util');

/**
 * 方案持久化存储（本地 JSON 文件）。
 *
 * 取舍说明（DESIGN.md「设计决策」一节）：
 * - 任务书预算 3–4 小时、单用户单组合、无需并发写入，引入数据库会明显抬高
 *   评审者的启动成本（安装/迁移/连接串），收益却接近于零。因此选择
 *   「一个 JSON 文件 + 原子写」：`write tmp → rename` 保证不会读到半个文件。
 * - 存「操作序列 + 冻结的基准快照 + 保存时的结果指纹」，不存逐标的计算结果：
 *   重新打开时用同一套引擎从基准快照复算，结果永远与首次保存一致，
 *   也不会因为后续代码改口径而出现「方案里存着旧口径数字」的漂移。
 * - 写入串行化（单进程内队列）：即使将来前端并发保存，也不会互相覆盖。
 */

const SCHEMA_VERSION = 1;

class PlanStore {
  /**
   * @param {{filePath: string, logger?: Console, now?: () => Date}} options
   */
  constructor(options) {
    this.filePath = options.filePath;
    this.logger = options.logger || console;
    this.now = options.now || (() => new Date());
    this.plans = [];
    this.writeQueue = Promise.resolve();
    this.loaded = false;
  }

  async init() {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      // 容忍 UTF-8 BOM（Windows 记事本保存的文件默认带 BOM）
      const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (!isPlainObject(parsed) || !Array.isArray(parsed.plans)) {
        throw new Error('文件结构不是 { schemaVersion, plans: [] }');
      }
      const valid = [];
      for (const record of parsed.plans) {
        if (isValidRecord(record)) {
          valid.push(record);
        } else {
          this.logger.warn(`[plan-store] 跳过一条无法识别的方案记录（id=${record && record.id}）`);
        }
      }
      this.plans = valid;
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        await this.#ensureDir();
        await this.#writeAll([]);
      } else {
        // 文件损坏时不静默清空：先隔离备份，再以空库继续提供服务，
        // 避免评审者因为一个坏文件而完全无法使用保存功能。
        const backupPath = await this.#quarantine();
        this.logger.warn(
          `[plan-store] 方案文件无法解析，已备份至 ${backupPath}，本次以空方案列表启动：${error.message}`
        );
        await this.#writeAll([]);
      }
    }
    this.loaded = true;
    return this;
  }

  /** @returns {Array<object>} 按创建时间倒序 */
  list() {
    return [...this.plans].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  get(id) {
    return this.plans.find((record) => record.id === id) || null;
  }

  /**
   * 新增一个方案。写入成功后才更新内存，保证「磁盘内容 = 内存内容」。
   *
   * @param {{name: string, base: object, rules: object, operations: Array<object>, summary: object, portfolioId: string}} input
   */
  async create(input) {
    return this.enqueue(async () => {
      const record = {
        schemaVersion: SCHEMA_VERSION,
        id: this.#nextId(),
        name: input.name,
        portfolioId: input.portfolioId,
        createdAt: this.now().toISOString(),
        base: input.base,
        rules: input.rules,
        operations: input.operations,
        summary: input.summary
      };
      const next = [...this.plans, record];
      await this.#writeAll(next);
      this.plans = next;
      return record;
    });
  }

  enqueue(task) {
    const run = this.writeQueue.then(() => task());
    this.writeQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  #nextId() {
    const now = this.now();
    const pad = (value) => String(value).padStart(2, '0');
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
      const id = `PLAN-${stamp}-${suffix}`;
      if (!this.plans.some((record) => record.id === id)) {
        return id;
      }
    }
    throw new AppError(ERROR_CODES.STORE_UNAVAILABLE, '生成方案编号失败，请重试', { httpStatus: 500 });
  }

  async #ensureDir() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
  }

  async #quarantine() {
    const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      await fs.rename(this.filePath, backupPath);
      return backupPath;
    } catch {
      return '(备份失败)';
    }
  }

  async #writeAll(plans) {
    await this.#ensureDir();
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: this.now().toISOString(),
      plans
    };
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tmpPath, this.filePath);
  }
}

function isValidRecord(record) {
  return (
    isPlainObject(record) &&
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.createdAt === 'string' &&
    isPlainObject(record.base) &&
    Array.isArray(record.base.holdings) &&
    Number.isFinite(record.base.cashCents) &&
    Array.isArray(record.operations) &&
    isPlainObject(record.rules) &&
    isPlainObject(record.summary)
  );
}

module.exports = { PlanStore, SCHEMA_VERSION, isValidRecord };
