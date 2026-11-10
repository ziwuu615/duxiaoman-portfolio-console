'use strict';

/**
 * 在当前进程内依次加载所有测试文件。
 *
 * 某些受限环境（例如禁止派生子进程的沙箱）里 `node --test` 会因为无法为每个
 * 测试文件 spawn 子进程而失败；此时可用 `node tests/run-all.js` 得到同样的
 * 断言结果。两者跑的是同一套测试代码。
 */

require('./money.test.js');
require('./engine.test.js');
require('./api.test.js');
require('./acceptance.test.js');
