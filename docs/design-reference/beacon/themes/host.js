/* Theme Lab（Beacon 只读参考副本）：主题注册、状态持久化、角色/屏幕路由。
   仅保留 Beacon 原生渲染；深色/浅绿/钢蓝三个存量主题未随此副本提供。 */
(() => {
  "use strict";

  const MODEL = window.SCREEN_MODEL;
  const THEMES = [
    { id: "beacon", name: "Beacon", kind: "native" }
  ];
  const STORAGE = "beacon.theme-lab.v1";
  const MODES = ["normal", "empty", "loading", "error", "denied"];

  function seed() {
    return {
      scopes: {
        personal: { id: "personal", name: "个人通用额度", short: "个人", balance: 30000, expiry: "2026-11-30", models: ["Qwen 2.5", "DeepSeek V3"], pool: "office", source: "运营 · 月度方案" },
        q4: { id: "q4", name: "Q4 研发项目", short: "Q4", balance: 0, expiry: "2026-12-31", models: ["Qwen 2.5", "DeepSeek V3"], pool: "coding", source: "等项目经理分配" },
        cs: { id: "cs", name: "智能客服项目", short: "客服", balance: 50000, expiry: "2026-11-30", models: ["Qwen 2.5"], pool: "support", source: "赵宁 · 经理直接分配" }
      },
      batches: {
        personal: [{ id: "B-P1", source: "运营 · 月度方案", amount: 30000, used: 0, expiry: "2026-11-30" }],
        q4: [],
        cs: [{ id: "B-C1", source: "赵宁 · 经理直接分配", amount: 50000, used: 0, expiry: "2026-11-30" }]
      },
      requests: [
        { id: "RQ-102", owner: "赵宁", kind: "项目总额度", scope: "q4", amount: 100000, scene: "Q4 项目新增两个小组", status: "pending", reviewer: "林晓", submitted: "2 小时前", hours: 2, expiry: "2026-12-31" },
        { id: "RQ-100", owner: "陈默", kind: "个人通用额度", scope: "personal", amount: 10000, scene: "整理周报与会议纪要", status: "pending", reviewer: "林晓", submitted: "5 小时前", hours: 5, expiry: "2026-11-30" },
        { id: "RQ-097", owner: "陈默", kind: "项目成员额度", scope: "q4", amount: 20000, scene: "Q4 联调", status: "pending", reviewer: "赵宁", submitted: "1 天前", hours: 26, expiry: "2026-12-31" },
        { id: "RQ-090", owner: "陈默", kind: "个人通用额度", scope: "personal", amount: 30000, scene: "日常办公", status: "approved", reviewer: "林晓", submitted: "3 天前", processed: "2 天前", expiry: "2026-11-30", comment: "按月度方案发放" }
      ],
      logs: [
        { id: "LG-31", model: "Qwen 2.5", scope: "personal", batch: "B-P1", cost: 2, time: "今天 15:02", result: "成功" },
        { id: "LG-30", model: "DeepSeek V3", scope: "cs", batch: "B-C1", cost: 2, time: "昨天 11:20", result: "成功" },
        { id: "LG-29", model: "Qwen 2.5", scope: "personal", batch: "B-P1", cost: 2, time: "昨天 09:41", result: "成功" }
      ],
      keys: [{ id: "KEY-01", name: "代码助手", scope: "personal", created: "2026-10-12" }],
      members: [
        { id: "chen", name: "陈默", dept: "研发", plans: ["标准办公方案"], models: ["Qwen 2.5", "DeepSeek V3"], balance: 30000 },
        { id: "zhao", name: "赵宁", dept: "研发", plans: ["研发试用方案"], models: ["Qwen 2.5"], balance: 10000 },
        { id: "li", name: "李倩", dept: "市场", plans: ["标准办公方案"], models: ["Qwen 2.5"], balance: 0 },
        { id: "wang", name: "王磊", dept: "客服", plans: ["客服支持方案"], models: ["Qwen 2.5"], balance: 5000 }
      ],
      plans: [
        { id: "office", name: "标准办公方案", pool: "office", mode: "follow", models: ["Qwen 2.5", "DeepSeek V3"], amount: 30000, cycle: "按月", inUse: 2 },
        { id: "coding", name: "研发试用方案", pool: "coding", mode: "subset", models: ["Qwen 2.5"], amount: 10000, cycle: "一次", inUse: 1 }
      ],
      pools: [
        { id: "office", name: "日常办公池", models: ["Qwen 2.5", "DeepSeek V3"], source: "SVC-1" },
        { id: "coding", name: "研发编程池", models: ["Qwen 2.5", "DeepSeek V3"], source: "SVC-1" },
        { id: "support", name: "客服模型池", models: ["Qwen 2.5"], source: "SVC-1" }
      ],
      catalog: [
        { id: "DEF-1", name: "Qwen 2.5", alias: "qwen-2.5", capability: "对话生成", enabled: true },
        { id: "DEF-2", name: "DeepSeek V3", alias: "deepseek-v3", capability: "代码生成", enabled: true },
        { id: "DEF-3", name: "GLM 4.6", alias: "glm-4.6", capability: "对话生成", enabled: false }
      ],
      services: [
        { id: "SVC-1", name: "企业模型服务", url: "https://models.example.invalid/v1", status: "passed", models: 3, enabled: true, checked: "2026-10-26 09:12" },
        { id: "SVC-2", name: "备用服务", url: "https://backup.example.invalid/v1", status: "untested", models: 1, enabled: false, checked: "—" }
      ],
      projects: [
        { id: "q4", name: "Q4 研发项目", manager: "赵宁", members: ["陈默", "赵宁"], pool: "coding", models: ["Qwen 2.5", "DeepSeek V3"], grants: [{ id: "Q4-01", amount: 500000, allocated: 15000, expiry: "2026-12-31", source: "运营首批发放" }] },
        { id: "cs", name: "智能客服项目", manager: "赵宁", members: ["陈默", "李倩"], pool: "support", models: ["Qwen 2.5"], grants: [{ id: "CS-01", amount: 300000, allocated: 50000, expiry: "2026-11-30", source: "运营首批发放" }] }
      ],
      selected: { requestId: "RQ-100", projectId: "q4", serviceId: "SVC-1", planId: "office", scope: "personal", tab: "todo", member: "陈默" },
      drafts: { apply: { amount: "300", scene: "", reason: "" }, budget: { amount: "5000", scene: "", reason: "" }, send: { prompt: "" }, key: { name: "我的代码助手" } },
      lastResult: "LG-31"
    };
  }

  const themes = new Map(THEMES.map(t => [t.id, t]));
  const roleIds = Object.keys(MODEL.roles);
  const screensById = new Map(MODEL.screens.map(s => [s.id, s]));

  function readSaved() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE) || "null");
      if (!raw || raw.version !== 1 || !raw.data) return null;
      return raw;
    } catch { return null; }
  }

  const saved = readSaved();
  const url = new URLSearchParams(location.search);
  const pick = (key, allowed, fallback) => {
    const v = url.get(key);
    return allowed.includes(v) ? v : fallback;
  };

  let state = {
    version: 1,
    theme: pick("theme", [...themes.keys()], saved?.theme && themes.has(saved.theme) ? saved.theme : "beacon"),
    role: pick("role", roleIds, saved?.role && roleIds.includes(saved.role) ? saved.role : "employee"),
    screen: saved?.screen || "home",
    mode: pick("mode", MODES, saved?.mode || "normal"),
    data: saved?.data || seed()
  };
  if (!MODEL.roles[state.role].nav.some(([id]) => id === state.screen)) state.screen = MODEL.roles[state.role].nav[0][0];

  const stage = document.getElementById("stage");
  const themeSeg = document.getElementById("themeSeg");
  const roleSelect = document.getElementById("roleSelect");
  const screenSelect = document.getElementById("screenSelect");
  const modeSelect = document.getElementById("modeSelect");
  const statusEl = document.getElementById("hostStatus");

  let frame = null;
  let frameReady = false;
  let frameState = null;
  let native = null;
  let statusTimer = 0;

  function save() {
    try {
      localStorage.setItem(STORAGE, JSON.stringify({ version: 1, theme: state.theme, role: state.role, screen: state.screen, mode: state.mode, data: state.data }));
    } catch { /* 存储不可用时只保留内存状态 */ }
  }

  function status(text) {
    statusEl.textContent = text;
    statusEl.classList.add("show");
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => statusEl.classList.remove("show"), 3200);
  }

  function syncUrl() {
    const q = new URLSearchParams({ theme: state.theme, role: state.role, screen: state.screen, mode: state.mode });
    history.replaceState(null, "", "?" + q.toString());
  }

  const api = {
    getData: () => state.data,
    getRole: () => state.role,
    getScreen: () => state.screen,
    getMode: () => state.mode,
    getTheme: () => state.theme,
    setScreen(id) {
      if (!screensById.has(id)) return;
      state.screen = id;
      afterChange();
    },
    setRole(role) { if (MODEL.roles[role]) { state.role = role; ensureScreen(); afterChange(); } },
    setMode(mode) { if (MODES.includes(mode)) { state.mode = mode; afterChange(); } },
    commit(fn) {
      fn(state.data);
      save();
      if (state.theme === "beacon" && window.BeaconTheme?.update) window.BeaconTheme.update();
    },
    toast: status
  };

  function afterChange() {
    save();
    syncUrl();
    renderControls();
    renderStage();
  }

  function ensureScreen() {
    const nav = MODEL.roles[state.role].nav;
    if (!nav.some(([id]) => id === state.screen)) state.screen = nav[0][0];
  }

  function renderControls() {
    themeSeg.replaceChildren(...THEMES.map(t => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = t.name;
      b.dataset.theme = t.id;
      b.setAttribute("aria-pressed", String(t.id === state.theme));
      b.addEventListener("click", () => setTheme(t.id));
      return b;
    }));

    if (roleSelect.options.length !== roleIds.length) {
      roleSelect.replaceChildren(...roleIds.map(r => {
        const o = document.createElement("option");
        o.value = r;
        o.textContent = MODEL.roles[r].label;
        return o;
      }));
    }
    roleSelect.value = state.role;

    const nav = MODEL.roles[state.role].nav;
    screenSelect.replaceChildren(...nav.map(([id, label]) => {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = label + " · " + (screensById.get(id)?.title || id);
      return o;
    }));
    screenSelect.value = state.screen;
    modeSelect.value = state.mode;
  }

  function postToFrame() {
    if (!frame?.contentWindow || !frameReady) return;
    const nav = screensById.get(state.screen)?.legacyNav || MODEL.roles[state.role].nav[0][0];
    frame.contentWindow.postMessage({ type: "host-init", role: state.role, nav, screen: state.screen }, "*");
  }

  function renderStage() {
    const theme = themes.get(state.theme);
    if (theme.kind === "legacy") {
      if (frame?.dataset.theme !== theme.id) {
        native?.remove();
        frame?.remove();
        frameReady = false;
        frameState = null;
        frame = document.createElement("iframe");
        frame.dataset.theme = theme.id;
        frame.title = theme.name + " 主题（存量原型，iframe 隔离）";
        frame.src = theme.src + "?embed=1";
        frame.addEventListener("load", postToFrame);
        stage.replaceChildren(frame);
      }
      postToFrame();
      return;
    }
    if (!native) {
      native = document.createElement("div");
      native.className = "stage-native";
      native.id = "beacon-root";
      window.BeaconTheme.mount(native, api);
    }
    if (native.parentElement !== stage) stage.replaceChildren(native);
    if (window.BeaconTheme?.update) window.BeaconTheme.update();
  }

  function setTheme(id) {
    if (!themes.has(id) || id === state.theme) return;
    state.theme = id;
    ensureScreen();
    afterChange();
    status("已切换到 " + themes.get(id).name + " 主题");
  }

  function setRole(role) {
    if (!MODEL.roles[role] || role === state.role) return;
    state.role = role;
    ensureScreen();
    afterChange();
    status("已切换到 " + MODEL.roles[role].label);
  }

  themeSeg.addEventListener("keydown", ev => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
    const list = THEMES.map(t => t.id);
    const i = list.indexOf(state.theme);
    const next = (i + (ev.key === "ArrowRight" ? 1 : -1) + list.length) % list.length;
    ev.preventDefault();
    setTheme(list[next]);
    themeSeg.querySelector('[data-theme="' + list[next] + '"]')?.focus();
  });

  roleSelect.addEventListener("change", () => setRole(roleSelect.value));
  screenSelect.addEventListener("change", () => { state.screen = screenSelect.value; afterChange(); });
  modeSelect.addEventListener("change", () => { state.mode = modeSelect.value; afterChange(); });

  window.addEventListener("message", ev => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "bridge-ready") { frameReady = true; postToFrame(); }
    if (msg.type === "bridge-state") frameState = msg;
    if (msg.type === "bridge-toast") status(msg.text);
  });

  // 检查脚本与外部分享使用同一入口。
  window.__themeLab = {
    get state() { return state; },
    setTheme,
    setRole,
    setScreen: api.setScreen,
    setMode: api.setMode,
    themes: THEMES,
    isFrameReady: () => frameReady,
    getFrameState: () => frameState
  };

  renderControls();
  renderStage();
  save();
})();
