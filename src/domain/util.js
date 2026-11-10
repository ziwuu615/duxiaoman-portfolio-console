'use strict';

/** 是否为「纯对象」（排除数组、null、类实例）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 深冻结，用于保护只读的行情快照与规则，避免上层代码误改基准数据。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

module.exports = { isPlainObject, deepFreeze };
