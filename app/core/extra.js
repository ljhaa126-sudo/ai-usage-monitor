"use strict";
// 额外内置的 AI：BoxAI（公司平台个人 Token 额度）、WorkBuddy（腾讯 AI 编程客户端）
const path = require("path");
const os = require("os");
const fs = require("fs");
const { requestJSON } = require("./http");
const { num, readJSON, NoLogin, appSupport, fileExists } = require("./util");

const EXTRA_DEFS = [
  {
    id: "boxai", name: "BoxAI", short: "Box", tagline: "腾讯 Box · 个人 Token 额度", color: "#4C8CF5",
    dashboard: "https://box-ai.woa.com/boxai/cost/user/overview", login: "",
    keyKind: "可选：RTX（留空自动读取本机账号）",
  },
  {
    id: "tokendash", name: "AI Token 用量", short: "¥", tagline: "token.woa.com · 全公司 AI 额度", color: "#19B36B",
    dashboard: "https://token.woa.com/", login: "",
    keyKind: "",
  },
  {
    id: "workbuddy", name: "WorkBuddy", short: "WB", tagline: "WorkBuddy · 企业额度", color: "#7A6BFF",
    dashboard: "https://www.workbuddy.cn/console", login: "https://www.workbuddy.cn/console/accounts",
    keyKind: "可选：Access Token（留空用网页登录）",
  },
];

const localRtx = () => {
  const j = readJSON(path.join(appSupport("Box"), "s3_user.json"));
  if (j && j.rtx) return String(j.rtx);
  try { return String(os.userInfo().username || "").toLowerCase(); } catch { return ""; }
};

const fmt = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(2) + " 亿";
  if (v >= 1e4) return (v / 1e4).toFixed(1) + " 万";
  return String(Math.round(v));
};

// 月度周期：下个月 1 日 00:00
function nextMonthStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0).getTime();
}

// ======================= BoxAI =======================
// 公开读取接口：https://box-ai.woa.com/api/cost/open-api/v1/quota/user?rtx=xxx
async function fetchBoxAI(cfg) {
  const st = { historyUnit: "峰值 %" };
  const rtx = (cfg.apiKey || "").trim() || localRtx();
  if (!rtx) throw new NoLogin("没有识别到 RTX 账号，可在设置里手动填写");
  st.account = rtx;
  const d = await requestJSON({ url: "https://box-ai.woa.com/api/cost/open-api/v1/quota/user?rtx=" + encodeURIComponent(rtx) });
  const q = d.data || d;
  if (num(q, "monthlyQuota") == null) throw new Error("BoxAI 返回了无法识别的额度格式");
  const total = num(q, "monthlyQuota") || 0;
  const used = num(q, "monthlyUsed") || 0;
  const pct = total > 0 ? (used / total) * 100 : 0;
  st.source = "BoxAI 额度接口";
  st.plan = String(q.userType || "") === "paid" ? "个人 Token 池" : "体验额度";
  const reset = nextMonthStart();
  st.primary = { key: "month", label: "本月 · Token 额度", usedPercent: Math.max(0, Math.min(100, pct)), resetsAt: reset, windowMinutes: 0, detail: `已用 ${fmt(used)} / ${fmt(total)}` };
  st.extra = [];
  const at = num(q, "activityQuotaTotal") || 0;
  if (at > 0) {
    st.extra.push({ key: "activity", label: "活动额度", usedPercent: Math.max(0, Math.min(100, ((num(q, "activityQuotaUsed") || 0) / at) * 100)), resetsAt: 0, windowMinutes: 0, detail: `已用 ${fmt(num(q, "activityQuotaUsed") || 0)} / ${fmt(at)}` });
  }
  if (q.quotaExceeded || q.monthlyExceeded) st.message = "本月额度已用尽，可在设置里查看用量页申请提额";
  else if (q.dailyExceeded) st.message = "今日额度已用尽";
  return st;
}

// ======================= AI Token 用量（token.woa.com · 全公司 AI 额度） =======================
// 腾讯官方「用量健康助手」(Tencent Token Dashboard) 通过 iOA 快速登录换取 access_token，存在本地 SQLite：
//   %APPDATA%\com.tencent.token-dashboard\auth-session.sqlite  表 auth_sessions(id='active')
// 我们不自己做 iOA 登录（需要官方签名），而是复用它已经登录好的 access_token 去查额度接口。
// 额度以人民币计价（公司统一 AI token 额度），接口：POST {bff}/v1/me/quota-realtime
// access_token 约 2 小时过期，但 session 约半个月有效，过期时用 /v1/auth/session/refresh 续一张。
function tdDbPath() {
  const dirs = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "com.tencent.token-dashboard"));
  dirs.push(path.join(os.homedir(), "Library", "Application Support", "com.tencent.token-dashboard"));
  dirs.push(path.join(os.homedir(), ".config", "com.tencent.token-dashboard"));
  dirs.push(path.join(os.homedir(), ".local", "share", "com.tencent.token-dashboard"));
  for (const d of dirs) {
    const p = path.join(d, "auth-session.sqlite");
    if (fileExists(p)) return p;
  }
  return "";
}

// 读会话库的实现可被测试替换
let _tdReadSession = tdReadSessionImpl;
function setTdSessionReader(fn) { _tdReadSession = fn || tdReadSessionImpl; }
function tdReadSession() { return _tdReadSession(); }

// 只读会话库（复制到临时文件再读，避免与健康助手争锁）
function tdReadSessionImpl() {
  const src = tdDbPath();
  if (!src) return null;
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); } catch { return { err: "当前运行环境不支持读取本地数据库（需要较新的 Electron）" }; }
  const tmp = path.join(os.tmpdir(), "aimon-td-" + process.pid + ".sqlite");
  try {
    fs.copyFileSync(src, tmp);
    const db = new DatabaseSync(tmp, { readOnly: true });
    const row = db.prepare("select access_token, access_expires_at, session_expires_at, username, display_name, org_name, device_id, bff_base_url from auth_sessions where id='active'").get();
    db.close();
    return row || null;
  } catch (e) {
    return { err: String((e && e.message) || e) };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

async function tdRefresh(sess) {
  const r = await requestJSON({
    url: sess.bff_base_url + "/v1/auth/session/refresh", method: "POST", body: "{}",
    headers: { Authorization: "Bearer " + sess.access_token, "x-device-id": sess.device_id || "", "Content-Type": "application/json" },
  });
  if (r && r.accessToken) return { token: r.accessToken, exp: num(r, "accessExpiresAt") || 0 };
  throw new NoLogin("AI Token 登录已过期：请打开「用量健康助手」重新登录一次");
}

async function fetchTokenDash() {
  const st = { historyUnit: "峰值 %", unit: "cny" };
  const sess = tdReadSession();
  if (!sess) throw new NoLogin("没有找到「用量健康助手」的登录：请先安装并登录 Tencent Token Dashboard");
  if (sess.err) throw new Error("读取「用量健康助手」登录态失败：" + sess.err);
  if (sess.username) st.account = sess.display_name || sess.username;
  if (sess.org_name) st.plan = sess.org_name + " · AI Token";
  const base = sess.bff_base_url || "https://token.woa.com/apigw/app";

  let token = sess.access_token;
  const accExp = num(sess, "access_expires_at") || 0;
  const sessExp = num(sess, "session_expires_at") || 0;
  const nowSec = Math.floor(Date.now() / 1000);
  if (sessExp && sessExp < nowSec) throw new NoLogin("AI Token 登录已过期：请打开「用量健康助手」重新登录一次");
  // access_token 快过期（或已过期）时，先用 refresh 续一张
  if (!accExp || accExp < nowSec + 60) {
    try { token = (await tdRefresh(sess)).token; } catch (e) { if (e && e.noLogin) throw e; /* 续签失败就用旧的试一次 */ }
  }

  const call = (tok) => requestJSON({
    url: base + "/v1/me/quota-realtime", method: "GET",
    headers: { Authorization: "Bearer " + tok, "x-device-id": sess.device_id || "", Accept: "application/json" },
  });

  let r;
  try {
    r = await call(token);
  } catch (e) {
    // 401：access_token 失效，refresh 再试一次
    if (e && (e.auth || e.status === 401)) {
      token = (await tdRefresh(sess)).token;
      r = await call(token);
    } else throw e;
  }

  const total = (r && r.total) || {};
  const limit = num(total, "quotaCny");
  if (limit == null) throw new Error("AI Token 返回了无法识别的额度格式");
  const used = num(total, "usedCny") || 0;
  st.source = "用量健康助手（token.woa.com）";
  const pct = limit > 0 ? (used / limit) * 100 : 0;
  // 金额保留两位；额度每月重置
  const yuan = (n) => "¥" + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  st.primary = {
    key: "month", label: "本月 · AI Token 额度",
    usedPercent: Math.max(0, Math.min(100, pct)), resetsAt: nextMonthStart(), windowMinutes: 0,
    detail: `已用 ${yuan(used)} / ${yuan(limit)}`,
  };
  st.extra = [];
  const daily = (r && r.dailyQuota) || null;
  if (daily && num(daily, "quotaCny") != null) {
    const dl = num(daily, "quotaCny") || 0, du = num(daily, "usedCny") || 0;
    st.extra.push({ key: "daily", label: "今日额度", usedPercent: dl > 0 ? Math.max(0, Math.min(100, (du / dl) * 100)) : 0, resetsAt: 0, windowMinutes: 0, detail: `已用 ${yuan(du)} / ${yuan(dl)}` });
  }
  if (num(total, "remainingCny") != null) st.credits = "剩余 " + yuan(num(total, "remainingCny"));
  return st;
}


// 企业信息直接从 WorkBuddy 客户端本地读（无需登录即可拿到 enterpriseId / 企业专属域名）
// 注意：腾讯等企业是「企业 SSO」账号，登录和接口都在企业专属域名（如 tencent.sso.codebuddy.cn），
// 走 iOA 认证；公网 www.workbuddy.cn 的手机号 / 微信登录登的是另一个账号体系，查不到企业额度。
function wbAuthFile() {
  const dirs = [];
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "CodeBuddyExtension", "Data", "Public", "auth"));
  dirs.push(path.join(os.homedir(), "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth"));
  dirs.push(path.join(os.homedir(), ".local", "share", "CodeBuddyExtension", "Data", "Public", "auth"));
  for (const d of dirs) {
    const j = readJSON(path.join(d, "workbuddy-desktop.info"));
    if (j) return j;
  }
  return null;
}

function wbLocal() {
  const base = path.join(os.homedir(), ".workbuddy");
  const snap = readJSON(path.join(base, "storage", "skeleton", "account-snapshot.json")) || {};
  const p = snap.primary || snap;
  const af = wbAuthFile() || {};
  const acc = af.account || {};
  // 只读明文字段（域名、企业 ID），加密的令牌一律不碰
  const dom = String((af.auth && af.auth.domain) || "").trim();
  return {
    enterpriseId: p.enterpriseId || p.enterprise_id || acc.enterpriseId || "",
    uid: p.uid || acc.uid || "",
    account: p.enterpriseUserName || acc.enterpriseUserName || p.nickname || "",
    plan: p.enterpriseName || acc.enterpriseName || "",
    sso: acc.accountType === "sso" || /\.sso\./.test(dom),
    domain: /^[a-z0-9.-]+\.(codebuddy\.cn|workbuddy\.cn|copilot\.tencent\.com|codebuddy\.ai|workbuddy\.ai)$/i.test(dom) ? dom : "",
  };
}

// 接口 / 登录用的站点：企业 SSO 用企业专属域名，其余用公网站点
function wbBase() {
  const l = wbLocal();
  return "https://" + (l.domain || "www.workbuddy.cn");
}

// 需要一次网页登录（Web 会话 Cookie）或用个人 Access Token
async function fetchWorkBuddy(cfg, ctx) {
  const st = { historyUnit: "峰值 %" };
  const manual = (cfg.apiKey || "").trim();
  const loc = wbLocal();
  let ent = (cfg.enterpriseId || "").trim() || loc.enterpriseId;
  const base = wbBase();
  if (loc.account) st.account = loc.account;
  if (loc.plan) st.plan = loc.plan;
  const req = (p, opt = {}) => requestJSON({
    url: base + p,
    ...opt,
    session: ctx && ctx.webSession,
    useSessionCookies: !manual,
    headers: {
      Accept: "application/json",
      ...(manual ? { Authorization: "Bearer " + manual } : {}),
      ...(ent ? { "X-Enterprise-Id": ent, "X-Tenant-Id": ent } : {}),
      ...(loc.uid ? { "X-User-Id": loc.uid } : {}),
      ...(opt.headers || {}),
    },
  });
  try {
    if (!ent) {
      const a = await req("/console/accounts");
      const list = (a && ((a.data && a.data.accounts) || a.accounts)) || [];
      const one = list.find((x) => x && x.enterpriseId) || list[0];
      if (one) {
        ent = one.enterpriseId || "";
        st.account = st.account || one.enterpriseUserName || one.nickname || one.email || "";
        if (!st.plan && one.enterpriseName) st.plan = one.enterpriseName;
      }
    }
    if (!ent) throw new NoLogin("没有拿到企业信息：请在设置里点「登录网页版」登录一次 WorkBuddy");
    const r = await req("/v2/billing/meter/get-enterprise-user-usage", { method: "POST", headers: { "Content-Type": "application/json", "X-Enterprise-Id": ent }, body: "{}" });
    const body = (r && r.data) || {};
    const q = body.data && body.data.data ? body.data.data : body.data || body;
    const limit = num(q, "limitNum", "limit_num");
    if (limit == null) throw new Error("WorkBuddy 返回了无法识别的额度格式");
    st.source = manual ? "手动填写的 Token" : "WorkBuddy 网页登录";
    if (!st.plan) st.plan = "企业版";
    const reset = parseN(q.cycleResetTime || q.cycle_reset_time || q.resetTime);
    if (limit === -1) {
      st.primary = { key: "month", label: "本月 · 企业额度", usedPercent: 0, resetsAt: 0, windowMinutes: 0, detail: "不限量" };
      return st;
    }
    // 与 WorkBuddy 客户端一致：credit / used_num 都是「已用量」，剩余 = limitNum - credit
    const used = num(q, "credit", "used_num", "usedNum") || 0;
    const pct = limit > 0 ? (used / limit) * 100 : 0;
    st.primary = { key: "month", label: "本月 · 企业额度", usedPercent: Math.max(0, Math.min(100, pct)), resetsAt: reset, windowMinutes: 0, detail: `剩余 ${fmt(Math.max(0, limit - used))} / ${fmt(limit)}` };
    return st;
  } catch (e) {
    const msg = String((e && e.message) || "");
    if (e && (e.auth || e.status === 401 || e.html || /登录已失效|未登录/.test(msg))) {
      throw new NoLogin(manual ? "Access Token 无效或已过期（返回的是登录页）：请重新填写，或改用企业登录" : (loc.sso ? "WorkBuddy 企业账号未登录：在设置里点「企业登录（iOA）」。窗口空白说明 iOA 拦截了本程序，需给它授信" : "WorkBuddy 网页登录已过期：在设置里点「登录网页版」重新登录一次"));
    }
    throw e;
  }
}

function parseN(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v < 1e11 ? v * 1000 : v;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

const EXTRA_FETCHERS = { boxai: fetchBoxAI, tokendash: fetchTokenDash, workbuddy: fetchWorkBuddy };

module.exports = { EXTRA_DEFS, EXTRA_FETCHERS, localRtx, fmt, wbLocal, wbBase, setTdSessionReader };
