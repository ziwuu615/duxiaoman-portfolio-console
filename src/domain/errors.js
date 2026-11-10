'use strict';

/**
 * 领域层统一错误类型。
 *
 * 设计要点：
 * - 每个错误都有稳定的机器可读 code，前端据此决定提示文案与高亮位置，
 *   而不是去解析自然语言（避免前后端文案耦合）。
 * - httpStatus 由错误自身携带，路由层不需要 if/else 猜状态码。
 * - details 用于返回可定位的上下文（第几笔操作、哪个标的、差多少钱），
 *   前端据此在出错的操作行上就地展示，而不是只弹一个笼统的 toast。
 */
class AppError extends Error {
  /**
   * @param {string} code 稳定的错误码（见 ERROR_CODES）
   * @param {string} message 面向用户的中文说明
   * @param {{details?: unknown, httpStatus?: number, cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = options.details;
    this.httpStatus = Number.isInteger(options.httpStatus) ? options.httpStatus : 400;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  toPayload() {
    const payload = { code: this.code, message: this.message };
    if (this.details !== undefined) {
      payload.details = this.details;
    }
    return payload;
  }
}

/**
 * 错误码总表：DESIGN.md 的接口章节与此保持一致。
 */
const ERROR_CODES = Object.freeze({
  // 请求格式
  INVALID_JSON: 'INVALID_JSON',
  INVALID_BODY: 'INVALID_BODY',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  // 交易操作
  INVALID_OPERATION: 'INVALID_OPERATION',
  INVALID_SIDE: 'INVALID_SIDE',
  INVALID_QUANTITY: 'INVALID_QUANTITY',
  UNKNOWN_SYMBOL: 'UNKNOWN_SYMBOL',
  INSUFFICIENT_CASH: 'INSUFFICIENT_CASH',
  INSUFFICIENT_POSITION: 'INSUFFICIENT_POSITION',
  TOO_MANY_OPERATIONS: 'TOO_MANY_OPERATIONS',
  // 方案
  INVALID_PLAN_NAME: 'INVALID_PLAN_NAME',
  EMPTY_PLAN: 'EMPTY_PLAN',
  PLAN_NOT_FOUND: 'PLAN_NOT_FOUND',
  // 数据与存储
  INVALID_PORTFOLIO_DATA: 'INVALID_PORTFOLIO_DATA',
  STORE_UNAVAILABLE: 'STORE_UNAVAILABLE',
  INVARIANT_VIOLATION: 'INVARIANT_VIOLATION',
  // 路由
  NOT_FOUND: 'NOT_FOUND',
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
});

module.exports = { AppError, ERROR_CODES };
