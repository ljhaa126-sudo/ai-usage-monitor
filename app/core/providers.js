"use strict";
const fs = require("fs");
const path = require("path");
const { requestJSON, CHROME_UA } = require("./http");
const { home, readJSON, parseTime, num, clamp, titleCase, jwtClaims, NoLogin, appSupport } = require("./util");
const { claudeLocal, codexLocal, claudeDirs, codexHome } = require("./locallogs");
const { claudeCodeOAuth, cursorToken } = require("./secrets");

const DEFS = [
  { id: "claude", name: "Claude", short: "Claude", tagline: "Anthropic · 订阅额度", color: "#D97757", dashboard: "https://claude.ai/settings/usage", login: "https://claude.ai/login", keyKind: "可选：sessionKey 或 OAuth Token" },
  { id: "codex", name: "Codex", short: "Codex", tagline: "OpenAI · ChatGPT 套餐", color: "#3BE38B", dashboard: "https://chatgpt.com/codex/settings/usage", login: "https://chatgpt.com/auth/login", keyKind: "可选：Access Token" },
  { id: "cursor", name: "Cursor", short: "Cursor", tagline: "Cursor 编辑器 · 月度额度", color: "#8B8CF8", dashboard: "https://cursor.com/dashboard?tab=usage", login: "https://cursor.com/dashboard", keyKind: "可选：WorkosCursorSessionToken" },
  { id: "gemini", name: "Gemini CLI", short: "Gemini", tagline: "Google · 每日请求额度", color: "#4C8DF6", dashboard: "https://aistudio.google.com/usage" },
  { id: "copilot", name: "GitHub Copilot", short: "Copilot", tagline: "高级请求 · 每月重置", color: "#E8EAED", dashboard: "https://github.com/settings/copilot/features", keyKind: "可选：GitHub Token" },
  { id: "kimi", name: "Kimi Code", short: "Kimi", tagline: "Moonshot · Coding 套餐", color: "#F06B8A", dashboard: "https://www.kimi.com/code/console", keyKind: "API Key（必填）" },
  { id: "glm", name: "智谱 GLM", short: "GLM", tagline: "GLM Coding Plan", color: "#3E7BFA", dashboard: "https://bigmodel.cn/coding-plan/personal/usage", keyKind: "API Key（必填）" },
];

const W = (key, label, usedPercent, resetsAt, windowMinutes, detail) => ({ key, label, usedPercent: clamp(usedPercent), resetsAt: resetsAt || 0, windowMinutes: windowMinutes || 0, detail: detail || "" });

// ======================= Claude =======================
function claudeParse(st, d) {
  const win = (k, key, label, minutes) => {
    const m = d && d[k];
    if (!m || num(m, "utilization") == null) return null;
    return W(key, label, num(m, "utilization"), parseTime(m.resets_at), minutes);
  };
  st.primary = win("five_hour", "5h", "当前会话", 300);
  st.secondary = win("seven_day", "week", "所有模型 · 本周", 10080);
  st.extra = [];
  for (const [k, l] of [["seven_day_opus", "Opus · 本周"], ["seven_day_sonnet", "Sonnet · 本周"], ["seven_day_oauth_apps", "OAuth 应用 · 本周"]]) {
    const w = win(k, "week", l, 10080);
    if (w) st.extra.push(w);
  }
  const ex = d && d.extra_usage;
  if (ex && ex.is_enabled) {
    st.extra.push(W("month", "额外用量 · 本月", num(ex, "utilization") || 0, 0, 0, `$${((num(ex, "used_credits") || 0) / 100).toFixed(2)} / $${((num(ex, "monthly_limit") || 0) / 100).toFixed(2)}`));
  }
}

const SK_RE = /sk-ant-sid[0-9A-Za-z_\-]+/;

const webHeaders = (origin, extra = {}) => ({
  Origin: origin, Referer: origin + "/", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin", ...extra,
});

async function claudeWeb(st, ctx, cookieHeader, src) {
  const base = { headers: webHeaders("https://claude.ai", { "anthropic-client-platform": "web_claude_ai", ...(cookieHeader ? { Cookie: cookieHeader } : {}) }), session: ctx.webSession, useSessionCookies: !cookieHeader };
  let orgs;
  try {
    orgs = await requestJSON({ ...base, url: "https://claude.ai/api/organizations" });
  } catch (e) {
    if (e.auth) throw new NoLogin("Claude 网页登录已失效，请在设置里重新登录");
    if (e.html) throw new Error("claude.ai 拦截了请求（Cloudflare）。请在设置里点「登录 Claude 网页版」，在弹出的窗口里通过一次验证即可。");
    throw e;
  }
  if (!Array.isArray(orgs) || !orgs.length) throw new Error("这个 Claude 账号下没有组织信息");
  const org = orgs.find((o) => /claude_max|claude_pro|chat/.test(JSON.stringify(o.capabilities || []))) || orgs[0];
  const caps = JSON.stringify(org.capabilities || []);
  st.plan = caps.includes("claude_max") ? "Max" : caps.includes("claude_pro") ? "Pro" : caps.includes("raven") ? "Team" : "Free";
  const m = /(\d+)x/.exec(org.rate_limit_tier || "");
  if (m) st.plan += " " + m[1] + "x";
  if (org.name) st.account = String(org.name).replace(/['’]s Organization$/, "");
  const d = await requestJSON({ ...base, url: `https://claude.ai/api/organizations/${org.uuid}/usage` });
  st.source = src;
  claudeParse(st, d);
}

async function fetchClaude(cfg, ctx) {
  const st = { historyUnit: "M tokens" };
  const loc = claudeLocal();
  st.history = loc.series;
  st.daily = loc.daily;

  const manual = (cfg.apiKey || "").trim();
  if (manual) {
    const sk = SK_RE.exec(manual);
    if (sk) { await claudeWeb(st, ctx, "sessionKey=" + sk[0], "手动填写的 sessionKey"); return st; }
    await claudeOAuth(st, manual, "手动填写的 Token");
    return st;
  }

  let oauthErr = null;
  const oa = await claudeCodeOAuth(claudeDirs());
  if (oa) {
    const m = /(\d+)x/.exec(oa.rateLimitTier || "");
    st.plan = (titleCase(oa.subscriptionType || "") + (m ? " " + m[1] + "x" : "")).trim();
    try { await claudeOAuth(st, oa.accessToken, "Claude Code 登录"); return st; } catch (e) { oauthErr = e; }
  }

  if (ctx.webSession) {
    const cookies = await ctx.webSession.cookies.get({ url: "https://claude.ai", name: "sessionKey" });
    if (cookies.length) { await claudeWeb(st, ctx, null, "Claude 网页登录"); return st; }
  }
  if (oauthErr) throw oauthErr;
  throw new NoLogin("还没有连接 Claude。打开 设置 → Claude → 「登录 Claude 网页版」，登录一次即可；装了 Claude Code 的会自动识别。");
}

async function claudeOAuth(st, token, src) {
  try {
    const d = await requestJSON({ url: "https://api.anthropic.com/api/oauth/usage", headers: { Authorization: "Bearer " + token, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0", "Content-Type": "application/json" } });
    st.source = src;
    claudeParse(st, d);
  } catch (e) {
    if (e.auth) throw new NoLogin("Claude Code 的登录已过期：运行一次 claude 即可自动刷新");
    throw e;
  }
}

// ======================= Codex =======================
function codexWin(m, key, label) {
  if (!m || num(m, "used_percent") == null) return null;
  const w = W(key, label, num(m, "used_percent"), parseTime(m.reset_at), (num(m, "limit_window_seconds") || 0) / 60);
  if (!w.resetsAt && num(m, "reset_after_seconds") != null) w.resetsAt = Date.now() + num(m, "reset_after_seconds") * 1000;
  return fixLabel(w);
}

function codexLocalWin(m, ts, key, label) {
  if (!m || num(m, "used_percent") == null) return null;
  const w = W(key, label, num(m, "used_percent"), parseTime(m.resets_at), num(m, "window_minutes") || 0);
  if (!w.resetsAt && num(m, "resets_in_seconds") != null) w.resetsAt = ts + num(m, "resets_in_seconds") * 1000;
  if (w.resetsAt && w.resetsAt < Date.now()) {
    w.usedPercent = 0; // 快照已过重置点
    if (w.windowMinutes) while (w.resetsAt < Date.now()) w.resetsAt += w.windowMinutes * 60000;
  }
  return fixLabel(w);
}

function fixLabel(w) {
  const m = w.windowMinutes;
  if (!m) return w;
  if (w.key === "5h" && m <= 300) return w;
  if (w.key === "week" && m >= 10020) return w;
  w.label = m < 1440 ? `${Math.round(m / 60)} 小时` : `${Math.round(m / 1440)} 天`;
  return w;
}

let codexApiAt = 0;

// ---------- Codex 限额重置（banked rate-limit resets） ----------
// GET  /wham/usage                                  → rate_limit_reset_credits.available_count
// GET  /wham/rate-limit-reset-credits               → 每一次重置的标题 / 到期时间
// POST /wham/rate-limit-reset-credits/consume       → 使用一次重置
let codexResets = null; // { available, credits: [...], at }

// ---------- 请求 chatgpt.com：三种方式，记住能用的那个 ----------
// chatgpt.com 前面有 Cloudflare。「Chrome 网络栈 + codex_cli_rs 的 User-Agent」这种不一致的组合会被当成机器人，
// 返回 403 验证网页。依次尝试：
//   node-cli：Node 的 TLS（非浏览器指纹）+ Codex CLI 的请求头，和 Codex CLI 本身一样；经系统代理
//   web     ：Chromium + 完整浏览器请求头 + 「登录网页版」窗口留下的 Cookie（含 Cloudflare 验证通过的 cf_clearance）
//   net-cli ：旧做法（Chromium + Codex CLI 请求头），兜底
const CODEX_WAYS = ["node-cli", "web", "net-cli"];
const CODEX_CLI_UA = "codex_cli_rs/0.135.0";
let codexWay = null;          // 上次成功的方式
let codexBlockedUntil = 0;    // 三种方式都被拦时，先暂停在线查询，避免一直撞墙
let codexCtx = {};            // 最近一次刷新的上下文（webSession），给「重置」等操作复用
let codexLog = () => {};

function codexWayOpts(way, auth) {
  const base = { Authorization: "Bearer " + auth.token, Accept: "application/json" };
  if (auth.accountId) base["ChatGPT-Account-Id"] = auth.accountId;
  const cli = { ...base, "User-Agent": CODEX_CLI_UA, originator: "codex_cli_rs" };
  if (way === "node-cli") return { via: "node", headers: cli };
  if (way === "web") {
    const ws = codexCtx.webSession;
    return { headers: { ...base, "User-Agent": CHROME_UA, Origin: "https://chatgpt.com", Referer: "https://chatgpt.com/codex/settings/usage", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8", "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" }, session: ws, useSessionCookies: !!ws };
  }
  return { headers: cli };
}

const isBlocked = (e) => !!(e && e.html);                 // Cloudflare 验证页 / 网页
const isNetErr = (e) => !!(e && !e.status && !e.html && !e.auth);

async function codexReq(url, auth, extra = {}) {
  const order = codexWay ? [codexWay, ...CODEX_WAYS.filter((w) => w !== codexWay)] : CODEX_WAYS;
  let last = null;
  for (const way of order) {
    const o = codexWayOpts(way, auth);
    try {
      const d = await requestJSON({ url, ...o, ...extra, headers: { ...o.headers, ...(extra.headers || {}) } });
      if (codexWay !== way) codexLog(`[codex] 在线接口改用「${way}」方式成功`);
      codexWay = way;
      return d;
    } catch (e) {
      last = e;
      e.way = way;
      if (e.auth) throw e;                      // 401：令牌失效，换方式也没用
      if (!isBlocked(e) && !isNetErr(e)) throw e; // 429 等：交给上层退避
      codexLog(`[codex] 「${way}」方式失败：${String(e.message).slice(0, 80)}`);
    }
  }
  if (last && isBlocked(last)) last.cfBlocked = true;
  throw last;
}

// 没有 Codex CLI 登录、但用「登录网页版」登录过 chatgpt.com：用网页会话换一个访问令牌
async function codexWebToken() {
  const ws = codexCtx.webSession;
  if (!ws) return null;
  const ck = await ws.cookies.get({ url: "https://chatgpt.com", name: "__Secure-next-auth.session-token" });
  const ck2 = ck.length ? ck : await ws.cookies.get({ url: "https://chatgpt.com" }).then((a) => a.filter((c) => /session-token/.test(c.name)));
  if (!ck2.length) return null;
  try {
    const r = await requestJSON({ url: "https://chatgpt.com/api/auth/session", headers: { "User-Agent": CHROME_UA, Referer: "https://chatgpt.com/" }, session: ws, useSessionCookies: true });
    return r && r.accessToken ? { token: r.accessToken, accountId: (r.account && r.account.id) || "", email: (r.user && r.user.email) || "" } : null;
  } catch { return null; }
}

function codexAuth(cfg) {
  const auth = readJSON(path.join(codexHome(), "auth.json")) || {};
  const tk = auth.tokens || {};
  const token = ((cfg && cfg.apiKey) || "").trim() || tk.access_token;
  const h = { Authorization: "Bearer " + token, "User-Agent": "codex_cli_rs/0.135.0", originator: "codex_cli_rs" };
  if (tk.account_id) h["ChatGPT-Account-Id"] = tk.account_id;
  return { token, tk, headers: h };
}

const RESET_TITLES = [
  [/full reset|weekly\s*\+\s*5/i, "完全重置（每周 + 5 小时）"],
  [/weekly/i, "每周限额重置"],
  [/5\s*h(ou)?r/i, "5 小时限额重置"],
];
function resetTitle(t) {
  for (const [re, zh] of RESET_TITLES) if (re.test(t || "")) return zh;
  return t || "限额重置";
}

async function codexResetDetails(auth, available) {
  const out = { available: available || 0, credits: [], at: Date.now() };
  try {
    const r = await codexReq("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", auth);
    if (num(r, "available_count") != null) out.available = num(r, "available_count");
    out.credits = (r.credits || [])
      .filter((c) => c && c.id && (!c.status || c.status === "available"))
      .map((c) => ({ id: String(c.id), title: resetTitle(c.title), rawTitle: c.title || "", grantedAt: parseTime(c.granted_at), expiresAt: parseTime(c.expires_at) }))
      .sort((a, b) => (a.expiresAt || Infinity) - (b.expiresAt || Infinity));
  } catch { /* 详情接口失败时仍显示次数 */ }
  return out;
}

async function consumeCodexReset(cfg, creditId) {
  const { token, tk } = codexAuth(cfg);
  if (!token) throw new Error("没有检测到 Codex 登录");
  const auth = { token, accountId: tk.account_id || "" };
  const body = { redeem_request_id: require("crypto").randomUUID() };
  if (creditId) body.credit_id = creditId;
  let r;
  try {
    r = await codexReq("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume", auth, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    if (e.auth) throw new Error("Codex 登录已过期或账号不支持重置：运行一次 codex 刷新登录");
    throw e;
  }
  codexApiAt = 0;        // 下次刷新强制走在线接口，拿到重置后的最新用量
  codexResets = null;
  const code = String((r && r.code) || "");
  const nw = num(r, "windows_reset");
  const msg = { reset: nw ? `重置成功，已恢复 ${nw} 个限额窗口` : "重置成功", already_redeemed: "这次重置已经生效", nothing_to_reset: "当前没有需要重置的限额，本次重置已保留", no_credit: "没有可用的重置次数" }[code] || "已提交重置请求";
  return { ok: code === "reset" || code === "already_redeemed", code, message: msg };
}

async function fetchCodex(cfg, ctx) {
  codexCtx = ctx || {};
  if (codexCtx.log) codexLog = codexCtx.log;
  const st = { historyUnit: "M tokens" };
  const loc = codexLocal();
  st.history = loc.series;
  st.daily = loc.daily;
  if (codexResets) st.resets = codexResets;
  const auth = readJSON(path.join(codexHome(), "auth.json")) || {};
  const tk = auth.tokens || {};
  let token = (cfg.apiKey || "").trim() || tk.access_token;
  let accountId = tk.account_id || "";
  if (!token) {
    const w = await codexWebToken();
    if (w) { token = w.token; accountId = w.accountId; st.account = w.email; }
  }
  const cauth = { token, accountId };
  const claims = jwtClaims(tk.id_token || "");
  if (claims) {
    st.account = claims.email || "";
    const a = claims["https://api.openai.com/auth"] || {};
    if (a.chatgpt_plan_type) st.plan = titleCase(a.chatgpt_plan_type);
    if (a.chatgpt_subscription_active_until) st.planEndsAt = parseTime(a.chatgpt_subscription_active_until);
  }
  let apiErr = null;
  const localFresh = loc.rate && loc.rateTs > Date.now() - 120000;
  // 在线接口被 Cloudflare 拦着的这段时间：直接用本地会话日志（Codex 每次对话都会写，同样是实时的）
  const blocked = Date.now() < codexBlockedUntil;
  if ((localFresh && Date.now() - codexApiAt < 5 * 60000) || (blocked && loc.rate)) {
    st.source = localFresh ? "本地会话（实时）" : codexLocalSource(loc.rateTs);
    st.primary = codexLocalWin(loc.rate.primary, loc.rateTs, "5h", "当前会话");
    st.secondary = codexLocalWin(loc.rate.secondary, loc.rateTs, "week", "所有模型 · 本周");
    if (blocked) st.message = CF_NOTE;
    if (st.primary || st.secondary) return st;
  }
  if (token) {
    try {
      const d = await codexReq("https://chatgpt.com/backend-api/wham/usage", cauth);
      codexApiAt = Date.now();
      codexBlockedUntil = 0;
      st.source = "ChatGPT 在线接口";
      const rc = d.rate_limit_reset_credits;
      if (rc && num(rc, "available_count") != null) {
        const n = num(rc, "available_count");
        // 次数变化或缓存超过 10 分钟才重新拉详情
        if (!codexResets || codexResets.available !== n || Date.now() - codexResets.at > 10 * 60000) codexResets = n > 0 ? await codexResetDetails(cauth, n) : { available: 0, credits: [], at: Date.now() };
        st.resets = codexResets;
      }
      if (d.plan_type) st.plan = titleCase(d.plan_type);
      if (d.email) st.account = d.email;
      const rl = d.rate_limit || {};
      st.primary = codexWin(rl.primary_window, "5h", "当前会话");
      st.secondary = codexWin(rl.secondary_window, "week", "所有模型 · 本周");
      st.extra = [];
      for (const x of d.additional_rate_limits || []) {
        const n = x.limit_name || x.metered_feature || "其他";
        const r2 = x.rate_limit || {};
        const a = codexWin(r2.primary_window, "5h", n + " · 5 小时");
        const b = codexWin(r2.secondary_window, "week", n + " · 本周");
        if (a) st.extra.push(a);
        if (b) st.extra.push(b);
      }
      const cr = d.credits || {};
      if (cr.unlimited) st.credits = "无限额度";
      else if (cr.balance && cr.balance !== "0") st.credits = "余额 " + cr.balance + " credits";
      // 本地会话日志比在线接口更新得更快（每次对话立即写入），取较新的那个
      if (loc.rate && loc.rateTs > Date.now() - 20000) {
        const p = codexLocalWin(loc.rate.primary, loc.rateTs, "5h", "当前会话");
        const s = codexLocalWin(loc.rate.secondary, loc.rateTs, "week", "所有模型 · 本周");
        if (p) st.primary = p;
        if (s) st.secondary = s;
        st.source = "本地会话（实时）";
      }
      return st;
    } catch (e) {
      apiErr = e;
      // 三种方式都被 Cloudflare 拦：15 分钟内不再撞，期间用本地数据
      if (e.cfBlocked) { codexBlockedUntil = Date.now() + 15 * 60000; codexLog("[codex] 在线接口被 Cloudflare 拦截，15 分钟内改用本地会话日志"); }
    }
  }
  if (loc.rate) {
    st.source = codexLocalSource(loc.rateTs);
    st.primary = codexLocalWin(loc.rate.primary, loc.rateTs, "5h", "当前会话");
    st.secondary = codexLocalWin(loc.rate.secondary, loc.rateTs, "week", "所有模型 · 本周");
    if (st.primary || st.secondary) {
      // 有本地数据就正常显示，不算出错；只在详细面板里给一句说明
      if (apiErr) st.message = apiErr.cfBlocked ? CF_NOTE : "在线接口暂时连不上，正在使用本地会话日志（会自动重试）";
      return st;
    }
  }
  if (apiErr && apiErr.cfBlocked) throw new Error("chatgpt.com 拦截了请求（Cloudflare 验证）。请在设置 → Codex 点「登录网页版」，在弹出的窗口里登录并通过一次验证；用一次 Codex 后也会自动从本地日志读到用量。");
  if (!token) throw new NoLogin("没有检测到 Codex 登录（~/.codex/auth.json）。运行 codex 并用 ChatGPT 账号登录即可。");
  if (apiErr && apiErr.auth) throw new NoLogin("Codex 登录已过期：运行一次 codex 即可刷新");
  throw apiErr;
}

function codexLocalSource(ts) {
  const t = new Date(ts);
  return `本地会话日志（${t.getMonth() + 1}-${t.getDate()} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}）`;
}
const CF_NOTE = "ChatGPT 在线接口被 Cloudflare 拦截，正在使用本地会话日志（每次用 Codex 都会自动更新）。想恢复在线数据：设置 → Codex →「登录网页版」，通过一次验证即可。";

// ======================= Cursor =======================
async function fetchCursor(cfg, ctx) {
  const st = { historyUnit: "峰值 %" };
  let cookie = (cfg.apiKey || "").trim();
  let useSession = false;
  if (cookie) {
    if (!cookie.includes("=")) cookie = "WorkosCursorSessionToken=" + cookie;
    st.source = "手动填写的 Cookie";
  } else {
    const { token, found } = await cursorToken();
    if (token) {
      const c = jwtClaims(token) || {};
      const sub = String(c.sub || "").split("|").pop();
      if (sub && !(c.exp && c.exp * 1000 < Date.now())) {
        cookie = `WorkosCursorSessionToken=${sub}%3A%3A${token}`;
        st.source = "Cursor 本机登录";
      }
    }
    if (!cookie && ctx.webSession) {
      const ck = await ctx.webSession.cookies.get({ url: "https://cursor.com", name: "WorkosCursorSessionToken" });
      if (ck.length) { useSession = true; st.source = "Cursor 网页登录"; }
    }
    if (!cookie && !useSession) {
      throw new NoLogin(found ? "Cursor 令牌读取不到或已过期：打开一次 Cursor，或在设置里登录 Cursor 网页版" : "没有检测到 Cursor。可在设置里登录 Cursor 网页版");
    }
  }
  const req = (url) => requestJSON({ url, headers: webHeaders("https://cursor.com", cookie ? { Cookie: cookie } : {}), session: ctx.webSession, useSessionCookies: useSession });
  let d;
  try { d = await req("https://cursor.com/api/usage-summary"); } catch (e) {
    if (e.auth) throw new NoLogin("Cursor 登录无效，请重新登录 Cursor");
    throw e;
  }
  try { const me = await req("https://cursor.com/api/auth/me"); st.account = me.email || ""; } catch { /* 可选 */ }
  st.plan = titleCase(d.membershipType || "");
  st.planStartAt = parseTime(d.billingCycleStart);
  st.planEndsAt = parseTime(d.billingCycleEnd);
  const minutes = st.planStartAt && st.planEndsAt > st.planStartAt ? (st.planEndsAt - st.planStartAt) / 60000 : 0;
  const iu = d.individualUsage || {};
  const plan = iu.plan || {};
  let total = num(plan, "totalPercentUsed");
  if (total == null) { const u = num(plan, "used") || 0, l = num(plan, "limit") || 0; total = l > 0 ? (u / l) * 100 : 0; }
  st.secondary = W("month", "本月 · 套餐总额度", total, st.planEndsAt, minutes, num(plan, "limit") ? `$${((num(plan, "used") || 0) / 100).toFixed(2)} / $${(num(plan, "limit") / 100).toFixed(2)}` : "");
  st.extra = [];
  if (num(plan, "autoPercentUsed") != null) st.extra.push(W("month", "Auto 模型 · 本月", num(plan, "autoPercentUsed"), st.planEndsAt));
  if (num(plan, "apiPercentUsed") != null) st.extra.push(W("month", "API 模型 · 本月", num(plan, "apiPercentUsed"), st.planEndsAt));
  const od = iu.onDemand;
  if (od && od.enabled) {
    const used = num(od, "used") || 0, lim = num(od, "limit");
    st.extra.push(W("month", "按需用量", lim ? (used / lim) * 100 : 0, 0, 0, `$${(used / 100).toFixed(2)}` + (lim ? ` / $${(lim / 100).toFixed(2)}` : "")));
  }
  return st;
}

// ======================= Gemini CLI =======================
const GEMINI_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const GEMINI_SECRET = "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";
const gem = { token: "", exp: 0, project: "", tier: "" };

function geminiClient() {
  const roots = ["/opt/homebrew/lib/node_modules/@google/gemini-cli", "/usr/local/lib/node_modules/@google/gemini-cli", path.join(home(), ".npm-global/lib/node_modules/@google/gemini-cli")];
  if (process.env.APPDATA) roots.unshift(path.join(process.env.APPDATA, "npm", "node_modules", "@google", "gemini-cli"));
  const find = (dir, depth) => {
    if (depth > 7) return null;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === "oauth2.js") {
        const t = fs.readFileSync(p, "utf8");
        const a = /OAUTH_CLIENT_ID\s*=\s*['"]([\w\-.]+)['"]/.exec(t), b = /OAUTH_CLIENT_SECRET\s*=\s*['"]([\w\-]+)['"]/.exec(t);
        if (a && b) return [a[1], b[1]];
      } else if (e.isDirectory() && e.name !== ".bin") { const r = find(p, depth + 1); if (r) return r; }
    }
    return null;
  };
  for (const r of roots) { const v = find(r, 0); if (v) return v; }
  return [GEMINI_ID, GEMINI_SECRET];
}

async function fetchGemini() {
  const st = { historyUnit: "峰值 %" };
  const cr = readJSON(path.join(home(), ".gemini", "oauth_creds.json"));
  if (!cr || (!cr.access_token && !cr.refresh_token)) throw new NoLogin("没有检测到 Gemini CLI 的 Google 登录。运行 gemini 并选择 Login with Google 即可。");
  const c = jwtClaims(cr.id_token || "");
  if (c) st.account = c.email || "";
  let token = cr.access_token;
  if ((cr.expiry_date || 0) < Date.now() + 60000) {
    if (gem.token && gem.exp > Date.now() + 60000) token = gem.token;
    else {
      const [id, sec] = geminiClient();
      const body = new URLSearchParams({ client_id: id, client_secret: sec, refresh_token: cr.refresh_token, grant_type: "refresh_token" }).toString();
      try {
        const r = await requestJSON({ url: "https://oauth2.googleapis.com/token", method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
        token = gem.token = r.access_token; gem.exp = Date.now() + (r.expires_in || 3600) * 1000;
      } catch { throw new NoLogin("Gemini 令牌刷新失败：运行一次 gemini 即可"); }
    }
  }
  const gh = { Authorization: "Bearer " + token, "Content-Type": "application/json", "User-Agent": `GeminiCLI/0.12.0 (${process.platform}; ${process.arch})` };
  try {
    if (!gem.project) {
      const la = await requestJSON({ url: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", method: "POST", headers: gh, body: JSON.stringify({ metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }) });
      gem.project = typeof la.cloudaicompanionProject === "string" ? la.cloudaicompanionProject : (la.cloudaicompanionProject || {}).id || process.env.GOOGLE_CLOUD_PROJECT || "";
      gem.tier = ((la.paidTier || {}).name) || ((la.currentTier || {}).name) || titleCase((la.currentTier || {}).id || "");
    }
    st.plan = gem.tier;
    const q = await requestJSON({ url: "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", method: "POST", headers: gh, body: JSON.stringify({ project: gem.project }) });
    st.source = "Google OAuth";
    const by = {};
    for (const b of q.buckets || []) {
      const rf = num(b, "remainingFraction");
      if (rf == null) continue;
      const used = clamp((1 - rf) * 100);
      if (!by[b.modelId] || by[b.modelId].used < used) by[b.modelId] = { used, reset: parseTime(b.resetTime) };
    }
    const ws = Object.keys(by).sort().map((m) => W("day", "Gemini " + m.replace(/^gemini-/i, "").split("-").map((x) => (x ? x[0].toUpperCase() + x.slice(1) : x)).join(" ") + " · 今日", by[m].used, by[m].reset, 1440));
    const pick = (re, ex) => ws.filter((w) => re.test(w.label) && !(ex && ex.test(w.label))).sort((a, b) => b.usedPercent - a.usedPercent)[0];
    st.primary = pick(/pro/i) || ws[0] || null;
    st.secondary = pick(/flash/i, /lite/i) || null;
    st.extra = ws.filter((w) => w !== st.primary && w !== st.secondary);
    return st;
  } catch (e) {
    if (e.auth) throw new NoLogin("Gemini 登录已失效，请运行 gemini 重新登录");
    throw e;
  }
}

// ======================= GitHub Copilot =======================
function copilotDiskToken() {
  const dirs = [path.join(home(), ".config", "github-copilot")];
  if (process.env.LOCALAPPDATA) dirs.unshift(path.join(process.env.LOCALAPPDATA, "github-copilot"));
  for (const f of dirs.flatMap((d) => ["apps.json", "hosts.json"].map((n) => path.join(d, n)))) {
    const j = readJSON(f);
    if (!j) continue;
    for (const [k, v] of Object.entries(j)) if (k.startsWith("github.com") && v && v.oauth_token) return v.oauth_token;
  }
  return "";
}

async function fetchCopilot(cfg) {
  const st = { historyUnit: "峰值 %" };
  let token = (cfg.apiKey || "").trim();
  st.source = "手动填写的 Token";
  if (!token) { token = copilotDiskToken(); st.source = "Copilot 插件登录"; }
  if (!token) throw new NoLogin("没有找到 Copilot 令牌。可在设置里填 GitHub Token（终端运行 gh auth token 可获得）。");
  let d;
  try {
    d = await requestJSON({ url: "https://api.github.com/copilot_internal/user", headers: { Authorization: "token " + token, "Editor-Version": "vscode/1.99.0", "Editor-Plugin-Version": "copilot-chat/0.26.7", "User-Agent": "GitHubCopilotChat/0.26.7", "X-Github-Api-Version": "2025-04-01" } });
  } catch (e) { if (e.auth) throw new NoLogin("GitHub Token 无效或没有 Copilot 权限"); throw e; }
  st.plan = titleCase(d.copilot_plan || "");
  st.account = d.login || "";
  const reset = parseTime(d.quota_reset_date_utc) || parseTime(d.quota_reset_date);
  st.planEndsAt = reset;
  const snaps = d.quota_snapshots || {};
  const mk = (k, label) => {
    const m = snaps[k];
    if (!m) return null;
    if (m.unlimited) return W("month", label, 0, reset, 0, "不限");
    const pr = num(m, "percent_remaining");
    if (pr == null) return null;
    const ent = num(m, "entitlement") || 0, rem = num(m, "remaining") || 0;
    return W("month", label, 100 - pr, reset, 0, ent ? `已用 ${Math.round(ent - rem)} / ${Math.round(ent)}` : "");
  };
  st.secondary = mk("premium_interactions", "高级请求 · 本月");
  st.extra = [mk("chat", "Chat · 本月"), mk("completions", "代码补全 · 本月")].filter(Boolean);
  if (!st.secondary && st.extra.length) st.secondary = st.extra.shift();
  return st;
}

// ======================= Kimi =======================
async function fetchKimi(cfg) {
  const st = { historyUnit: "峰值 %" };
  const key = (cfg.apiKey || "").trim() || process.env.KIMI_API_KEY;
  if (!key) throw new NoLogin("在设置里填写 Kimi Code 的 API Key（kimi.com/code 控制台创建）");
  let d;
  try { d = await requestJSON({ url: "https://api.kimi.com/coding/v1/usages", headers: { Authorization: "Bearer " + key } }); } catch (e) { if (e.auth) throw new NoLogin("Kimi API Key 无效"); throw e; }
  st.source = "Kimi API";
  const lv = ((d.user || {}).membership || {}).level;
  if (lv) st.plan = titleCase(String(lv).replace(/^LEVEL_/, "").toLowerCase());
  const dw = (o, key, label) => {
    if (!o) return null;
    const lim = num(o, "limit") || 0;
    let used = num(o, "used");
    if (used == null && num(o, "remaining") != null) used = lim - num(o, "remaining");
    if (!lim) return null;
    return W(key, label, (used / lim) * 100, parseTime(o.resetTime || o.reset_time || o.resetAt), 0, `已用 ${Math.round(used)} / ${Math.round(lim)}`);
  };
  const wk = dw(d.usage, "week", "所有模型 · 本周");
  if (wk) { wk.windowMinutes = 10080; st.secondary = wk; }
  st.extra = [];
  for (const it of d.limits || []) {
    const wd = it.window || {};
    const dur = num(wd, "duration") || 0, unit = String(wd.timeUnit || "").toUpperCase();
    const minutes = unit.includes("HOUR") ? dur * 60 : unit.includes("DAY") ? dur * 1440 : unit.includes("SECOND") ? dur / 60 : dur;
    const w = dw(it.detail, "5h", minutes === 300 ? "当前会话" : minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`);
    if (!w) continue;
    w.windowMinutes = minutes;
    if (!st.primary && minutes <= 600) st.primary = w; else st.extra.push(w);
  }
  const pools = d.usages;
  if (pools) {
    const r = (k, key, label, mins) => {
      const p = pools[k];
      if (!p || num(p, "used_ratio") == null) return null;
      let v = num(p, "used_ratio"); if (v <= 1) v *= 100;
      return W(key, label, v, parseTime(p.reset_time), mins);
    };
    st.primary ||= r("limit_5h", "5h", "当前会话", 300);
    st.secondary ||= r("limit_7d", "week", "所有模型 · 本周", 10080);
  }
  if (!st.primary && !st.secondary) throw new Error("Kimi 返回了无法识别的用量格式");
  return st;
}

// ======================= 智谱 GLM =======================
async function fetchGLM(cfg) {
  const st = { historyUnit: "峰值 %" };
  const key = (cfg.apiKey || "").trim();
  if (!key) throw new NoLogin("在设置里填写智谱 GLM Coding Plan 的 API Key");
  const base = cfg.region === "global" ? "https://api.z.ai" : "https://open.bigmodel.cn";
  if (cfg.region === "global") st.dashboard = "https://z.ai/manage-apikey/coding-plan/personal/my-plan";
  let d;
  try { d = await requestJSON({ url: base + "/api/monitor/usage/quota/limit", headers: { Authorization: key, "Accept-Language": "zh-CN,zh" } }); } catch (e) { if (e.auth) throw new NoLogin("GLM API Key 无效"); throw e; }
  st.source = "智谱开放平台";
  const data = d.data || d;
  if (data.level) st.plan = titleCase(data.level);
  st.extra = [];
  for (const m of data.limits || []) {
    const pct = num(m, "percentage");
    if (pct == null) continue;
    const typ = String(m.type || "").toUpperCase(), unit = num(m, "unit");
    const cur = num(m, "currentValue"), tot = num(m, "usage");
    const w = W("other", typ, pct, parseTime(m.nextResetTime), 0, cur != null && tot ? `已用 ${cur} / ${tot}` : "");
    if (typ === "TOKENS_LIMIT" && unit === 3) Object.assign(w, { key: "5h", label: "当前会话", windowMinutes: 300 }), (st.primary = w);
    else if (typ === "TOKENS_LIMIT" && unit === 6) Object.assign(w, { key: "week", label: "所有模型 · 本周", windowMinutes: 10080 }), (st.secondary = w);
    else if (typ === "TIME_LIMIT") Object.assign(w, { key: "month", label: "MCP 工具调用 · 本月" }), st.extra.push(w);
    else st.extra.push(w);
  }
  if (!st.primary && !st.secondary && !st.extra.length) throw new Error("GLM 返回了无法识别的用量格式");
  return st;
}

const FETCHERS = { claude: fetchClaude, codex: fetchCodex, cursor: fetchCursor, gemini: fetchGemini, copilot: fetchCopilot, kimi: fetchKimi, glm: fetchGLM };

const RESETTERS = { codex: consumeCodexReset };

// 给「对话完成提醒」用：拿 ChatGPT 访问令牌（优先网页登录，其次 Codex 登录），并用同样的防拦截方式请求
async function chatgptAuth(ctx) {
  if (ctx && ctx.webSession) codexCtx = { ...codexCtx, webSession: ctx.webSession };
  const w = await codexWebToken().catch(() => null);
  if (w) return { token: w.token, accountId: w.accountId };
  const tk = (readJSON(path.join(codexHome(), "auth.json")) || {}).tokens || {};
  return tk.access_token ? { token: tk.access_token, accountId: tk.account_id || "" } : null;
}
function chatgptReq(url, auth) { return codexReq(url, auth); }

// 登录网页版 / 手动刷新后：立即重新尝试在线接口（不用等 15 分钟）
function resetCodexBlock() { codexBlockedUntil = 0; codexApiAt = 0; codexWay = null; }

module.exports = { DEFS, FETCHERS, RESETTERS, resetCodexBlock, chatgptAuth, chatgptReq, webHeaders, SK_RE };
