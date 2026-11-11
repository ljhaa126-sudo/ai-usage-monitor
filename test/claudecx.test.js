"use strict";
// v1.7.14：Claude 限额重置逐条显示 + Codex 被 Cloudflare 拦时改用本机 Codex 程序读取
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const APP = process.argv[2] || path.join(__dirname, "..", "app");
const H = fs.mkdtempSync(path.join(os.tmpdir(), "ccx-"));
process.env.HOME = H; process.env.USERPROFILE = H;
delete process.env.CLAUDE_CONFIG_DIR;
process.env.CODEX_HOME = path.join(H, ".codex");
fs.mkdirSync(path.join(H, ".claude"), { recursive: true });
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
fs.writeFileSync(path.join(H, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "oat", subscriptionType: "max", rateLimitTier: "default_claude_max_5x" } }));
fs.writeFileSync(path.join(H, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: "org-1" } }));
fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({ tokens: { access_token: "tok", account_id: "acc" } }));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccxd-"));
let pass = 0; const ok = (n) => { pass++; console.log("  ✓ " + n); };
const load = () => { for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(APP, "core"))) delete require.cache[k]; return { http: require(path.join(APP, "core/http.js")), prov: require(path.join(APP, "core/providers.js")) }; };
const day = 864e5, now = Date.now();
const J = (o) => ({ status: 200, headers: {}, text: JSON.stringify(o) });
const usage = { five_hour: { utilization: 40, resets_at: new Date(now + 3600e3).toISOString() }, seven_day: { utilization: 20, resets_at: new Date(now + 3 * day).toISOString() } };
const ember = { eligible: true, at_limit: false, grants: [
  { id: "wk", label: "Weekly limit reset", type: "weekly", resets_total: 1, resets_left: 1, ends_at: new Date(now + 20 * day).toISOString(), usable_now: false, use_requires_limit: true, clears: [], blocking: [] },
  { id: "s5", label: "5-hour limit reset", type: "session", resets_total: 2, resets_left: 2, ends_at: new Date(now + 5 * day).toISOString(), usable_now: true, use_requires_limit: false, clears: [], blocking: [] },
  { id: "old", label: "x", type: "full", resets_total: 1, resets_left: 1, ends_at: new Date(now - day).toISOString(), usable_now: true } ] };
// 用户截图里的真实情况：一个完全重置 + 一个 Fable 重置（Fable 的 type 也是 full）
const ember2 = { eligible: true, grants: [
  { id: "full1", label: "Full reset", type: "full", resets_left: 1, ends_at: new Date(now + 30 * day).toISOString(), usable_now: true, clears: ["five_hour", "seven_day"] },
  { id: "fab1", label: "Fable reset", type: "full", resets_left: 1, ends_at: new Date(now + 6 * day).toISOString(), usable_now: true, gives_back_weekly: true } ] };
const ember3 = { eligible: true, grants: [ // 名字里没写 Fable，只靠字段判断
  { id: "f2", label: "Limit reset", type: "full", resets_left: 1, usable_now: true, clears: ["five_hour", "seven_day_omelette"] },
  { id: "f3", label: "Limit reset", type: "full", resets_left: 1, usable_now: true, gives_back_weekly: true } ] };

(async () => {
  // 1) Claude：带 cedar_ember=1 读到每一次重置
  let { http, prov } = load();
  let seen = [];
  http.setTransport(async (o) => { seen.push(o); if (o.method === "POST") return J({ result: "reset", resets_left: 1 }); return J(o.url.includes("cedar_ember=1") ? { ...usage, cedar_ember: ember } : usage); });
  let st = await prov.FETCHERS.claude({}, { dataDir });
  assert.ok(seen[0].url.includes("/api/oauth/usage?cedar_ember=1"));
  assert.ok(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/.test(seen[0].headers["User-Agent"]));
  assert.strictEqual(st.primary.usedPercent, 40);
  assert.strictEqual(st.resets.available, 3);
  assert.deepStrictEqual(st.resets.credits.map((c) => c.title), ["5 小时限额重置", "5 小时限额重置", "每周限额重置"]);
  assert.strictEqual(st.resets.credits[2].locked, "用满后可用");
  assert.ok(!st.resets.credits[0].locked);
  assert.ok(fs.existsSync(path.join(dataDir, "claude-resets.json")));
  ok("Claude：逐条读到每次重置（类型 + 到期时间），过期的不显示，用满才能用的标出来");

  // 2) 立即重置：发到 reset_rate_limits，带组织和 grant
  seen = [];
  const r = await prov.RESETTERS.claude({}, "s5");
  const post = seen.find((o) => o.method === "POST");
  assert.ok(post.url.endsWith("/api/organizations/org-1/reset_rate_limits"));
  const body = JSON.parse(post.body);
  assert.strictEqual(body.program, "cedar_ember"); assert.strictEqual(body.grant_id, "s5"); assert.ok(body.request_id);
  assert.ok(r.ok && /成功/.test(r.message));
  ok("Claude：「立即重置」用对应的那一次");

  // 3) 接口不认参数（400）→ 退回普通读法，重置用本机保存的
  ({ http, prov } = load());
  http.setTransport(async (o) => (o.url.includes("cedar_ember") ? { status: 400, headers: {}, text: "{\"error\":\"bad\"}" } : J(usage)));
  st = await prov.FETCHERS.claude({}, { dataDir });
  assert.strictEqual(st.primary.usedPercent, 40);
  assert.strictEqual(st.resets.credits.length, 3); assert.ok(st.resets.cached);
  ok("接口不支持时用量照常，重置显示上次读取的");

  // 4) 连不上 → 错误里带上本机保存的重置
  ({ http, prov } = load());
  http.setTransport(async () => { throw new Error("连接超时"); });
  const err = await prov.FETCHERS.claude({}, { dataDir }).then(() => null, (e) => e);
  assert.strictEqual(err.patch.resets.credits.length, 3);
  ok("Claude 连不上时仍能显示每次重置");

  // 5) 没有重置 → 0 次
  ({ http, prov } = load());
  http.setTransport(async () => J({ ...usage, cedar_ember: { eligible: false, ineligible_reason: "no_grant" } }));
  st = await prov.FETCHERS.claude({}, { dataDir });
  assert.strictEqual(st.resets.available, 0);
  ok("没有重置时显示 0 次");

  // 5b) Fable 重置不能算成完全重置
  ({ http, prov } = load());
  http.setTransport(async () => J({ ...usage, cedar_ember: ember2 }));
  st = await prov.FETCHERS.claude({}, { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ccxf-")) });
  assert.deepStrictEqual(st.resets.credits.map((c) => c.kind), ["fable", "full"]);
  assert.strictEqual(st.resets.credits[0].title, "Fable 重置");
  assert.strictEqual(st.resets.credits[1].title, "完全重置（每周 + 5 小时）");
  assert.ok(/不会重置每周总限额/.test(st.resets.credits[0].desc));
  http.setTransport(async () => J({ ...usage, cedar_ember: ember3 }));
  st = await prov.FETCHERS.claude({}, { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ccxf-")) });
  assert.deepStrictEqual(st.resets.credits.map((c) => c.kind), ["fable", "fable"]);
  ok("Fable 重置单独显示（即使接口把类型标成 full），不算进完全重置");

  // 6) Codex：chatgpt.com 被 Cloudflare 拦 → 改用本机 Codex 程序（app-server）
  const fake = path.join(H, "fake-codex.js");
  fs.writeFileSync(fake, `#!${process.execPath}
let buf = "";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  if (m.method === "initialize") out({ id: m.id, result: { userAgent: "x" } });
  else if (m.method === "account/rateLimits/read") out({ id: m.id, result: { rateLimits: { limitId: "codex", primary: { usedPercent: 33, windowDurationMins: 300, resetsAt: ${Math.floor(now / 1000) + 3600} }, secondary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: ${Math.floor(now / 1000) + 86400 * 4} }, planType: "plus" },
     rateLimitResetCredits: { availableCount: 1, credits: [{ id: "cr1", resetType: "codexRateLimits", status: "available", grantedAt: ${Math.floor(now / 1000) - 86400}, expiresAt: ${Math.floor(now / 1000) + 86400 * 9}, title: "Full reset" }] } } });
  else if (m.method === "account/rateLimitResetCredit/consume") out({ id: m.id, result: { outcome: m.params && m.params.creditId === "cr1" && m.params.idempotencyKey ? "reset" : "noCredit" } });
} });
`);
  fs.chmodSync(fake, 0o755);
  process.env.AIMON_CODEX_BIN = fake;
  ({ http, prov } = load());
  http.setTransport(async () => ({ status: 403, headers: { "content-type": "text/html" }, text: "<html>Just a moment...</html>" }));
  st = await prov.FETCHERS.codex({}, { dataDir });
  assert.strictEqual(st.primary.usedPercent, 33);
  assert.strictEqual(st.secondary.usedPercent, 9);
  assert.ok(/本机 Codex 程序/.test(st.source));
  assert.strictEqual(st.resets.available, 1);
  assert.strictEqual(st.resets.credits[0].title, "完全重置（每周 + 5 小时）");
  assert.ok(st.resets.credits[0].expiresAt > now + 8 * day);
  ok("Codex 被 Cloudflare 拦 → 用本机 Codex 程序读到线上额度和每次重置");

  // 7) 之后 30 分钟优先走本机程序（不再先撞墙）
  let hits = 0;
  http.setTransport(async () => { hits++; return { status: 403, headers: { "content-type": "text/html" }, text: "<html></html>" }; });
  st = await prov.FETCHERS.codex({}, { dataDir });
  assert.strictEqual(st.primary.usedPercent, 33); assert.strictEqual(hits, 0);
  ok("之后优先走本机 Codex 程序");

  // 8) 重置也能经本机程序执行
  const rr = await prov.RESETTERS.codex({}, "cr1");
  assert.ok(rr.ok, JSON.stringify(rr));
  ok("Codex「立即重置」在被拦时经本机程序执行");

  // 9) 没装 Codex 程序：仍然报 Cloudflare 原因
  process.env.AIMON_CODEX_BIN = path.join(H, "nope");
  ({ http, prov } = load());
  http.setTransport(async () => ({ status: 403, headers: { "content-type": "text/html" }, text: "<html></html>" }));
  const e2 = await prov.FETCHERS.codex({}, { dataDir }).then(() => null, (e) => e);
  assert.ok(e2 && /Cloudflare/.test(e2.message), e2 && e2.message);
  ok("没有本机 Codex 程序时照旧提示原因");

  console.log(`claudecx: ${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
