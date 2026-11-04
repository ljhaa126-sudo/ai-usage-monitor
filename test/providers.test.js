const fs = require("fs"), path = require("path"), os = require("os");
const HOME = "/tmp/machome"; fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
const W = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (c) => `${b64({ alg: "HS256" })}.${b64(c)}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;
const now = Date.now(), iso = (ms) => new Date(ms).toISOString();

W(`${HOME}/.claude/.credentials.json`, JSON.stringify({ claudeAiOauth: { accessToken: "oat", subscriptionType: "max", rateLimitTier: "default_claude_max_20x" } }));
let cl = ""; for (let i = 0; i < 4; i++) { const l = JSON.stringify({ timestamp: iso(now - i * 864e5), requestId: "r" + i, message: { id: "m" + i, usage: { input_tokens: 1000, output_tokens: 500000 * (i + 1), cache_read_input_tokens: 2e6 } } }); cl += l + "\n" + l + "\n"; }
W(`${HOME}/.claude/projects/p/a.jsonl`, cl);
W(`${HOME}/.codex/auth.json`, JSON.stringify({ tokens: { access_token: "tok", account_id: "acc", id_token: jwt({ email: "x@y.z", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }) } }));
W(`${HOME}/.codex/sessions/2026/11/02/r.jsonl`, JSON.stringify({ timestamp: iso(now), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 1e6 }, last_token_usage: { total_tokens: 1e6 } }, rate_limits: { primary: { used_percent: 55, window_minutes: 300, resets_in_seconds: 1000 }, secondary: { used_percent: 20, window_minutes: 10080, resets_in_seconds: 2e5 } } } }) + "\n");
const cj = jwt({ sub: "auth0|user_ABC", exp: Math.floor(now / 1000) + 86400 });
const dbdir = os.platform() === "darwin" ? `${HOME}/Library/Application Support` : `${HOME}/.config`;
W(`${dbdir}/Cursor/User/globalStorage/state.vscdb`, Buffer.concat([Buffer.alloc(300, 1), Buffer.from("cursorAuth/accessToken"), Buffer.from([0x03]), Buffer.from(cj), Buffer.alloc(50, 0)]));
W(`${HOME}/.config/github-copilot/apps.json`, JSON.stringify({ "github.com:Iv1": { oauth_token: "gho" } }));
W(`${HOME}/.gemini/oauth_creds.json`, JSON.stringify({ access_token: "old", refresh_token: "rt", expiry_date: 1 }));

const http = require("../app/core/http");
const R = (o) => ({ status: 200, headers: {}, text: JSON.stringify(o) });
const rs = iso(now + 2 * 36e5);
let fail = null;
http.setTransport(async ({ url }) => {
  if (fail && fail.test(url)) return { status: 401, headers: {}, text: "{}" };
  if (url.includes("oauth/usage") || url.includes("org-1/usage")) return R({ five_hour: { utilization: 73, resets_at: iso(now + 51 * 6e4) }, seven_day: { utilization: 7, resets_at: iso(now + 80 * 36e5) }, seven_day_opus: { utilization: 3, resets_at: null } });
  if (url.endsWith("claude.ai/api/organizations")) return R([{ uuid: "org-1", name: "me@x.com's Organization", capabilities: ["chat", "claude_max"], rate_limit_tier: "default_claude_max_5x" }]);
  if (url.includes("wham/usage")) return R({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 21, limit_window_seconds: 18000, reset_after_seconds: 3600 }, secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_after_seconds: 3e5 } } });
  if (url.includes("usage-summary")) return R({ billingCycleStart: iso(now - 10 * 864e5), billingCycleEnd: iso(now + 20 * 864e5), membershipType: "pro", individualUsage: { plan: { used: 400, limit: 2000, totalPercentUsed: 20, autoPercentUsed: 2, apiPercentUsed: 0 } } });
  if (url.includes("auth/me")) return R({ email: "me@cursor.dev" });
  if (url.includes("copilot_internal")) return R({ login: "octo", copilot_plan: "individual", quota_reset_date: "2026-12-01", quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 210, percent_remaining: 70 }, chat: { unlimited: true } } });
  if (url.includes("kimi.com")) return R({ usage: { limit: "100", used: "35", resetTime: rs }, limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", used: "60", resetTime: rs } }] });
  if (url.includes("quota/limit")) return R({ data: { level: "pro", limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 33, nextResetTime: now + 3e6 }, { type: "TOKENS_LIMIT", unit: 6, percentage: 8 }, { type: "TIME_LIMIT", percentage: 2, currentValue: 20, usage: 1000 }] } });
  if (url.includes("loadCodeAssist")) return R({ cloudaicompanionProject: "p1", currentTier: { name: "Gemini Code Assist" } });
  if (url.includes("retrieveUserQuota")) return R({ buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0.48, resetTime: rs }, { modelId: "gemini-2.5-flash", remainingFraction: 0.9, resetTime: rs }] });
  if (url.includes("oauth2.googleapis")) return R({ access_token: "ya29", expires_in: 3600 });
  return { status: 404, headers: {}, text: "nf" };
});

const { FETCHERS } = require("../app/core/providers");
const ctx = { webSession: { cookies: { get: async () => [] } } };
const brief = (s) => JSON.stringify({ plan: s.plan, acc: s.account, src: s.source, p: s.primary && [s.primary.label, Math.round(s.primary.usedPercent), !!s.primary.resetsAt], s: s.secondary && [s.secondary.label, Math.round(s.secondary.usedPercent)], x: (s.extra || []).map((w) => w.label), h: s.history && s.history.map((d) => +d.value.toFixed(2)) });
(async () => {
  for (const [id, f] of Object.entries(FETCHERS)) {
    const cfg = { apiKey: id === "kimi" || id === "glm" ? "k" : "", region: "cn" };
    try { console.log(id.padEnd(8), "OK ", brief(await f(cfg, ctx))); } catch (e) { console.log(id.padEnd(8), "ERR", e.noLogin ? "[nologin]" : "", e.message); }
  }
  // Codex 在线接口 401 -> 本地日志
  fail = /wham/;
  try { console.log("codex-fb", "OK ", brief(await FETCHERS.codex({}, ctx))); } catch (e) { console.log("codex-fb ERR", e.message); }
  // Claude 网页会话（登录窗口留下的 Cookie）
  fail = /oauth\/usage/;
  fs.rmSync(`${HOME}/.claude/.credentials.json`);
  const web = { webSession: { cookies: { get: async ({ name }) => (name === "sessionKey" ? [{ value: "x" }] : []) } } };
  try { console.log("claude-web", "OK ", brief(await FETCHERS.claude({}, web))); } catch (e) { console.log("claude-web ERR", e.message); }
  try { await FETCHERS.claude({}, ctx); } catch (e) { console.log("claude-none", e.noLogin ? "[nologin]" : "", e.message); }
  // 引擎
  const { Store } = require("../app/core/store");
  const { Engine } = require("../app/core/engine");
  fail = null;
  const store = new Store("/tmp/machome/data");
  const eng = new Engine(store, ctx);
  let n = 0; eng.on("update", () => n++);
  eng.tick();
  await new Promise((r) => setTimeout(r, 800));
  console.log("engine updates:", n, eng.list().map((s) => `${s.id}:${s.state}:${Math.round(s.headline)}`).join(" "));
  process.exit(0);
})();
