/* 组件画廊：静态呈现 36 个组件的状态，供人工评审与一致性门禁使用。
   不连接宿主状态，不写入任何数据。 */
(() => {
  "use strict";

  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $$ = id => document.getElementById(id);

  const btn = (variant, label, opts = {}) => `<button type="button" class="bb-btn${variant ? " bb-btn--" + variant : ""}${opts.sm ? " bb-btn--sm" : ""}" ${opts.disabled ? "disabled" : ""} ${opts.audit ? `data-audit="${opts.audit}"` : ""}>${label}</button>`;

  const sections = [];

  sections.push({
    title: "按钮与操作",
    note: "三级主次 + 危险动作 + 小尺寸；禁用态不改变语义，只降低可操作性。",
    html: `<div class="gal-rows">
      <div class="gal-row"><span class="gal-label">默认</span>
        ${btn("primary", "主操作", { audit: "btn-primary" })}${btn("", "次操作", { audit: "btn-default" })}
        ${btn("quiet", "静默", { audit: "btn-quiet" })}${btn("danger", "危险动作", { audit: "btn-danger" })}</div>
      <div class="gal-row"><span class="gal-label">小尺寸</span>
        ${btn("primary", "批准", { sm: true })}${btn("", "驳回", { sm: true })}${btn("quiet", "取消", { sm: true })}
        <button class="bb-link" type="button">文字链接</button>
        <span class="bb-kbd">1</span><span class="bb-kbd">Enter</span></div>
      <div class="gal-row"><span class="gal-label">禁用 / 焦点</span>
        ${btn("primary", "不可用", { disabled: true })}${btn("", "不可用", { disabled: true })}
        <span class="bb-tip" data-tip="悬停或聚焦显示提示">${btn("", "带提示按钮")}</span>
        <span class="gal-note">焦点环为 3px 实色，颜色取自 --bb-accent。</span></div>
    </div>`
  });

  sections.push({
    title: "表单与输入",
    note: "控件描边单独一档并达到 3:1；错误态同时使用文字与颜色。",
    html: `<div class="gal-cols">
      <div class="bb-field"><label for="g-name">项目名称</label><input class="bb-input" id="g-name" value="Q4 研发项目"></div>
      <div class="bb-field"><label for="g-select">模型范围</label><select class="bb-select" id="g-select"><option>跟随模型池</option><option>仅指定模型</option></select></div>
      <div class="bb-field"><label for="g-amount">金额（元）</label><div class="bb-amount"><input class="bb-input" id="g-amount" inputmode="decimal" value="5000.00"></div><span class="bb-hint">最多两位小数，必须大于 0。</span></div>
      <div class="bb-field"><label for="g-error">金额</label><div class="bb-amount"><input class="bb-input" id="g-error" aria-invalid="true" aria-describedby="g-error-msg" value="0"></div><span class="bb-field-error" id="g-error-msg">金额需大于 0。</span></div>
      <div class="bb-field"><label for="g-textarea">使用说明</label><textarea class="bb-textarea" id="g-textarea" rows="3">用于 Q4 项目联调与文档整理。</textarea></div>
      <div class="bb-field"><span class="gal-label" style="min-width:0">开关与勾选</span>
        <div class="gal-row"><button type="button" class="bb-switch" id="g-switch" aria-checked="true"><span class="bb-switch-track"></span>启用</button>
        <label class="bb-check"><input type="checkbox" checked> 跟随模型池</label></div></div>
    </div>`
  });

  sections.push({
    title: "状态标签",
    note: "颜色永远配文字；不允许只用色块表达状态。",
    html: `<div class="gal-row">
      <span class="bb-badge">中性</span><span class="bb-badge bb-badge--ok">已发放</span>
      <span class="bb-badge bb-badge--warn">待处理</span><span class="bb-badge bb-badge--danger">已驳回</span>
      <span class="bb-badge bb-badge--info">运行中</span><span class="bb-badge bb-badge--accent">成员</span>
    </div>`
  });

  sections.push({
    title: "提示与反馈",
    note: "四类提示共用结构，语气与图标随语义变化；正文保持可读对比度。",
    html: `<div class="gal-rows">
      <div class="bb-notice bb-notice--info"><span class="bb-notice-icon" aria-hidden="true">i</span><div><b>审批人：林晓</b> 批准后更新对应用途余额，模型范围保持不变。</div></div>
      <div class="bb-notice bb-notice--ok"><span class="bb-notice-icon" aria-hidden="true">✓</span><div><b>已发放 ¥150.00</b> 来源批次已记录，成员可用额度已更新。</div></div>
      <div class="bb-notice bb-notice--warn"><span class="bb-notice-icon" aria-hidden="true">!</span><div><b>运行数据未接入</b> 未接入监控采集，不能据此判断服务健康。</div></div>
      <div class="bb-notice bb-notice--danger"><span class="bb-notice-icon" aria-hidden="true">×</span><div><b>读取失败</b> 采集服务不可用，可以重试或稍后查看。</div></div>
    </div>`
  });

  sections.push({
    title: "导航与分段",
    note: "页内切换用 tabs；同一组互斥选项用 segmented，两者都支持键盘操作。",
    html: `<div class="gal-rows">
      <div class="bb-tabs" role="tablist"><button type="button" role="tab" aria-selected="true">待处理 · 3</button><button type="button" role="tab" aria-selected="false">已处理</button></div>
      <div class="gal-row"><span class="gal-label">用途</span>
        <div class="bb-segmented" role="group"><button type="button" aria-pressed="true">个人</button><button type="button" aria-pressed="false">Q4</button><button type="button" aria-pressed="false">客服</button></div>
        <div class="bb-stepper"><li aria-current="step"><span class="bb-step-dot">1</span>选择项目</li><li><span class="bb-step-dot">2</span>发放总额度</li><li><span class="bb-step-dot">3</span>分配给成员</li></div>
      </div>
    </div>`
  });

  sections.push({
    title: "表格",
    note: "表头冷调底、行分隔发丝线；窄屏只在表格容器内横向滚动。",
    html: `<div class="bb-tablewrap"><table class="bb-table">
      <thead><tr><th scope="col">批次</th><th scope="col">发放金额</th><th scope="col">已分配</th><th scope="col">到期</th><th scope="col">状态</th></tr></thead>
      <tbody>
        <tr><td><b>Q4-01</b><small>运营首批发放</small></td><td class="bb-num">¥5,000.00</td><td class="bb-num">¥150.00</td><td>2026-12-31</td><td><span class="bb-badge bb-badge--ok">已发放</span></td></tr>
        <tr><td><b>Q4-02</b><small>经理追加</small></td><td class="bb-num">¥1,000.00</td><td class="bb-num">¥0.00</td><td>2026-12-31</td><td><span class="bb-badge bb-badge--warn">待分配</span></td></tr>
      </tbody></table></div>`
  });

  sections.push({
    title: "数据状态",
    note: "空、加载、失败三态都必须给出下一步；空状态不暗示能力缺失。",
    html: `<div class="gal-cols">
      <div class="bb-empty" data-audit="empty"><b>还没有调用记录</b><p>完成一次在线使用后，这里会按用途记录。</p>${btn("primary", "去在线使用", { sm: true })}</div>
      <div class="bb-loading" aria-busy="true"><span class="bb-sr">正在加载</span><div class="bb-skeleton bb-skeleton--wide"></div><div class="bb-skeleton"></div><div class="bb-skeleton bb-skeleton--short"></div></div>
      <div class="bb-empty"><b>数据读取失败</b><p>采集服务不可用，请重试。</p>${btn("", "重新加载", { sm: true })}</div>
    </div>`
  });

  sections.push({
    title: "主卡（Hero）",
    note: "整页唯一深色面；光晕随状态变化，不承担信息，状态仍由文字表达。",
    html: `<div class="bb-hero" data-tone="accent" data-audit="hero">
      <div class="bb-hero-aura" aria-hidden="true"></div>
      <div class="bb-hero-grid">
        <div class="bb-hero-main">
          <div class="bb-hero-state"><span class="bb-dot" aria-hidden="true"></span>现在可以开始</div>
          <h2>用 Qwen 2.5 处理今天的工作</h2>
          <p class="bb-hero-sub">在下面直接输入内容，请求会按当前用途扣费。</p>
          <p class="bb-hero-num"><span class="bb-cur" aria-hidden="true">¥</span><span class="bb-val">300.00</span><span class="bb-unit">可用</span></p>
          <p class="bb-hero-note">个人通用额度 · 有效期至 2026-11-30</p>
          <div class="bb-hero-actions">${btn("primary", "在线开始使用")}${btn("ghost-inverse", "查看额度明细")}</div>
        </div>
        <aside class="bb-hero-side">
          <div><p class="bb-hero-side-title">适用范围</p><div class="bb-hero-chips"><span class="bb-chip">Qwen 2.5</span><span class="bb-chip">DeepSeek V3</span></div></div>
          <div><p class="bb-hero-side-title">额度来源</p>
            <div class="bb-hero-kv"><span>来源</span><b>运营 · 月度方案</b></div>
            <div class="bb-hero-kv"><span>有效期</span><b>2026-11-30</b></div></div>
        </aside>
      </div>
    </div>`
  });

  sections.push({
    title: "额度带与指标",
    note: "色带按金额分配宽度，可点击切换；运营口径不同时改为等宽并注明不可相加。",
    html: `<div class="bb-ribbon" role="group" aria-label="额度分布" data-audit="ribbon">
        <button type="button" class="bb-ribbon-seg" data-tone="1" aria-pressed="true" style="flex:30000 1 0%"><span class="bb-ribbon-name">个人</span><span class="bb-ribbon-val">¥300.00</span></button>
        <button type="button" class="bb-ribbon-seg" data-tone="empty" aria-pressed="false" style="flex:3200 1 0%"><span class="bb-ribbon-name">Q4</span><span class="bb-ribbon-val">¥0.00</span></button>
        <button type="button" class="bb-ribbon-seg" data-tone="2" aria-pressed="false" style="flex:50000 1 0%"><span class="bb-ribbon-name">客服</span><span class="bb-ribbon-val">¥500.00</span></button>
      </div>
      <div class="bb-legend"><span><i style="background:var(--bb-accent)"></i>个人 <b>¥300.00</b></span><span><i style="background:var(--bb-chart-2)"></i>客服 <b>¥500.00</b></span><span><i style="background:var(--bb-surface-3);border:1px solid var(--bb-border-default)"></i>Q4 <b>¥0.00</b></span></div>
      <div class="bb-stat-grid" style="margin-top:var(--bb-space-4)">
        <div class="bb-stat"><div class="bb-stat-label">可用余额</div><div class="bb-stat-value">¥300.00</div><div class="bb-stat-detail">个人通用额度</div></div>
        <div class="bb-stat"><div class="bb-stat-label">待审批</div><div class="bb-stat-value">3</div><div class="bb-stat-detail">按职责汇总</div></div>
        <div class="bb-stat"><div class="bb-stat-label">项目待分配</div><div class="bb-stat-value">¥7,350.00</div><div class="bb-stat-detail">仍在项目批次</div></div>
      </div>`
  });

  sections.push({
    title: "申请与审批",
    note: "审批就地展开：金额、有效期与影响同屏可见，确认后才生效。",
    html: `<div class="bb-request" data-status="pending" data-audit="request">
        <div class="bb-request-head">
          <div class="bb-request-who">陈默 · 项目成员额度<small>Q4 研发项目 · 1 天前</small></div>
          <span class="bb-badge bb-badge--warn">待处理</span>
          <div class="bb-request-amt">¥ 200.00<small>申请金额</small></div>
        </div>
        <div class="bb-request-meta"><span>审批人：赵宁</span><span>有效期 2026-12-31</span><span>RQ-097</span></div>
        <div class="bb-request-actions">${btn("primary", "批准", { sm: true })}${btn("", "驳回", { sm: true })}</div>
      </div>
      <div class="bb-request" data-status="pending" style="margin-top:var(--bb-space-3)">
        <div class="bb-request-head">
          <div class="bb-request-who">陈默 · 个人通用额度<small>个人通用额度 · 5 小时前</small></div>
          <span class="bb-badge bb-badge--warn">待处理</span>
          <div class="bb-request-amt">¥ 100.00<small>申请金额</small></div>
        </div>
        <div class="bb-approval">
          <div class="bb-approval-grid">
            <div class="bb-field"><label for="g-approve">批准金额（元）</label><div class="bb-amount"><input class="bb-input" id="g-approve" value="100.00"></div></div>
            <div class="bb-field"><label for="g-expiry">有效期</label><input class="bb-input" id="g-expiry" value="2026-11-30"></div>
          </div>
          <p class="bb-impact">批准后：<b>个人通用额度</b> 可用额度增加 <b>¥100.00</b>，申请人会收到结果通知。</p>
          <div class="bb-request-actions">${btn("primary", "确认发放")}${btn("", "取消")}</div>
        </div>
      </div>`
  });

  sections.push({
    title: "就地输入与路径",
    note: "发送请求不跳页；来源路径用三个节点说明额度如何到达。",
    html: `<div class="gal-cols">
      <div class="bb-composer">
        <label class="bb-hint" for="g-prompt">用「个人通用额度」发送一次请求</label>
        <textarea class="bb-textarea" id="g-prompt" placeholder="例如：把今天的会议记录整理成三条结论"></textarea>
        <div class="bb-composer-foot"><span>本地模拟 · 每次成功扣 ¥0.02</span><div class="gal-row">${btn("", "取消", { sm: true })}${btn("primary", "发送", { sm: true })}</div></div>
      </div>
      <div class="bb-stack">
        <div class="bb-path">
          <div class="bb-path-node"><small>项目</small><b>Q4 研发项目</b><em>赵宁 · 经理直接分配</em></div>
          <span class="bb-path-arrow" aria-hidden="true">→</span>
          <div class="bb-path-node"><small>用途</small><b>Q4</b><em>有效期 2026-12-31</em></div>
          <span class="bb-path-arrow" aria-hidden="true">→</span>
          <div class="bb-path-node"><small>模型</small><b>Qwen 2.5</b><em>DeepSeek V3</em></div>
        </div>
        <dl class="bb-dl"><div><dt>申请单</dt><dd>RQ-102</dd></div><div><dt>金额</dt><dd>¥1,000.00</dd></div><div><dt>到期</dt><dd>2026-12-31</dd></div></dl>
      </div>
    </div>`
  });

  sections.push({
    title: "弹窗",
    note: "只在需要阻塞确认时使用；本主题的审批与明细均就地展开，不弹窗。",
    html: `<dialog class="bb-dialog" open>
      <h2>停用这个模型服务？</h2>
      <p>停用后，来自该服务的模型停止新调用；已发放额度与历史日志保留。</p>
      <div class="bb-dialog-actions">${btn("", "取消")}${btn("danger", "确认停用")}</div>
    </dialog>`
  });

  function render() {
    const grid = $$("galGrid");
    const frag = document.createRange().createContextualFragment(sections.map(s => `<section class="gal-section">
      <h2>${esc(s.title)}</h2><p>${s.note}</p><div class="gal-rows">${s.html}</div></section>`).join(""));
    grid.replaceChildren(frag);
  }

  render();

  $$("g-switch").addEventListener("click", ev => {
    const el = ev.currentTarget;
    el.setAttribute("aria-checked", el.getAttribute("aria-checked") === "true" ? "false" : "true");
  });
})();
