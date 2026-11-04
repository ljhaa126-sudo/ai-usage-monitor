"use strict";
// 读取本机已登录工具的凭据（只读，不修改任何文件）。
// macOS：Claude Code 的登录保存在「钥匙串」里；Cursor 的令牌可能被 Electron safeStorage 加密（密钥同样在钥匙串）。
// 首次读取时 macOS 会弹窗询问是否允许，选「始终允许」后不再询问。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { mac, appSupport, jwtClaims, readJSON } = require("./util");
const win = process.platform === "win32";

const cache = new Map();

function keychain(service, account) {
  if (!mac) return Promise.resolve(null);
  const k = service + "|" + (account || "");
  if (cache.has(k)) return Promise.resolve(cache.get(k));
  const args = ["find-generic-password", "-w", "-s", service];
  if (account) args.push("-a", account);
  return new Promise((resolve) => {
    execFile("/usr/bin/security", args, { timeout: 60000 }, (err, stdout) => {
      const v = err ? null : String(stdout).trim();
      if (v) cache.set(k, v);
      resolve(v || null);
    });
  });
}

// ---------- Claude Code ----------
async function claudeCodeOAuth(dirs) {
  for (const d of dirs) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(d, ".credentials.json"), "utf8"));
      if (j.claudeAiOauth && j.claudeAiOauth.accessToken) return j.claudeAiOauth;
    } catch { /* next */ }
  }
  if (!mac) return null;
  // 只有本机装过 Claude Code（存在 ~/.claude）才去问钥匙串，避免无意义的弹窗
  if (!dirs.some((d) => fs.existsSync(d))) return null;
  const raw = await keychain("Claude Code-credentials");
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    return j.claudeAiOauth && j.claudeAiOauth.accessToken ? j.claudeAiOauth : null;
  } catch { return null; }
}

// ---------- Chromium/Electron safeStorage（macOS）----------
function macSafeStorageDecrypt(password, buf) {
  if (!buf || buf.length < 4 || buf.slice(0, 3).toString() !== "v10") return null;
  const key = crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  try {
    const d = crypto.createDecipheriv("aes-128-cbc", key, iv);
    return Buffer.concat([d.update(buf.slice(3)), d.final()]);
  } catch { return null; }
}

// ---------- Windows：Chromium/Electron safeStorage（DPAPI 保护的主密钥 + AES-256-GCM）----------
// 用系统自带的 PowerShell 调用 DPAPI 解出主密钥，不需要任何原生模块。
function dpapiUnprotect(buf) {
  if (!win) return Promise.resolve(null);
  const ps = "Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());" +
    "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";
  return new Promise((resolve) => {
    const cp = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 20000, windowsHide: true }, (err, out) => {
      resolve(err ? null : Buffer.from(String(out).trim(), "base64"));
    });
    cp.stdin.end(buf.toString("base64"));
  });
}

const winKeys = new Map();
async function winMasterKey(localStatePath) {
  if (winKeys.has(localStatePath)) return winKeys.get(localStatePath);
  const ls = readJSON(localStatePath);
  const enc = ls && ls.os_crypt && ls.os_crypt.encrypted_key;
  if (!enc) return null;
  const raw = Buffer.from(enc, "base64");
  if (raw.slice(0, 5).toString() !== "DPAPI") return null;
  const key = await dpapiUnprotect(raw.slice(5));
  if (key && key.length === 32) winKeys.set(localStatePath, key);
  return key;
}

function winSafeStorageDecrypt(key, buf) {
  if (!key || !buf || buf.length < 31 || buf.slice(0, 3).toString() !== "v10") return null;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, buf.slice(3, 15));
    d.setAuthTag(buf.slice(buf.length - 16));
    return Buffer.concat([d.update(buf.slice(15, buf.length - 16)), d.final()]);
  } catch { return null; }
}

// ---------- Cursor：从 state.vscdb 中找出 accessToken（直接扫描 SQLite 字节，免依赖）----------
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
const SAFE_RE = /cursor-safe-storage:v1:[A-Za-z0-9+/=]{20,}/;

async function cursorToken() {
  const base = appSupport("Cursor", "User", "globalStorage");
  let best = null, bestExp = 0, found = false, encrypted = null;
  for (const f of ["state.vscdb", "state.vscdb-wal"]) {
    let data;
    try { data = fs.readFileSync(path.join(base, f)); } catch { continue; }
    found = true;
    const key = Buffer.from("cursorAuth/accessToken");
    let idx = 0;
    for (;;) {
      const i = data.indexOf(key, idx);
      if (i < 0) break;
      const pos = i + key.length;
      idx = pos;
      const chunk = data.slice(pos, pos + 4096).toString("latin1");
      let m = JWT_RE.exec(chunk);
      let cand = m && m.index < 8 ? m[0] : null;
      if (!cand) {
        const s = SAFE_RE.exec(chunk);
        if (s && s.index < 8) encrypted = s[0];
      }
      if (cand) {
        const c = jwtClaims(cand);
        const exp = (c && c.exp) || 0;
        if (!best || exp > bestExp) { best = cand; bestExp = exp; }
      }
    }
  }
  if (!best && encrypted && (mac || win)) {
    const raw = Buffer.from(encrypted.slice("cursor-safe-storage:v1:".length), "base64");
    let pt = null;
    if (mac) {
      const pw = await keychain("Cursor Safe Storage", "Cursor");
      if (pw) pt = macSafeStorageDecrypt(pw, raw);
    } else {
      pt = winSafeStorageDecrypt(await winMasterKey(appSupport("Cursor", "Local State")), raw);
    }
    if (pt) {
      const m = JWT_RE.exec(pt.toString("latin1"));
      if (m) best = m[0];
    }
  }
  return { token: best, found };
}

module.exports = { keychain, claudeCodeOAuth, cursorToken, macSafeStorageDecrypt, winSafeStorageDecrypt };
