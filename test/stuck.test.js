"use strict";
// 刷新失败 / 卡住时：不再一直显示「正在更新…」，而是写清楚原因；卡住的请求 60 秒后放弃，之后照常重试
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const APP = process.argv[2] || path.join(__dirname, "..", "app");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "stuck-"));
process.env.HOME = HOME;
const { Store } = require(path.join(APP, "core/store"));
const { Engine } = require(path.join(APP, "core/engine"));
const P = require(path.join(APP, "core/providers"));
let pass = 0; const ok = (n) => { pass++; console.log("  ✓ " + n); };

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "stuck-d-"));
  const store = new Store(data);
  const eng = new Engine(store, {});
  eng.fetchTimeout = 300; // 测试里用 0.3 秒代替 60 秒
  // 模拟「上次保存的数据」：启动时显示，标记为 fromCache
  eng.status.codex = { ...eng.base(P.DEFS.find((d) => d.id === "codex"), "ok"), primary: { key: "5h", label: "当前会话", usedPercent: 88, resetsAt: Date.now() + 3600e3 }, headline: 88, fromCache: true, updatedAt: Date.now() - 120e3 };

  // 1) 刷新失败（被 Cloudflare 拦截）
  P.FETCHERS.codex = async () => { throw new Error(P.DEFS && "ChatGPT 在线接口被 Cloudflare 拦截，暂时显示上次的线上数据。恢复方法：设置 → Codex →「登录网页版」"); };
  await eng.refresh("codex");
  let s = eng.status.codex;
  assert.strictEqual(s.fromCache, false);
  assert.strictEqual(s.headline, 88);
  assert.ok(/Cloudflare/.test(s.lastErrorFull));
  ok("刷新失败：保留上次的数据，但不再标成「正在更新…」，记下原因（被 Cloudflare 拦截）");

  // 2) 请求卡住不返回：超时放弃，之后还能继续刷新
  P.FETCHERS.codex = () => new Promise(() => {});
  const t0 = Date.now();
  await eng.refresh("codex");
  assert.ok(Date.now() - t0 < 2000);
  assert.strictEqual(eng.sched.codex.inflight, false);
  assert.ok(/超时/.test(eng.status.codex.lastErrorFull));
  ok("请求卡住 → 超时放弃，不会永远停在「正在更新」");
  P.FETCHERS.codex = async () => ({ primary: { key: "5h", label: "当前会话", usedPercent: 42, resetsAt: Date.now() + 3600e3 } });
  await eng.refresh("codex");
  s = eng.status.codex;
  assert.strictEqual(s.state, "ok"); assert.strictEqual(Math.round(s.headline), 42); assert.ok(!s.lastError && !s.lagging);
  ok("网络恢复后照常更新，错误提示消失");
  console.log(`\n全部通过：${pass} 项`);
  process.exit(0);
})().catch((e) => { console.error("✗", e); process.exit(1); });
