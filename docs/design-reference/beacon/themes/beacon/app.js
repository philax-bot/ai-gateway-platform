/* Beacon 主题视图层：24 屏，只组合 components.css 中的组件。
   所有数据来自宿主（api.getData），写入通过 api.commit 持久化。
   页面内不允许出现裸色值、裸字号或自定义圆角。 */
(() => {
  "use strict";

  const MODEL = window.SCREEN_MODEL;
  const SCREENS = new Map(MODEL.screens.map(s => [s.id, s]));
  const GLYPHS = { home: "⌂", use: "▷", quota: "◒", models: "◈", requests: "⌁", logs: "≋", myProjects: "▦", keys: "⌘", projects: "▦", allocate: "⇄", apply: "＋", budgetApply: "＋", approvals: "⌁", overview: "◉", members: "◇", plans: "▤", catalog: "◈", services: "◧", serviceEdit: "✎", pools: "◫", projectNew: "＋", projectGrant: "↓" };
  const NAV_GROUPS = {
    employee: { home: "工作台", use: "工作台", quota: "额度", models: "额度", requests: "记录", logs: "记录", myProjects: "项目", keys: "接入" },
    manager: { home: "工作台", projects: "项目", allocate: "项目", myProjects: "项目", approvals: "审批", apply: "申请", budgetApply: "申请", requests: "记录", logs: "记录" },
    ops: { overview: "总览", approvals: "审批", members: "成员与开通", plans: "成员与开通", catalog: "资源", services: "资源", pools: "资源", projects: "项目", projectNew: "项目", projectGrant: "项目", request: "审批" }
  };
  const STATE_LABEL = { normal: "正常", empty: "空状态", loading: "加载中", error: "读取失败", denied: "无权限" };
  const NAV_PARENT = { result: "logs", request: "requests", allocate: "projects", budgetApply: "apply", projectNew: "projects", projectGrant: "projects", serviceEdit: "services" };

  let api = null;
  let root = null;
  let focusSel = "";
  let draft = null;
  let ui = { toastTimer: 0, tab: "todo", filter: "all", formError: "", composer: false };

  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = c => (c / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const data = () => api.getData();
  const scopeOf = id => data().scopes[id];
  const screen = () => SCREENS.get(api.getScreen());

  function mount(el, html) {
    const frag = document.createRange().createContextualFragment(html);
    el.replaceChildren(frag);
  }

  function btn(act, label, opts = {}) {
    const variant = opts.variant ? " bb-btn--" + opts.variant : "";
    const size = opts.sm ? " bb-btn--sm" : "";
    const attrs = [
      opts.id ? `id="${opts.id}"` : "",
      opts.data ? Object.entries(opts.data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(" ") : "",
      opts.disabled ? "disabled" : "",
      opts.aria ? Object.entries(opts.aria).map(([k, v]) => `aria-${k}="${esc(v)}"`).join(" ") : "",
      opts.focus ? `data-focus="${opts.focus}"` : ""
    ].filter(Boolean).join(" ");
    return `<button type="button" class="bb-btn${variant}${size}" data-act="${act}" ${attrs}>${label}</button>`;
  }

  function badge(text, tone) { return `<span class="bb-badge${tone ? " bb-badge--" + tone : ""}">${esc(text)}</span>`; }
  const STATUS_TONE = { pending: "warn", approved: "ok", rejected: "danger" };
  const STATUS_TEXT = { pending: "待处理", approved: "已发放", rejected: "已驳回" };

  function field(opts) {
    const id = opts.id;
    const err = opts.error ? `<span class="bb-field-error" id="${id}-error">${esc(opts.error)}</span>` : "";
    const hint = opts.hint ? `<span class="bb-hint">${esc(opts.hint)}</span>` : "";
    const control = opts.textarea
      ? `<textarea class="bb-textarea" id="${id}" name="${opts.name || id}" rows="${opts.rows || 3}" placeholder="${esc(opts.placeholder || "")}" ${opts.required ? "required" : ""}>${esc(opts.value || "")}</textarea>`
      : `<input class="bb-input" id="${id}" name="${opts.name || id}" type="${opts.type || "text"}" value="${esc(opts.value ?? "")}" placeholder="${esc(opts.placeholder || "")}" ${opts.inputmode ? `inputmode="${opts.inputmode}"` : ""} ${opts.required ? "required" : ""} ${opts.readonly ? "readonly" : ""}>`;
    const aria = opts.error ? `aria-invalid="true" aria-describedby="${id}-error"` : "";
    return `<div class="bb-field">${opts.label ? `<label for="${id}">${opts.label}</label>` : ""}${control.replace("<input", `<input ${aria}`).replace("<textarea", `<textarea ${aria}`)}${hint}${err}</div>`;
  }

  function amountField(id, value, label) {
    return `<div class="bb-field"><label for="${id}">${label || "金额（元）"}</label>
      <div class="bb-amount"><input class="bb-input" id="${id}" name="amount" inputmode="decimal" value="${esc(value)}" required></div></div>`;
  }

  function stateBlock(kind, copy) {
    if (kind === "loading") {
      return `<div class="bb-loading" data-state="loading" aria-busy="true">
        <span class="bb-sr">正在加载</span>
        <div class="bb-skeleton bb-skeleton--wide"></div>
        <div class="bb-skeleton"></div><div class="bb-skeleton bb-skeleton--short"></div>
        <div class="bb-skeleton"></div><div class="bb-skeleton bb-skeleton--short"></div>
      </div>`;
    }
    if (kind === "error") {
      return `<div class="bb-empty" data-state="error"><b>数据读取失败</b><p>${esc(copy || "可能是网络或采集服务不可用，请重试。")}</p>${btn("retry", "重新加载")}</div>`;
    }
    if (kind === "denied") {
      return `<div class="bb-empty" data-state="denied"><b>没有查看权限</b><p>${esc(copy || "当前角色没有这个页面的权限。切换到对应角色或在原型中查看演示说明。")}</p>${btn("goto-home", "返回工作台")}</div>`;
    }
    return `<div class="bb-empty" data-state="empty"><b>${esc(copy || screen()?.empty || "暂无数据")}</b><p>空状态不代表没有该能力，可以继续下一步操作。</p>${btn("goto-home", "回到工作台")}</div>`;
  }

  function gate(mode) {
    if (mode === "normal") return "";
    if (mode === "empty") return stateBlock("empty");
    return stateBlock(mode);
  }

  function notice(tone, title, text) {
    const icon = { info: "i", ok: "✓", warn: "!", danger: "×" }[tone] || "i";
    return `<div class="bb-notice bb-notice--${tone}"><span class="bb-notice-icon" aria-hidden="true">${icon}</span><div><b>${esc(title)}</b> ${text}</div></div>`;
  }

  /* ---------------- 通用块 ---------------- */
  function scopeSegmented() {
    const ids = Object.keys(data().scopes);
    return `<div class="bb-segmented" role="group" aria-label="切换用途">${ids.map(id => {
      const s = data().scopes[id];
      return `<button type="button" data-act="scope" data-scope="${id}" aria-pressed="${data().selected.scope === id}">${esc(s.short)}</button>`;
    }).join("")}</div>`;
  }

  function ribbon(entries, opts = {}) {
    const tones = ["1", "2", "3"];
    const segs = entries.map((e, i) => {
      const tone = e.cents === 0 ? "empty" : tones[i % 3];
      const pressed = opts.selectable ? `aria-pressed="${e.active === true}"` : "";
      const tag = opts.selectable ? "button" : "div";
      const act = opts.selectable ? `data-act="scope" data-scope="${e.id}"` : "";
      return `<${tag} class="bb-ribbon-seg" data-tone="${tone}" ${pressed} ${act} style="flex:${opts.equal ? "1 1 0%" : Math.max(e.cents, 3200) + " 1 0%"}">
        <span class="bb-ribbon-name">${esc(e.name)}</span><span class="bb-ribbon-val">¥${money(e.cents)}</span></${tag}>`;
    }).join("");
    const legend = entries.map((e, i) => {
      const tone = e.cents === 0 ? "empty" : tones[i % 3];
      const color = { 1: "var(--bb-accent)", 2: "var(--bb-chart-2)", 3: "var(--bb-surface-3)", empty: "var(--bb-surface-3)" }[tone];
      return `<span><i style="background:${color};border:1px solid var(--bb-border-default)"></i>${esc(e.name)} <b>¥${money(e.cents)}</b></span>`;
    }).join("");
    return `<div class="bb-ribbon" role="${opts.selectable ? "group" : "list"}" aria-label="${esc(opts.label || "额度分布")}">${segs}</div>
      <div class="bb-legend">${legend}</div>
      ${opts.note ? `<p class="bb-hint" style="margin-top:var(--bb-space-2)">${esc(opts.note)}</p>` : ""}`;
  }

  function table(headers, rows) {
    return `<div class="bb-tablewrap"><table class="bb-table"><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }

  function statGrid(items) {
    return `<div class="bb-stat-grid">${items.map(([label, value, detail, size]) => `<div class="bb-stat">
      <div class="bb-stat-label">${esc(label)}</div><div class="bb-stat-value${size === "sm" ? " bb-stat-value--sm" : ""}">${value}</div>
      ${detail ? `<div class="bb-stat-detail">${esc(detail)}</div>` : ""}</div>`).join("")}</div>`;
  }

  function requestList(items, opts = {}) {
    if (!items.length) return stateBlock("empty", opts.empty || "当前没有待处理申请。");
    return items.map(r => {
      const open = (data().ui?.openId || "") === r.id && opts.inline;
      return `<article class="bb-request" data-status="${r.status}" data-req="${r.id}" ${opts.inline && r.status === "pending" ? 'tabindex="0"' : ""}>
        <div class="bb-request-head">
          <div class="bb-request-who">${esc(r.owner)} · ${esc(r.kind)}<small>${esc(scopeOf(r.scope)?.name || r.scope)} · ${esc(r.submitted)}</small></div>
          ${badge(STATUS_TEXT[r.status], STATUS_TONE[r.status])}
          <div class="bb-request-amt">¥ ${money(r.amount)}<small>${r.status === "approved" ? "已发放金额" : r.status === "rejected" ? "未发放" : "申请金额"}</small></div>
        </div>
        <div class="bb-request-meta"><span>审批人：${esc(r.reviewer)}</span><span>有效期 ${esc(r.expiry)}</span><span>${esc(r.id)}</span><span>场景：${esc(r.scene)}</span></div>
        ${r.status !== "pending" && r.comment ? `<p class="bb-hint">处理意见：${esc(r.comment)}</p>` : ""}
        ${open ? approvalPanel(r) : opts.inline && r.status === "pending" ? `<div class="bb-request-actions">
          ${btn("approve-open", "批准", { variant: "primary", sm: true, data: { id: r.id } })}
          ${btn("reject-open", "驳回", { sm: true, data: { id: r.id } })}
        </div>` : ""}
        ${!opts.inline ? `<div class="bb-request-actions">${btn("open-request", "查看详情", { sm: true, data: { id: r.id } })}</div>` : ""}
      </article>`;
    }).join("");
  }

  function approvalPanel(r) {
    const rejecting = data().ui?.rejecting === r.id;
    if (rejecting) {
      return `<div class="bb-approval">
        ${field({ id: "reject-reason", label: "驳回原因（会同步给申请人）", textarea: true, value: draft?.reject || "", required: true })}
        <div class="bb-request-actions">
          ${btn("reject-confirm", "确认驳回", { variant: "danger", data: { id: r.id } })}
          ${btn("approve-cancel", "取消", { data: { id: r.id } })}
        </div></div>`;
    }
    return `<div class="bb-approval">
      <div class="bb-approval-grid">
        ${amountField("approve-amount", money(r.amount), "批准金额（元）")}
        ${field({ id: "approve-expiry", label: "有效期", value: r.expiry })}
      </div>
      <p class="bb-impact">批准后：<b>${esc(scopeOf(r.scope)?.name || r.scope)}</b> 可用额度增加 <b>¥${money(r.amount)}</b>。${r.kind === "项目总额度" ? "额度先进入项目批次，不会直接变成个人余额。" : "申请人会收到结果通知。"}</p>
      <div class="bb-request-actions">
        ${btn("approve-confirm", "确认发放", { variant: "primary", data: { id: r.id } })}
        ${btn("approve-cancel", "取消", { data: { id: r.id } })}
      </div></div>`;
  }

  function heroBlock(cfg) {
    return `<section class="bb-hero" data-tone="${cfg.tone || "accent"}" aria-labelledby="bbHeroTitle">
      <div class="bb-hero-aura" aria-hidden="true"></div>
      <div class="bb-hero-grid">
        <div class="bb-hero-main">
          <div class="bb-hero-state"><span class="bb-dot" aria-hidden="true"></span>${esc(cfg.state)}</div>
          <h2 id="bbHeroTitle">${esc(cfg.title)}</h2>
          <p class="bb-hero-sub">${esc(cfg.sub)}</p>
          <p class="bb-hero-num"><span class="bb-cur" aria-hidden="true">${cfg.cur === undefined ? "¥" : cfg.cur}</span><span class="bb-val">${cfg.value}</span><span class="bb-unit">${esc(cfg.unit || "可用")}</span></p>
          <p class="bb-hero-note">${esc(cfg.note)}</p>
          <div class="bb-hero-actions">${cfg.actions}</div>
        </div>
        <aside class="bb-hero-side">${cfg.side}</aside>
      </div>
    </section>`;
  }

  function heroKv(label, value) { return `<div class="bb-hero-kv"><span>${esc(label)}</span><b>${esc(value)}</b></div>`; }

  /* ---------------- 24 屏 ---------------- */
  const views = {
    home() {
      const d = data(), id = d.selected.scope, s = scopeOf(id), ready = s.balance >= 2;
      const others = Object.entries(d.scopes).filter(([k]) => k !== id);
      const pending = d.requests.filter(r => r.status === "pending" && r.owner === "陈默");
      return `${heroBlock({
        tone: ready ? "accent" : "warn",
        state: ready ? "现在可以开始" : "这一项还没有额度",
        title: ready ? `用 ${s.models[0]} 处理今天的工作` : "先申请额度，才能使用这项用途",
        sub: ready ? "在下面直接输入内容，请求会按当前用途扣费。" : "加入项目不等于自动获得额度，需要项目经理从项目批次分配。",
        value: money(s.balance), note: `${s.name} · 有效期至 ${s.expiry}`,
        actions: (ready ? btn("open-composer", `在线开始使用`, { variant: "primary", focus: "cta" }) : btn("goto-apply", "申请额度", { variant: "primary" }))
          + btn("goto-quota", "查看额度明细", { variant: "ghost-inverse" }),
        side: `<div><p class="bb-hero-side-title">适用范围</p><div class="bb-hero-chips">${s.models.map(m => `<span class="bb-chip">${esc(m)}</span>`).join("")}</div></div>
          <div><p class="bb-hero-side-title">额度来源</p>
            ${heroKv("来源", s.source)}${heroKv("有效期", s.expiry)}${heroKv("待处理申请", pending.length + " 件")}</div>
          <div><p class="bb-hero-side-title">快捷键</p><div class="bb-hero-kv"><span><span class="bb-kbd">1</span> 开始</span><span><span class="bb-kbd">2</span> 申请</span><span><span class="bb-kbd">3</span> 接入</span></div></div>`
      })}
      ${ui.composer ? composerBlock() : ""}
      <section class="bb-section">
        <div class="bb-section-head"><h2>额度分布</h2><span>点色块可切换用途 · 合计 ¥${money(Object.values(d.scopes).reduce((n, x) => n + x.balance, 0))}</span></div>
        ${ribbon(Object.entries(d.scopes).map(([key, v]) => ({ id: key, name: v.short, cents: v.balance, active: key === id })), { selectable: true })}
      </section>
      <div class="bb-cols">
        <section class="bb-card bb-stack" aria-labelledby="bbNextTitle">
          <div class="bb-section-head"><h2 id="bbNextTitle">接下来可以做什么</h2><span>按数字键直达</span></div>
          <ul class="bb-stack" style="gap:0">
            ${[["在线开始使用", "在当前用途输入内容，立即得到结果", "1", "open-composer"], ["申请追加额度", "说明用途与金额，由对应负责人审批", "2", "goto-apply"], ["接入编程工具", "生成个人凭证并填入兼容客户端", "3", "goto-keys"]]
              .map(([title, desc, key, act]) => `<li class="bb-row" style="padding:var(--bb-space-3) 0;border-bottom:1px solid var(--bb-border-subtle);justify-content:space-between">
                <div style="min-width:0"><b style="font-weight:600">${title}</b><div class="bb-hint">${desc}</div></div>
                ${btn(act, `打开<span class="bb-kbd">${key}</span>`, { sm: true })}
              </li>`).join("")}
          </ul>
        </section>
        <section class="bb-card bb-stack" aria-labelledby="bbFeedTitle">
          <div class="bb-section-head"><h2 id="bbFeedTitle">最近活动</h2><span>${d.logs.length} 条调用</span></div>
          <div class="bb-kv">
            ${d.logs.slice(0, 3).map(l => `<div class="bb-kv-row"><span>${esc(l.model)} · ${esc(scopeOf(l.scope)?.short || l.scope)}<br><span class="bb-hint">${esc(l.time)}</span></span><b>¥${money(l.cost)}</b></div>`).join("")}
          </div>
          ${btn("goto-logs", "查看全部日志", { variant: "quiet", sm: true })}
        </section>
      </div>
      <section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>其他用途</h2><span>${others.length} 个</span></div>
        ${others.map(([key, v]) => `<div class="bb-row" style="justify-content:space-between;padding:var(--bb-space-3) 0;border-bottom:1px solid var(--bb-border-subtle)">
          <div><b>${esc(v.name)}</b><div class="bb-hint">${v.balance >= 2 ? "可使用" : "没有额度"} · ${esc(v.source)}</div></div>
          <div class="bb-row"><span class="bb-num">¥${money(v.balance)}</span>${v.balance >= 2 ? btn("scope", "切换", { sm: true, data: { scope: key } }) : btn("goto-apply", "申请", { sm: true })}</div>
        </div>`).join("")}
      </section>`;
    },

    use() {
      const d = data(), s = scopeOf(d.selected.scope), ready = s.balance >= 2;
      const models = s.models;
      return `${notice("info", "先确认用途与模型。", "请求只从当前用途的批次扣费，不会自动借用其他额度。")}
      <div class="bb-cols">
        <section class="bb-card bb-stack">
          <div class="bb-section-head"><h2>发送一次请求</h2>${badge(ready ? "可使用" : "无有效额度", ready ? "ok" : "warn")}</div>
          <div class="bb-row">${scopeSegmented()}</div>
          ${field({ id: "use-model", label: "本次使用模型", value: models[0], readonly: true, hint: "当前用途已开放：" + models.join("、") })}
          ${field({ id: "use-prompt", label: "输入问题", textarea: true, value: draft?.prompt || "", placeholder: "例如：把今天的会议记录整理成三条结论" })}
          <div class="bb-composer-foot"><span>本地模拟 · 每次成功扣 ¥0.02</span>
            <div class="bb-row">${btn("use-send", "发送请求", { variant: "primary", disabled: !ready })}</div>
          </div>
        </section>
        <div class="bb-stack">
          ${statGrid([["当前用途余额", "¥" + money(s.balance), s.name + " · " + s.expiry], ["可用模型", String(models.length), models.join("、")]])}
          ${notice("warn", "额度不足时", "主按钮会禁用，先从「申请额度」补充同用途来源。")}
          ${btn("goto-quota", "查看额度批次", { sm: true })}
        </div>
      </div>`;
    },

    quota() {
      const d = data(), s = scopeOf(d.selected.scope), batches = d.batches[d.selected.scope] || [];
      const used = batches.reduce((n, b) => n + b.used, 0);
      return `<div class="bb-spread"><div class="bb-row">${scopeSegmented()}</div>${badge(s.balance >= 2 ? "可使用" : "无有效额度", s.balance >= 2 ? "ok" : "warn")}</div>
      ${statGrid([["可用余额", "¥" + money(s.balance), s.name], ["已使用", "¥" + money(used), "按用途独立计量"], ["到期日", s.expiry, "到期当日结束失效", "sm"]])}
      <section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>额度批次</h2><span>${batches.length} 个批次</span></div>
        ${batches.length ? table(["批次", "来源", "金额", "已用", "到期"], batches.map(b => [`<b>${esc(b.id)}</b>`, esc(b.source), `<span class="bb-num">¥${money(b.amount)}</span>`, `<span class="bb-num">¥${money(b.used)}</span>`, esc(b.expiry)]))
          : stateBlock("empty", "这个用途还没有额度批次。")}
      </section>
      <section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>来源路径</h2><span>个人与项目互不替代</span></div>
        <div class="bb-path">
          <div class="bb-path-node"><small>${s.pool === "office" ? "个人开通方案" : "项目"}</small><b>${esc(s.name)}</b><em>${esc(s.source)}</em></div>
          <span class="bb-path-arrow" aria-hidden="true">→</span>
          <div class="bb-path-node"><small>用途</small><b>${esc(s.short)}</b><em>有效期 ${esc(s.expiry)}</em></div>
          <span class="bb-path-arrow" aria-hidden="true">→</span>
          <div class="bb-path-node"><small>可用模型</small><b>${esc(s.models.join("、"))}</b><em>按模型确认适用余额</em></div>
        </div>
      </section>`;
    },

    models() {
      const d = data(), s = scopeOf(d.selected.scope);
      return `<div class="bb-row">${scopeSegmented()}</div>
      <section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>已开放模型</h2><span>${s.models.length} 个 · 来自 ${esc(s.pool)} 池</span></div>
        ${s.models.map((m, i) => `<div class="bb-row" style="justify-content:space-between;padding:var(--bb-space-3) 0;border-bottom:1px solid var(--bb-border-subtle)">
          <div><b>${esc(m)}</b><div class="bb-hint">${i === 0 ? "对话生成 · 推荐" : "代码生成"} · 适用余额 ¥${money(s.balance)}</div></div>
          <div class="bb-row">${btn("goto-use", "使用", { sm: true, data: { model: m } })}</div>
        </div>`).join("")}
      </section>
      ${notice("info", "模型与额度必须同时满足。", "追加额度不会扩大模型范围；模型停用后原有额度仍保留但不能新调用。")}`;
    },

    requests() {
      const d = data(), mine = d.requests.filter(r => r.owner === "陈默");
      return `<div class="bb-tabs" role="tablist" aria-label="申请筛选">
        ${[["all", "全部"], ["pending", "待处理"], ["done", "已处理"]].map(([k, label]) => `<button type="button" role="tab" data-act="req-tab" data-tab="${k}" aria-selected="${ui.tab === k}">${label}</button>`).join("")}
      </div>
      <section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>我发起的申请</h2><span>同一申请在各角色共享结果</span></div>
        ${table(["申请事项", "金额", "审批人", "状态", "操作"], mine
          .filter(r => ui.tab === "all" || (ui.tab === "pending" ? r.status === "pending" : r.status !== "pending"))
          .map(r => [`<b>${esc(r.kind)}</b><small>${esc(r.id)} · ${esc(r.submitted)}</small>`, `<span class="bb-num">¥${money(r.amount)}</span>`, esc(r.reviewer), badge(STATUS_TEXT[r.status], STATUS_TONE[r.status]), btn("open-request", "查看", { sm: true, data: { id: r.id } })]))}
      </section>`;
    },

    request() {
      const d = data(), r = d.requests.find(x => x.id === d.selected.requestId) || d.requests[0];
      if (!r) return stateBlock("empty", "没有选中的申请。");
      const canReview = r.status === "pending" && ((api.getRole() === "ops" && r.reviewer === "林晓") || (api.getRole() === "manager" && r.reviewer === "赵宁"));
      return `<section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>${esc(r.kind)}申请</h2>${badge(STATUS_TEXT[r.status], STATUS_TONE[r.status])}</div>
        <dl class="bb-dl">
          ${[["申请单", r.id], ["申请人", r.owner], ["用途 / 对象", scopeOf(r.scope)?.name || r.scope], ["申请金额", "¥" + money(r.amount)], ["审批人", r.reviewer], ["提交时间", r.submitted], ["使用场景", r.scene], ["有效期", r.expiry]]
            .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}
        </dl>
        ${r.status === "approved" ? notice("ok", "已批准。", `发放 ¥${money(r.amount)}，来源批次已记录。`) : r.status === "rejected" ? notice("danger", "已驳回。", esc(r.comment || "未填写原因。")) : notice("warn", "等待审批。", `由 ${esc(r.reviewer)} 处理，同用途无需重复提交。`)}
      </section>
      ${canReview ? `<section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>审批决定</h2><span>${esc(r.reviewer)}</span></div>
        ${approvalPanel(r)}
      </section>` : `<section class="bb-card bb-stack"><div class="bb-section-head"><h2>下一步</h2></div>
        <div class="bb-row">${btn("goto-home", "返回工作台", { variant: "primary" })}${r.status === "pending" ? btn("reapply", "补充说明", { sm: true }) : ""}</div></section>`}`;
    },

    logs() {
      const d = data(), rows = d.logs.filter(l => ui.filter === "all" || l.scope === ui.filter);
      return `<div class="bb-row">
        <div class="bb-segmented" role="group" aria-label="用途筛选">
          ${[["all", "全部"], ...Object.entries(d.scopes).map(([k, v]) => [k, v.short])].map(([k, label]) => `<button type="button" data-act="log-filter" data-filter="${k}" aria-pressed="${ui.filter === k}">${label}</button>`).join("")}
        </div>
        ${badge(rows.length + " 条", "neutral")}
      </div>
      <section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>调用记录</h2><span>请求用哪个用途，就记在哪个用途</span></div>
        ${rows.length ? table(["模型 / 时间", "用途", "批次", "结果", "费用"], rows.map(l => [
          `<b>${esc(l.model)}</b><small>${esc(l.time)} · ${esc(l.id)}</small>`,
          esc(scopeOf(l.scope)?.name || l.scope),
          esc(l.batch),
          esc(l.result),
          `<span class="bb-num">¥${money(l.cost)}</span> <button class="bb-link" type="button" data-act="open-result" data-id="${l.id}">详情</button>`
        ])) : stateBlock("empty", "当前筛选下还没有调用记录。")}
      </section>`;
    },

    result() {
      const d = data(), l = d.logs.find(x => x.id === d.lastResult) || d.logs[0];
      if (!l) return stateBlock("empty", "没有可查看的调用结果。");
      return `<section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>调用完成</h2>${badge("本地模拟成功", "ok")}</div>
        ${notice("ok", "本次扣费 ¥" + money(l.cost), `来源：${esc(scopeOf(l.scope)?.name || l.scope)}，剩余 ¥${money(scopeOf(l.scope)?.balance || 0)}。`)}
        <dl class="bb-dl">${[["请求", l.id], ["模型", l.model], ["用途", scopeOf(l.scope)?.name || l.scope], ["来源批次", l.batch], ["用量（演示）", "1,240 input / 386 output tokens"]].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
        <div class="bb-row">${btn("goto-logs", "查看日志", { variant: "primary" })}${btn("open-composer", "继续使用")}</div>
      </section>`;
    },

    myProjects() {
      const d = data(), mine = d.projects.filter(p => p.members.includes("陈默"));
      return `${mine.length ? `<div class="bb-cols-2">${mine.map(p => `<section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>${esc(p.name)}</h2>${badge(p.id === "q4" ? "成员" : "成员", "accent")}</div>
        <p class="bb-hint">经理 ${esc(p.manager)} · 模型 ${esc(p.models.join("、"))}</p>
        <div class="bb-kv">${p.grants.map(g => `<div class="bb-kv-row"><span>${esc(g.id)} · ${esc(g.source)}</span><b>¥${money(g.amount - g.allocated)} 待分配</b></div>`).join("")}</div>
        <div class="bb-row">${btn("goto-quota", "查看我的项目额度", { sm: true })}${btn("apply-member", "申请成员额度", { sm: true, data: { project: p.id } })}</div>
      </section>`).join("")}</div>` : stateBlock("empty", "还没有加入任何项目。")}
      ${notice("info", "项目额度先进入项目，再分配给成员。", "加入项目不会自动获得额度，也不会把项目总额度算作个人余额。")}`;
    },

    keys() {
      const d = data();
      return `<div class="bb-cols">
        <section class="bb-card bb-stack">
          <div class="bb-section-head"><h2>我的演示凭证</h2><span>不签发真实密钥</span></div>
          ${d.keys.length ? table(["名称", "绑定用途", "创建时间", "操作"], d.keys.map(k => [`<b>${esc(k.name)}</b><small>${esc(k.id)}</small>`, esc(scopeOf(k.scope)?.name || k.scope), esc(k.created), btn("key-use", "模拟接入", { sm: true })])) : stateBlock("empty", "还没有凭证。")}
          ${notice("warn", "凭证不拥有独立余额。", "绑定个人通用或某个项目用途，与在线使用共享该用途的额度。")}
        </section>
        <section class="bb-card bb-stack">
          <div class="bb-section-head"><h2>添加凭证</h2></div>
          ${field({ id: "key-name", label: "名称", value: draft?.keyName || "" })}
          ${field({ id: "key-scope", label: "绑定用途", value: scopeOf(d.selected.scope).name, readonly: true })}
          ${btn("key-create", "添加演示凭证", { variant: "primary" })}
        </section>
      </div>`;
    },

    projects() {
      const d = data(), p = d.projects.find(x => x.id === d.selected.projectId) || d.projects[0];
      const isOps = api.getRole() === "ops";
      if (!p) return stateBlock("empty", "还没有可管理的项目。");
      const grant = p.grants[0];
      return `<div class="bb-spread">
        <div class="bb-segmented" role="group" aria-label="选择项目">${d.projects.map(x => `<button type="button" data-act="pick-project" data-project="${x.id}" aria-pressed="${x.id === p.id}">${esc(x.name)}</button>`).join("")}</div>
        ${isOps ? btn("goto-project-new", "创建项目", { variant: "primary", sm: true }) : btn("goto-budget-apply", "申请项目总额度", { variant: "primary", sm: true })}
      </div>
      ${statGrid([["累计发放", "¥" + money(grant ? grant.amount : 0), "项目批次"], ["已分配", "¥" + money(grant ? grant.allocated : 0), "给成员"], ["待分配", "¥" + money(grant ? grant.amount - grant.allocated : 0), "仍在项目"], ["成员", String(p.members.length), "继承项目模型范围"]])}
      <section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>项目批次</h2><span>${esc(p.pool)} 池 · ${esc(p.models.join("、"))}</span></div>
        ${table(["批次", "发放金额", "已分配", "到期", "来源"], p.grants.map(g => [`<b>${esc(g.id)}</b>`, `<span class="bb-num">¥${money(g.amount)}</span>`, `<span class="bb-num">¥${money(g.allocated)}</span>`, esc(g.expiry), esc(g.source)]))}
        <div class="bb-row">${isOps ? btn("goto-grant", "发放总额度") : ""}${btn("goto-allocate", "分配给成员", { variant: "primary" })}</div>
      </section>
      <section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>成员额度</h2><span>成员加入不等于自动发钱</span></div>
        ${table(["成员", "角色", "模型范围", "操作"], p.members.map(m => [`<b>${esc(m)}</b>`, m === p.manager ? "经理" : "成员", esc(p.models.join("、")), btn("goto-allocate", "分配", { sm: true, data: { member: m } })]))}
      </section>`;
    },

    allocate() {
      const d = data(), p = d.projects.find(x => x.id === d.selected.projectId) || d.projects[0];
      if (!p) return stateBlock("empty", "没有可分配的项目批次。");
      const grant = p.grants[0];
      return `<section class="bb-card bb-stack" style="max-width:640px">
        <div class="bb-section-head"><h2>从 ${esc(p.name)} 分配给成员</h2><span>${esc(grant ? grant.id : "无批次")}</span></div>
        ${field({ id: "alloc-member", label: "成员", value: d.selected.member || p.members[0] })}
        ${field({ id: "alloc-grant", label: "来源批次", value: grant ? `${grant.id} · 可分配 ¥${money(grant.amount - grant.allocated)}` : "无", readonly: true })}
        ${amountField("alloc-amount", "2000")}
        ${notice("info", "有效期继承来源批次。", `分配后仅增加该成员在本项目下的额度，不影响个人通用额度。`)}
        <div class="bb-row">${btn("alloc-submit", "确认分配", { variant: "primary" })}${btn("goto-projects", "返回项目")}</div>
      </section>`;
    },

    apply() {
      const d = data();
      const reviewer = "林晓";
      return `<section class="bb-card bb-stack" style="max-width:720px">
        <div class="bb-section-head"><h2>申请额度</h2>${badge(ui.pendingRequest ? "已有待处理申请" : "新申请", ui.pendingRequest ? "warn" : "neutral")}</div>
        ${notice("info", "审批人：" + reviewer, "批准后更新对应用途余额；模型范围保持不变。")}
        <div class="bb-field"><label for="apply-scope">申请用途</label>${scopeSegmented()}</div>
        ${amountField("apply-amount", d.drafts.apply.amount)}
        ${field({ id: "apply-scene", label: "使用场景", value: d.drafts.apply.scene, placeholder: "例如：Q4 项目联调" })}
        ${field({ id: "apply-reason", label: "使用说明", textarea: true, value: d.drafts.apply.reason })}
        ${ui.formError ? `<span class="bb-field-error">${esc(ui.formError)}</span>` : ""}
        <div class="bb-row">${btn("apply-submit", "提交申请", { variant: "primary" })}${btn("goto-home", "取消")}</div>
      </section>`;
    },

    budgetApply() {
      const d = data(), p = d.projects.find(x => x.id === d.selected.projectId) || d.projects[0];
      return `<section class="bb-card bb-stack" style="max-width:720px">
        <div class="bb-section-head"><h2>申请项目总额度</h2>${badge("进入项目批次", "neutral")}</div>
        ${notice("info", "审批人：林晓（运营）", "批准后形成新的项目批次，成员个人余额不会自动增加。")}
        ${field({ id: "budget-project", label: "项目", value: p ? p.name : "无", readonly: true })}
        ${amountField("budget-amount", d.drafts.budget.amount)}
        ${field({ id: "budget-scene", label: "使用场景", value: d.drafts.budget.scene })}
        ${field({ id: "budget-reason", label: "使用说明", textarea: true, value: d.drafts.budget.reason })}
        <div class="bb-row">${btn("budget-submit", "提交申请", { variant: "primary" })}${btn("goto-projects", "取消")}</div>
      </section>`;
    },

    approvals() {
      const d = data();
      const reviewer = api.getRole() === "manager" ? "赵宁" : "林晓";
      const list = d.requests.filter(r => r.reviewer === reviewer);
      const rows = list.filter(r => (ui.tab === "todo" ? r.status === "pending" : r.status !== "pending"));
      return `<div class="bb-tabs" role="tablist" aria-label="审批筛选">
        ${[["todo", "待处理 · " + list.filter(r => r.status === "pending").length], ["done", "已处理"]].map(([k, label]) => `<button type="button" role="tab" data-act="approval-tab" data-tab="${k}" aria-selected="${ui.tab === k}">${label}</button>`).join("")}
      </div>
      <p class="bb-hint">当前身份处理由你审批的申请：${reviewer === "赵宁" ? "成员额度由项目经理审批；项目总额度与个人额度转运营。" : "个人额度与项目总额度由运营审批；成员额度由项目经理处理。"}</p>
      <section class="bb-stack">${rows.length ? requestList(rows, { inline: true, empty: "当前没有待处理申请。" }) : stateBlock("empty", "当前没有待处理申请。")}</section>`;
    },

    overview() {
      const d = data(), todo = d.requests.filter(r => r.status === "pending" && r.reviewer === "林晓");
      const oldest = todo.slice().sort((a, b) => b.hours - a.hours)[0];
      return `${heroBlock({
        tone: todo.length ? "warn" : "accent",
        state: todo.length ? "有待处理申请" : "待办已清空",
        title: todo.length ? "先处理等待最久的一件" : "今天没有待处理申请",
        sub: oldest ? `${oldest.owner} 的「${oldest.kind}」已等待 ${oldest.submitted}，金额 ¥${money(oldest.amount)}。` : "新的申请会自动进入队列。",
        cur: "", value: String(todo.length), unit: "件待办",
        note: "按 j / k 在队列中移动，Enter 打开当前申请",
        actions: (todo.length ? btn("queue-start", "开始处理第一件", { variant: "primary" }) : btn("queue-start", "开始处理第一件", { variant: "primary", disabled: true })) + btn("goto-approvals", "查看完整队列", { variant: "ghost-inverse" }),
        side: `<div><p class="bb-hero-side-title">本周口径</p>${heroKv("已发放", "¥" + money(d.requests.filter(r => r.status === "approved").reduce((n, r) => n + r.amount, 0)))}${heroKv("待分配", "¥7,350.00")}${heroKv("个人有效余额", "¥400.00")}</div>
          <div><p class="bb-hero-side-title">审批口径</p>${heroKv("个人额度", "运营")}${heroKv("项目总额度", "运营")}${heroKv("成员额度", "项目经理")}</div>`
      })}
      ${statGrid([["待审批", String(todo.length), "按运营职责汇总"], ["个人有效余额", "¥400.00", "已发放未消费"], ["项目待分配", "¥7,350.00", "仍在项目批次"], ["本轮消费", "¥" + money(d.logs.reduce((n, l) => n + l.cost, 0)), "本地模拟调用"]])}
      <section class="bb-section">
        <div class="bb-section-head"><h2>资金分布</h2><span>口径不同，不能相加</span></div>
        ${ribbon([{ name: "个人有效余额", cents: 40000 }, { name: "项目待分配", cents: 735000 }, { name: "本周已发放", cents: d.requests.filter(r => r.status === "approved").reduce((n, r) => n + r.amount, 0) }], { label: "资金分布", equal: true, note: "三类口径独立，等宽展示不代表占比。" })}
      </section>
      <section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>待处理队列</h2><span>批准后就地生效</span></div>
        ${todo.length ? requestList(todo.slice().sort((a, b) => b.hours - a.hours), { inline: true }) : stateBlock("empty", "队列已清空。")}
      </section>
      <div class="bb-cols">
        <section class="bb-card bb-stack"><div class="bb-section-head"><h2>常用操作</h2><span>开通与配置</span></div>
          <div class="bb-stack" style="gap:var(--bb-space-2)">
            ${btn("goto-members", "为成员开通 AI", { sm: true })}
            ${btn("goto-project-new", "创建项目", { sm: true })}
            ${btn("goto-pools", "管理模型池", { sm: true })}
          </div>
        </section>
        <section class="bb-card bb-stack"><div class="bb-section-head"><h2>资源与运行</h2>${badge("运行数据未接入", "warn")}</div>
          <div class="bb-kv">${[["模型池", d.pools.length + " 个"], ["开通方案", d.plans.length + " 个"], ["项目", d.projects.length + " 个"], ["上游故障率", "—"]].map(([k, v]) => `<div class="bb-kv-row"><span>${k}</span><b>${v}</b></div>`).join("")}</div>
          <p class="bb-hint">未接入监控采集，不能据此判断服务健康。</p>
        </section>
      </div>`;
    },

    members() {
      const d = data();
      return `<section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>成员与权益</h2><span>${d.members.length} 位成员</span></div>
        ${table(["成员", "部门", "已开通方案", "模型范围", "个人余额"], d.members.map(m => [`<b>${esc(m.name)}</b>`, esc(m.dept), esc(m.plans.join("、")), esc(m.models.join("、")), `<span class="bb-num">${m.balance ? "¥" + money(m.balance) : "未发放"}</span>`]))}
        <div class="bb-row">${btn("member-open", "为成员开通 AI", { variant: "primary" })}${btn("goto-plans", "管理开通方案")}</div>
      </section>`;
    },

    plans() {
      const d = data();
      return `<div class="bb-cols-2">${d.plans.map(p => `<section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>${esc(p.name)}</h2>${badge(p.mode === "follow" ? "跟随模型池" : "指定模型", "accent")}</div>
        <div class="bb-kv">${[["模型池", p.pool], ["额度", "¥" + money(p.amount)], ["周期", p.cycle], ["已开通", p.inUse + " 人"]].map(([k, v]) => `<div class="bb-kv-row"><span>${k}</span><b>${esc(v)}</b></div>`).join("")}</div>
        <p class="bb-hint">当前可用模型：${esc(p.models.join("、"))}</p>
        <div class="bb-row">${btn("plan-open", "用此方案开通", { sm: true, variant: "primary", data: { plan: p.id } })}${btn("plan-edit", "编辑范围", { sm: true, data: { plan: p.id } })}</div>
      </section>`).join("")}</div>`;
    },

    catalog() {
      const d = data();
      return `<section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>模型目录</h2><span>${d.catalog.length} 个定义</span></div>
        ${table(["模型", "上游标识", "能力", "状态", "操作"], d.catalog.map(m => [`<b>${esc(m.name)}</b>`, `<code>${esc(m.alias)}</code>`, esc(m.capability), badge(m.enabled ? "已启用" : "未开放", m.enabled ? "ok" : "neutral"), btn("catalog-toggle", m.enabled ? "停用" : "启用", { sm: true, data: { id: m.id } })]))}
        <div class="bb-row">${btn("catalog-new", "新建模型定义", { variant: "primary" })}</div>
      </section>`;
    },

    services() {
      const d = data();
      return `<div class="bb-stack">${d.services.map(s => `<section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>${esc(s.name)}</h2>${badge(s.status === "passed" ? "验证通过" : s.status === "failed" ? "验证失败" : "待验证", s.status === "passed" ? "ok" : s.status === "failed" ? "danger" : "warn")}</div>
        <div class="bb-kv">${[["地址", s.url], ["模型数", String(s.models)], ["启用", s.enabled ? "是" : "否"], ["最近验证", s.checked]].map(([k, v]) => `<div class="bb-kv-row"><span>${k}</span><b>${esc(v)}</b></div>`).join("")}</div>
        <div class="bb-row">${btn("goto-service-edit", "编辑与验证", { sm: true, variant: "primary", data: { id: s.id } })}${btn("service-toggle", s.enabled ? "停用" : "启用", { sm: true, data: { id: s.id } })}</div>
      </section>`).join("")}</div>`;
    },

    serviceEdit() {
      const d = data(), s = d.services.find(x => x.id === d.selected.serviceId) || d.services[0];
      if (!s) return stateBlock("empty", "没有要编辑的服务。");
      return `<div class="bb-cols">
        <section class="bb-card bb-stack">
          <div class="bb-section-head"><h2>接入与验证</h2>${badge(s.status === "passed" ? "验证通过" : "待验证", s.status === "passed" ? "ok" : "warn")}</div>
          ${field({ id: "svc-name", label: "服务名称", value: s.name })}
          ${field({ id: "svc-url", label: "接口地址", value: s.url })}
          ${field({ id: "svc-models", label: "映射模型", value: "Qwen 2.5, DeepSeek V3", hint: "修改连接或映射后原验证失效。" })}
          <div class="bb-row">${btn("svc-test", "模拟验证连接", { variant: "primary" })}${btn("svc-save", "保存配置")}</div>
        </section>
        <section class="bb-card bb-stack">
          <div class="bb-section-head"><h2>变更影响</h2></div>
          ${notice("warn", "停用或改地址会阻止新调用。", "已发放额度与历史日志保留；其他来源的模型不受影响。")}
          <div class="bb-kv">${[["关联模型池", "3 个"], ["受影响权益", "2 项"], ["受影响项目", "2 个"]].map(([k, v]) => `<div class="bb-kv-row"><span>${k}</span><b>${v}</b></div>`).join("")}</div>
        </section>
      </div>`;
    },

    pools() {
      const d = data();
      return `<div class="bb-stack">${d.pools.map(p => `<section class="bb-card bb-stack">
        <div class="bb-section-head"><h2>${esc(p.name)}</h2><span>来源 ${esc(p.source)}</span></div>
        <div class="bb-hero-chips">${p.models.map(m => `<span class="bb-badge bb-badge--accent">${esc(m)}</span>`).join("")}</div>
        <p class="bb-hint">池内模型变更只影响之后的开通；已发放额度不随模型变化。</p>
        <div class="bb-row">${btn("pool-edit", "调整开放范围", { sm: true, data: { id: p.id } })}</div>
      </section>`).join("")}
      <div class="bb-row">${btn("pool-new", "新建模型池", { variant: "primary" })}</div></div>`;
    },

    projectNew() {
      return `<section class="bb-card bb-stack" style="max-width:720px">
        <div class="bb-section-head"><h2>创建项目</h2>${badge("运营可创建", "neutral")}</div>
        ${field({ id: "proj-name", label: "项目名称", placeholder: "例如：Q1 数据平台" })}
        ${field({ id: "proj-manager", label: "项目经理", value: "赵宁" })}
        ${field({ id: "proj-pool", label: "模型池", value: "研发编程池" })}
        ${notice("info", "创建后仍需发放总额度。", "成员加入项目不会自动获得额度，需要经理从批次分配。")}
        <div class="bb-row">${btn("project-create", "创建项目", { variant: "primary" })}${btn("goto-projects", "取消")}</div>
      </section>`;
    },

    projectGrant() {
      const d = data(), p = d.projects.find(x => x.id === d.selected.projectId) || d.projects[0];
      return `<section class="bb-card bb-stack" style="max-width:720px">
        <div class="bb-section-head"><h2>发放项目总额度</h2>${badge(p ? p.name : "无项目", "neutral")}</div>
        ${amountField("grant-amount", "5000")}
        ${field({ id: "grant-expiry", label: "有效期", value: "2026-12-31" })}
        ${notice("info", "先进项目，再分配。", "发放形成新的项目批次，成员个人余额不会自动增加。")}
        <div class="bb-row">${btn("grant-submit", "确认发放", { variant: "primary" })}${btn("goto-projects", "取消")}</div>
      </section>`;
    }
  };

  function composerBlock() {
    return `<section class="bb-composer" aria-label="在线使用">
      <label class="bb-hint" for="bb-prompt">用「${esc(scopeOf(data().selected.scope).name)}」发送一次请求</label>
      <textarea class="bb-textarea" id="bb-prompt" data-focus="prompt" placeholder="例如：把今天的会议记录整理成三条结论">${esc(draft?.prompt || "")}</textarea>
      <div class="bb-composer-foot"><span>本地模拟 · 每次成功扣 ¥0.02</span>
        <div class="bb-row">${btn("composer-cancel", "取消", { sm: true })}${btn("use-send", "发送", { variant: "primary", sm: true })}</div>
      </div></section>`;
  }

  /* ---------------- Shell ---------------- */
  function shell() {
    const role = api.getRole(), nav = MODEL.roles[role].nav, s = screen();
    const groups = NAV_GROUPS[role] || {};
    const order = [];
    const byGroup = new Map();
    for (const [id, label] of nav) {
      const group = groups[id] || "其他";
      if (!byGroup.has(group)) { byGroup.set(group, []); order.push(group); }
      byGroup.get(group).push([id, label]);
    }
    const reviewer = role === "manager" ? "赵宁" : "林晓";
    const navHtml = order.map(group => `<div class="bb-nav-label">${esc(group)}</div>` + byGroup.get(group).map(([id, label]) => {
      const count = id === "approvals" ? data().requests.filter(r => r.status === "pending" && r.reviewer === reviewer).length : 0;
      return `<button type="button" class="bb-nav-item" data-act="nav" data-screen="${id}" ${id === (NAV_PARENT[api.getScreen()] || api.getScreen()) ? 'aria-current="page"' : ""}>
        <span class="bb-nav-glyph" aria-hidden="true">${GLYPHS[id] || "·"}</span><span>${esc(label)}</span>
        ${count ? `<span class="bb-nav-count">${count}</span>` : ""}</button>`;
    }).join("")).join("");

    const mode = api.getMode();
    const screenHtml = views[api.getScreen()] ? views[api.getScreen()]() : stateBlock("empty", s?.empty);
    const gated = mode === "normal" ? screenHtml : gate(mode);

    return `<div class="bb">
      <aside class="bb-rail" aria-label="主导航">
        <div class="bb-brand"><span class="bb-brand-mark" aria-hidden="true"></span>
          <div><span class="bb-brand-name">Beacon</span><span class="bb-brand-sub">${esc(MODEL.roles[role].label)}</span></div>
        </div>
        <nav class="bb-nav-group">${navHtml}</nav>
        <div class="bb-rail-foot"><b>2026.10.26 · 本地模拟</b>审批、调用与费用均为演示数据</div>
      </aside>
      <div class="bb-main">
        <header class="bb-top">
          <div class="bb-top-title">
            <div class="bb-crumb">${esc(MODEL.roles[role].label)} / ${esc(role === "ops" ? "运营台" : role === "manager" ? "项目空间" : "个人工作台")}</div>
            <h1>${esc(s?.title || "工作台")}</h1>
            <p class="bb-top-sub">${esc(s?.sub || "")}</p>
          </div>
          <div class="bb-top-actions">
            ${mode !== "normal" ? badge("演示状态：" + STATE_LABEL[mode], "warn") : ""}
            ${badge("本地模拟", "neutral")}
            ${btn("goto-help", "说明", { sm: true, variant: "quiet" })}
          </div>
        </header>
        <div class="bb-page" id="bb-page">${gated}</div>
      </div>
    </div>
    <div class="bb-toast" id="bb-toast" role="status" aria-live="polite"></div>`;
  }

  function render() {
    if (!root) return;
    const scroller = root.parentElement;
    const keep = scroller ? scroller.scrollTop : 0;
    const keepScroll = !!focusSel;
    mount(root, shell());
    if (scroller) scroller.scrollTop = keepScroll ? keep : 0;
    const target = focusSel && root.querySelector(focusSel);
    focusSel = "";
    if (target) target.focus({ preventScroll: true });
  }

  function toast(text) {
    const el = root?.querySelector("#bb-toast");
    if (!el) return;
    el.textContent = text;
    el.classList.add("is-on");
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => el.classList.remove("is-on"), 3400);
  }

  function commit(fn) { api.commit(fn); }

  function setScreen(id) {
    if (!SCREENS.has(id)) return;
    ui.formError = "";
    focusSel = "";
    api.setScreen(id);
    render();
  }

  function scopeTo(id) {
    draft = null;
    commit(d => { d.selected.scope = id; });
    render();
  }

  function pushRequest(kind, scope, amount, scene, reason, reviewer) {
    const d = data();
    const id = "RQ-" + (110 + d.requests.length);
    commit(x => {
      x.requests.unshift({ id, owner: api.getRole() === "manager" ? "赵宁" : "陈默", kind, scope, amount, scene, reason, status: "pending", reviewer, submitted: "刚刚", hours: 0, expiry: scope === "q4" ? "2026-12-31" : "2026-11-30" });
    });
    return id;
  }

  function handle(act, el) {
    const d = data();
    const val = id => (document.getElementById(id)?.value || "").trim();
    switch (act) {
      case "nav": return setScreen(el.dataset.screen);
      case "goto-home": return setScreen("home");
      case "goto-quota": return setScreen("quota");
      case "goto-logs": return setScreen("logs");
      case "goto-keys": return setScreen("keys");
      case "goto-apply": return setScreen("apply");
      case "goto-use": return setScreen("use");
      case "goto-projects": return setScreen("projects");
      case "goto-project-new": return setScreen("projectNew");
      case "goto-budget-apply": return setScreen("budgetApply");
      case "goto-grant": return setScreen("projectGrant");
      case "goto-allocate": return setScreen("allocate");
      case "goto-members": return setScreen("members");
      case "goto-plans": return setScreen("plans");
      case "goto-pools": return setScreen("pools");
      case "goto-approvals": return setScreen("approvals");
      case "goto-service-edit": commit(x => { x.selected.serviceId = el.dataset.id; }); return setScreen("serviceEdit");
      case "goto-help": return toast("演示说明：所有审批、调用与费用均为本地模拟。");
      case "retry": return render();
      case "scope": return scopeTo(el.dataset.scope);
      case "open-request": commit(x => { x.selected.requestId = el.dataset.id; }); return setScreen("request");
      case "open-composer": ui.composer = true; focusSel = '[data-focus="prompt"]'; return render();
      case "composer-cancel": ui.composer = false; draft = null; focusSel = '[data-focus="cta"]'; return render();
      case "req-tab": ui.tab = el.dataset.tab; return render();
      case "approval-tab": ui.tab = el.dataset.tab; return render();
      case "log-filter": ui.filter = el.dataset.filter; return render();
      case "open-result": commit(x => { x.lastResult = el.dataset.id; }); return setScreen("result");
      case "pick-project": commit(x => { x.selected.projectId = el.dataset.project; }); return render();

      case "use-send": {
        const prompt = val("use-prompt") || val("bb-prompt");
        if (!prompt) { toast("先写一句要处理的内容，再发送。"); const box = document.getElementById("use-prompt") || document.getElementById("bb-prompt"); box?.focus(); return; }
        const sc = scopeOf(d.selected.scope);
        if (sc.balance < 2) return toast("当前用途余额不足，请先申请额度。");
        const batch = (d.batches[d.selected.scope] || [])[0];
        commit(x => {
          const s = x.scopes[x.selected.scope];
          s.balance -= 2;
          if (batch) { batch.used += 2; }
          x.logs.unshift({ id: "LG-" + (40 + x.logs.length), model: s.models[0], scope: x.selected.scope, batch: batch ? batch.id : "—", cost: 2, time: "刚刚", result: "成功" });
          x.lastResult = x.logs[0].id;
        });
        ui.composer = false; draft = null; focusSel = "";
        setScreen("result");
        return toast("已扣 ¥0.02，剩余 ¥" + money(scopeOf(d.selected.scope).balance) + "。");
      }

      case "apply-submit": {
        const amount = val("apply-amount"), scene = val("apply-scene"), reason = val("apply-reason");
        if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) { ui.formError = "金额需为大于 0 的数字，最多两位小数。"; focusSel = "#apply-amount"; return render(); }
        if (!scene || !reason) { ui.formError = "请填写使用场景与使用说明。"; focusSel = !scene ? "#apply-scene" : "#apply-reason"; return render(); }
        ui.formError = "";
        const id = pushRequest("个人通用额度", d.selected.scope, Math.round(Number(amount) * 100), scene, reason, "林晓");
        commit(x => { x.selected.requestId = id; });
        setScreen("request");
        return toast("申请已提交，审批人：林晓。");
      }

      case "budget-submit": {
        const amount = val("grant-amount") || val("budget-amount"), scene = val("budget-scene"), reason = val("budget-reason");
        if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) { ui.formError = "金额需为大于 0 的数字。"; return render(); }
        const id = pushRequest("项目总额度", d.selected.projectId, Math.round(Number(amount) * 100), scene || "项目扩展", reason || "按项目计划申请", "林晓");
        commit(x => { x.selected.requestId = id; });
        setScreen("request");
        return toast("项目总额度申请已提交。");
      }

      case "approve-open": commit(x => { x.ui = { ...(x.ui || {}), rejecting: "", openId: el.dataset.id }; x.selected.requestId = el.dataset.id; }); return render();
      case "reject-open": commit(x => { x.ui = { ...(x.ui || {}), rejecting: el.dataset.id, openId: el.dataset.id }; x.selected.requestId = el.dataset.id; }); return render();
      case "approve-cancel": commit(x => { x.ui = { ...(x.ui || {}), rejecting: "", openId: "" }; }); return render();
      case "approve-confirm": {
        const raw = (document.getElementById("approve-amount")?.value || "").replace(/,/g, "").trim();
        if (!/^\d+(\.\d{1,2})?$/.test(raw) || Number(raw) <= 0) { toast("金额需为大于 0 的数字。"); document.getElementById("approve-amount")?.focus(); return; }
        const r = d.requests.find(x => x.id === el.dataset.id);
        if (!r) return;
        const cents = Math.round(Number(raw) * 100);
        commit(x => {
          const req = x.requests.find(y => y.id === r.id);
          req.status = "approved"; req.amount = cents; req.processed = "刚刚";
          const scope = x.scopes[req.scope];
          if (scope) {
            scope.balance += cents;
            (x.batches[req.scope] ||= []).unshift({ id: "B-" + req.id, source: req.kind, amount: cents, used: 0, expiry: req.expiry });
          }
          x.ui = { ...(x.ui || {}), rejecting: "", openId: "" };
        });
        focusSel = "";
        return toast("已发放 ¥" + money(cents) + "，额度已更新。");
      }
      case "reject-confirm": {
        const reason = (document.getElementById("reject-reason")?.value || "").trim();
        if (!reason) { toast("请填写驳回原因，申请人需要知道下一步。"); document.getElementById("reject-reason")?.focus(); return; }
        commit(x => {
          const req = x.requests.find(y => y.id === el.dataset.id);
          if (req) { req.status = "rejected"; req.comment = reason; req.processed = "刚刚"; }
          x.ui = { ...(x.ui || {}), rejecting: "", openId: "" };
        });
        return toast("已驳回，原因已同步给申请人。");
      }
      case "queue-start": {
        const next = d.requests.filter(r => r.status === "pending").sort((a, b) => b.hours - a.hours)[0];
        return next ? handle("approve-open", { dataset: { id: next.id } }) : toast("队列已清空。");
      }
      case "member-open": return setScreen("members");
      case "plan-open": return toast("演示：已按方案开通 1 位成员。");
      case "plan-edit": return toast("演示：方案范围编辑未展开。");
      case "catalog-toggle": {
        commit(x => { const m = x.catalog.find(y => y.id === el.dataset.id); if (m) m.enabled = !m.enabled; });
        return toast("模型状态已更新。");
      }
      case "catalog-new": return toast("演示：新建模型定义未展开。");
      case "service-toggle": {
        commit(x => { const s = x.services.find(y => y.id === el.dataset.id); if (s) s.enabled = !s.enabled; });
        return toast("服务启停状态已更新。");
      }
      case "svc-test": commit(x => { const s = x.services.find(y => y.id === x.selected.serviceId); if (s) { s.status = "passed"; s.checked = "刚刚"; } }); return toast("模拟验证通过，已更新验证时间。");
      case "svc-save": {
        const name = val("svc-name"), url = val("svc-url");
        commit(x => { const s = x.services.find(y => y.id === x.selected.serviceId); if (s) { s.name = name; s.url = url; s.status = "untested"; s.checked = "—"; } });
        return toast("配置已保存，原验证状态已失效。");
      }
      case "pool-edit": return toast("演示：模型池范围调整未展开。");
      case "pool-new": return toast("演示：新建模型池未展开。");
      case "project-create": {
        const name = val("proj-name");
        if (!name) { toast("请填写项目名称。"); document.getElementById("proj-name")?.focus(); return; }
        commit(x => { x.projects.push({ id: "p" + (x.projects.length + 1), name, manager: "赵宁", members: ["赵宁"], pool: "coding", models: ["Qwen 2.5", "DeepSeek V3"], grants: [] }); });
        setScreen("projects");
        return toast("项目已创建，下一步发放总额度。");
      }
      case "grant-submit": {
        const amt = val("grant-amount"), exp = val("grant-expiry");
        if (!/^\d+(\.\d{1,2})?$/.test(amt) || Number(amt) <= 0) { toast("金额需为大于 0 的数字。"); return; }
        const cents = Math.round(Number(amt) * 100);
        commit(x => {
          const p = x.projects.find(y => y.id === x.selected.projectId) || x.projects[0];
          if (p) p.grants.unshift({ id: p.id.toUpperCase() + "-" + (p.grants.length + 1), amount: cents, allocated: 0, expiry: exp, source: "运营发放" });
        });
        setScreen("projects");
        return toast("已发放 ¥" + money(cents) + " 到项目批次。");
      }
      case "alloc-submit": {
        const raw = val("alloc-amount");
        if (!/^\d+(\.\d{1,2})?$/.test(raw) || Number(raw) <= 0) { toast("金额需为大于 0 的数字。"); return; }
        const cents = Math.round(Number(raw) * 100);
        commit(x => {
          const p = x.projects.find(y => y.id === x.selected.projectId) || x.projects[0];
          const g = p?.grants[0];
          if (g) g.allocated += cents;
        });
        setScreen("projects");
        return toast("已分配 ¥" + money(cents) + " 给成员。");
      }
      case "key-create": {
        const name = val("key-name");
        if (!name) { toast("请填写凭证名称。"); return; }
        commit(x => { x.keys.push({ id: "KEY-0" + (x.keys.length + 1), name, scope: x.selected.scope, created: "刚刚" }); });
        return toast("已添加演示凭证（未签发真实密钥）。");
      }
      case "key-use": return toast("演示：已生成接入示例，未调用真实模型。");
      case "reapply": return setScreen("apply");
      case "apply-member": return setScreen("apply");
      default: return undefined;
    }
  }

  // 事件绑定
  function bind() {
    root.addEventListener("click", ev => {
      const el = ev.target.closest("[data-act]");
      if (!el || !root.contains(el)) return;
      const act = el.dataset.act;
      if (!act) return;
      ev.preventDefault();
      const result = handle(act, el);
      if (result !== undefined) return;
      // 局部动作（如审批）没有排屏，需要重绘
      if (!["nav", "goto-home"].includes(act)) render();
    });

    root.addEventListener("input", ev => {
      if (ev.target.id === "bb-prompt") draft = { ...(draft || {}), prompt: ev.target.value };
      if (ev.target.id === "reject-reason") draft = { ...(draft || {}), reject: ev.target.value };
      if (ev.target.id === "apply-amount") data().drafts.apply.amount = ev.target.value;
      if (ev.target.id === "apply-scene") data().drafts.apply.scene = ev.target.value;
      if (ev.target.id === "apply-reason") data().drafts.apply.reason = ev.target.value;
    });

    root.addEventListener("keydown", ev => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(ev.target.tagName);
      if (api.getRole() === "ops" && !typing && (ev.key === "j" || ev.key === "k")) {
        const cards = [...root.querySelectorAll(".bb-request[tabindex]")];
        if (!cards.length) return;
        ev.preventDefault();
        const i = cards.indexOf(document.activeElement);
        const next = ev.key === "j" ? Math.min(cards.length - 1, i + 1) : Math.max(0, i - 1);
        cards[next].focus();
        return;
      }
      if (ev.key === "Enter" && document.activeElement?.classList.contains("bb-request") && !data().ui?.rejecting) {
        ev.preventDefault();
        handle("approve-open", { dataset: { id: document.activeElement.dataset.req } });
        render();
        return;
      }
      if (!typing && ["1", "2", "3"].includes(ev.key)) {
        ev.preventDefault();
        if (ev.key === "1") { ui.composer = true; focusSel = '[data-focus="prompt"]'; render(); }
        if (ev.key === "2") setScreen("apply");
        if (ev.key === "3") setScreen("keys");
      }
    });
  }

  window.BeaconTheme = {
    mount(el, hostApi) {
      api = hostApi;
      root = el;
      root.classList.add("bb-host-root");
      // 保证组件作用域：host 已挂载 tokens/base/components，这里只标记根节点，避免与其他主题样式交叉。
      root.setAttribute("data-theme", "beacon");
      bind();
      render();
    },
    update() { render(); },
    screens: MODEL.screens.map(s => s.id)
  };
})();
