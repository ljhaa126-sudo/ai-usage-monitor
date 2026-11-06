"use strict";
// 刷新调度（v1.3）
// 1. 事件驱动：Claude Code / Codex 会话文件、Claude 桌面版、Gemini CLI 一有写入，就马上刷新对应 AI。
// 2. 智能频率：正在使用（最近有活动或用量在变）时按设置的频率刷新；闲置时自动放慢到 2 分钟。
// 3. 容错：偶发的网络失败不报错，继续显示上次数据；连续失败或数据明显过期才提示。
// 4. 休眠 / 断网时暂停，唤醒后等网络恢复再刷新。
// 5. 上次成功的数据会存盘，重开程序立刻显示，不会出现竖条忽长忽短。
// 6. AI 列表是动态的：内置 + 自定义工具，随时增删都不会崩（缺配置按默认值补）。
const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");
const { DEFS, FETCHERS, RESETTERS } = require("./providers");
const { EXTRA_DEFS, EXTRA_FETCHERS } = require("./extra");
const { customDef, fetchCustom } = require("./custom");
const { activeDays } = require("./store");
const { claudeDirs, codexHome } = require("./locallogs");
const { home, appSupport } = require("./util");

const MIN_GAP = { claude: 10000, codex: 3000, cursor: 15000, gemini: 15000, copilot: 20000, kimi: 5000, glm: 5000, deepseek: 15000, hunyuan: 30000, boxai: 60000, tokendash: 60000, workbuddy: 60000 };
const DEFAULT_GAP = 10000;
const IDLE_INTERVAL = 120000;     // 闲置时的刷新间隔
const ACTIVE_WINDOW = 5 * 60000;  // 最近 5 分钟有活动算「正在使用」
const CHANGE_WINDOW = 10 * 60000; // 最近 10 分钟用量有变化也算「正在使用」

class Engine extends EventEmitter {
  constructor(store, ctx, log) {
    super();
    this.store = store;
    this.ctx = ctx || {};
    this.log = log || (() => {});
    this.status = {};
    this.sched = {};
    this.paused = false;
    this.startedAt = Date.now();
    const snap = store.loadSnapshot ? store.loadSnapshot() : {};
    for (const d of this.defs()) {
      const enabled = this.provCfg(d.id).enabled;
      let st = this.base(d, enabled ? "loading" : "disabled");
      const old = snap[d.id];
      // 上次成功的数据：先显示出来，后台再更新
      if (enabled && old && (old.primary || old.secondary)) st = { ...st, ...old, state: "ok", fromCache: true, message: "" };
      st.history = st.history && st.history.length ? st.history : store.peakSeries(d.id);
      this.status[d.id] = st;
      this.sched[d.id] = { nextAt: 0, fails: 0, inflight: false, lastAt: 0, activityAt: 0, changedAt: 0, lastHeadline: null };
    }
  }

  // ---------- AI 清单（内置 + 自定义），随时可增删 ----------
  defs() {
    const cs = (this.store.cfg.customs || []).map(customDef);
    return [...DEFS, ...EXTRA_DEFS, ...cs];
  }
  def(id) { return this.defs().find((d) => d.id === id); }

  // 取配置：缺失时按默认值兜底，绝不返回 undefined（旧的崩溃就出在这里）
  provCfg(id) {
    const p = this.store.cfg.providers || (this.store.cfg.providers = {});
    if (!p[id] || typeof p[id] !== "object") p[id] = { enabled: true, apiKey: "", region: "cn" };
    if (p[id].enabled === undefined) p[id].enabled = true;
    return p[id];
  }

  fetcher(id) {
    if (FETCHERS[id]) return FETCHERS[id];
    if (EXTRA_FETCHERS[id]) return EXTRA_FETCHERS[id];
    const c = (this.store.cfg.customs || []).find((x) => x.id === id);
    if (c) return () => fetchCustom(c);
    return null;
  }

  base(d, state) {
    return { id: d.id, name: d.name, short: d.short, tagline: d.tagline, color: d.color, dashboard: d.dashboard || "", login: d.login || "", keyKind: d.keyKind || "",
      custom: !!d.custom, letter: d.letter || "", enabled: state !== "disabled", state, message: "", plan: "", account: "", source: "", primary: null, secondary: null, extra: [],
      headline: 0, headlineKey: "", resetCount: 0, resets: null, planEndsAt: 0, credits: "", history: [], historyUnit: "峰值 %", activeDays: [], updatedAt: 0, lagging: false };
  }

  // 结构变化（新增/删除自定义工具、改顺序）后调用：清掉不存在的，补上新增的
  sync() {
    const ids = this.defs().map((d) => d.id);
    for (const id of Object.keys(this.status)) if (!ids.includes(id)) { delete this.status[id]; delete this.sched[id]; }
    for (const d of this.defs()) if (!this.status[d.id]) {
      this.status[d.id] = this.base(d, this.provCfg(d.id).enabled ? "loading" : "disabled");
      this.status[d.id].history = this.store.peakSeries(d.id);
      this.sched[d.id] = { nextAt: 0, fails: 0, inflight: false, lastAt: 0, activityAt: 0, changedAt: 0, lastHeadline: null };
    }
    this.emit("update");
  }

  list() {
    const cfg = this.store.cfg;
    const out = [];
    for (const id of cfg.order || []) {
      const s = this.status[id];
      if (s) out.push(s);
    }
    return out;
  }

  start() {
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
    this.watch();
  }

  stop() {
    clearInterval(this.timer);
    for (const w of this.watchers || []) try { w.close(); } catch { /* ignore */ }
  }

  // ---------- 休眠 / 唤醒 ----------
  pause() { this.paused = true; }
  resume() {
    this.paused = false;
    const now = Date.now();
    // 唤醒后等网络恢复（4~7 秒）再刷新，并且不把唤醒期间的失败算进去
    for (const s of Object.values(this.sched)) { s.nextAt = now + 4000 + Math.random() * 3000; s.fails = 0; }
  }

  active(id) {
    const s = this.sched[id], now = Date.now();
    if (!s) return false;
    return now - this.startedAt < 2 * 60000 || now - s.activityAt < ACTIVE_WINDOW || now - s.changedAt < CHANGE_WINDOW;
  }

  interval(id) {
    const base = Math.max((this.store.cfg.refreshSeconds || 30) * 1000, MIN_GAP[id] || DEFAULT_GAP);
    if (this.store.cfg.smartRefresh === false) return base;
    return this.active(id) ? base : Math.max(base, IDLE_INTERVAL);
  }

  tick() {
    if (this.paused) return;
    if (this.ctx.isOnline && !this.ctx.isOnline()) return; // 断网：先不刷新，也不报错
    const now = Date.now();
    for (const d of this.defs()) {
      const s = this.sched[d.id] || (this.sched[d.id] = { nextAt: 0, fails: 0, inflight: false, lastAt: 0, activityAt: 0, changedAt: 0, lastHeadline: null });
      let on = true;
      try { on = !!this.provCfg(d.id).enabled; } catch { on = false; }
      if (!on) {
        const cur = this.status[d.id];
        if (!cur || cur.state !== "disabled") { this.status[d.id] = this.base(d, "disabled"); this.emit("update"); }
        continue;
      }
      if (!this.status[d.id]) this.status[d.id] = this.base(d, "loading");
      if (this.status[d.id].state === "disabled") { this.status[d.id] = this.base(d, "loading"); s.nextAt = 0; }
      if (!s.inflight && now >= s.nextAt) this.refresh(d.id);
    }
  }

  // 有活动：标记为「正在使用」，并尽快刷新（遵守最小间隔）
  activity(id, refresh = true) {
    const s = this.sched[id];
    if (!s) return;
    s.activityAt = Date.now();
    if (refresh && !(s.fails && Date.now() < s.nextAt)) s.nextAt = Math.min(s.nextAt || Infinity, Math.max(Date.now(), s.lastAt + (MIN_GAP[id] || DEFAULT_GAP)));
  }

  refreshNow(id) {
    for (const i of id ? [id] : this.defs().map((d) => d.id)) {
      const s = this.sched[i];
      if (!s) continue;
      s.activityAt = Date.now();
      s.nextAt = Math.max(Date.now(), s.lastAt + (MIN_GAP[i] || DEFAULT_GAP));
    }
    this.tick();
  }

  resetSchedule() {
    for (const s of Object.values(this.sched)) { s.nextAt = 0; s.fails = 0; }
    this.sync();
    this.emit("update");
    this.tick();
  }

  // 使用一次限额重置（目前支持 Codex），成功后立即刷新用量
  async consumeReset(id, creditId) {
    const fn = RESETTERS[id];
    if (!fn) return { ok: false, message: "该 AI 不支持限额重置" };
    let r;
    try { r = await fn(this.provCfg(id), creditId, this.ctx); } catch (e) {
      this.log(`[${id}] 重置失败：${e.message}`);
      return { ok: false, message: "重置失败：" + shortErr(e) };
    }
    this.log(`[${id}] 使用重置：${r.code}`);
    const s = this.sched[id];
    if (s) { s.lastAt = 0; s.nextAt = 0; s.activityAt = Date.now(); }
    this.tick();
    return r;
  }

  async refresh(id) {
    const d = this.def(id);
    const fetchFn = this.fetcher(id);
    const s = this.sched[id];
    if (!d) return;
    if (!s) return;
    if (!fetchFn) {
      this.status[id] = { ...this.base(d, "nologin"), message: "这个工具没有配置数据来源，请在设置里编辑" };
      s.nextAt = Date.now() + 60000;
      this.emit("update");
      return;
    }
    const pc0 = this.provCfg(id);
    // 没有手动填 Key：用自动识别到的（环境变量 / Claude Code 设置 / cc-switch 等）
    const auto = !String(pc0.apiKey || "").trim() && this.ctx.autoCfg ? this.ctx.autoCfg(id) : null;
    const pc = auto ? { ...pc0, apiKey: auto.apiKey, apiKeys: auto.apiKeys || [], ...(auto.region ? { region: auto.region } : {}) } : pc0;
    s.inflight = true;
    s.lastAt = Date.now();
    const prev = this.status[id];
    let st, err;
    // 单次刷新最多等 60 秒：网络卡住时不会一直「正在更新」、也不会让这个 AI 从此不再刷新
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("请求超时（60 秒没有响应）")), this.fetchTimeout || 60000); });
    try { st = await Promise.race([fetchFn(pc, this.ctx), timeout]); } catch (e) { err = e; } finally { clearTimeout(timer); }
    s.inflight = false;
    if (!this.provCfg(id).enabled) return;
    if (!this.status[id]) this.status[id] = this.base(d, "loading");

    const interval = this.interval(id);
    let out;
    if (!err) {
      out = { ...this.base(d, "ok"), ...st, state: "ok", updatedAt: Date.now() };
      if (auto) out.source = "自动识别（" + auto.from + "）";
      s.fails = 0;
      s.nextAt = Date.now() + interval;
    } else if (err.noLogin) {
      out = { ...this.base(d, "nologin"), message: err.message, history: (prev && prev.history) || [] };
      s.fails = 0;
      s.nextAt = Date.now() + Math.max(interval, 60000); // 没登录不用频繁查
    } else {
      s.fails++;
      let wait;
      if (err.status === 429) {
        const ra = Number((err.headers || {})["retry-after"]) * 1000 || 0;
        wait = Math.min(Math.max(ra, 60000 * Math.pow(2, Math.min(s.fails - 1, 3))), 10 * 60000);
      } else {
        wait = Math.min(15000 * Math.pow(2, s.fails - 1), 5 * 60000);
      }
      wait = Math.max(interval, wait) * (0.85 + Math.random() * 0.3); // 加一点随机，避免同时重试
      s.nextAt = Date.now() + wait;
      const hasData = prev && (prev.primary || prev.secondary || (prev.extra || []).length);
      if (hasData) {
        // 有旧数据：偶发失败不打扰，继续显示；连续失败 3 次或数据过旧才提示
        // 记下失败原因（气泡底部显示），并且不再显示成「正在更新…」
        out = { ...prev, lagging: true, fromCache: false, lastError: shortErr(err), lastErrorFull: String(err.message || "") };
        const old = Date.now() - (prev.updatedAt || 0) > Math.max(3 * interval, 5 * 60000);
        if (s.fails >= 3 || old) {
          out.state = "stale";
          out.message = err.status === 429 ? "请求太频繁被限流，已自动放慢，稍后恢复" : `暂时连不上（${shortErr(err)}），显示的是上次的数据，会自动重试`;
        }
      } else {
        out = { ...this.base(d, "error"), message: "更新失败：" + shortErr(err), history: (prev && prev.history) || [] };
      }
      this.log(`[${id}] 第 ${s.fails} 次失败：${err.message}`);
    }

    const main = out.primary || out.secondary || (out.extra || [])[0];
    if (main) { out.headline = main.usedPercent; out.headlineKey = main.label; }
    if (!err) {
      const h = Math.round(out.headline || 0);
      if (s.lastHeadline != null && h !== s.lastHeadline) s.changedAt = Date.now();
      s.lastHeadline = h;
      if (out.primary || out.secondary) out.resetCount = this.store.record(out);
      if (out.historyUnit !== "M tokens") {
        out.historyUnit = "峰值 %";
        out.history = this.store.peakSeries(id);
        out.activeDays = activeDays(this.store.peakMap(id));
      } else if (out.daily) {
        out.activeDays = activeDays(out.daily);
      }
      delete out.daily;
      out.lagging = false;
      out.fromCache = false;
      delete out.lastError;
      delete out.lastErrorFull;
      if (st && st.dashboard) out.dashboard = st.dashboard;
    }
    this.status[id] = out;
    if (this.store.saveSnapshot) this.store.saveSnapshot(this.list());
    this.emit("update");
  }

  // ---------- 活动监听（事件驱动刷新） ----------
  watch() {
    this.watchers = [];
    const add = (dir, id, opts = {}) => {
      const filter = opts.filter || (() => true);
      const go = () => {
        try {
          const w = fs.watch(dir, { recursive: true }, (_e, f) => {
            if (f && !filter(String(f))) return;
            clearTimeout(this["_w" + id + dir]);
            this["_w" + id + dir] = setTimeout(() => this.activity(id, opts.refresh !== false), opts.debounce || 1500);
          });
          w.on("error", () => {});
          this.watchers.push(w);
          return true;
        } catch { return false; }
      };
      if (!go()) {
        const t = setInterval(() => { if (fs.existsSync(dir) && go()) clearInterval(t); }, 60000);
        this.watchers.push({ close: () => clearInterval(t) });
      }
    };
    const jsonl = (f) => f.endsWith(".jsonl");
    for (const d of claudeDirs()) add(path.join(d, "projects"), "claude", { filter: jsonl });
    add(path.join(codexHome(), "sessions"), "codex", { filter: jsonl });
    // Claude 桌面版：聊天时会写本地存储（只看这几类目录，忽略缓存、日志）
    add(appSupport("Claude"), "claude", { filter: (f) => /IndexedDB|Local Storage|Session Storage|claude-code/i.test(f) && !/Cache|GPUCache|Crashpad|logs?\//i.test(f), debounce: 3000 });
    // Gemini CLI 会话
    add(path.join(home(), ".gemini", "tmp"), "gemini", { debounce: 2500 });
    // Cursor 使用中：只作为「活跃」信号，不立即刷新
    add(appSupport("Cursor", "User", "workspaceStorage"), "cursor", { refresh: false, debounce: 5000 });
  }
}

function shortErr(e) {
  const m = String(e && e.message || e);
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED/.test(m)) return "网络不可用";
  if (/ERR_PROXY|ERR_TUNNEL/.test(m)) return "代理连接失败";
  if (/超时|TIMED_OUT/.test(m)) return "连接超时";
  if (/ERR_CONNECTION/.test(m)) return "连接被中断";
  return m.length > 60 ? m.slice(0, 60) + "…" : m;
}

module.exports = { Engine };
