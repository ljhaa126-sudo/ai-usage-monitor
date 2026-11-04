"use strict";
// 自动识别：本机痕迹、API Key、Claude 桌面版登录
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const APP = process.argv[2] || path.join(__dirname, "..", "app");
const H = fs.mkdtempSync(path.join(os.tmpdir(), "det-"));
process.env.AIMON_DETECT_HOME = H;
process.env.XDG_CONFIG_HOME = path.join(H, ".config");
process.env.CODEX_HOME = path.join(H, ".codex");
const D = require(path.join(APP, "core/detect.js"));
const sec = require(path.join(APP, "core/secrets.js"));
let pass = 0; const ok = (n) => { pass++; console.log("  ✓ " + n); };
const put = (p, t) => { fs.mkdirSync(path.dirname(path.join(H, p)), { recursive: true }); fs.writeFileSync(path.join(H, p), t); };

(async () => {
  // ---- 什么都没装 ----
  let det = new D.Detector({ log: () => {} });
  let found = await det.scan();
  assert.deepStrictEqual(found, {});
  ok("什么都没装 → 什么都不显示");

  // ---- 陆续装上 ----
  const changed = [];
  det.on("changed", (ids) => changed.push(...ids));
  put(".codex/auth.json", "{}");
  put(".gemini/oauth_creds.json", "{}");
  put(".claude/projects/x.jsonl", "");
  found = await det.scan("新安装");
  assert.deepStrictEqual(Object.keys(found).sort(), ["claude", "codex", "gemini"]);
  assert.deepStrictEqual(changed.sort(), ["claude", "codex", "gemini"]);
  ok("后来新装 / 第一次登录的 AI → 自动发现并接入");

  // ---- API Key：Claude Code 里接了智谱 GLM、shell 里配了 Kimi ----
  put(".claude/settings.json", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic", ANTHROPIC_AUTH_TOKEN: "0123456789abcdef0123456789abcdef.AbCdEfGhIjKl" } }));
  put(".zshrc", 'export PATH=$PATH:/x\nexport KIMI_API_KEY="sk-kimi-AbCdEfGhIjKlMnOpQrStUvWx"\n');
  let k = D.findApiKeys({});
  assert.strictEqual(k.glm.apiKey, "0123456789abcdef0123456789abcdef.AbCdEfGhIjKl");
  assert.strictEqual(k.glm.region, "cn");
  assert.strictEqual(k.glm.from, "Claude Code 设置");
  assert.strictEqual(k.kimi.apiKey, "sk-kimi-AbCdEfGhIjKlMnOpQrStUvWx");
  assert.strictEqual(k.kimi.from, "~/.zshrc");
  ok("从 Claude Code 设置找到 GLM Key、从 ~/.zshrc 找到 Kimi Key");

  // cc-switch 里存的 z.ai（国际版）
  fs.rmSync(path.join(H, ".claude/settings.json"));
  put(".cc-switch/config.json", JSON.stringify({ claude: { providers: { a: { name: "Z.ai", settingsConfig: { env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "fedcba9876543210fedcba9876543210.ZyXwVuTsRqPo" } } } } } }));
  k = D.findApiKeys({});
  assert.strictEqual(k.glm.region, "global");
  assert.strictEqual(k.glm.from, "cc-switch");
  ok("从 cc-switch 找到 z.ai Key（自动选国际版）");

  // 环境变量 + 占位符不算
  k = D.findApiKeys({ ZHIPUAI_API_KEY: "your-key-here", MOONSHOT_API_KEY: "sk-moonshotAbCdEfGhIjKlMnOp" });
  assert.strictEqual(k.kimi.apiKey, "sk-kimi-AbCdEfGhIjKlMnOpQrStUvWx", "Kimi Code 的 Key 优先于开放平台");
  ok("占位符不当成 Key；Kimi Code 套餐 Key 优先");

  found = await det.scan();
  assert.ok(found.kimi && found.glm);
  assert.strictEqual(det.autoCfg("glm").region, "global");
  ok("找到 Key 的 AI 也会自动接入");

  // ---- 腾讯内部：Box 客户端（RTX 账号）、用量健康助手（token.woa.com）----
  put(".config/Box/s3_user.json", JSON.stringify({ rtx: "someone" }));
  put(".config/com.tencent.token-dashboard/auth-session.sqlite", "x");
  found = await det.scan();
  assert.strictEqual(found.boxai, "Box 客户端");
  assert.strictEqual(found.tokendash, "用量健康助手（token.woa.com）");
  ok("识别腾讯 BoxAI（Box 客户端）和 token.woa.com（用量健康助手）");

  // ---- Claude 桌面版的登录（Chromium Cookies 数据库）----
  const { DatabaseSync } = require("node:sqlite");
  const pw = "testpassword";
  const enc = (plain, prefix) => {
    const key = crypto.pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
    const c = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    return Buffer.concat([Buffer.from("v10"), c.update(Buffer.concat([prefix || Buffer.alloc(0), Buffer.from(plain)])), c.final()]);
  };
  const db = path.join(H, "Cookies");
  const d = new DatabaseSync(db);
  d.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER)");
  const future = (Math.floor(Date.now() / 1000) + 30 * 864e2 + 11644473600) * 1e6;
  d.prepare("INSERT INTO cookies VALUES (?,?,?,?,?)").run(".claude.ai", "sessionKey", "", enc("sk-ant-sid01-NEWVERSIONabc_DEF-123", crypto.randomBytes(32)), future);
  d.prepare("INSERT INTO cookies VALUES (?,?,?,?,?)").run(".claude.ai", "lastActiveOrg", "", enc("org"), future);
  d.close();
  const s = await D.readClaudeDesktopSession({ db, decrypt: async (b) => sec.macSafeStorageDecrypt(pw, b) });
  assert.strictEqual(s.value, "sk-ant-sid01-NEWVERSIONabc_DEF-123");
  assert.ok(s.expires > Date.now() / 1000);
  ok("读出 Claude 桌面版的登录（新版 Chromium 加密格式）");
  const s2 = await D.readClaudeDesktopSession({ db, decrypt: async () => null });
  assert.strictEqual(s2, null);
  ok("钥匙串没允许 → 安全放弃，不报错");

  console.log(`\n全部通过：${pass} 项`);
})().catch((e) => { console.error("✗", e); process.exit(1); });
