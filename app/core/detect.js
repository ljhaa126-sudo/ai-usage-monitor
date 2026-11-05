"use strict";
// 自动识别本机的 AI：不需要用户手动配置。
//   ① 扫描各 AI 在本机留下的痕迹（安装目录、登录文件、配置目录），启动时扫一次，之后每 60 秒一次，
//      主目录 / 应用程序目录有变化时立即再扫（新安装、第一次登录的 AI 几秒内就能接入）。
//   ② 只装了 Claude 桌面版（没有 Claude Code）：直接读取桌面版保存的登录（sessionKey），
//      导入到本程序的网页会话里，相当于自动完成「登录网页版」。
//   ③ Kimi / 智谱 GLM 这类用 API Key 的：在本机已有的配置里找 Key——环境变量、shell 配置文件、
//      Claude Code 的 settings.json（很多人把 Kimi / GLM 接进 Claude Code）、cc-switch 等工具的配置。
// 全部只读本机文件，不联网、不上传。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const util = require("./util");

const home = () => process.env.AIMON_DETECT_HOME || util.home();
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
const appSupport = (...p) => {
  const h = home();
  if (process.platform === "darwin") return path.join(h, "Library", "Application Support", ...p);
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(h, "AppData", "Roaming"), ...p);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(h, ".config"), ...p);
};
const localAppData = (...p) => path.join(process.env.LOCALAPPDATA || path.join(home(), "AppData", "Local"), ...p);
const macApp = (name) => process.platform === "darwin" && (exists(`/Applications/${name}.app`) || exists(path.join(home(), "Applications", `${name}.app`)));

// ---------------- ① 各 AI 的本机痕迹 ----------------
// 返回命中的第一条说明（用于日志），没有就返回 ""
const CATALOG = {
  claude: () => [
    [() => exists(path.join(home(), ".claude")), "Claude Code"],
    [() => macApp("Claude") || exists(appSupport("Claude")) || exists(localAppData("AnthropicClaude")), "Claude 桌面版"],
  ],
  codex: () => [
    [() => exists(path.join(process.env.CODEX_HOME || path.join(home(), ".codex"), "auth.json")), "Codex 登录"],
    [() => macApp("Codex") || macApp("ChatGPT") || exists(localAppData("Programs", "Codex")), "Codex / ChatGPT 桌面版"],
  ],
  cursor: () => [[() => exists(appSupport("Cursor")) || exists(path.join(home(), ".cursor")) || macApp("Cursor"), "Cursor"]],
  gemini: () => [[() => exists(path.join(home(), ".gemini", "oauth_creds.json")), "Gemini CLI 登录"]],
  copilot: () => [[() => exists(path.join(home(), ".config", "github-copilot")) || exists(localAppData("github-copilot")), "Copilot 插件"]],
  workbuddy: () => [[() => exists(path.join(home(), ".workbuddy")) || macApp("WorkBuddy"), "WorkBuddy"]],
  // 腾讯内部：BoxAI 读 Box 客户端里的 RTX 账号；AI Token 用量（token.woa.com）读「用量健康助手」的登录
  boxai: () => [[() => exists(appSupport("Box", "s3_user.json")) || exists(path.join(home(), ".box")) || macApp("Box") || macApp("Box AI Studio"), "Box 客户端"]],
  tokendash: () => [[() => ["com.tencent.token-dashboard"].some((d) => exists(appSupport(d, "auth-session.sqlite")) || exists(path.join(home(), ".local", "share", d, "auth-session.sqlite"))), "用量健康助手（token.woa.com）"]],
};

// ---------------- ③ 在本机配置里找 API Key ----------------
const SHELL_FILES = [".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile", path.join(".config", "fish", "config.fish")];
const KEYISH = /^(sk-[A-Za-z0-9._-]{16,}|[A-Za-z0-9]{24,}\.[A-Za-z0-9]{8,}|[A-Za-z0-9_-]{32,})$/; // Kimi: sk-…；智谱: xxxx.yyyy

function parseShell(text) {
  const env = {};
  for (const line of String(text).split(/\r?\n/)) {
    let m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(["']?)([^"'\s#;]+)\2/.exec(line);
    if (!m) m = /^\s*set\s+-[gxU]+\s+([A-Z_][A-Z0-9_]*)\s+(["']?)([^"'\s#;]+)\2/.exec(line); // fish
    if (m) env[m[1]] = m[3];
  }
  return env;
}

// 一组「地址 + Key」：来自同一个 env 对象 / 同一个配置条目
function groupsFromEnv(env, from) {
  const g = [];
  const base = env.ANTHROPIC_BASE_URL || env.OPENAI_BASE_URL || env.BASE_URL || "";
  const key = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || "";
  if (base && key) g.push({ base, key, from });
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (/^KIMI(_CODE)?_API_KEY$/.test(k)) g.push({ base: "api.kimi.com", key: v, from });
    if (/^MOONSHOT_API_KEY$/.test(k)) g.push({ base: "api.moonshot.cn", key: v, from });
    if (/^DEEPSEEK_API_KEY$/.test(k)) g.push({ base: "api.deepseek.com", key: v, from });
    if (/^(HUNYUAN|TOKENHUB)_API_KEY$/.test(k)) g.push({ base: "tokenhub.tencentmaas.com", key: v, from });
    if (/^(ZHIPUAI|ZHIPU|GLM|BIGMODEL|ZAI)_API_KEY$/.test(k)) g.push({ base: /^ZAI/.test(k) ? "z.ai" : "bigmodel", key: v, from });
  }
  // 腾讯云 API 密钥（查混元额度用）
  if (env.TENCENTCLOUD_SECRET_ID && env.TENCENTCLOUD_SECRET_KEY) g.push({ base: "tencentcloud", key: env.TENCENTCLOUD_SECRET_ID + " " + env.TENCENTCLOUD_SECRET_KEY, from });
  return g;
}

// 在任意 JSON 里找配置条目：{ env: {...} }、{ baseUrl / base_url, apiKey / api_key }
function groupsFromJSON(j, from, out = [], depth = 0, parentKey = "") {
  if (!j || typeof j !== "object" || depth > 10) return out;
  if (Array.isArray(j)) { for (const x of j) groupsFromJSON(x, from, out, depth + 1, parentKey); return out; }
  const flat = {};
  for (const [k, v] of Object.entries(j)) if (typeof v === "string") flat[k] = v;
  out.push(...groupsFromEnv(flat, from));
  const base = flat.baseUrl || flat.base_url || flat.baseURL || flat.apiBase || flat.api_base || flat.apiHost || flat.endpoint || flat.url || "";
  const key = flat.apiKey || flat.api_key || flat.apikey || flat.token || flat.key || "";
  // 没写地址时，用 provider / type / id / name 字段或上一级键名当提示（如 "deepseek"）
  const hint = base || [flat.provider, flat.apiProvider, flat.type, flat.id, flat.name, parentKey].filter((x) => typeof x === "string" && /deepseek|kimi|moonshot|glm|zhipu|bigmodel|hunyuan/i.test(x))[0] || "";
  if (hint && key) out.push({ base: hint, key, from });
  for (const [k, v] of Object.entries(j)) if (v && typeof v === "object") groupsFromJSON(v, from, out, depth + 1, k);
  // 有的客户端把配置存成 JSON 字符串
  for (const v of Object.values(flat)) if (v.length > 20 && v.length < 2e5 && /^[[{]/.test(v.trim()) && /deepseek|kimi|moonshot|bigmodel|z\.ai|hunyuan/i.test(v)) { try { groupsFromJSON(JSON.parse(v), from, out, depth + 1); } catch { /* ignore */ } }
  return out;
}

// 文本里按「DeepSeek Key 的格式（sk- + 32 位十六进制）+ 附近出现 deepseek」找（YAML / .env / 客户端本地数据）
const DS_KEY = /sk-[0-9a-f]{32}(?![0-9a-zA-Z])/g;
function deepseekFromText(text, from, out = []) {
  const t = String(text);
  if (!/deepseek/i.test(t)) return out;
  let m;
  DS_KEY.lastIndex = 0;
  // 归属判断：Key 前面最近出现的服务商名字必须是 DeepSeek（中间没有别家），
  // 前面找不到任何服务商名字时才看后面紧挨着的。避免把别家的 Key 发给 DeepSeek 去验证。
  const PROV = /deepseek|openai|anthropic|claude|moonshot|kimi|zhipu|bigmodel|glm|gemini|google|groq|siliconflow|silicon|dashscope|qwen|aliyun|baichuan|minimax|doubao|volcengine|ark\.cn|hunyuan|tencent|mistral|openrouter|ollama|azure|grok|x\.ai|together|perplexity|cohere|stepfun|yi-|lingyi|spark|xfyun|ernie|baidu|wenxin|302\.ai|aihubmix|github|copilot/gi;
  const nearest = (s, fromEnd) => {
    let last = null, mm;
    PROV.lastIndex = 0;
    while ((mm = PROV.exec(s))) { last = mm; if (!fromEnd) break; }
    return last ? last[0].toLowerCase() : "";
  };
  while ((m = DS_KEY.exec(t))) {
    const before = nearest(t.slice(Math.max(0, m.index - 600), m.index), true);
    const owner = before || nearest(t.slice(m.index + m[0].length, m.index + m[0].length + 200), false);
    if (owner === "deepseek") out.push({ base: "api.deepseek.com", key: m[0], from });
    if (out.length > 20) break;
  }
  return out;
}

// SQLite 数据库（新版 cc-switch 等）：把所有文本单元格拿出来按 JSON / 文本两种方式找
function groupsFromSqlite(file, from) {
  const out = [];
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); } catch { return out; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aimon-db-"));
  try {
    const t = path.join(tmp, "x.db");
    fs.copyFileSync(file, t);
    for (const ext of ["-wal", "-shm"]) if (exists(file + ext)) { try { fs.copyFileSync(file + ext, t + ext); } catch { /* ignore */ } }
    const d = new DatabaseSync(t, { readOnly: true });
    try {
      const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name).slice(0, 40);
      for (const tb of tables) {
        let rows = [];
        try { rows = d.prepare(`SELECT * FROM "${String(tb).replace(/"/g, "")}" LIMIT 2000`).all(); } catch { continue; }
        for (const r of rows) {
          const cells = Object.values(r).filter((v) => typeof v === "string");
          const row = {};
          for (const [k, v] of Object.entries(r)) if (typeof v === "string") row[k] = v;
          groupsFromJSON(row, from, out);
          deepseekFromText(cells.join("\n"), from, out);
        }
      }
    } finally { d.close(); }
  } catch { /* ignore */ } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
  return out;
}

// 桌面 AI 客户端（Cherry Studio、Chatbox、LobeHub…）的本地数据（Chromium LevelDB），只做文本匹配
function scanClientStores(from, dirs, out = []) {
  let budget = 120e6; // 最多读 120 MB
  const walk = (d, depth) => {
    if (depth > 4 || budget <= 0) return;
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^(Cache|Code Cache|GPUCache|blob_storage|Crashpad|logs?|Service Worker|DawnCache|ShaderCache)$/i.test(e.name)) walk(p, depth + 1); continue; }
      if (!/\.(log|ldb|json|sqlite|db)$/i.test(e.name) && e.name !== "config") continue;
      let sz = 0;
      try { sz = fs.statSync(p).size; } catch { continue; }
      if (!sz || sz > 30e6) continue;
      budget -= sz;
      try { deepseekFromText(fs.readFileSync(p).toString("latin1"), from, out); } catch { /* ignore */ }
    }
  };
  for (const d of dirs) if (exists(d)) { const before = out.length; walk(d, 0); for (let i = before; i < out.length; i++) out[i].from = path.basename(d); }
  return out;
}

function readText(p) { try { const st = fs.statSync(p); if (st.size > 2e6) return ""; return fs.readFileSync(p, "utf8"); } catch { return ""; } }
function readJ(p) { const t = readText(p); if (!t) return null; try { return JSON.parse(t); } catch { return null; } }

// 常见桌面 AI 客户端的数据目录
const CLIENT_DIRS = () => ["CherryStudio", "Cherry Studio", "xyz.chatboxapp.app", "Chatbox", "chatbox", "LobeHub", "lobehub-desktop", "ChatWise", "AnythingLLM", "anythingllm-desktop", "Jan", "NextChat", "ChatGPT-Next-Web"].map((n) => appSupport(n));

// 客户端数据较大：只在数据有变化、且距上次至少 10 分钟时重新扫描
let clientCache = { sig: null, at: 0, keys: [] };
function clientKeys() {
  const dirs = CLIENT_DIRS().filter(exists);
  const sig = dirs.map((d) => [d, mtime(d), mtime(path.join(d, "Local Storage", "leveldb")), mtime(path.join(d, "IndexedDB"))].join(":")).join("|");
  if (clientCache.sig === sig) return clientCache.keys;
  if (clientCache.sig !== null && Date.now() - clientCache.at < 10 * 60e3) return clientCache.keys;
  clientCache = { sig, at: Date.now(), keys: dirs.length ? scanClientStores("AI 客户端", dirs) : [] };
  return clientCache.keys;
}

function findApiKeys(env = process.env, opts = {}) {
  const h = home();
  const groups = [...groupsFromEnv(env, "环境变量")];
  for (const f of SHELL_FILES) {
    const t = readText(path.join(h, f));
    if (t) groups.push(...groupsFromEnv(parseShell(t), "~/" + f.replace(/\\/g, "/")));
  }
  // Claude Code（把 Kimi / GLM 接进 Claude Code 是最常见的用法）
  for (const f of [path.join(h, ".claude", "settings.json"), path.join(h, ".claude", "settings.local.json")]) {
    const j = readJ(f);
    if (j) groups.push(...groupsFromJSON(j, "Claude Code 设置"));
  }
  // Continue、OpenCode、Aider、家目录 .env 等编程工具
  for (const [f, name] of [[".continue/config.json", "Continue"], [".continue/config.yaml", "Continue"], [".local/share/opencode/auth.json", "OpenCode"], [".config/opencode/opencode.json", "OpenCode"], [".aider.conf.yml", "Aider"], [".env", "~/.env"]]) {
    const p = path.join(h, f);
    const t = readText(p);
    if (!t) continue;
    if (/\.json$/.test(f)) { try { groupsFromJSON(JSON.parse(t), name, groups); } catch { /* ignore */ } }
    if (f === ".env") groups.push(...groupsFromEnv(parseShell(t), name));
    deepseekFromText(t, name, groups);
  }
  // cc-switch / Claude Code Router / Kimi CLI 等配置工具
  for (const [dir, name] of [[".cc-switch", "cc-switch"], [".claude-code-router", "Claude Code Router"], [".kimi", "Kimi CLI"], [".config/kimi", "Kimi CLI"]]) {
    const d = path.join(h, dir);
    let files = [];
    try { files = fs.readdirSync(d).filter((n) => /\.(json|toml|db|sqlite)$/i.test(n)).slice(0, 20); } catch { continue; }
    for (const n of files) {
      const p = path.join(d, n);
      if (/\.(db|sqlite)$/i.test(n)) { groups.push(...groupsFromSqlite(p, name)); continue; } // 新版 cc-switch 用 SQLite
      if (/\.json$/i.test(n)) { const j = readJ(p); if (j) groups.push(...groupsFromJSON(j, name)); }
      else {
        // TOML：同一段里的 base_url / api_key
        for (const sec of readText(p).split(/^\s*\[/m)) {
          const b = /base_url\s*=\s*"([^"]+)"/.exec(sec), k = /api_key\s*=\s*"([^"]+)"/.exec(sec);
          if (b && k) groups.push({ base: b[1], key: k[1], from: name });
        }
      }
    }
  }
  // 腾讯云命令行工具 tccli、腾讯云 SDK 的凭据文件
  for (const n of (() => { try { return fs.readdirSync(path.join(h, ".tccli")).filter((x) => /\.credential$/.test(x)); } catch { return []; } })()) {
    const j = readJ(path.join(h, ".tccli", n));
    if (j && j.secretId && j.secretKey) groups.push({ base: "tencentcloud", key: j.secretId + " " + j.secretKey, from: "tccli" });
  }
  {
    const t = readText(path.join(h, ".tencentcloud", "credentials"));
    const id = /secret_id\s*=\s*(\S+)/i.exec(t), sk = /secret_key\s*=\s*(\S+)/i.exec(t);
    if (id && sk) groups.push({ base: "tencentcloud", key: id[1] + " " + sk[1], from: "腾讯云 SDK 凭据" });
  }
  const ok = groups.map((g) => ({ ...g, key: String(g.key || "").trim(), b: String(g.base || "").toLowerCase() })).filter((g) => KEYISH.test(g.key) || (g.b === "tencentcloud" && /^AKID[A-Za-z0-9]{8,} [A-Za-z0-9]{16,}$/.test(g.key)));
  const out = {};
  // Kimi：Kimi Code 套餐的地址（api.kimi.com）优先于普通开放平台（moonshot）
  const kscore = (g) => (/kimi\.com/.test(g.b) ? 2 : 0) + (/^sk-kimi-/.test(g.key) ? 1 : 0);
  const kimi = ok.filter((g) => /kimi|moonshot/.test(g.b)).sort((a, b) => kscore(b) - kscore(a))[0];
  if (kimi) out.kimi = { apiKey: kimi.key, from: kimi.from };
  const glm = ok.find((g) => /bigmodel|zhipu|z\.ai/.test(g.b));
  if (glm) out.glm = { apiKey: glm.key, region: /z\.ai/.test(glm.b) ? "global" : "cn", from: glm.from };
  if (opts.clients !== false) clientKeys().forEach((g) => ok.push({ ...g, b: "api.deepseek.com" }));
  // DeepSeek：可能找到好几个（旧 Key、多个客户端）。全部交给数据源逐个验证，先用配置文件里的
  const dss = [...new Map(ok.filter((g) => /deepseek/.test(g.b)).map((g) => [g.key, g])).values()];
  if (dss.length) out.deepseek = { apiKey: dss[0].key, apiKeys: dss.map((g) => g.key), from: dss[0].from };
  const tc = ok.find((g) => g.b === "tencentcloud");
  if (tc) out.hunyuan = { apiKey: tc.key, from: tc.from };
  // 只有调用混元模型的 Key（查不了额度）：记为「检测到」，提示补充腾讯云 API 密钥
  const hy = ok.find((g) => /tencentmaas|hunyuan/.test(g.b));
  if (hy && !tc) Object.defineProperty(out, "_hints", { value: { hunyuan: "混元 API Key（" + hy.from + "），查额度还需要腾讯云 API 密钥" }, enumerable: false });
  return out;
}

// ---------------- ② 读取 Claude 桌面版保存的登录 ----------------
// Chromium 的 Cookies 数据库（SQLite）。时间戳是 1601 年起的微秒数。
function claudeCookiePaths() {
  if (process.platform === "win32") return { db: appSupport("Claude", "Network", "Cookies"), localState: appSupport("Claude", "Local State") };
  return { db: appSupport("Claude", "Cookies"), localState: appSupport("Claude", "Local State") };
}

// decrypt(buf) → Buffer | null；返回 { value, expires } 或 null
async function readClaudeDesktopSession({ db, decrypt }) {
  if (!exists(db)) return null;
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); } catch { return null; }
  // 复制一份再读（桌面版运行时数据库被占用；Windows 上可能完全锁住，复制失败就放弃）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aimon-ck-"));
  try {
    const t = path.join(tmp, "Cookies");
    fs.copyFileSync(db, t);
    for (const ext of ["-wal", "-journal"]) if (exists(db + ext)) { try { fs.copyFileSync(db + ext, t + ext); } catch { /* ignore */ } }
    const d = new DatabaseSync(t, { readOnly: true });
    let rows;
    // expires_utc 超出 JS 安全整数范围，在 SQL 里先换算成秒
    try { rows = d.prepare("SELECT name, value, encrypted_value, CAST(expires_utc / 1000000 AS INTEGER) AS exp_s FROM cookies WHERE host_key LIKE '%claude.ai' AND name = 'sessionKey' ORDER BY expires_utc DESC").all(); } finally { d.close(); }
    for (const r of rows) {
      let v = r.value || "";
      if (!v && r.encrypted_value && r.encrypted_value.length) {
        const pt = await decrypt(Buffer.from(r.encrypted_value));
        const m = pt && /sk-ant-sid[0-9A-Za-z_-]+/.exec(pt.toString("latin1")); // 新版 Chromium 在明文前加了 32 字节校验，直接匹配
        v = m ? m[0] : "";
      }
      if (/^sk-ant-sid/.test(v)) {
        const exp = r.exp_s ? Number(r.exp_s) - 11644473600 : 0;
        if (!exp || exp > Date.now() / 1000) return { value: v, expires: exp };
      }
    }
    return null;
  } catch { return null; } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
}

async function claudeDesktopDecryptor() {
  const sec = require("./secrets");
  const { localState } = claudeCookiePaths();
  if (process.platform === "darwin") {
    let pw = null;
    return async (buf) => {
      if (!pw) pw = await sec.keychain("Claude Safe Storage"); // 首次会弹出钥匙串授权
      return pw ? sec.macSafeStorageDecrypt(pw, buf) : null;
    };
  }
  if (process.platform === "win32") {
    let key = null;
    return async (buf) => {
      if (!key) key = await sec.winMasterKey(localState);
      return key ? sec.winSafeStorageDecrypt(key, buf) : null;
    };
  }
  return async () => null;
}

// ---------------- 调度 ----------------
class Detector extends EventEmitter {
  constructor({ log = () => {}, webSession = null, interval = 60000 } = {}) {
    super();
    this.log = log;
    this.webSession = webSession;
    this.interval = interval;
    this.found = {};          // id -> 说明
    this.keys = {};           // id -> { apiKey, region?, from }
    this.first = true;
    this.claudeTry = { at: 0, mtime: 0, denied: false };
    this.watchers = [];
  }

  // 给数据源用：没有手动填 Key 时用自动找到的
  autoCfg(id) { return this.keys[id] || null; }

  async scan(why = "") {
    const was = { ...this.found };
    const found = {};
    for (const [id, checks] of Object.entries(CATALOG)) {
      for (const [fn, label] of checks()) { let hit = false; try { hit = fn(); } catch { /* ignore */ } if (hit) { found[id] = label; break; } }
    }
    let keys = {};
    try { keys = findApiKeys(); } catch (e) { this.log("[detect] 查找 API Key 失败 " + e.message); }
    for (const [id, k] of Object.entries(keys)) found[id] = (id === "hunyuan" ? "腾讯云 API 密钥（" : "API Key（") + k.from + "）";
    for (const [id, how] of Object.entries(keys._hints || {})) if (!found[id]) found[id] = how;
    const keyChanged = JSON.stringify(keys) !== JSON.stringify(this.keys);
    this.keys = keys;
    this.found = found;
    if (found.claude) await this.importClaudeDesktop().catch((e) => this.log("[detect] 读取 Claude 桌面版登录失败 " + e.message));
    const added = Object.keys(found).filter((id) => !was[id]);
    if (this.first) {
      this.log("[detect] 本机识别到：" + (Object.entries(found).map(([id, how]) => `${id}（${how}）`).join("、") || "无"));
      this.first = false;
      if (Object.keys(found).length) this.emit("changed", Object.keys(found), true);
    } else if (added.length || keyChanged) {
      if (added.length) this.log(`[detect] 新发现：${added.map((id) => `${id}（${found[id]}）`).join("、")}${why ? "（" + why + "）" : ""}`);
      this.emit("changed", [...new Set([...added, ...(keyChanged ? Object.keys(keys) : [])])], false);
    }
    return found;
  }

  // 只装了 Claude 桌面版的用户：把桌面版的登录导入本程序（已经登录过网页版就不动）
  async importClaudeDesktop(force) {
    const ws = this.webSession;
    if (!ws || this.claudeTry.denied) return false;
    const have = await ws.cookies.get({ url: "https://claude.ai", name: "sessionKey" });
    if (have.length && !force) return false;
    const { db } = claudeCookiePaths();
    const mt = mtime(db);
    if (!mt) return false;
    // 数据库没变化、且 30 分钟内试过：不重复读（避免反复弹钥匙串授权）
    if (!force && mt === this.claudeTry.mtime && Date.now() - this.claudeTry.at < 30 * 60e3) return false;
    this.claudeTry.at = Date.now();
    this.claudeTry.mtime = mt;
    const decrypt = await claudeDesktopDecryptor();
    let tried = 0, opened = 0;
    const wrapped = async (buf) => { tried++; const r = await decrypt(buf); if (r) opened++; return r; };
    const s = await readClaudeDesktopSession({ db, decrypt: wrapped });
    if (!s) {
      // 有登录记录但解不开（钥匙串没允许）：本次运行不再尝试，避免反复弹窗
      if (tried && !opened) { this.claudeTry.denied = true; this.log("[detect] 没能读取 Claude 桌面版的登录（钥匙串未授权），本次运行不再尝试"); }
      return false;
    }
    await ws.cookies.set({ url: "https://claude.ai", domain: ".claude.ai", path: "/", name: "sessionKey", value: s.value, secure: true, httpOnly: true, sameSite: "lax", ...(s.expires ? { expirationDate: s.expires } : {}) });
    this.log("[detect] 已导入 Claude 桌面版的登录（等同于登录网页版）");
    this.emit("claude-session");
    return true;
  }

  start() {
    const run = (why) => this.scan(why).catch((e) => this.log("[detect] " + e.message));
    run();
    this.timer = setInterval(() => run(), this.interval);
    // 主目录 / 应用程序目录 / 应用数据目录有新东西出现：几秒后再扫一次
    let t = null;
    const poke = (why) => { clearTimeout(t); t = setTimeout(() => run(why), 3000); };
    const dirs = [home(), appSupport()];
    if (process.platform === "darwin") dirs.push("/Applications");
    if (process.platform === "win32") dirs.push(localAppData(), localAppData("Programs"));
    for (const d of dirs) {
      try {
        const w = fs.watch(d, { persistent: false }, (_ev, name) => { if (name && !/^\.(DS_Store|Trash)|\.(log|tmp|swp)$/i.test(String(name))) poke("新增 " + name); });
        w.on("error", () => {});
        this.watchers.push(w);
      } catch { /* ignore */ }
    }
    return this;
  }

  stop() { clearInterval(this.timer); for (const w of this.watchers) try { w.close(); } catch { /* ignore */ } }
}

module.exports = { Detector, findApiKeys, parseShell, groupsFromJSON, readClaudeDesktopSession, claudeCookiePaths, CATALOG };
