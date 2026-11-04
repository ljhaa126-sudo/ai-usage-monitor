"use strict";
// DeepSeek / 腾讯混元：取数 + 自动识别
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const APP = process.argv[2] || path.join(__dirname, "..", "app");
const H = fs.mkdtempSync(path.join(os.tmpdir(), "cn-"));
process.env.AIMON_DETECT_HOME = H;
delete process.env.DEEPSEEK_API_KEY; delete process.env.TENCENTCLOUD_SECRET_ID; delete process.env.TENCENTCLOUD_SECRET_KEY;
const http = require(path.join(APP, "core/http.js"));
const P = require(path.join(APP, "core/providers.js"));
const D = require(path.join(APP, "core/detect.js"));
let pass = 0; const ok = (n) => { pass++; console.log("  ✓ " + n); };
const put = (p, t) => { fs.mkdirSync(path.dirname(path.join(H, p)), { recursive: true }); fs.writeFileSync(path.join(H, p), t); };

(async () => {
  // ---- DeepSeek ----
  let seen;
  http.setTransport(async (o) => { seen = o; return { status: 200, headers: {}, text: JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "86.50", granted_balance: "10.00", topped_up_balance: "76.50" }] }) }; });
  let st = await P.FETCHERS.deepseek({ apiKey: "sk-abcdefabcdefabcdefabcdef" });
  assert.strictEqual(seen.url, "https://api.deepseek.com/user/balance");
  assert.strictEqual(seen.headers.Authorization, "Bearer sk-abcdefabcdefabcdefabcdef");
  assert.strictEqual(st.headlineText, "¥86.50");
  assert.ok(/余额 ¥86.50（赠送 ¥10.00/.test(st.primary.detail));
  ok("DeepSeek：显示账户余额 ¥86.50");
  http.setTransport(async () => ({ status: 200, headers: {}, text: JSON.stringify({ is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0.00" }] }) }));
  st = await P.FETCHERS.deepseek({ apiKey: "sk-abcdefabcdefabcdefabcdef" });
  assert.strictEqual(st.primary.usedPercent, 100);
  ok("DeepSeek：余额用完 → 圆环变满（红色）并提示");
  await assert.rejects(P.FETCHERS.deepseek({}), (e) => e.noLogin);
  ok("DeepSeek：没有 Key → 归为「未检测到」，不报错");

  // ---- 混元 ----
  http.setTransport(async (o) => {
    seen = o;
    return { status: 200, headers: {}, text: JSON.stringify({ Response: { TotalCount: 1, TokenPlanList: [{ TeamId: "tp-ent-x", ProductType: "enterprise", Name: "我的混元套餐", Uin: "1000001", Status: "enable", StopReason: "NORMAL", PackageInfo: { TotalQuota: "1000000", TotalUsed: "250000", ExpireTime: "2027-04-01T00:00:00Z" } }], RequestId: "r" } }) };
  });
  st = await P.FETCHERS.hunyuan({ apiKey: "AKIDabcdefghijklmnopqrstuvwxyz123456 abcdefghijklmnopqrstuvwxyz123456" });
  assert.strictEqual(seen.url, "https://tokenhub.tencentcloudapi.com");
  assert.strictEqual(seen.headers["X-TC-Action"], "DescribeTokenPlanList");
  assert.strictEqual(seen.headers["X-TC-Version"], "2026-03-22");
  assert.ok(/^TC3-HMAC-SHA256 Credential=AKIDabcdefghijklmnopqrstuvwxyz123456\/\d{4}-\d\d-\d\d\/tokenhub\/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=[0-9a-f]{64}$/.test(seen.headers.Authorization));
  assert.strictEqual(st.plan, "我的混元套餐");
  assert.strictEqual(Math.round(st.primary.usedPercent), 25);
  assert.ok(/已用 25.0 万 \/ 100.0 万 credits/.test(st.primary.detail), st.primary.detail);
  ok("混元：用腾讯云密钥签名查询 Token Plan，显示 25%（已用 25 万 / 100 万）");
  http.setTransport(async () => ({ status: 200, headers: {}, text: JSON.stringify({ Response: { Error: { Code: "AuthFailure.SecretIdNotFound", Message: "x" } } }) }));
  await assert.rejects(P.FETCHERS.hunyuan({ apiKey: "AKIDabcdefghijklmnopqrstuvwxyz123456 abcdefghijklmnopqrstuvwxyz123456" }), (e) => e.noLogin && /密钥无效/.test(e.message));
  ok("混元：密钥无效 → 提示，不当成出错");

  // ---- 自动识别 ----
  put(".claude/settings.json", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "sk-0123456789abcdef0123456789abcdef" } }));
  put(".tccli/default.credential", JSON.stringify({ secretId: "AKIDabcdefghijklmnopqrstuvwxyz123456", secretKey: "abcdefghijklmnopqrstuvwxyz123456", region: "ap-guangzhou" }));
  let k = D.findApiKeys({});
  assert.strictEqual(k.deepseek.apiKey, "sk-0123456789abcdef0123456789abcdef");
  assert.strictEqual(k.deepseek.from, "Claude Code 设置");
  assert.strictEqual(k.hunyuan.apiKey, "AKIDabcdefghijklmnopqrstuvwxyz123456 abcdefghijklmnopqrstuvwxyz123456");
  assert.strictEqual(k.hunyuan.from, "tccli");
  ok("自动找到：Claude Code 里接的 DeepSeek Key、tccli 里的腾讯云密钥");

  fs.rmSync(path.join(H, ".tccli"), { recursive: true });
  k = D.findApiKeys({ HUNYUAN_API_KEY: "sk-hunyuanAbCdEfGhIjKlMnOpQr" });
  assert.ok(!k.hunyuan);
  const det = new D.Detector({ log: () => {} });
  process.env.HUNYUAN_API_KEY = "sk-hunyuanAbCdEfGhIjKlMnOpQr";
  const found = await det.scan();
  assert.ok(/查额度还需要腾讯云 API 密钥/.test(found.hunyuan), found.hunyuan);
  ok("只有调用混元的 API Key → 显示「检测到」并提示补充腾讯云密钥");

  console.log(`\n全部通过：${pass} 项`);
})().catch((e) => { console.error("✗", e); process.exit(1); });
