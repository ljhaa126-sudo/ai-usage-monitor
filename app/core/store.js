"use strict";
const fs = require("fs");
const path = require("path");
const { readJSON, dayKey } = require("./util");
const { sanitize } = require("./custom");

const PROVIDER_IDS = ["claude", "codex", "cursor", "gemini", "copilot", "kimi", "glm", "deepseek", "hunyuan", "boxai", "tokendash", "workbuddy"];
// 新增的内置 AI 默认关闭，避免老用户升级后竖条突然多出图标
const DEFAULT_OFF = ["workbuddy"];

const provDefault = (id) => ({ enabled: !DEFAULT_OFF.includes(id), apiKey: "", region: "cn" });

function defaults() {
  const providers = {};
  for (const id of PROVIDER_IDS) providers[id] = provDefault(id);
  return {
    providers,
    customs: [], // 自定义 AI 工具（见 core/custom.js）
    order: [...PROVIDER_IDS],
    refreshSeconds: 30,
    smartRefresh: true, // 正在使用时按 refreshSeconds，闲置时放慢
    style: "minimal", // minimal（极简气泡）| detail（详细面板）
    hideIdle: true,
    autoStart: false,
    proxy: "",
    trayPercent: true,
    // 位置：edge = 吸附在屏幕边缘；float = 自由摆放（坐标为所在屏幕工作区内的比例）
    dock: { mode: "edge", edge: "right", y: 0.32, x: 0.8, displayId: 0 },
    zoom: 1, // 整体缩放 0.6 ~ 2.0（竖条、气泡、面板统一缩放）
    taskNotify: true, // AI 任务完成 / 需要处理时，在对应图标旁弹出提醒
    hotkey: "", // 显示 / 隐藏悬浮条的快捷键（Electron 写法）。"" = 默认，"off" = 不使用
  };
}

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cfgPath = path.join(dir, "config.json");
    this.histPath = path.join(dir, "history.json");
    this.snapPath = path.join(dir, "snapshot.json");
    this.cfg = this.loadCfg();
    this.hist = readJSON(this.histPath) || { days: {}, resets: {} };
    this.hist.days ||= {};
    this.hist.resets ||= {};
  }

  loadCfg() {
    const disk = readJSON(this.cfgPath);
    return normalizeCfg(disk);
  }

  // 统一修补配置：任何时候 providers / order / customs 都是完整、一致的
  normalize() { this.cfg = normalizeCfg(this.cfg); return this.cfg; }

  saveCfg() {
    const tmp = this.cfgPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.cfg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.cfgPath);
  }

  saveHist() {
    const tmp = this.histPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.hist), { mode: 0o600 });
    fs.renameSync(tmp, this.histPath);
  }

  // 上次成功的数据：重开程序时先显示，避免竖条从空变满
  loadSnapshot() {
    const j = readJSON(this.snapPath) || {};
    // 超过 12 小时的旧数据就不用了
    for (const k of Object.keys(j)) if (!j[k] || Date.now() - (j[k].updatedAt || 0) > 12 * 3600e3) delete j[k];
    return j;
  }

  saveSnapshot(list) {
    clearTimeout(this._st);
    this._st = setTimeout(() => {
      const o = {};
      for (const s of list) if ((s.state === "ok" || s.state === "stale") && s.updatedAt && (s.primary || s.secondary)) o[s.id] = s;
      try { fs.writeFileSync(this.snapPath, JSON.stringify(o), { mode: 0o600 }); } catch { /* ignore */ }
    }, 2000);
  }

  // 记录一次成功采样，返回本周期内 5h 窗口已重置次数
  record(st) {
    const day = dayKey();
    const pd = (this.hist.days[st.id] ||= {});
    const r = (pd[day] ||= { peak: 0, n: 0 });
    r.peak = Math.max(r.peak, st.headline || 0);
    r.n++;
    const cut = dayKey(Date.now() - 40 * 864e5);
    for (const d of Object.keys(pd)) if (d < cut) delete pd[d];

    let count = 0;
    if (st.primary && st.primary.resetsAt) {
      const key = Math.floor(st.primary.resetsAt / 600000) * 600000;
      const list = (this.hist.resets[st.id] ||= []);
      if (!list.includes(key)) list.push(key);
      list.sort((a, b) => a - b);
      if (list.length > 200) list.splice(0, list.length - 200);
      let start = Date.now() - 7 * 864e5;
      if (st.secondary && st.secondary.resetsAt) start = st.secondary.resetsAt - (st.secondary.windowMinutes || 10080) * 60000;
      const now = Date.now();
      count = list.filter((v) => v > start && v <= now).length;
    }
    this.saveHistSoon();
    return count;
  }

  saveHistSoon() {
    clearTimeout(this._ht);
    this._ht = setTimeout(() => { try { this.saveHist(); } catch { /* ignore */ } }, 3000);
  }

  peakSeries(id) {
    const pd = this.hist.days[id] || {};
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const d = dayKey(Date.now() - i * 864e5);
      out.push({ date: d, value: pd[d] ? pd[d].peak : 0 });
    }
    return out;
  }

  peakMap(id) {
    const m = {};
    for (const [d, r] of Object.entries(this.hist.days[id] || {})) m[d] = r.peak;
    return m;
  }
}

function normalizeCfg(src) {
  const d = defaults();
  if (!src || typeof src !== "object") return d;
  const c = { ...d, ...src, dock: { ...d.dock, ...(src.dock || {}) } };
  const z = Number(c.zoom);
  c.zoom = isFinite(z) && z > 0 ? Math.max(0.6, Math.min(2, Math.round(z * 100) / 100)) : 1;
  const customs = [];
  const seen = new Set();
  for (const x of Array.isArray(src.customs) ? src.customs : []) {
    const s = sanitize(x);
    if (s && !seen.has(s.id) && !PROVIDER_IDS.includes(s.id)) { seen.add(s.id); customs.push(s); }
  }
  c.customs = customs;
  const ids = [...PROVIDER_IDS, ...customs.map((x) => x.id)];
  const sp = src.providers || {};
  c.providers = {};
  for (const id of ids) c.providers[id] = { ...provDefault(id), ...(sp[id] || {}) };
  const order = (Array.isArray(src.order) ? src.order : []).filter((id, i, a) => ids.includes(id) && a.indexOf(id) === i);
  for (const id of ids) if (!order.includes(id)) order.push(id);
  c.order = order;
  return c;
}

function activeDays(map) {
  const now = new Date();
  const wd = now.getDay() || 7;
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = dayKey(now.getTime() - (wd - 1 - i) * 864e5);
    out.push((map[d] || 0) > 0);
  }
  return out;
}

module.exports = { Store, PROVIDER_IDS, activeDays, defaults, normalizeCfg };
