"use strict";
// 借用本机 Codex 自己的程序（codex app-server）读取账号额度。
// Codex 用自己的网络栈访问 chatgpt.com，Cloudflare 不会拦；读到的是账号级的线上数据（和直接请求 /wham/usage 一样），
// 不是本机会话日志，两台电脑都用也准确。
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { home } = require("./util");

const WIN = process.platform === "win32";
const EXE = WIN ? "codex.exe" : "codex";

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

// 文件开头是 "#!" 或者是 .cmd/.ps1/.js：是 npm 生成的启动脚本，不是真正的程序
function isScript(p) {
  if (/\.(cmd|ps1|js|mjs|bat)$/i.test(p)) return true;
  try {
    const fd = fs.openSync(p, "r");
    const b = Buffer.alloc(2);
    fs.readSync(fd, b, 0, 2, 0);
    fs.closeSync(fd);
    return b.toString() === "#!";
  } catch { return true; }
}

// npm 包里的原生程序：vendor/<平台>/bin/codex 或 vendor/<平台>/codex/codex
function vendorBinary(pkgRoot) {
  const out = [];
  const roots = [path.join(pkgRoot, "vendor")];
  // 新版把原生程序拆到 @openai/codex-<平台> 包里
  for (const nm of [path.join(pkgRoot, "node_modules", "@openai"), path.dirname(pkgRoot)]) {
    for (const n of ls(nm)) if (/^codex-/.test(n)) roots.push(path.join(nm, n, "vendor"));
  }
  for (const v of roots) {
    for (const t of ls(v)) {
      for (const p of [path.join(v, t, "bin", EXE), path.join(v, t, "codex", EXE), path.join(v, t, EXE)]) {
        if (isFile(p) && !isScript(p)) out.push(p);
      }
    }
  }
  return out[0] || "";
}

function binDirs() {
  const h = home();
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  if (WIN) {
    const ad = process.env.APPDATA || path.join(h, "AppData", "Roaming");
    const la = process.env.LOCALAPPDATA || path.join(h, "AppData", "Local");
    dirs.push(path.join(ad, "npm"), path.join(la, "pnpm"), path.join(h, ".bun", "bin"), path.join(h, ".local", "bin"),
      path.join(la, "Programs", "codex"), path.join(la, "Programs", "Codex", "resources"), path.join(la, "Microsoft", "WindowsApps"));
  } else {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", path.join(h, ".local", "bin"), path.join(h, ".npm-global", "bin"),
      path.join(h, ".bun", "bin"), path.join(h, ".volta", "bin"), path.join(h, "Library", "pnpm"), path.join(h, ".codex", "bin"),
      "/Applications/Codex.app/Contents/Resources", path.join(h, "Applications", "Codex.app", "Contents", "Resources"));
    for (const v of ls(path.join(h, ".nvm", "versions", "node"))) dirs.push(path.join(h, ".nvm", "versions", "node", v, "bin"));
    for (const v of ls(path.join(h, ".fnm", "node-versions"))) dirs.push(path.join(h, ".fnm", "node-versions", v, "installation", "bin"));
  }
  return [...new Set(dirs)];
}

// npm 全局包的目录（找不到启动脚本时直接在这里找原生程序）
function pkgRoots() {
  const h = home();
  const r = [];
  if (WIN) {
    r.push(path.join(process.env.APPDATA || path.join(h, "AppData", "Roaming"), "npm", "node_modules", "@openai", "codex"));
  } else {
    for (const p of ["/opt/homebrew/lib", "/usr/local/lib", path.join(h, ".npm-global", "lib")]) r.push(path.join(p, "node_modules", "@openai", "codex"));
    for (const v of ls(path.join(h, ".nvm", "versions", "node"))) r.push(path.join(h, ".nvm", "versions", "node", v, "lib", "node_modules", "@openai", "codex"));
    r.push(path.join(h, ".bun", "install", "global", "node_modules", "@openai", "codex"));
  }
  return r;
}

function resolveCandidate(dir, name) {
  const p = path.join(dir, name);
  if (!isFile(p)) return "";
  if (!isScript(p)) return p;                       // 原生程序（Homebrew、安装脚本、Codex 桌面版自带的）
  const rp = real(p);
  const roots = [];
  if (/codex\.js$/.test(rp)) roots.push(path.dirname(path.dirname(rp)));            // .../@openai/codex/bin/codex.js
  roots.push(path.join(dir, "node_modules", "@openai", "codex"));                    // Windows npm：%APPDATA%\npm\node_modules
  roots.push(path.join(dir, "..", "lib", "node_modules", "@openai", "codex"));       // Unix npm 前缀
  for (const r of roots) { const b = isDir(r) && vendorBinary(r); if (b) return b; }
  return "";
}

let found = { at: 0, bin: "" };
function findCodex() {
  if (process.env.AIMON_CODEX_BIN) return process.env.AIMON_CODEX_BIN; // 测试用
  if (Date.now() - found.at < 10 * 60000) return found.bin;
  let bin = "";
  outer: for (const d of binDirs()) {
    for (const n of WIN ? ["codex.exe", "codex.cmd", "codex"] : ["codex"]) {
      const b = resolveCandidate(d, n);
      if (b) { bin = b; break outer; }
    }
  }
  if (!bin) for (const r of pkgRoots()) { const b = isDir(r) && vendorBinary(r); if (b) { bin = b; break; } }
  found = { at: Date.now(), bin };
  return bin;
}

// 和 codex app-server 说几句话（每行一个 JSON-RPC 消息），拿到结果就关掉
function rpc(method, params, { timeout = 30000, env = {}, version = "1" } = {}) {
  const bin = findCodex();
  if (!bin) return Promise.reject(Object.assign(new Error("本机没有找到 Codex 程序"), { noBin: true }));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env }, windowsHide: true });
    } catch (e) { reject(e); return; }
    let buf = "", err = "", done = false;
    const finish = (e, v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try { child.stdin.end(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
      if (e) reject(e); else resolve(v);
    };
    const t = setTimeout(() => finish(new Error("Codex 程序读取额度超时")), timeout);
    const send = (m) => { try { child.stdin.write(JSON.stringify(m) + "\n"); } catch (e) { finish(e); } };
    child.on("error", (e) => finish(new Error("无法启动 Codex 程序：" + e.message)));
    child.on("exit", (code) => finish(new Error(`Codex 程序提前退出（${code}）${err ? "：" + err.trim().split("\n").pop().slice(0, 120) : ""}`)));
    child.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1 && !m.method) {
          if (m.error) return finish(new Error("Codex 程序初始化失败：" + (m.error.message || "")));
          send({ method: "initialized" });
          send(params === undefined ? { id: 2, method } : { id: 2, method, params });
        } else if (m.id === 2 && !m.method) {
          if (m.error) {
            const e = new Error(m.error.message || "Codex 程序返回错误");
            e.rpcCode = m.error.code;
            if (/auth|login|sign in|unauthori[sz]ed|401/i.test(e.message)) e.auth = true;
            return finish(e);
          }
          return finish(null, m.result);
        } else if (m.method && m.id != null) {
          // 服务端发来的请求（审批之类）：这里用不到，回一个错误让它别等
          send({ id: m.id, error: { code: -32601, message: "not supported" } });
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "ai_usage_monitor", title: "AI Usage Monitor", version } } });
  });
}

// 把 app-server 的返回（camelCase）转成和 /wham/usage 一样的结构，后面统一解析
function toWham(r) {
  const win = (w) => w && w.usedPercent != null ? {
    used_percent: w.usedPercent,
    limit_window_seconds: w.windowDurationMins != null ? w.windowDurationMins * 60 : undefined,
    reset_at: w.resetsAt || undefined,
  } : null;
  const rl = (r && r.rateLimits) || {};
  const d = { rate_limit: { primary_window: win(rl.primary), secondary_window: win(rl.secondary) }, additional_rate_limits: [] };
  if (rl.planType) d.plan_type = rl.planType;
  const by = (r && r.rateLimitsByLimitId) || {};
  for (const [id, snap] of Object.entries(by)) {
    if (!snap || id === (rl.limitId || "codex") || id === "codex") continue;
    d.additional_rate_limits.push({ limit_name: snap.limitName || id, rate_limit: { primary_window: win(snap.primary), secondary_window: win(snap.secondary) } });
  }
  const cr = rl.credits;
  if (cr) d.credits = { unlimited: !!cr.unlimited, balance: cr.balance != null ? String(cr.balance) : "" };
  const rc = r && r.rateLimitResetCredits;
  if (rc && rc.availableCount != null) {
    d.rate_limit_reset_credits = { available_count: rc.availableCount };
    if (Array.isArray(rc.credits)) {
      d.reset_credit_details = rc.credits.map((c) => ({
        id: c.id, title: c.title || "", status: c.status === "available" ? "available" : c.status,
        granted_at: c.grantedAt || 0, expires_at: c.expiresAt || 0,
      }));
    }
  }
  return d;
}

module.exports = { findCodex, rpc, toWham };
