'use strict';

const fs = require('node:fs/promises');
const { AppError, ERROR_CODES } = require('../domain/errors');
const { createPortfolio } = require('../domain/portfolio');

/**
 * 读取并校验基准组合数据（data/portfolio.json）。
 *
 * 基准数据在服务启动时一次性读入内存并冻结：模拟过程只读不写，
 * 因此「原始组合不受模拟影响」在结构上就成立，而不是靠调用方自觉。
 */
async function loadPortfolio(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    throw new AppError(
      ERROR_CODES.INVALID_PORTFOLIO_DATA,
      `无法读取组合数据文件：${filePath}（${error.message}）`,
      { details: { filePath }, httpStatus: 500, cause: error }
    );
  }

  let raw;
  try {
    // 容忍 UTF-8 BOM：Windows 记事本 / PowerShell 保存的 JSON 常带 BOM，
    // 直接 JSON.parse 会失败，这里统一剥掉。
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new AppError(
      ERROR_CODES.INVALID_PORTFOLIO_DATA,
      `组合数据不是合法 JSON：${filePath}（${error.message}）`,
      { details: { filePath }, httpStatus: 500, cause: error }
    );
  }

  try {
    return createPortfolio(raw);
  } catch (error) {
    if (error instanceof AppError) {
      error.details = { ...(error.details || {}), filePath };
      error.httpStatus = 500;
    }
    throw error;
  }
}

module.exports = { loadPortfolio };
