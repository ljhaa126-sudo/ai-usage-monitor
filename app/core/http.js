"use strict";
// 统一的 HTTP 请求：在 Electron 里走 Chromium 网络栈（真实 Chrome 指纹、系统代理、可带登录窗口的 Cookie），
// 测试时可以用 setTransport 注入假实现。
const { HttpError } = require("./util");

const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

let transport = null;

function setTransport(fn) { transport = fn; }

function electronTransport({ url, method = "GET", headers = {}, body, session, useSessionCookies, timeout = 20000 }) {
  const { net } = require("electron");
  return new Promise((resolve, reject) => {
    const opts = { url, method, redirect: "follow", useSessionCookies: !!useSessionCookies };
    if (session) opts.session = session;
    const req = net.request(opts);
    for (const [k, v] of Object.entries(headers)) {
      try { req.setHeader(k, v); } catch { /* 部分头不可设置 */ }
    }
    const timer = setTimeout(() => { req.abort(); reject(new Error(`连接 ${new URL(url).host} 超时，请检查网络或代理`)); }, timeout);
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    req.on("error", (e) => { clearTimeout(timer); reject(new Error(`无法连接 ${new URL(url).host}：${e.message}`)); });
    if (body) req.write(body);
    req.end();
  });
}

// Node 原生 https：公司内网（*.woa.com 等）经 iOA / 中间设备时，Chromium 新 TLS 特性可能握手失败
// （net::ERR_SSL_PROTOCOL_ERROR），这类请求改走 Node，失败时也作为兜底。
function nodeTransport({ url, method = "GET", headers = {}, body, timeout = 20000 }) {
  const u = new URL(url);
  const mod = u.protocol === "http:" ? require("http") : require("https");
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }); });
      res.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`连接 ${u.host} 超时，请检查网络或代理`)); }, timeout);
    req.on("error", (e) => { clearTimeout(timer); reject(new Error(`无法连接 ${u.host}：${e.message}`)); });
    if (body) req.write(body);
    req.end();
  });
}

// ---------------- Node TLS + 系统代理（「像命令行工具一样」发请求） ----------------
// chatgpt.com 的 Cloudflare 会拦「Chrome 的 TLS 指纹 + 命令行工具的 User-Agent」这种不一致的请求（返回 403 网页）。
// Codex CLI 自己用的是非浏览器 TLS，所以这里用 Node 的 TLS 发同样的请求。
// Node 本身不认系统代理：用 Electron 的 resolveProxy 解析（系统代理 / PAC / 设置里手填的代理都算），
// 然后自己做 HTTP CONNECT 或 SOCKS5 隧道。
async function resolveProxyFor(url) {
  try {
    const { session } = require("electron");
    if (session && session.defaultSession) return await session.defaultSession.resolveProxy(url);
  } catch { /* 不在 Electron 里（测试） */ }
  const p = process.env.HTTPS_PROXY || process.env.https_proxy || "";
  if (!p) return "DIRECT";
  const u = new URL(p);
  return `PROXY ${u.hostname}:${u.port || 80}`;
}

// "PROXY a:1; SOCKS5 b:2; DIRECT" → 第一个能用的
function pickProxy(rule) {
  for (const part of String(rule || "DIRECT").split(";").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(PROXY|HTTPS|SOCKS5|SOCKS)\s+\[?([^\]\s]+?)\]?:(\d+)$/i.exec(part);
    if (m) return { type: /^SOCKS/i.test(m[1]) ? "socks5" : "http", host: m[2], port: Number(m[3]) };
    if (/^DIRECT$/i.test(part)) return null;
  }
  return null;
}

function rawConnect(host, port, timeout) {
  const net = require("net");
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); reject(new Error(`连接代理 ${host}:${port} 超时`)); }, timeout);
    s.once("connect", () => { clearTimeout(t); resolve(s); });
    s.once("error", (e) => { clearTimeout(t); reject(new Error(`连接代理 ${host}:${port} 失败：${e.message}`)); });
  });
}

// 从 socket 读到满足条件为止
function readUntil(sock, done, timeout) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => { cleanup(); reject(new Error("代理握手超时")); }, timeout);
    const onData = (d) => { buf = Buffer.concat([buf, d]); const n = done(buf); if (n) { cleanup(); resolve(buf); } };
    const onErr = (e) => { cleanup(); reject(e); };
    const onEnd = () => { cleanup(); reject(new Error("代理关闭了连接")); };
    const cleanup = () => { clearTimeout(t); sock.off("data", onData); sock.off("error", onErr); sock.off("end", onEnd); };
    sock.on("data", onData); sock.on("error", onErr); sock.on("end", onEnd);
  });
}

async function tunnel(px, host, port, timeout) {
  const s = await rawConnect(px.host, px.port, timeout);
  try {
    if (px.type === "http") {
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      const r = await readUntil(s, (b) => b.indexOf("\r\n\r\n") >= 0, timeout);
      const line = r.toString("latin1").split("\r\n")[0];
      if (!/^HTTP\/1\.[01] 200/.test(line)) throw new Error(`代理拒绝连接（${line}）`);
      return s;
    }
    // SOCKS5，无认证，用域名连接（由代理解析，避免本地 DNS 污染）
    s.write(Buffer.from([5, 1, 0]));
    const a = await readUntil(s, (b) => b.length >= 2, timeout);
    if (a[0] !== 5 || a[1] !== 0) throw new Error("SOCKS5 代理需要认证或不支持");
    const hb = Buffer.from(host);
    s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, hb.length]), hb, Buffer.from([port >> 8, port & 255])]));
    const r = await readUntil(s, (b) => {
      if (b.length < 5) return false;
      const alen = b[3] === 1 ? 4 : b[3] === 4 ? 16 : b[3] === 3 ? 1 + b[4] : 0;
      return b.length >= 4 + alen + 2;
    }, timeout);
    if (r[1] !== 0) throw new Error(`SOCKS5 代理连接失败（代码 ${r[1]}）`);
    return s;
  } catch (e) { s.destroy(); throw e; }
}

async function nodeProxiedTransport({ url, method = "GET", headers = {}, body, timeout = 20000 }) {
  const u = new URL(url);
  const port = Number(u.port) || 443;
  const px = pickProxy(await resolveProxyFor(url));
  const tls = require("tls");
  const https = require("https");
  let sock;
  if (px) {
    const raw = await tunnel(px, u.hostname, port, timeout);
    sock = tls.connect({ socket: raw, servername: u.hostname, ALPNProtocols: ["http/1.1"] });
  } else {
    sock = tls.connect({ host: u.hostname, port, servername: u.hostname, ALPNProtocols: ["http/1.1"] });
  }
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { sock.destroy(); reject(new Error(`连接 ${u.host} 超时`)); }, timeout);
    sock.once("secureConnect", () => { clearTimeout(t); resolve(); });
    sock.once("error", (e) => { clearTimeout(t); reject(new Error(`无法连接 ${u.host}：${e.message}`)); });
  });
  return new Promise((resolve, reject) => {
    const req = https.request(u, { method, headers, createConnection: () => sock }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { clearTimeout(timer); sock.destroy(); resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8"), via: px ? px.type + "-proxy" : "direct" }); });
      res.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`连接 ${u.host} 超时`)); }, timeout);
    req.on("error", (e) => { clearTimeout(timer); reject(new Error(`无法连接 ${u.host}：${e.message}`)); });
    if (body) req.write(body);
    req.end();
  });
}

const INTRANET = /(\.|^)(woa\.com|oa\.com|tencent\.com|tencent-cloud\.com)$/i;

// Windows 兜底：iOA 等终端安全软件按「进程」放行内网 HTTPS，未授信的 exe 会拿到非 TLS 响应
// （WRONG_VERSION_NUMBER / ERR_SSL_PROTOCOL_ERROR）。此时改由系统自带、已授信的 PowerShell 代发请求。
function psTransport({ url, method = "GET", headers = {}, body, timeout = 20000 }) {
  const { execFile } = require("child_process");
  const req = Buffer.from(JSON.stringify({ url, method, headers, body: body || "" }), "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;",
    "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;",
    "$q=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:AIMON_REQ))|ConvertFrom-Json;",
    "$h=@{};foreach($p in $q.headers.PSObject.Properties){if($p.Name -notin 'User-Agent','Content-Type','Accept'){$h[$p.Name]=[string]$p.Value}};",
    "$a=@{Uri=$q.url;Method=$q.method;Headers=$h;UseBasicParsing=$true;TimeoutSec=" + Math.ceil(timeout / 1000) + "};",
    "if($q.headers.'User-Agent'){$a.UserAgent=$q.headers.'User-Agent'};if($q.headers.'Content-Type'){$a.ContentType=$q.headers.'Content-Type'};if($q.body){$a.Body=[Text.Encoding]::UTF8.GetBytes($q.body)};",
    "try{$r=Invoke-WebRequest @a;$s=[int]$r.StatusCode;$c=$r.Content}catch{$x=$_.Exception.Response;if(-not $x){throw};$s=[int]$x.StatusCode;$c=(New-Object IO.StreamReader($x.GetResponseStream())).ReadToEnd()};",
    "if($c -is [byte[]]){$c=[Text.Encoding]::UTF8.GetString($c)};",
    "[Console]::Out.Write((@{status=$s;text=[string]$c}|ConvertTo-Json -Compress -Depth 3))",
  ].join("");
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: timeout + 5000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, AIMON_REQ: req } },
      (err, stdout) => {
        if (err && !stdout) return reject(new Error(`无法连接 ${new URL(url).host}：${String(err.message).split("\n")[0]}`));
        try { const o = JSON.parse(String(stdout).trim()); resolve({ status: o.status, headers: {}, text: o.text || "" }); }
        catch { reject(new Error(`无法连接 ${new URL(url).host}：返回数据无法解析`)); }
      });
  });
}

const TLS_BLOCKED = /ERR_SSL|EPROTO|WRONG_VERSION_NUMBER|ERR_CERT|ECONNRESET|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/;
let psPreferred = false; // 一旦确认被拦，之后内网请求直接走 PowerShell

async function viaNode(opts) {
  if (process.platform === "win32" && psPreferred) return psTransport(opts);
  try { return await nodeTransport(opts); } catch (e) {
    if (process.platform === "win32" && TLS_BLOCKED.test(String(e && e.message))) {
      const r = await psTransport(opts);
      psPreferred = true;
      return r;
    }
    throw e;
  }
}

async function requestJSON(opts) {
  const headers = { Accept: "application/json", "User-Agent": CHROME_UA, ...(opts.headers || {}) };
  let res;
  if (transport) res = await transport({ ...opts, headers });
  else {
    let host = "";
    try { host = new URL(opts.url).hostname; } catch { /* ignore */ }
    const canNode = !opts.useSessionCookies;
    if (opts.via === "node") res = await nodeProxiedTransport({ ...opts, headers });
    else if (canNode && INTRANET.test(host)) res = await viaNode({ ...opts, headers });
    else {
      try { res = await electronTransport({ ...opts, headers }); } catch (e) {
        if (canNode && TLS_BLOCKED.test(String(e && e.message))) res = await viaNode({ ...opts, headers });
        else throw e;
      }
    }
  }
  if (res.status < 200 || res.status >= 300) throw new HttpError(res.status, res.text, res.headers);
  try { return JSON.parse(res.text); } catch {
    const ct = String((res.headers || {})["content-type"] || "");
    const html = /html/i.test(ct) || /^\s*</.test(String(res.text || ""));
    const e = new Error(html ? `返回的是网页而不是数据（HTTP ${res.status}），通常是登录已失效，请重新登录` : `返回数据无法解析（HTTP ${res.status}）：${String(res.text || "").slice(0, 120)}`);
    if (html) e.html = true;
    throw e;
  }
}

module.exports = { requestJSON, setTransport, CHROME_UA, nodeProxiedTransport, pickProxy, resolveProxyFor };
