"use strict";
// 自定义 AI 工具：用户自己填一个返回 JSON 的用量接口 + 字段路径，即可接入竖条
const { requestJSON } = require("./http");
const { parseTime, NoLogin } = require("./util");

// 常用模板（设置页「添加」时可选）
const PRESETS = {
  blank: { name: "", url: "", method: "GET", headers: "", body: "", percentPath: "", usedPath: "", limitPath: "", remainPath: "", resetPath: "", label: "额度", unit: "", dashboard: "" },
  newapi: { name: "中转站（One/New API）", url: "https://你的域名/api/user/self", method: "GET", headers: "Authorization: Bearer 你的系统访问令牌\nNew-Api-User: 你的用户ID", body: "", percentPath: "", usedPath: "data.used_quota", limitPath: "", remainPath: "data.quota", resetPath: "", label: "账户额度", unit: "", dashboard: "" },
  deepseek: { name: "DeepSeek", url: "https://api.deepseek.com/user/balance", method: "GET", headers: "Authorization: Bearer {{env:DEEPSEEK_API_KEY}}", body: "", percentPath: "", usedPath: "", limitPath: "", remainPath: "balance_infos.0.total_balance", resetPath: "", label: "账户余额", unit: "元", dashboard: "https://platform.deepseek.com/usage" },
  siliconflow: { name: "硅基流动", url: "https://api.siliconflow.cn/v1/user/info", method: "GET", headers: "Authorization: Bearer {{env:SILICONFLOW_API_KEY}}", body: "", percentPath: "", usedPath: "", limitPath: "", remainPath: "data.totalBalance", resetPath: "", label: "账户余额", unit: "元", dashboard: "https://cloud.siliconflow.cn/account/ak" },
};

const FIELDS = Object.keys(PRESETS.blank);

function sanitize(c) {
  if (!c || typeof c !== "object") return null;
  const o = { id: String(c.id || "") };
  if (!/^c_[a-z0-9]{4,20}$/.test(o.id)) return null;
  for (const k of FIELDS) o[k] = c[k] == null ? PRESETS.blank[k] : String(c[k]).slice(0, 4000);
  o.method = /^post$/i.test(o.method) ? "POST" : "GET";
  if (!o.name.trim()) o.name = "自定义 AI";
  return o;
}

function customDef(c) {
  const name = c.name.trim() || "自定义 AI";
  const short = name.replace(/\s+/g, "").slice(0, 6);
  return { id: c.id, name, short, tagline: "自定义 · " + (c.label || "额度"), color: "#9AA0A6", dashboard: /^https:\/\//.test(c.dashboard) ? c.dashboard : "", custom: true, letter: [...name][0] || "?" };
}

// a.b.0.c / a.b[0].c
function getPath(obj, p) {
  if (!p || !String(p).trim()) return undefined;
  let cur = obj;
  for (const seg of String(p).trim().replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function toNum(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[,\s]/g, ""));
  return isNaN(n) ? null : n;
}

const fill = (s) => String(s || "").replace(/\{\{env:([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_m, k) => process.env[k] || "");

function parseHeaders(text) {
  const h = {};
  for (const line of fill(text).split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
    if (k) h[k] = v;
  }
  return h;
}

const fmtN = (n, unit) => {
  const a = Math.abs(n);
  const s = a >= 1e8 ? (n / 1e8).toFixed(2) + " 亿" : a >= 1e4 ? (n / 1e4).toFixed(1) + " 万" : Number.isInteger(n) ? String(n) : n.toFixed(2);
  return unit ? s + " " + unit : s;
};

// 把接口返回 + 字段路径 → 统一的用量窗口
function extract(c, d) {
  const label = (c.label || "额度").trim() || "额度";
  const unit = (c.unit || "").trim();
  const reset = c.resetPath ? parseTime(getPath(d, c.resetPath)) : 0;
  let pct = toNum(getPath(d, c.percentPath));
  const used = toNum(getPath(d, c.usedPath));
  let limit = toNum(getPath(d, c.limitPath));
  const remain = toNum(getPath(d, c.remainPath));
  if (limit == null && used != null && remain != null) limit = used + remain;
  let detail = "";
  if (pct != null) {
    const raw = getPath(d, c.percentPath);
    if (pct > 0 && pct <= 1 && !/%/.test(String(raw))) pct *= 100; // 0~1 的比例自动换算成百分比
    if (used != null && limit) detail = `已用 ${fmtN(used, unit)} / ${fmtN(limit, unit)}`;
    else if (remain != null) detail = `剩余 ${fmtN(remain, unit)}`;
  } else if (used != null && limit) {
    pct = (used / limit) * 100;
    detail = `已用 ${fmtN(used, unit)} / ${fmtN(limit, unit)}`;
  } else if (remain != null && limit) {
    pct = ((limit - remain) / limit) * 100;
    detail = `剩余 ${fmtN(remain, unit)} / ${fmtN(limit, unit)}`;
  } else if (remain != null) {
    pct = 0;
    detail = `余额 ${fmtN(remain, unit)}`;
  } else if (used != null) {
    pct = 0;
    detail = `已用 ${fmtN(used, unit)}`;
  } else {
    return null;
  }
  return { key: "custom", label, usedPercent: Math.max(0, Math.min(100, pct)), resetsAt: reset, windowMinutes: 0, detail };
}

async function rawFetch(c) {
  const url = fill(c.url).trim();
  if (!/^https?:\/\//i.test(url)) throw new NoLogin("接口地址需要以 http:// 或 https:// 开头，请在设置里编辑");
  const headers = parseHeaders(c.headers);
  const opt = { url, method: c.method === "POST" ? "POST" : "GET", headers };
  if (opt.method === "POST") {
    opt.body = fill(c.body) || "{}";
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
  }
  return requestJSON(opt);
}

async function fetchCustom(c) {
  const st = { historyUnit: "峰值 %", source: "自定义接口" };
  let d;
  try { d = await rawFetch(c); } catch (e) {
    if (e.auth) throw new NoLogin("接口返回 401/403：请检查请求头里的令牌");
    throw e;
  }
  const w = extract(c, d);
  if (!w) throw new Error("接口返回里找不到配置的字段，请在设置里点「测试」核对字段路径");
  st.primary = w;
  st.extra = [];
  return st;
}

// 设置页「测试」：返回解析结果 + 接口原始返回（截断）
async function testCustom(c) {
  const s = sanitize({ ...c, id: c.id || "c_test0" });
  if (!s) return { ok: false, message: "配置无效" };
  let d;
  try { d = await rawFetch(s); } catch (e) { return { ok: false, message: e.message }; }
  const w = extract(s, d);
  let sample = "";
  try { sample = JSON.stringify(d, null, 2); } catch { sample = String(d); }
  if (sample.length > 3000) sample = sample.slice(0, 3000) + "\n…（已截断）";
  // 不回显可能的密钥字段
  sample = sample.replace(/("(?:[^"]*(?:token|key|secret|password)[^"]*)"\s*:\s*)"[^"]*"/gi, '$1"***"');
  return w ? { ok: true, message: `解析成功：${w.label} 已用 ${Math.round(w.usedPercent)}%${w.detail ? " · " + w.detail : ""}`, sample } : { ok: false, message: "请求成功，但没找到配置的字段，参考下方原始返回填写字段路径", sample };
}

function newId() { return "c_" + Math.random().toString(36).slice(2, 10); }

module.exports = { PRESETS, FIELDS, sanitize, customDef, fetchCustom, testCustom, extract, getPath, newId };
