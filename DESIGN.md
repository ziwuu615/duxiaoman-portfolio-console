# 设计与交付说明 · 投资组合分析与调仓模拟

VC-FIN-001 ｜ 实现：`portfolio-console/`（Node 20+，零运行时依赖）｜ AI 协作记录：`docs/AI-COLLAB.md` ｜ 验证证据：`VERIFY.md`

## 1. 需求与交互

### 1.1 核心用户流程

```
查看资产结构 → 识别超限 → 逐笔试算（顺序生效）→ 对比原始/模拟 → 命名保存
                                                        ↓ 刷新页面 / 重启服务
                                              重新打开（只读复算）
```

界面：顶部 KPI（含快照时间）→ 集中度检查 → 持仓明细（原始 vs 当前）→ 行业分布；右侧为调仓操作台与已保存方案列表。

### 1.2 功能边界

| 支持 | 不支持 |
| --- | --- |
| 单用户、单组合、CNY、固定行情快照、给定标的、正整数数量、买卖两向、方案保存与只读重开 | 多组合/多币种、实时行情、手续费税费分红、融资卖空、真实下单、登录、方案编辑与删除 |

### 1.3 验收条件

AC-01 初始（总资产 100,000.00、现金 20,000.00、A01 40% 与科技 60% 触发）；AC-02 卖 A01 100 股后 30%/50% 恰好等于阈值、两项提醒解除；
AC-03 再买 A02 100 股后科技 55% 再次提醒、总资产不变；AC-04 买入 201 股 / 卖出 401 股 / 0 / 负数 / 小数全部拒绝且不改有效结果；
AC-05 保存后重启并重开，结果与保存时一致、原始组合不变。逐条实际输出见 `VERIFY.md` 第 3 节。

### 1.4 状态与交互

| 状态 | 界面表现 |
| --- | --- |
| 加载 | 全屏遮罩 + "正在加载组合数据…"（`body[data-state=loading]`） |
| 失败 | 遮罩转错误态，显示原因与「重试」，不留白屏 |
| 空（无操作 / 无方案） | 操作区引导文案、方案区空状态说明，而不是空白 |
| 校验失败 | 操作台就地显示**错误码 + 原因 + 修正建议**（如"最多可买入 200 股"），上一版有效结果不变 |
| 只读（重开方案） | 顶部横幅显示方案名与保存时间；表单隐藏、操作序列只读；一键「退出查看」 |
| 数据不一致 | 顶部红色横幅提示，不静默展示可疑数字 |

原则：**任何失败都不能让页面变成"看起来正常但数字是旧的"**。

## 2. 数据与状态

### 2.1 实体关系

```
Portfolio 1─1 Snapshot(固定价格) ─N Instrument(symbol, name, industry, price, quantity)
Plan 1─1 frozenBase(现金 + 每只标的价格/数量) ─N Operation(side, symbol, quantity) ─1 summary(指纹)
```

### 2.2 三层状态与原始数据隔离

| 层 | 存放位置 | 生命周期 | 可写 |
| --- | --- | --- | --- |
| 基准数据（组合 + 快照） | 启动时读 `data/portfolio.json`，`deepFreeze`，代码中无写回路径 | 进程级 | 否 |
| 模拟草稿 | 前端操作序列 + 每次整组复算的返回 | 页面会话 | 是 |
| 已保存方案 | `data/plans.json` | 跨刷新、跨重启 | 只追加 |

`simulate()` 从 `createInitialState()` 出发、每笔返回新 Map；方案保存冻结基准，与当前数据文件无引用关系。
**原始数据隔离**由此成立：模拟过程只读基准、不回写；`data/portfolio.json` 在全流程中只被读取一次（启动时），
"模拟影响原始组合"在结构上不会发生。

### 2.3 保存什么、怎么重算

```json
{ "id": "PLAN-20261110105231-7QK2", "name": "AC-03 降低科技集中度", "createdAt": "…", "portfolioId": "DEMO-001",
  "base": { "snapshotId": "SNAP-20261102", "cashCents": 2000000,
            "holdings": [{ "symbol": "A01", "industry": "科技", "priceCents": 10000, "quantity": 400 }] },
  "rules": { "singleThresholdBps": 3000, "industryThresholdBps": 5000 },
  "operations": [{ "side": "SELL", "symbol": "A01", "quantity": 100 }],
  "summary": { "totalAssetCents": 10000000, "cashCents": 2500000, "alertCount": 1 } }
```

（示例只列 A01；实际写入全部 6 只标的）

- **不存逐标的计算结果**：否则"操作序列"与"结果快照"形成两份真相，口径演进后历史方案无法解释。
- **重开策略**：用冻结基准还原组合 → 跑同一套 `simulate()` → 与 `summary` 指纹（总资产/现金/提醒数）比对，不一致置 `integrity.ok=false` 并在顶部告警。重开一致性不是假设，而是每次打开都验证。
- **为什么冻结价格与原始数量**：只存 `snapshot_id` 的话，基准文件一改历史方案就漂移；代价约 1KB/方案。

### 2.4 草稿状态迁移

```
原始(0 笔) --添加合法操作--> 模拟(n 笔) --添加非法操作--> 模拟(n 笔) + 错误（结果不变）
    ^                          └── 移除某笔 / 清空 ──> 对剩余序列整组重算
```

每次变更都整组提交（`POST /api/simulate`），后端从基准重放：不存在增量漂移，校验失败天然无副作用。

### 2.5 提醒集合的语义

AC-03 的"再次触发"落在存量提醒上（科技 60% → 55%），按"新增"算会是 0 条。因此接口给三组：
`alerts.current`（当前全部提醒，界面主展示）、`triggered`（新增，仅用于 KPI 角标）、`resolved`（已解除，底部绿标）；
同一性按稳定 id（`instrument:A01` / `industry:科技`）判断，不按文案比较。

## 3. 系统结构与接口

### 3.1 结构图

```
浏览器（原生 JS，无构建）——只渲染后端给的 display 字符串，不做金额/占比计算
   │ fetch JSON（同源）
Node http（src/app.js：路由 / 静态资源 / 统一错误映射 / 请求日志）
   ├ api/handlers.js      参数校验、编排、序列化
   ├ domain/engine.js     估值 · 集中度 · 顺序模拟（纯函数，无 I/O）
   ├ domain/money.js      整数分 · pct2 · 万分比 · BigInt 精确比较
   └ store/planStore.js   方案 JSON 原子写 + 写队列 + 损坏隔离
        data/portfolio.json（只读）      data/plans.json（追加写）
```

### 3.2 主要接口

| 方法 | 路径 | 输入 | 输出 | 主要错误 |
| --- | --- | --- | --- | --- |
| GET | `/api/health` | — | ok / version / planCount | — |
| GET | `/api/portfolio` | — | portfolio / thresholds / instruments / analysis / warnings | 500 |
| GET | `/api/instruments` | — | cash / instruments / maxOperations | — |
| POST | `/api/simulate` | `{operations[]}` | operations / simulated / diff | 400 / 413 / 422 |
| POST | `/api/plans` | `{name, operations[]}` | 201 plan / operations / simulated / diff | 400 / 422 |
| GET | `/api/plans` | — | plans[]（摘要、操作数、现金、提醒数） | — |
| GET | `/api/plans/{id}` | — | plan / operations / base / simulated / diff / integrity | 404 |

DTO 统一：金额 `{cents, display, sign}`、占比 `{pct2, display}`、阈值 `{ratio, bps, pct2, display}`；
`diff` 含 `cash / totalAsset / positions / industries / alerts{base,current,triggered,resolved} / steps`。

### 3.3 错误体与错误码

```json
{"error":{"code":"INSUFFICIENT_CASH","message":"第 1 笔操作：现金不足，买入 201 股 A01 需要 20,100.00 元，可用现金仅 20,000.00 元",
 "details":{"operationIndex":0,"symbol":"A01","requiredCents":2010000,"availableCents":2000000,"shortfallCents":10000}}}
```

错误码：`INVALID_JSON` / `INVALID_BODY` / `PAYLOAD_TOO_LARGE` / `INVALID_OPERATION` / `INVALID_SIDE` / `INVALID_QUANTITY` /
`UNKNOWN_SYMBOL` / `INSUFFICIENT_CASH` / `INSUFFICIENT_POSITION` / `TOO_MANY_OPERATIONS` / `INVALID_PLAN_NAME` /
`EMPTY_PLAN` / `PLAN_NOT_FOUND` / `INVALID_PORTFOLIO_DATA` / `STORE_UNAVAILABLE` / `INVARIANT_VIOLATION` /
`NOT_FOUND` / `METHOD_NOT_ALLOWED` / `INTERNAL_ERROR`。

### 3.4 约束在后端执行，口径只有一份

| 约束 | 执行点 |
| --- | --- |
| 数量为正整数 | `money.parseQuantity`（拒绝 0/负数/小数/超限） |
| 现金不为负、卖出不超持仓 | `engine.applyOperation` 用前序状态比较，差额写进 `details` |
| 仅给定标的、同一快照 | 标的查表；价格全程来自冻结基准 |
| 顺序生效、失败不改结果 | 整组重放，任一失败抛错、无副作用 |
| 总资产守恒（固定价、无费用） | `simulate()` 末尾断言，违反返回 500 |

**避免前后端口径不一致**：所有金额/占比的展示字符串都由后端 DTO 生成（`display` 字段），前端不做任何除法与舍入。
同一份整数运算既用于"是否超限"的判定，也用于"40.00%"的展示。

## 4. 计算与异常

### 4.1 数值口径与金额精度

| 量 | 内部表示 | 示例 |
| --- | --- | --- |
| 金额 | 整数分 `cents` | `"20000.00"` → `2000000` |
| 市值 | `priceCents × quantity` | `10000 × 400 = 4000000` |
| 总资产 | `Σ市值 + cashCents` | `10000000` |
| 占比 | `pct2` = 百分比 × 100 | 40.00% → `4000` |
| 阈值 | 万分比 `bps` = 比例 × 10000 | 0.30 → `3000` |

- 占比：`pct2 = roundHalfUp(市值 × 10000 ÷ 总资产)`，BigInt 整数除法，四舍五入（half-up）。
- 是否超限：`BigInt(市值) × 10000 > BigInt(总资产) × bps`，**精确区分"等于"与"大于"**；两位小数只用于展示，不参与判定。
- 分母为 0：占比记 0，不抛异常。

### 4.2 阈值边界与验证方法

验证方法（计算验证方法）：先写断言（`node:test`）再实现；每条边界都有对应用例，并由 `VERIFY.md` 记录真实输出。

| 边界 | 期望 | 验证 |
| --- | --- | --- |
| 恰好 30.00%（3000000 / 10000000） | 不提醒 | `compareToThreshold(...) === 0` |
| 略超（3000001 分） | 提醒 | `=== 1` |
| AC-02 科技恰好 50.00% | 不提醒 | 用例通过 |
| AC-03 科技 55.00% | 提醒 | 用例通过 |
| 四舍五入 2/3 | 66.67%（非 66.66%） | `pct2Of(2,3) === 6667` |
| 现金刚好够买 | 现金归零、占比 0.00% | `BUY A06 ×200`（= 20,000.00） |
| 金额三位小数 / 负价 | 启动期拒绝 | `parseMoneyToCents` 抛错 |

**自检**：`simulate()` 末尾断言"模拟前后总资产相等"，违反即 500 `INVARIANT_VIOLATION`——把"固定价格、无费用"这一业务前提变成可执行检查。

### 4.3 异常与降级

| 场景 | 处理 |
| --- | --- |
| `plans.json` 损坏 | 重命名为 `plans.json.corrupt-<时间戳>` 备份后以空库启动，保存仍可用 |
| 写盘失败 | 先写盘成功再更新内存，否则 500 `STORE_UNAVAILABLE` |
| 路径穿越（`%2e%2e/`） | 先解码再规范化，越界 403/404，不返回数据目录内容 |
| 请求体非 JSON / 过大 | 400 `INVALID_JSON` / 413 `PAYLOAD_TOO_LARGE`（上限 256KB） |
| 价格缺失 | 启动期拒绝（没有估值口径就无法计算） |
| 行业未知 | 归入「未分类」并写入 `warnings`，不阻断启动 |

## 5. 设计决策

**D1 存储：单文件 JSON + 临时文件 rename 原子写 + 单进程写队列**
备选：localStorage（不满足"服务端保存 + 重启恢复"语义）、SQLite（原生依赖、离线装不上，收益小于成本）。
代价：全量重写、无事务；单用户个位数方案可接受。收益：可读可核对、零依赖。损坏时备份重建，不静默清空。

**D2 计算结果持久化：只存操作 + 冻结基准 + 结果指纹**
备选：存完整结果（两份真相，口径演进后对不上）、只存 `snapshot_id`（基准一改就漂移）。
打开时复算并与指纹比对；代价约 1KB/方案，收益是可复现、可自检。

**D3 模拟状态放前端（后端无状态）**
备选：服务端 session 存草稿——引入会话生命周期，重启即丢，与"可重启"矛盾。
代价：每加一笔操作一次往返（本地 <20ms，上限 50 笔）；收益：后端无隐藏状态，重启前后行为一致。

**D4 前端不做二次计算**
备选：前后端各算一遍做交叉校验——两套舍入必然对不上，最终变成"谁对"的争论。
改为测试层独立重算断言，运行期只信后端一份口径。

## 6. 完成情况与复盘

### 6.1 已完成

| 项 | 状态 |
| --- | --- |
| FR-01 ~ FR-05 | ✅ 全部实现 |
| AC-01 ~ AC-05 | ✅ 5/5（单测 + 接口 + 页面三层验证） |
| 自动化测试 | ✅ 37/37（`tests/*.test.js`） |
| 关键页面截图 | ✅ 5 张（`docs/screenshots/`） |
| 交付文档 | ✅ PLAN / DESIGN / README / VERIFY / SUBMISSION / AI-COLLAB |

### 6.2 未完成与已知问题

**未完成（超出范围）**：方案编辑/删除/复制、多组合、多币种、导出、图表可视化、鉴权、公网部署加固。

**已知问题**：① 单文件全量重写，万级方案未压测；② `node --test` 在禁止派生子进程的环境失败，已提供 `npm run test:inproc`；
③ 仅支持两位小数价格与正整数数量，不支持零股；④ 逐笔校验每次一次往返，操作上限 50 笔；
⑤ 方案列表无搜索/分页；⑥ 无鉴权，仅监听 `127.0.0.1`。

### 6.3 与开工方案的差异（如实记录）

| 开工计划 | 实际 | 原因 |
| --- | --- | --- |
| 操作 + 冻结基准 | 再加结果指纹（总资产/现金/提醒数） | 让"重开一致"每次打开都被验证 |
| 提醒只给当前列表 | 拆成 current / triggered / resolved | AC-03 的"再次触发"落在存量提醒上（见 2.5） |
| `npm test` 一条命令 | 另提供 `npm run test:inproc` | 本机沙箱禁止子进程，`node --test` 报 `spawn EPERM` |
| 直接读 UTF-8 数据文件 | 增加 BOM 剥离 + 单测 | 记事本/PowerShell 的 BOM 会让 `JSON.parse` 失败、方案库被误判损坏 |
| 直接测非法操作 | 先清空回原始组合再测 | AC-04 要求"分别从原组合"；带两笔操作时现金已变，201 股实际买得起 |

### 6.4 如果再多一小时（按优先级）

1. **「基于此方案继续调整」**：把已保存方案的操作序列复制成新草稿（当前只读重开）。
2. **每笔现金流明细 + 拖拽排序**：后端 `steps[]` 已返回每笔现金与数量变化，只差 UI。
3. **属性化测试**：随机生成合法/非法序列，断言"总资产守恒 / 现金非负 / 失败不改状态"三项不变量。
4. **存储改造**：JSONL 追加写，去掉全量重写。

> 最值得记录的一条判断：**"等于阈值不触发"决定了整个数值方案**。用浮点算占比在 AC-02 的 30.00%/50.00% 上不可靠；
> 换成整数分 / pct2 / 万分比并用 BigInt 交叉相乘后，"等于"与"大于"才成为精确可分的两个结果。
