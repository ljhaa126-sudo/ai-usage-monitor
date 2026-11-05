"use strict";
// Copilot：没用过的免费版不显示；DeepSeek：从更多工具 / 客户端找 Key，多个候选逐个验证
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const APP = process.argv[2] || path.join(__dirname, "..", "app");
const H = fs.mkdtempSync(path.join(os.tmpdir(), "d2-"));
process.env.AIMON_DETECT_HOME = H;
process.env.XDG_CONFIG_HOME = path.join(H, ".config");
delete process.env.DEEPSEEK_API_KEY;
const http = require(path.join(APP, "core/http.js"));
const P = require(path.join(APP, "core/providers.js"));
const D = require(path.join(APP, "core/detect.js"));
let pass = 0; const ok = (n) => { pass++; console.log("  ✓ " + n); };
const put = (p, t) => { fs.mkdirSync(path.dirname(path.join(H, p)), { recursive: true }); fs.writeFileSync(path.join(H, p), t); };
const K = (c) => "sk-" + c.repeat(32);

(async () => {
  // ---- Copilot ----
  const cop = (body) => http.setTransport(async () => ({ status: 200, headers: {}, text: JSON.stringify(body) }));
  cop({ login: "u", copilot_plan: "free", access_type_sku: "free_limited_copilot", quota_reset_date: "2026-12-01", quota_snapshots: {
    premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: false },
    chat: { entitlement: 200, remaining: 200, percent_remaining: 100, unlimited: false },
    completions: { entitlement: 2000, remaining: 2000, percent_remaining: 100, unlimited: false } } });
  await assert.rejects(P.FETCHERS.copilot({ apiKey: "" }).catch((e) => { throw e; }), (e) => e.noLogin);
  ok("Copilot：没用过的自动免费版 → 不显示（以前显示「高级请求 100%」）");
  // 额度为 0 的项不算「用完」
  cop({ login: "u", copilot_plan: "individual", quota_reset_date: "2026-12-01", quota_snapshots: {
    premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 0 },
    chat: { entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: true },
    completions: { entitlement: 2000, remaining: 1500, percent_remaining: 75 } } });
  const st = await P.FETCHERS.copilot({ apiKey: "ghu_x" });
  assert.ok(!/高级请求/.test(JSON.stringify(st)));
  assert.strictEqual(st.secondary.usedPercent, 0); // chat 不限
  ok("Copilot：套餐里没有的额度（0）不再显示成「已用 100%」");

  // ---- DeepSeek：各种地方的 Key ----
  put(".continue/config.yaml", `models:\n  - name: DeepSeek Chat\n    provider: deepseek\n    model: deepseek-chat\n    apiKey: ${K("a")}\n`);
  let k = D.findApiKeys({}, { clients: false });
  assert.strictEqual(k.deepseek.apiKey, K("a")); assert.strictEqual(k.deepseek.from, "Continue");
  ok("Continue 的 config.yaml");
  fs.rmSync(path.join(H, ".continue"), { recursive: true });
  put(".local/share/opencode/auth.json", JSON.stringify({ deepseek: { type: "api", key: K("b") } }));
  k = D.findApiKeys({}, { clients: false });
  assert.strictEqual(k.deepseek.apiKey, K("b"));
  ok("OpenCode 的 auth.json");
  fs.rmSync(path.join(H, ".local"), { recursive: true });

  // 新版 cc-switch（SQLite，配置存成 JSON 字符串）
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(path.join(H, ".cc-switch"), { recursive: true });
  const db = new DatabaseSync(path.join(H, ".cc-switch", "cc-switch.db"));
  db.exec("CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT)");
  db.prepare("INSERT INTO providers VALUES (?,?,?,?)").run("p1", "claude", "DeepSeek", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: K("c") } }));
  db.close();
  k = D.findApiKeys({}, { clients: false });
  assert.strictEqual(k.deepseek.apiKey, K("c")); assert.strictEqual(k.deepseek.from, "cc-switch");
  ok("新版 cc-switch 的数据库");
  fs.rmSync(path.join(H, ".cc-switch"), { recursive: true });

  // Cherry Studio 本地数据（LevelDB 日志里的明文 JSON）
  put(".config/CherryStudio/Local Storage/leveldb/000003.log", "\x00\x01junk" + JSON.stringify({ llm: { providers: [{ id: "deepseek", name: "深度求索", apiKey: K("d"), apiHost: "https://api.deepseek.com" }, { id: "openai", apiKey: "sk-" + "e".repeat(32) }] } }) + "\x00more");
  k = D.findApiKeys({});
  assert.deepStrictEqual(k.deepseek.apiKeys, [K("d")], JSON.stringify(k.deepseek));
  assert.strictEqual(k.deepseek.from, "CherryStudio");
  ok("Cherry Studio 等桌面客户端（只认 DeepSeek 旁边的 Key，不会把 OpenAI 的 Key 认错）");

  // 多个候选：前两个已失效，第三个有效 → 用第三个
  let tried = [];
  http.setTransport(async (o) => {
    const key = o.headers.Authorization.slice(7); tried.push(key);
    if (key !== K("3")) return { status: 401, headers: {}, text: '{"error":{"message":"Authentication Fails"}}' };
    return { status: 200, headers: {}, text: JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12.00", granted_balance: "0", topped_up_balance: "12.00" }] }) };
  });
  const s2 = await P.FETCHERS.deepseek({ apiKey: K("1"), apiKeys: [K("1"), K("2"), K("3")] });
  assert.strictEqual(s2.headlineText, "¥12.00");
  assert.deepStrictEqual(tried, [K("1"), K("2"), K("3")]);
  tried = [];
  await P.FETCHERS.deepseek({ apiKey: K("1"), apiKeys: [K("1"), K("2"), K("3")] });
  assert.deepStrictEqual(tried, [K("3")]);
  ok("找到多个 DeepSeek Key：逐个验证，用有效的那个，并记住");

  console.log(`\n全部通过：${pass} 项`);
})().catch((e) => { console.error("✗", e); process.exit(1); });
