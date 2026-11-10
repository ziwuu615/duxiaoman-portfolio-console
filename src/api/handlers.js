'use strict';

const { AppError, ERROR_CODES } = require('../domain/errors');
const { isPlainObject } = require('../domain/util');
const { analyze, createInitialState, simulate, MAX_OPERATIONS } = require('../domain/engine');
const { formatMoney } = require('../domain/money');
const { createPortfolioFromFrozen, freezeBase } = require('../domain/portfolio');
const {
  serializeAnalysis,
  serializeDiff,
  serializePortfolio,
  serializePlanDetail,
  serializePlanSummary,
  serializeSteps,
  serializeThresholds
} = require('../domain/serialize');

/**
 * HTTP 处理器：薄薄一层，把请求翻译成领域调用，再把结果序列化。
 * 所有业务规则都在 domain 层，处理器里不做计算，避免出现第二套口径。
 */
function createHandlers({ portfolio, planStore, startedAt, version }) {
  const baseAnalysis = analyze(createInitialState(portfolio), portfolio);

  return {
    health() {
      return {
        ok: true,
        service: 'portfolio-console',
        version,
        uptimeSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
        portfolioId: portfolio.meta.id,
        planCount: planStore.list().length
      };
    },

    getPortfolio() {
      return serializePortfolio(portfolio, baseAnalysis);
    },

    getInstruments() {
      return {
        cash: { cents: portfolio.cashCents, display: formatMoney(portfolio.cashCents) },
        instruments: Array.from(portfolio.instruments.values()).map((instrument) => ({
          symbol: instrument.symbol,
          name: instrument.name,
          industry: instrument.industry,
          priceCents: instrument.priceCents,
          priceDisplay: formatMoney(instrument.priceCents),
          quantity: instrument.initialQuantity
        })),
        maxOperations: MAX_OPERATIONS
      };
    },

    simulate({ body }) {
      if (!isPlainObject(body)) {
        throw new AppError(ERROR_CODES.INVALID_BODY, '请求体必须是 JSON 对象', { details: { field: 'body' } });
      }
      if (!Array.isArray(body.operations)) {
        throw new AppError(ERROR_CODES.INVALID_BODY, 'operations 必须是数组', { details: { field: 'operations' } });
      }

      const result = simulate(portfolio, body.operations);
      return {
        operations: serializeSteps(result.steps),
        simulated: serializeAnalysis(result.analysis, portfolio),
        diff: serializeDiff(result.baseAnalysis, result.analysis, result.steps)
      };
    },

    async createPlan({ body }) {
      if (!isPlainObject(body)) {
        throw new AppError(ERROR_CODES.INVALID_BODY, '请求体必须是 JSON 对象', { details: { field: 'body' } });
      }
      const name = normalizePlanName(body.name);
      if (!Array.isArray(body.operations)) {
        throw new AppError(ERROR_CODES.INVALID_BODY, 'operations 必须是数组', { details: { field: 'operations' } });
      }
      if (body.operations.length === 0) {
        throw new AppError(ERROR_CODES.EMPTY_PLAN, '方案至少需要一笔调仓操作', { httpStatus: 422 });
      }

      const result = simulate(portfolio, body.operations);
      const record = await savePlan(planStore, {
        name,
        portfolio,
        operations: result.operations,
        analysis: result.analysis
      });

      return {
        status: 201,
        payload: {
          plan: serializePlanSummary(record),
          operations: serializeSteps(result.steps),
          simulated: serializeAnalysis(result.analysis, portfolio),
          diff: serializeDiff(result.baseAnalysis, result.analysis, result.steps)
        }
      };
    },

    listPlans() {
      return {
        plans: planStore.list().map(serializePlanSummary),
        maxOperations: MAX_OPERATIONS
      };
    },

    getPlan({ params }) {
      const record = planStore.get(params.id);
      if (!record) {
        throw new AppError(ERROR_CODES.PLAN_NOT_FOUND, `方案不存在：${params.id}`, {
          details: { id: params.id },
          httpStatus: 404
        });
      }

      // 用方案内冻结的基准快照复算，不读取当前的 data/portfolio.json，
      // 因此即使基准数据后来被改动，重开方案的结果也与保存时一致。
      const restored = createPortfolioFromFrozen(record.base, record.rules, {
        id: record.id,
        name: record.name
      });

      let result;
      try {
        result = simulate(restored, record.operations);
      } catch (error) {
        if (error instanceof AppError) {
          throw new AppError(
            ERROR_CODES.STORE_UNAVAILABLE,
            `方案 ${record.id} 中的操作无法复算：${error.message}`,
            { details: { id: record.id, cause: error.code }, httpStatus: 500 }
          );
        }
        throw error;
      }

      // 指纹校验：总资产、现金、提醒数三项都要与保存时一致。
      // 金额与现金能抓住"算错"，提醒数能抓住"口径变了但金额没变"（例如阈值被改动）。
      const recomputedAlertCount = result.analysis.alerts.length;
      const integrity = {
        ok:
          result.analysis.totalAssetCents === record.summary.totalAssetCents &&
          result.analysis.cashCents === record.summary.cashCents &&
          recomputedAlertCount === record.summary.alertCount,
        recomputedTotalAssetCents: result.analysis.totalAssetCents,
        storedTotalAssetCents: record.summary.totalAssetCents,
        recomputedCashCents: result.analysis.cashCents,
        storedCashCents: record.summary.cashCents,
        recomputedAlertCount,
        storedAlertCount: record.summary.alertCount
      };

      return {
        ...serializePlanDetail(
          record,
          result.baseAnalysis,
          result.analysis,
          result.steps,
          restored
        ),
        thresholds: serializeThresholds(restored.rules),
        integrity,
        portfolioContext: {
          id: restored.meta.id,
          name: portfolio.meta.name,
          snapshotId: record.base.snapshotId,
          snapshotAt: record.base.snapshotAt,
          currency: record.base.currency
        }
      };
    }
  };
}

async function savePlan(planStore, { name, portfolio, operations, analysis }) {
  try {
    return await planStore.create({
      name,
      portfolioId: portfolio.meta.id,
      base: freezeBase(portfolio),
      rules: {
        singleThresholdBps: portfolio.rules.singleThresholdBps,
        industryThresholdBps: portfolio.rules.industryThresholdBps
      },
      operations,
      summary: {
        totalAssetCents: analysis.totalAssetCents,
        cashCents: analysis.cashCents,
        alertCount: analysis.alerts.length
      }
    });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(ERROR_CODES.STORE_UNAVAILABLE, `方案保存失败：${error.message}`, {
      details: { reason: 'write_failed' },
      httpStatus: 500,
      cause: error
    });
  }
}

/** 方案名称：去首尾空格、合并内部空白、1–40 字、不含控制字符。 */
function normalizePlanName(value) {
  if (typeof value !== 'string') {
    throw new AppError(ERROR_CODES.INVALID_PLAN_NAME, '方案名称必须是字符串', { details: { field: 'name' } });
  }
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length === 0) {
    throw new AppError(ERROR_CODES.INVALID_PLAN_NAME, '请填写方案名称', { details: { field: 'name' } });
  }
  if (name.length > 40) {
    throw new AppError(ERROR_CODES.INVALID_PLAN_NAME, '方案名称最长 40 个字符', {
      details: { field: 'name', maxLength: 40, actualLength: name.length }
    });
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new AppError(ERROR_CODES.INVALID_PLAN_NAME, '方案名称不能包含控制字符', { details: { field: 'name' } });
  }
  return name;
}

module.exports = { createHandlers, normalizePlanName };
