"use strict";
// Codex 重置详情保存到本机：连不上 ChatGPT 时也逐条显示到期时间
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const APP = process.argv[2] || path.join(__dirname, "..", "app");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
process.env.CODEX_HOME = tmp;
fs.writeFileSync(path.join(tmp, "auth.json"), JSON.stringify({ tokens: { access_token: "tok", account_id: "acc" } }));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rsd-"));
let pass = 0; const ok = (n) => { pass++; console.log("  ✓ " + n); };
const load = () => { for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(APP, "core"))) delete require.cache[k]; return { http: require(path.join(APP, "core/http.js")), prov: require(path.join(APP, "core/providers.js")) }; };
const day = 864e5, now = Date.now();
const usage = { plan_type: "plus", rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 3600 } }, rate_limit_reset_credits: { available_count: 2 } };
const credits = { available_count: 2, credits: [
  { id: "c2", title: "full_reset", status: "available", granted_at: new Date(now - 2 * day).toISOString(), expires_at: new Date(now + 30 * day).toISOString() },
  { id: "c1", title: "full_reset", status: "available", granted_at: new Date(now - 3 * day).toISOString(), expires_at: new Date(now + 29 * day).toISOString() } ] };
const J = (o) => ({ status: 200, headers: {}, text: JSON.stringify(o) });
const timeout = () => { throw new Error("连接 chatgpt.com 超时，请检查网络或代理"); };

(async () => {
  // 1) 第一次联网成功：逐条拿到详情，并保存到本机
  let { http, prov } = load();
  http.setTransport(async (o) => (o.url.includes("reset-credits") ? J(credits) : J(usage)));
  let st = await prov.FETCHERS.codex({}, { dataDir });
  assert.deepStrictEqual(st.resets.credits.map((c) => c.id), ["c1", "c2"]); // 按到期先后
  assert.ok(fs.existsSync(path.join(dataDir, "codex-resets.json")));
  ok("联网成功：逐条读到每次重置的到期时间，并保存到本机");

  // 2) 重启后：用量接口通，但详情接口超时 → 用本机保存的
  ({ http, prov } = load());
  http.setTransport(async (o) => (o.url.includes("reset-credits") ? timeout() : J(usage)));
  st = await prov.FETCHERS.codex({}, { dataDir });
  assert.strictEqual(st.resets.credits.length, 2); assert.ok(st.resets.cached);
  ok("详情接口超时 → 仍然逐条显示（上次读取）");

  // 3) 整个连不上（超时）→ 刷新失败，但带上本机保存的详情给界面
  ({ http, prov } = load());
  http.setTransport(async () => timeout());
  const err = await prov.FETCHERS.codex({}, { dataDir }).then(() => null, (e) => e);
  assert.ok(err && /超时/.test(err.message));
  assert.strictEqual(err.patch.resets.credits.length, 2);
  ok("完全连不上 → 界面仍能逐条显示每次重置的到期时间");

  // 4) 已经过期的不再显示
  const f = path.join(dataDir, "codex-resets.json");
  const j = JSON.parse(fs.readFileSync(f, "utf8")); j.credits[0].expiresAt = now - 1000; fs.writeFileSync(f, JSON.stringify(j));
  ({ http, prov } = load());
  http.setTransport(async () => timeout());
  const err2 = await prov.FETCHERS.codex({}, { dataDir }).then(() => null, (e) => e);
  assert.strictEqual(err2.patch.resets.credits.length, 1);
  ok("本机保存的里已过期的自动去掉");

  // 5) 引擎：失败时把本机保存的详情补到旧数据上
  const { Store } = require(path.join(APP, "core/store"));
  const { Engine } = require(path.join(APP, "core/engine"));
  const eng = new Engine(new Store(fs.mkdtempSync(path.join(os.tmpdir(), "rse-"))), { dataDir });
  eng.status.codex = { ...eng.base(prov.DEFS.find((d) => d.id === "codex"), "ok"), primary: { key: "5h", label: "当前会话", usedPercent: 50 }, resets: { available: 2, credits: [] }, fromCache: true, updatedAt: now - 60e3 };
  prov.FETCHERS.codex = async () => { throw err; };
  await eng.refresh("codex");
  assert.strictEqual(eng.status.codex.resets.credits.length, 2);
  ok("界面上：连不上时显示「可用重置 2 次」+ 每次的到期时间");
  console.log(`\n全部通过：${pass} 项`);
  process.exit(0);
})().catch((e) => { console.error("✗", e); process.exit(1); });
