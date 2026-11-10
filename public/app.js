/* =========================================================
   投资组合分析与调仓模拟 · 前端交互
   设计约束：
   - 所有金额 / 占比 / 阈值的展示字符串都来自后端，前端不做除法与舍入，
     避免同一套口径在前端被「再算一遍」而漂移。
   - 前端只做交互与排版：校验的最终权威始终在后端（422 + 错误码）。
   ========================================================= */

(function () {
  'use strict';

  var $ = function (selector, root) {
    return (root || document).querySelector(selector);
  };

  var state = {
    status: 'loading',
    base: null,
    plans: [],
    operations: [],
    steps: [],
    simulated: null,
    diff: null,
    activePlan: null,
    busy: false,
    saving: false,
    highlightPlanId: null
  };

  /* ---------- 通用工具 ---------- */

  function esc(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function deltaClass(value) {
    if (!value) {
      return 'delta-flat';
    }
    return value > 0 ? 'delta-up' : 'delta-down';
  }

  function signedMoney(money) {
    if (!money) {
      return '';
    }
    return money.sign > 0 ? '+' + money.display : money.display;
  }

  function signedPct(pct) {
    if (!pct) {
      return '';
    }
    return pct.pct2 > 0 ? '+' + pct.display : pct.display;
  }

  function toast(message, kind) {
    var stack = $('#toast-stack');
    var node = document.createElement('div');
    node.className = 'toast' + (kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : '');
    node.textContent = message;
    stack.appendChild(node);
    window.setTimeout(function () {
      node.remove();
    }, kind === 'error' ? 6000 : 3600);
  }

  function ApiError(status, payload) {
    this.status = status;
    this.code = (payload && payload.code) || 'HTTP_ERROR';
    this.details = (payload && payload.details) || null;
    this.message = (payload && payload.message) || '请求失败（HTTP ' + status + '）';
  }

  async function api(path, options) {
    var init = Object.assign({ headers: { 'Content-Type': 'application/json' } }, options || {});
    var response;
    try {
      response = await fetch(path, init);
    } catch (networkError) {
      throw new ApiError(0, {
        code: 'NETWORK_ERROR',
        message: '无法连接本地服务，请确认 node server.js 仍在运行'
      });
    }

    var text = await response.text();
    var payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (parseError) {
        throw new ApiError(response.status, {
          code: 'BAD_RESPONSE',
          message: '服务返回了无法解析的响应'
        });
      }
    }

    if (!response.ok) {
      throw new ApiError(response.status, payload && payload.error);
    }
    return payload;
  }

  /* ---------- 派生状态 ---------- */

  function currentAnalysis() {
    if (state.activePlan) {
      return state.activePlan.simulated;
    }
    return state.diff ? state.simulated : state.base.analysis;
  }

  function currentDiff() {
    if (state.activePlan) {
      return state.activePlan.diff;
    }
    return state.diff;
  }

  function isComparing() {
    return Boolean(currentDiff());
  }

  function isReadOnly() {
    return Boolean(state.activePlan);
  }

  /* ---------- 顶部信息 ---------- */

  function renderMeta() {
    var base = state.base;
    $('#meta-portfolio').textContent = base.portfolio.id + ' · ' + base.portfolio.name;
    $('#meta-snapshot').textContent = '快照 ' + base.portfolio.snapshotAtDisplay + '（' + base.portfolio.snapshotId + '）';
    $('#meta-currency').textContent = base.portfolio.currency;
    $('#threshold-legend').textContent =
      '单一标的 > ' +
      base.thresholds.single.display +
      ' · 行业 > ' +
      base.thresholds.industry.display +
      ' 触发提醒（' +
      (base.thresholds.comparison === 'strictly_greater_than' ? '等于阈值不提醒' : '') +
      '）';
  }

  /* ---------- 视图状态横幅 ---------- */

  function renderBanner() {
    var banner = $('#view-banner');
    if (state.activePlan) {
      banner.hidden = false;
      var plan = state.activePlan.plan;
      $('#view-banner-text').textContent =
        '正在查看已保存方案「' +
        plan.name +
        '」· 保存于 ' +
        plan.createdAtDisplay +
        ' · 基于方案内冻结的快照复算';
    } else {
      banner.hidden = true;
    }

    var integrity = state.activePlan && state.activePlan.integrity;
    var integrityBanner = $('#integrity-banner');
    if (integrity && !integrity.ok) {
      integrityBanner.hidden = false;
      $('#integrity-text').textContent =
        '复算结果与保存记录不一致（存储现金 ' +
        (integrity.storedCashCents / 100).toFixed(2) +
        ' / 复算现金 ' +
        (integrity.recomputedCashCents / 100).toFixed(2) +
        '），请查看服务端日志。';
    } else {
      integrityBanner.hidden = true;
    }
  }

  /* ---------- KPI ---------- */

  function renderKpi() {
    var analysis = currentAnalysis();
    var diff = currentDiff();

    $('#kpi-total').textContent = analysis.totalAsset.display;
    if (diff) {
      $('#kpi-total-foot').textContent =
        '原始 ' + diff.totalAsset.base.display + ' · ' + (diff.totalAsset.invariantHolds ? '总资产不变' : '总资产发生变化');
    } else {
      $('#kpi-total-foot').textContent = '含现金 ' + analysis.cash.display;
    }

    $('#kpi-cash').textContent = analysis.cash.display;
    $('#kpi-cash-foot').textContent = '占总资产 ' + analysis.weights.cash.display;

    $('#kpi-market-value').textContent = analysis.marketValue.display;
    $('#kpi-market-foot').textContent = '占总资产 ' + analysis.weights.marketValue.display;

    $('#kpi-held').textContent = String(analysis.counts.heldInstruments);
    $('#kpi-held-foot').textContent =
      '共 ' +
      analysis.counts.totalQuantityDisplay +
      ' 股 · ' +
      analysis.counts.totalInstruments +
      ' 个标的 · ' +
      analysis.counts.industries +
      ' 个行业';

    var alertCard = $('.kpi-alert');
    $('#kpi-alert').textContent = String(analysis.alerts.length);
    if (diff) {
      var baseCount = diff.alerts.base.length;
      $('#kpi-alert-foot').textContent = '原始 ' + baseCount + ' 项 · 已解除 ' + diff.alerts.resolved.length + ' 项 · 新增 ' + diff.alerts.triggered.length + ' 项';
    } else {
      var instruments = analysis.alerts.filter(function (alert) {
        return alert.type === 'instrument';
      }).length;
      var industries = analysis.alerts.length - instruments;
      $('#kpi-alert-foot').textContent = '标的 ' + instruments + ' 项 · 行业 ' + industries + ' 项';
    }
    alertCard.classList.toggle('is-clear', analysis.alerts.length === 0);
  }

  /* ---------- 集中度 ---------- */

  function alertCardHtml(alert, baseAlerts) {
    var baseAlert = null;
    for (var i = 0; i < (baseAlerts || []).length; i += 1) {
      if (baseAlerts[i].id === alert.id) {
        baseAlert = baseAlerts[i];
        break;
      }
    }

    var typeLabel = alert.type === 'instrument' ? '单一标的' : '行业';
    var baseNote = '';
    if (baseAlerts) {
      baseNote = baseAlert ? '原占比 ' + baseAlert.actual.display : '原始组合无此提醒';
    }
    var statement =
      alert.type === 'instrument'
        ? '标的 ' + esc(alert.subject) + ' 市值 ' + alert.marketValue.display
        : '行业合计市值 ' + alert.marketValue.display;

    return (
      '<article class="alert-card' +
      (alert.type === 'industry' ? ' industry' : '') +
      '" data-testid="alert-card">' +
      '<div class="alert-top">' +
      '<span class="alert-type">' +
      typeLabel +
      '</span>' +
      '<span class="alert-name">' +
      esc(alert.label) +
      '</span>' +
      '</div>' +
      '<div class="alert-figures">' +
      '<span class="alert-actual">' +
      alert.actual.display +
      '</span>' +
      '<span class="alert-vs">超过阈值 ' +
      alert.threshold.display +
      '（超出 ' +
      alert.overBy.display +
      '）</span>' +
      '</div>' +
      '<div class="alert-meta"><span>' +
      statement +
      '</span>' +
      (baseNote ? '<span>' + baseNote + '</span>' : '') +
      '</div>' +
      '</article>'
    );
  }

  function renderAlerts() {
    var analysis = currentAnalysis();
    var diff = currentDiff();
    var grid = $('#alert-grid');
    var empty = $('#alert-empty');
    var summary = $('#alert-summary');
    var resolvedRow = $('#resolved-row');

    if (analysis.alerts.length === 0) {
      grid.innerHTML = '';
      grid.hidden = true;
      empty.hidden = false;
      summary.textContent = '无提醒';
      summary.className = 'badge badge-ok';
    } else {
      grid.hidden = false;
      empty.hidden = true;
      var baseAlerts = diff ? diff.alerts.base : null;
      grid.innerHTML = analysis.alerts
        .map(function (alert) {
          return alertCardHtml(alert, baseAlerts);
        })
        .join('');
      summary.textContent = '触发 ' + analysis.alerts.length + ' 项';
      summary.className = 'badge badge-danger';
    }

    if (diff && diff.alerts.resolved.length > 0) {
      resolvedRow.hidden = false;
      $('#resolved-list').innerHTML = diff.alerts.resolved
        .map(function (alert) {
          return (
            '<span class="resolved-chip" data-testid="resolved-chip">✓ ' +
            esc(alert.label) +
            ' ' +
            alert.actual.display +
            ' 已解除</span>'
          );
        })
        .join('');
    } else {
      resolvedRow.hidden = true;
      $('#resolved-list').innerHTML = '';
    }
  }

  /* ---------- 持仓明细 ---------- */

  function compareCell(nowText, baseText, deltaText, deltaPct2) {
    if (!isComparing()) {
      return '<span class="val-now">' + nowText + '</span>';
    }
    return (
      '<span class="val-now">' +
      nowText +
      '<span class="val-delta ' +
      deltaClass(deltaPct2) +
      '">' +
      deltaText +
      '</span></span>' +
      '<span class="val-base">原 ' +
      baseText +
      '</span>'
    );
  }

  function renderHoldings() {
    var diff = currentDiff();
    var body = $('#holdings-body');
    var rows;

    if (diff) {
      rows = diff.positions.map(function (position) {
        return {
          symbol: position.symbol,
          name: position.name,
          industry: position.industry,
          price: position.price.display,
          currentQuantity: position.currentQuantity,
          baseQuantity: position.baseQuantity,
          quantityDelta: position.quantityDelta,
          currentMarketValue: position.currentMarketValue.display,
          baseMarketValue: position.baseMarketValue.display,
          marketValueDelta: signedMoney(position.marketValueDelta),
          marketValueDeltaValue: position.marketValueDelta.cents,
          currentWeight: position.currentWeight.display,
          baseWeight: position.baseWeight.display,
          weightDelta: signedPct(position.weightDelta),
          weightDeltaValue: position.weightDelta.pct2,
          overThreshold: position.overThreshold
        };
      });
    } else {
      rows = state.base.analysis.positions.map(function (position) {
        return {
          symbol: position.symbol,
          name: position.name,
          industry: position.industry,
          price: position.price.display,
          currentQuantity: position.quantity,
          baseQuantity: position.quantity,
          quantityDelta: 0,
          currentMarketValue: position.marketValue.display,
          baseMarketValue: position.marketValue.display,
          marketValueDelta: '',
          marketValueDeltaValue: 0,
          currentWeight: position.weight.display,
          baseWeight: position.weight.display,
          weightDelta: '',
          weightDeltaValue: 0,
          overThreshold: position.overThreshold
        };
      });
    }

    body.innerHTML = rows
      .map(function (row) {
        var quantityText = String(row.currentQuantity);
        var statusPill =
          row.currentQuantity === 0
            ? '<span class="pill pill-muted">已清仓</span>'
            : row.overThreshold
              ? '<span class="pill pill-danger">超限</span>'
              : '<span class="pill pill-ok">正常</span>';

        var qtyDeltaText = row.quantityDelta === 0 ? '0' : row.quantityDelta > 0 ? '+' + row.quantityDelta : String(row.quantityDelta);

        return (
          '<tr class="' +
          (row.overThreshold ? 'is-over' : '') +
          '" data-testid="holding-row" data-symbol="' +
          esc(row.symbol) +
          '">' +
          '<td class="symbol-cell">' +
          '<span class="symbol-code">' +
          esc(row.symbol) +
          '</span>' +
          '<span class="symbol-name">' +
          esc(row.name) +
          '</span>' +
          '<span class="industry-tag">' +
          esc(row.industry) +
          '</span>' +
          '</td>' +
          '<td class="num">' +
          row.price +
          '</td>' +
          '<td class="num">' +
          compareCell(quantityText, String(row.baseQuantity), qtyDeltaText, row.quantityDelta) +
          '</td>' +
          '<td class="num">' +
          compareCell(row.currentMarketValue, row.baseMarketValue, row.marketValueDelta, row.marketValueDeltaValue) +
          '</td>' +
          '<td class="num">' +
          compareCell(row.currentWeight, row.baseWeight, row.weightDelta, row.weightDeltaValue) +
          '</td>' +
          '<td class="col-status">' +
          statusPill +
          '</td>' +
          '</tr>'
        );
      })
      .join('');

    $('#holdings-legend').hidden = !isComparing();
    $('#holdings-sub').textContent = isComparing()
      ? '上方为当前（模拟/方案）值，灰色为原始值；占比 = 市值 ÷ 总资产（含现金）'
      : '按行情快照价格计算市值与占比；占比 = 市值 ÷ 总资产（含现金）';

    var analysis = currentAnalysis();
    $('#holdings-foot').textContent =
      '持仓市值合计 ' +
      analysis.marketValue.display +
      ' + 现金 ' +
      analysis.cash.display +
      ' = 总资产 ' +
      analysis.totalAsset.display +
      '；占比四舍五入到两位小数，合计可能不等于 100%。';
  }

  /* ---------- 行业分布 ---------- */

  function renderIndustries() {
    var diff = currentDiff();
    var thresholdPct = state.base.thresholds.industry.pct2 / 100;
    var list = $('#industry-list');
    var rows;

    if (diff) {
      rows = diff.industries.map(function (bucket) {
        return {
          industry: bucket.industry,
          currentWeight: bucket.currentWeight,
          baseWeight: bucket.baseWeight,
          over: bucket.overThreshold,
          currentMarketValue: bucket.currentMarketValue.display
        };
      });
    } else {
      rows = state.base.analysis.industries.map(function (bucket) {
        return {
          industry: bucket.industry,
          currentWeight: bucket.weight,
          baseWeight: bucket.weight,
          over: bucket.overThreshold,
          currentMarketValue: bucket.marketValue.display
        };
      });
    }

    list.innerHTML = rows
      .map(function (row) {
        var width = Math.min(100, row.currentWeight.pct2 / 100);
        var baseWidth = Math.min(100, row.baseWeight.pct2 / 100);
        return (
          '<div class="industry-row" data-testid="industry-row">' +
          '<div class="industry-name">' +
          (row.over ? '<span class="over-dot" aria-hidden="true"></span>' : '') +
          esc(row.industry) +
          '</div>' +
          '<div class="bar-track">' +
          '<div class="bar-fill' +
          (row.over ? ' is-over' : '') +
          '" style="width:' +
          width +
          '%"></div>' +
          (isComparing()
            ? '<div class="bar-base" style="width:' + baseWidth + '%"></div>'
            : '') +
          '<div class="bar-threshold" style="left:' +
          thresholdPct +
          '%" title="行业阈值 ' +
          state.base.thresholds.industry.display +
          '"></div>' +
          '</div>' +
          '<div class="industry-values"><b>' +
          row.currentWeight.display +
          '</b>' +
          (isComparing() ? '<span>原 ' + row.baseWeight.display + '</span>' : '<span>' + row.currentMarketValue + '</span>') +
          '</div>' +
          '</div>'
        );
      })
      .join('');
  }

  /* ---------- 操作序列 ---------- */

  function suggestionFor(error) {
    var details = error.details || {};
    var instrument = null;
    if (state.base && details.symbol) {
      instrument = state.base.instruments.filter(function (item) {
        return item.symbol === details.symbol;
      })[0];
    }

    switch (error.code) {
      case 'INSUFFICIENT_CASH': {
        if (instrument && instrument.price.cents > 0) {
          var maxBuy = Math.floor(details.availableCents / instrument.price.cents);
          return '按可用现金 ' + (details.availableCents / 100).toFixed(2) + ' 元，最多可买入 ' + maxBuy + ' 股 ' + details.symbol + '。';
        }
        return '请减少买入数量，或先卖出其他标的补充现金。';
      }
      case 'INSUFFICIENT_POSITION':
        return '当前模拟持仓 ' + details.availableQuantity + ' 股，卖出数量不能超过该数量。';
      case 'INVALID_QUANTITY':
        return '数量必须是大于 0 的整数（不能为 0、负数或小数）。';
      case 'UNKNOWN_SYMBOL':
        return '仅支持行情快照中的标的：' + (details.allowedSymbols || []).join('、') + '。';
      case 'INVALID_SIDE':
        return '方向仅支持买入（BUY）或卖出（SELL）。';
      case 'TOO_MANY_OPERATIONS':
        return '方案最多 ' + details.max + ' 笔操作，请保存当前方案后重新开始。';
      default:
        return '';
    }
  }

  function showOperationError(error) {
    $('#op-error').hidden = false;
    $('#op-error-code').textContent = error.code || 'ERROR';
    $('#op-error-msg').textContent = error.message || '操作未被接受';
    var hint = suggestionFor(error);
    $('#op-error-hint').textContent = hint;
    $('#op-error-hint').hidden = hint === '';
  }

  function clearOperationError() {
    $('#op-error').hidden = true;
    $('#op-error-code').textContent = '';
    $('#op-error-msg').textContent = '';
    $('#op-error-hint').textContent = '';
  }

  function renderOperations() {
    var form = $('#op-form');
    var saveBox = $('.save-box');
    var list = $('#op-list');
    var empty = $('#op-empty');
    var count = $('#op-count');

    if (isReadOnly()) {
      // 查看已保存方案：操作只读展示，表单与保存入口隐藏。
      form.hidden = true;
      saveBox.hidden = true;
      $('#op-hint').hidden = true;
      $('#op-reset').hidden = true;
      $('#sim-sub').textContent = '已保存方案为只读；再次打开或复制操作请先「退出查看」';
      // 只读模式不展示"现金/总资产变化"（KPI 已给出方案当前值），避免残留上一次草稿的数字。
      $('#sim-compare').hidden = true;

      var planOps = state.activePlan.operations;
      count.textContent = String(planOps.length);
      empty.hidden = true;
      list.innerHTML = planOps
        .map(function (operation) {
          return (
            '<li class="op-item">' +
            '<span class="op-index">' +
            (operation.index + 1) +
            '</span>' +
            '<span class="op-side ' +
            (operation.side === 'BUY' ? 'side-buy' : 'side-sell') +
            '">' +
            operation.sideLabel +
            '</span>' +
            '<span class="op-desc"><b>' +
            esc(operation.symbol) +
            '</b> ' +
            esc(operation.name) +
            ' × ' +
            operation.quantity +
            '</span>' +
            '<span class="op-amount">只读</span>' +
            '<span></span>' +
            '</li>'
          );
        })
        .join('');
      return;
    }

    form.hidden = false;
    saveBox.hidden = false;
    $('#op-hint').hidden = false;
    $('#sim-sub').textContent = '按顺序添加买卖操作，全部使用同一行情快照';

    count.textContent = String(state.operations.length);
    $('#op-reset').hidden = state.operations.length === 0;
    empty.hidden = state.operations.length > 0;

    list.innerHTML = state.operations
      .map(function (operation, index) {
        var step = state.steps[index];
        var amountText = step ? (operation.side === 'BUY' ? '-' : '+') + step.amount.display : '';
        return (
          '<li class="op-item" data-testid="op-item">' +
          '<span class="op-index">' +
          (index + 1) +
          '</span>' +
          '<span class="op-side ' +
          (operation.side === 'BUY' ? 'side-buy' : 'side-sell') +
          '">' +
          (operation.side === 'BUY' ? '买入' : '卖出') +
          '</span>' +
          '<span class="op-desc"><b>' +
          esc(operation.symbol) +
          '</b> ' +
          esc(step ? step.name : '') +
          ' × ' +
          operation.quantity +
          '</span>' +
          '<span class="op-amount">' +
          amountText +
          '</span>' +
          '<button type="button" class="op-remove" data-index="' +
          index +
          '" data-testid="op-remove" aria-label="移除第 ' +
          (index + 1) +
          ' 笔操作">✕</button>' +
          '</li>'
        );
      })
      .join('');

    var analysis = currentAnalysis();
    var diff = currentDiff();
    var instrument = selectedInstrument();
    var hintParts = [];
    hintParts.push('可用现金 ' + analysis.cash.display);
    if (instrument) {
      var holding = analysis.positions.filter(function (position) {
        return position.symbol === instrument.symbol;
      })[0];
      hintParts.push('当前可卖 ' + (holding ? holding.quantity : 0) + ' 股');
      hintParts.push('价格 ' + instrument.price.display);
    }
    $('#op-hint').textContent = hintParts.join(' · ');

    var compare = $('#sim-compare');
    if (diff) {
      compare.hidden = false;
      $('#sim-cash').textContent = diff.cash.base.display + ' → ' + diff.cash.current.display;
      $('#sim-total').textContent =
        diff.totalAsset.base.display + ' → ' + diff.totalAsset.current.display + (diff.totalAsset.invariantHolds ? '（不变）' : '（异常）');
    } else {
      compare.hidden = true;
    }
  }

  function renderSimStatus() {
    var badge = $('#sim-status');
    if (isReadOnly()) {
      badge.textContent = '已保存方案';
      badge.className = 'badge badge-warn';
      return;
    }
    if (state.operations.length > 0) {
      badge.textContent = '模拟中 · ' + state.operations.length + ' 笔';
      badge.className = 'badge badge-accent';
    } else {
      badge.textContent = '原始组合';
      badge.className = 'badge badge-muted';
    }
  }

  /* ---------- 已保存方案 ---------- */

  function renderPlans() {
    var list = $('#plan-list');
    var empty = $('#plan-empty');
    $('#plan-count').textContent = state.plans.length + ' 个';

    if (state.plans.length === 0) {
      list.innerHTML = '';
      empty.hidden = false;
      return;
    }

    empty.hidden = true;
    list.innerHTML = state.plans
      .map(function (plan) {
        var active = state.activePlan && state.activePlan.plan.id === plan.id;
        var highlight = state.highlightPlanId === plan.id;
        return (
          '<article class="plan-item' +
          (active ? ' is-active' : '') +
          (highlight ? ' is-active' : '') +
          '" data-testid="plan-item">' +
          '<p class="plan-name">' +
          esc(plan.name) +
          '</p>' +
          '<p class="plan-meta">' +
          plan.operationCount +
          ' 笔操作 · 保存于 ' +
          esc(plan.createdAtDisplay) +
          ' · 快照 ' +
          esc(plan.snapshotId) +
          '</p>' +
          '<p class="plan-summary" title="' +
          esc(plan.operationSummary) +
          '">' +
          esc(plan.operationSummary) +
          '</p>' +
          '<div class="plan-foot">' +
          '<span class="plan-stat">现金 ' +
          plan.summary.cash.display +
          ' · 提醒 ' +
          plan.summary.alertCount +
          ' 项</span>' +
          '<button type="button" class="btn btn-secondary btn-xs" data-testid="plan-open" data-plan-id="' +
          esc(plan.id) +
          '"' +
          (active ? ' disabled' : '') +
          '>' +
          (active ? '正在查看' : '重新打开') +
          '</button>' +
          '</div>' +
          '</article>'
        );
      })
      .join('');
  }

  /* ---------- 总渲染 ---------- */

  function renderAll() {
    if (state.status !== 'ready') {
      return;
    }
    renderMeta();
    renderBanner();
    renderKpi();
    renderAlerts();
    renderHoldings();
    renderIndustries();
    renderOperations();
    renderSimStatus();
    renderPlans();
    document.body.dataset.state = 'ready';
  }

  /* ---------- 交互 ---------- */

  function selectedInstrument() {
    var select = $('#op-symbol');
    if (!select.value || !state.base) {
      return null;
    }
    return (
      state.base.instruments.filter(function (instrument) {
        return instrument.symbol === select.value;
      })[0] || null
    );
  }

  async function runSimulation(nextOperations, options) {
    if (state.busy) {
      return;
    }
    var opts = options || {};
    state.busy = true;
    var addButton = $('#op-add');
    var previousLabel = addButton.textContent;
    addButton.disabled = true;
    addButton.textContent = '校验中…';

    try {
      var payload = await api('/api/simulate', {
        method: 'POST',
        body: JSON.stringify({ operations: nextOperations })
      });

      state.operations = payload.operations.map(function (step) {
        return { side: step.side, symbol: step.symbol, quantity: step.quantity };
      });
      state.steps = payload.operations;
      state.simulated = payload.simulated;
      state.diff = state.operations.length > 0 ? payload.diff : null;
      if (state.operations.length === 0) {
        state.steps = [];
        state.simulated = null;
      }
      clearOperationError();
      if (opts.clearQuantityInput) {
        $('#op-quantity').value = '';
      }
      renderAll();
      if (state.operations.length > 0) {
        toast('已加入第 ' + state.operations.length + ' 笔操作', 'ok');
      }
    } catch (error) {
      if (error instanceof ApiError) {
        showOperationError(error);
      } else {
        toast('操作失败：' + error.message, 'error');
      }
    } finally {
      state.busy = false;
      addButton.disabled = false;
      addButton.textContent = previousLabel;
    }
  }

  function buildInstrumentOptions() {
    var select = $('#op-symbol');
    select.innerHTML = state.base.instruments
      .map(function (instrument) {
        return (
          '<option value="' +
          esc(instrument.symbol) +
          '">' +
          esc(instrument.symbol) +
          ' ' +
          esc(instrument.name) +
          ' · ' +
          instrument.price.display +
          '</option>'
        );
      })
      .join('');
  }

  async function refreshPlans() {
    var payload = await api('/api/plans');
    state.plans = payload.plans;
  }

  async function savePlan() {
    if (state.saving) {
      return;
    }
    var nameInput = $('#save-name');
    var name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      nameInput.setAttribute('aria-invalid', 'true');
      toast('请先填写方案名称', 'error');
      return;
    }
    if (state.operations.length === 0) {
      toast('请先添加至少一笔调仓操作', 'error');
      return;
    }

    state.saving = true;
    var button = $('#save-button');
    var label = button.textContent;
    button.disabled = true;
    button.textContent = '保存中…';

    try {
      var payload = await api('/api/plans', {
        method: 'POST',
        body: JSON.stringify({ name: name, operations: state.operations })
      });
      await refreshPlans();
      state.highlightPlanId = payload.plan.id;
      nameInput.value = '';
      nameInput.removeAttribute('aria-invalid');
      renderPlans();
      toast('方案「' + payload.plan.name + '」已保存：' + payload.plan.id, 'ok');
    } catch (error) {
      if (error instanceof ApiError && error.code === 'INVALID_PLAN_NAME') {
        nameInput.setAttribute('aria-invalid', 'true');
      }
      toast('保存失败：' + error.message, 'error');
    } finally {
      state.saving = false;
      button.disabled = false;
      button.textContent = label;
    }
  }

  async function openPlan(id) {
    try {
      var detail = await api('/api/plans/' + encodeURIComponent(id));
      state.activePlan = detail;
      state.highlightPlanId = null;
      renderAll();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      toast('打开方案失败：' + error.message, 'error');
    }
  }

  function exitPlanView() {
    state.activePlan = null;
    renderAll();
  }

  function bindEvents() {
    $('#op-form').addEventListener('submit', function (event) {
      event.preventDefault();
      if (isReadOnly() || state.busy) {
        return;
      }
      var symbol = $('#op-symbol').value;
      var side = $('#op-side').value;
      var quantity = $('#op-quantity').value.trim();
      clearOperationError();
      if (!quantity) {
        showOperationError({ code: 'INVALID_QUANTITY', message: '请填写交易数量', details: {} });
        $('#op-quantity').focus();
        return;
      }
      runSimulation(state.operations.concat([{ side: side, symbol: symbol, quantity: quantity }]), {
        clearQuantityInput: true
      });
    });

    $('#op-quantity').addEventListener('input', function () {
      clearOperationError();
    });

    $('#op-symbol').addEventListener('change', renderOperations);
    $('#op-side').addEventListener('change', renderOperations);

    $('#op-list').addEventListener('click', function (event) {
      var button = event.target.closest('[data-index]');
      if (!button || isReadOnly() || state.busy) {
        return;
      }
      var index = Number(button.getAttribute('data-index'));
      var next = state.operations.filter(function (_, position) {
        return position !== index;
      });
      runSimulation(next);
    });

    $('#op-reset').addEventListener('click', function () {
      if (state.busy) {
        return;
      }
      state.operations = [];
      state.steps = [];
      state.simulated = null;
      state.diff = null;
      clearOperationError();
      renderAll();
    });

    $('#save-button').addEventListener('click', savePlan);

    $('#plan-list').addEventListener('click', function (event) {
      var button = event.target.closest('[data-plan-id]');
      if (!button) {
        return;
      }
      openPlan(button.getAttribute('data-plan-id'));
    });

    $('#exit-plan').addEventListener('click', exitPlanView);
    $('#overlay-retry').addEventListener('click', boot);
  }

  /* ---------- 启动 ---------- */

  function showFatalError(error) {
    state.status = 'error';
    document.body.dataset.state = 'error';
    $('#overlay-title').textContent = '无法加载组合数据';
    $('#overlay-desc').textContent =
      (error.message || '未知错误') + '\n请确认服务已启动（node server.js），再点击重试。';
    $('#overlay-retry').hidden = false;
  }

  async function boot() {
    state.status = 'loading';
    state.activePlan = null;
    document.body.dataset.state = 'loading';
    $('#overlay-title').textContent = '正在加载组合数据…';
    $('#overlay-desc').textContent = '首次请求需要拉取组合快照与已保存方案';
    $('#overlay-retry').hidden = true;

    try {
      var results = await Promise.all([api('/api/portfolio'), api('/api/plans')]);
      state.base = results[0];
      state.plans = results[1].plans;
      state.operations = [];
      state.steps = [];
      state.simulated = null;
      state.diff = null;
      state.status = 'ready';
      buildInstrumentOptions();
      renderAll();
    } catch (error) {
      showFatalError(error);
    }
  }

  bindEvents();
  boot();
})();
