"use strict";
const { app, BrowserWindow, ipcMain, screen, shell, Menu, Tray, nativeImage, session, powerMonitor, net, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");
const { Store } = require("./core/store");
const { Engine } = require("./core/engine");
const { DEFS, resetCodexBlock } = require("./core/providers");
const { EXTRA_DEFS, wbBase } = require("./core/extra");
const custom = require("./core/custom");
const { CHROME_UA } = require("./core/http");

const MOCK = process.env.AIMON_MOCK === "1";
const SHOT = process.env.AIMON_SHOT || "";

app.setName("AI 用量监控");
if (process.platform === "win32") app.setAppUserModelId("com.aiusage.monitor");
if (!app.requestSingleInstanceLock()) { app.quit(); }

let store, engine, overlay, settingsWin, tray, webSession;
const loginWins = {};
let logFile;

function log(msg) {
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 512 * 1024) fs.unlinkSync(logFile);
    fs.appendFileSync(logFile, `${new Date().toLocaleString()}  ${msg}\n`);
  } catch { /* ignore */ }
}

// ---------------- 状态推送 ----------------
let pushT = null;
function broadcast() {
  if (pushT) return;
  pushT = setTimeout(() => {
    pushT = null;
    const list = engine.list();
    for (const w of [overlay, settingsWin]) if (w && !w.isDestroyed()) w.webContents.send("update", list);
    updateTray(list);
  }, 60);
}

function sendConfig() {
  for (const w of [overlay, settingsWin]) if (w && !w.isDestroyed()) w.webContents.send("config", store.cfg);
}

// ---------------- 悬浮层（覆盖所在屏幕工作区的透明窗口，空白处点击穿透） ----------------
function targetDisplay() {
  const all = screen.getAllDisplays();
  return all.find((d) => d.id === store.cfg.dock.displayId) || screen.getPrimaryDisplay();
}

// macOS 贴顶部：悬浮层盖住整块屏幕（包括菜单栏），层级高于菜单栏，竖条贴着屏幕最上沿（菜单栏里），刘海屏时绕着刘海排布
const macTop = () => process.platform === "darwin" && store.cfg.dock.mode === "edge" && store.cfg.dock.edge === "top";
const overlayRect = (d) => (macTop() ? d.bounds : d.workArea);
let macScreens = [];
function screenInfo() {
  if (process.env.AIMON_SCREEN) { try { return JSON.parse(process.env.AIMON_SCREEN); } catch { /* ignore */ } } // 测试用：模拟刘海
  const d = targetDisplay();
  const { notchFor } = require("./core/notch");
  return { notch: process.platform === "darwin" ? notchFor(d, macScreens) : null, menuBar: d.workArea.y - d.bounds.y, fullTop: macTop() };
}
function sendScreenInfo() { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("screen", screenInfo()); }
async function refreshScreens() {
  if (process.platform !== "darwin") return;
  try { macScreens = await require("./core/notch").readScreens(); } catch { macScreens = []; }
  const n = screenInfo().notch;
  log(`[screen] ${n ? `刘海 ${Math.round(n.x0)}–${Math.round(n.x1)}，高 ${Math.round(n.h)}` : "没有刘海"}`);
  sendScreenInfo();
}
function applyLevel() {
  if (!overlay || overlay.isDestroyed()) return;
  if (process.platform === "darwin") overlay.setAlwaysOnTop(true, macTop() ? "status" : "floating"); // status 层级高于菜单栏
}

function createOverlay() {
  const d = targetDisplay();
  overlay = new BrowserWindow({
    ...overlayRect(d),
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: process.platform === "linux", // macOS/Windows：点击竖条不会抢走当前窗口的焦点
    acceptFirstMouse: true,
    roundedCorners: false,
    type: process.platform === "darwin" ? "panel" : undefined,
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false },
  });
  // 注意：Windows 上 "floating" 这一档会被 Electron 放到任务栏「后面」，容易被其他置顶窗口盖住；Windows 用最高的 "screen-saver"
  overlay.setAlwaysOnTop(true, process.platform === "win32" ? "screen-saver" : "floating");
  applyLevel();
  if (process.platform === "darwin") overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.loadFile(path.join(__dirname, "renderer", "overlay.html"));
  overlay.once("ready-to-show", () => {
    overlay.showInactive();
    startKeepOnTop();
    if (SHOT) setTimeout(() => shot(), Number(process.env.AIMON_SHOT_DELAY || 1500));
  });
}

// Windows：所有「置顶」窗口在同一层里，谁最后被激活谁在上面。悬浮条为了不抢焦点不会被激活，
// 一旦被别的置顶程序（微信 / 企业微信 / 钉钉的悬浮窗、输入法工具栏、录屏工具、安全软件悬浮球、全屏播放……）盖住就回不来。
// 所以在切换窗口、唤醒、解锁、换屏时，以及每 2 秒，重新把它提到置顶层最上面（不会抢焦点、不影响打字）。
function keepOnTop() {
  if (process.platform !== "win32" || !overlay || overlay.isDestroyed() || !overlay.isVisible()) return;
  try {
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.moveTop();
  } catch { /* ignore */ }
}
let topTimer = null;

// ---------------- 显示 / 隐藏悬浮条的快捷键 ----------------
// 默认选三个修饰键 + U（Usage）：macOS ⌃⌥⌘U、Windows Ctrl+Alt+Shift+U。
// 系统和常见软件（微信 / QQ 截图 Ctrl+Alt+A、输入法、Office、IDE、录屏）都不用这一组；
// 万一被别的软件先占用了，依次换备选，设置里也可以自己改。
const HOTKEY_DEFAULTS = process.platform === "darwin"
  ? ["Control+Alt+Command+U", "Control+Alt+Command+J", "Control+Alt+Command+K"]
  : ["Control+Alt+Shift+U", "Control+Alt+Shift+J", "Control+Alt+Shift+K"];
let hotkey = { active: "", error: "", def: HOTKEY_DEFAULTS[0] }, hotkeyPaused = false;
function toggleOverlay(why) {
  if (!overlay || overlay.isDestroyed()) return;
  if (overlay.isVisible()) overlay.hide();
  else { overlay.showInactive(); keepOnTop(); }
  log(`[ui] ${overlay.isVisible() ? "显示" : "隐藏"}悬浮条（${why}）`);
  refreshTrayMenu();
}
function registerHotkey() {
  hotkeyPaused = false;
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
  const want = String(store.cfg.hotkey || "").trim();
  hotkey = { active: "", error: "", def: HOTKEY_DEFAULTS[0] };
  if (want === "off") { sendHotkey(); return; }
  const tryKey = (k) => { try { return globalShortcut.register(k, () => toggleOverlay("快捷键")); } catch { return false; } };
  if (want) {
    if (tryKey(want)) hotkey.active = want;
    else hotkey.error = "这个快捷键已被其他软件占用或不可用，已改用默认快捷键";
  }
  if (!hotkey.active) for (const k of HOTKEY_DEFAULTS) if (tryKey(k)) { hotkey.active = k; break; }
  if (!hotkey.active && !hotkey.error) hotkey.error = "默认快捷键都被其他软件占用了，请在这里换一个";
  log(`[ui] 快捷键 ${hotkey.active || "未注册"}${hotkey.error ? "（" + hotkey.error + "）" : ""}`);
  sendHotkey();
}
function sendHotkey() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send("hotkey", hotkey);
  if (tray) refreshTrayMenu();
}
function startKeepOnTop() {
  if (process.platform !== "win32" || topTimer) return;
  topTimer = setInterval(keepOnTop, 2000);
}

function fitOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  const d = targetDisplay();
  applyLevel();
  overlay.setBounds(overlayRect(d));
  keepOnTop();
  overlay.webContents.send("config", store.cfg);
  sendScreenInfo();
}

async function shot() {
  try { await shotInner(); } catch (e) { log("[shot] 失败 " + (e && e.message)); }
  app.exit(0);
}
async function shotInner() {
  const img = await overlay.webContents.capturePage();
  fs.writeFileSync(SHOT, img.toPNG());
  if (process.env.AIMON_SHOT_SCRIPT) {
    // 依次执行脚本动作并截图：格式 "动作|文件;;动作|文件"
    for (const step of process.env.AIMON_SHOT_SCRIPT.split(";;")) {
      const i = step.lastIndexOf("|");
      const js = step.slice(0, i), file = step.slice(i + 1);
      await overlay.webContents.executeJavaScript(js);
      await new Promise((r) => setTimeout(r, 700));
      fs.writeFileSync(file, (await overlay.webContents.capturePage()).toPNG());
    }
  }
}

// ---------------- 设置窗口 ----------------
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 560, height: 760, minWidth: 480, minHeight: 520,
    title: "AI 用量监控 · 设置",
    backgroundColor: "#000000",
    icon: process.platform === "win32" ? path.join(__dirname, "assets", "icon.png") : undefined,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : process.platform === "win32" ? "hidden" : "default",
    titleBarOverlay: process.platform === "win32" ? { color: "#000000", symbolColor: "#f5f5f7", height: 36 } : undefined,
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  settingsWin.loadFile(path.join(__dirname, "renderer", "settings.html"));
  // 录制快捷键时关掉了设置窗口：恢复全局快捷键
  settingsWin.on("closed", () => { if (hotkeyPaused) registerHotkey(); });
  settingsWin.once("ready-to-show", () => {
    settingsWin.show();
    if (process.platform === "darwin") app.focus({ steal: true });
    if (SHOT && process.env.AIMON_SETTINGS_SHOT) setTimeout(async () => {
      if (process.env.AIMON_SETTINGS_JS) { try { await settingsWin.webContents.executeJavaScript(process.env.AIMON_SETTINGS_JS); } catch { /* ignore */ } await new Promise((r) => setTimeout(r, 600)); }
      fs.writeFileSync(process.env.AIMON_SETTINGS_SHOT, (await settingsWin.webContents.capturePage()).toPNG());
    }, 1200);
  });
}

// ---------------- 网页登录（Claude / Cursor）：在独立窗口里登录，Cookie 存在本程序自己的会话中 ----------------
// WorkBuddy：网关在首次访问时就会种下 session Cookie（未登录也有），不能用「有没有 Cookie」判断登录。
// 改为真实请求 /console/accounts：返回 JSON 账号列表才算登录成功；302 到 /auth/realms/... 说明还没登录。
function wbLoggedIn() {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = net.request({ url: wbBase() + "/console/accounts", method: "GET", session: webSession, useSessionCookies: true, redirect: "manual" });
      req.setHeader("Accept", "application/json");
      req.on("redirect", () => { try { req.abort(); } catch { /* ignore */ } fin(false); });
      req.on("response", (res) => {
        const ch = []; res.on("data", (c) => ch.push(c));
        res.on("end", () => {
          if (res.statusCode !== 200) return fin(false);
          try { const j = JSON.parse(Buffer.concat(ch).toString("utf8")); fin(!!((j.data && j.data.accounts) || j.accounts)); } catch { fin(false); }
        });
      });
      req.on("error", () => fin(false));
      setTimeout(() => { try { req.abort(); } catch { /* ignore */ } fin(false); }, 10000);
      req.end();
    } catch { fin(false); }
  });
}

// WorkBuddy 登录分两段：① 身份认证（Keycloak，得到 KEYCLOAK_SESSION）② 回跳 /console/accounts/.apisix/redirect 让网关写入 session。
// 扫码后如果窗口在第②步之前被关掉，就会出现「认证过了但仍未登录」。这里用隐藏窗口静默补完第②步。
function wbFinishSso(timeout = 15000) {
  return new Promise((resolve) => {
    const w = new BrowserWindow({ show: false, webPreferences: { session: webSession, contextIsolation: true, sandbox: true } });
    let done = false;
    const fin = async () => {
      if (done) return; done = true;
      try {
        if (process.env.AIMON_DIAG_WB && !w.isDestroyed()) {
          const u = w.webContents.getURL().replace(/(state|code|session_code|client_data|tab_id|nonce)=[^&]+/g, "$1=…");
          const txt = await w.webContents.executeJavaScript("document.body?document.body.innerText.replace(/\\s+/g,' ').slice(0,300):''");
          log(`[diag-wb] 隐藏窗口停在: ${u.slice(0, 200)} | ${txt}`);
        }
      } catch { /* ignore */ }
      try { w.destroy(); } catch { /* ignore */ }
      resolve(await wbLoggedIn());
    };
    w.webContents.on("did-navigate", (_e, u) => { if (/\/console\/accounts(?!\/\.apisix)/.test(u) && !/\/auth\//.test(u)) setTimeout(fin, 500); });
    w.webContents.on("did-fail-load", (_e, code, desc, url) => { if (process.env.AIMON_DIAG_WB) log(`[diag-wb] 加载失败 ${code} ${desc} ${String(url).split("?")[0]}`); setTimeout(fin, 500); });
    setTimeout(fin, timeout);
    w.loadURL(wbBase() + "/console/accounts", { userAgent: CHROME_UA });
  });
}

async function webStatus() {
  const out = {};
  const ck = async (url, name) => (await webSession.cookies.get({ url, name })).length > 0;
  out.claude = await ck("https://claude.ai", "sessionKey");
  out.cursor = await ck("https://cursor.com", "WorkosCursorSessionToken");
  out.codex = (await webSession.cookies.get({ url: "https://chatgpt.com" })).some((c) => /session-token/.test(c.name));
  out.workbuddy = await wbLoggedIn();
  if (!out.workbuddy && (await webSession.cookies.get({ url: wbBase() + "/auth/", name: "KEYCLOAK_SESSION" })).length) {
    out.workbuddy = await wbFinishSso();
  }
  return out;
}

function openLogin(id, idp) {
  const def = (engine && engine.def(id)) || [...DEFS, ...EXTRA_DEFS].find((d) => d.id === id);
  if (!def || !def.login) return;
  if (loginWins[id] && !loginWins[id].isDestroyed()) { loginWins[id].close(); delete loginWins[id]; }
  const w = new BrowserWindow({
    width: 520, height: 760, title: `登录 ${def.name}`, backgroundColor: "#ffffff", autoHideMenuBar: true,
    icon: process.platform === "win32" ? path.join(__dirname, "assets", "icon.png") : undefined,
    webPreferences: { session: webSession, contextIsolation: true, sandbox: true },
  });
  loginWins[id] = w;
  // 企业 SSO 账号（如腾讯）：直接打开企业专属登录，自动走 iOA 认证，不需要手机号 / 扫码
  w.loadURL(id === "workbuddy" && !idp ? wbBase() + "/console/accounts" : def.login, { userAgent: CHROME_UA });
  // WorkBuddy 登录页默认只显示手机号；微信 / 企业微信（腾讯 OneID）入口在页面里以「其他方式」链接存在。
  // 选了登录方式时，到达登录页后直接跳到对应的身份提供方，不用在小窗口里找图标。
  if (id === "workbuddy" && idp && /^[a-z]+$/.test(idp)) {
    let jumped = false;
    w.webContents.on("did-finish-load", async () => {
      if (jumped || w.isDestroyed()) return;
      const u = w.webContents.getURL();
      if (!/\/auth\/realms\/[^/]+\/protocol\/openid-connect\/auth/.test(u)) return;
      try {
        const href = await w.webContents.executeJavaScript(`(()=>{const a=[...document.querySelectorAll('a[href]')].find(x=>x.getAttribute('href').includes('/broker/${idp}/login'));return a?a.href:'';})()`);
        if (href) { jumped = true; w.loadURL(href, { userAgent: CHROME_UA }); }
      } catch { /* ignore */ }
    });
  }
  w.webContents.setWindowOpenHandler(({ url }) => { w.loadURL(url, { userAgent: CHROME_UA }); return { action: "deny" }; });
  // 登录成功（拿到会话 Cookie 并跳到主页面）后自动关闭
  const check = async () => {
    const u = w.isDestroyed() ? "" : w.webContents.getURL();
    if (/login|signin|auth|passport|sso|oauth/i.test(u)) return;
    const ok = id === "workbuddy" ? await wbLoggedIn() : (await webStatus())[id];
    if (ok) setTimeout(() => !w.isDestroyed() && w.close(), 800);
  };
  w.webContents.on("did-navigate", check);
  w.webContents.on("did-navigate-in-page", check);
  // 内网登录页被 iOA 拦截时（ERR_SSL_PROTOCOL_ERROR），不要留一个空白窗口，给出说明
  w.webContents.on("did-fail-load", (_e, code, _desc, url, isMain) => {
    if (!isMain || !/woa\.com|oa\.com/.test(String(url)) || !/^-1(0[0-9]|1[0-9])$/.test(String(code))) return;
    log(`[login] ${id} 内网登录页加载失败 ${code} ${String(url).split("?")[0]}`);
    const html = `<meta charset="utf-8"><body style="font:14px/1.7 -apple-system,'Microsoft YaHei UI',sans-serif;padding:28px;color:#222">
      <h3 style="margin:0 0 12px">登录页被 iOA 拦截了</h3>
      <p>企业登录需要访问公司内网（${String(url).split("/")[2]}），但 iOA 不允许本程序访问内网 HTTPS，所以页面是空白的。</p>
      <p><b>解决办法</b>：在 iOA 里给 <code>AI Usage Monitor.exe</code> 授信（或联系 IT 8000 申请放行），然后重新点「企业登录（iOA）」。</p>
      <p style="color:#888">BoxAI 不受影响：它的额度查询已经通过系统自带的 PowerShell 代发请求。</p></body>`;
    w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  });
  w.on("closed", async () => {
    delete loginWins[id];
    if (id === "codex") resetCodexBlock();
    engine.refreshNow(id);
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send("web-status", await webStatus());
  });
  if (process.platform === "darwin") app.focus({ steal: true });
}

async function logoutWeb(id) {
  const dom = id === "claude" ? "claude.ai" : id === "cursor" ? "cursor.com" : id === "codex" ? "chatgpt.com" : id === "workbuddy" ? "workbuddy.cn" : null;
  if (!dom) return;
  const all = await webSession.cookies.get({});
  for (const c of all) {
    if (!c.domain || !c.domain.replace(/^\./, "").endsWith(dom)) continue;
    const url = `https://${c.domain.replace(/^\./, "")}${c.path || "/"}`;
    try { await webSession.cookies.remove(url, c.name); } catch { /* ignore */ }
  }
  engine.refreshNow(id);
}

// ---------------- 代理 ----------------
async function applyProxy() {
  const p = (store.cfg.proxy || "").trim();
  const conf = !p ? { mode: "system" } : /^direct$/i.test(p) ? { mode: "direct" } : { proxyRules: /:\/\//.test(p) ? p : "http://" + p };
  for (const s of [session.defaultSession, webSession]) { try { await s.setProxy(conf); } catch { /* ignore */ } }
}

// ---------------- 菜单栏图标 ----------------
function trayIcon() {
  const name = process.platform === "darwin" ? "trayTemplate.png" : process.platform === "win32" ? "tray-win.png" : "tray.png";
  const p = path.join(__dirname, "assets", name);
  const img = nativeImage.createFromPath(p);
  if (process.platform === "darwin") img.setTemplateImage(true);
  return img;
}

function buildMenu() {
  const c = store.cfg;
  return Menu.buildFromTemplate([
    { label: overlay && overlay.isVisible() ? "隐藏悬浮条" : "显示悬浮条", click: () => { if (overlay.isVisible()) overlay.hide(); else { overlay.showInactive(); keepOnTop(); } refreshTrayMenu(); }, accelerator: hotkey.active || undefined, registerAccelerator: false },
    { label: "立即刷新", accelerator: "CmdOrCtrl+R", click: () => engine.refreshNow() },
    { type: "separator" },
    { label: "展示样式", submenu: [
      { label: "极简（悬停弹出气泡）", type: "radio", checked: c.style === "minimal", click: () => updateCfg({ style: "minimal" }) },
      { label: "详细（点击展开完整面板）", type: "radio", checked: c.style === "detail", click: () => updateCfg({ style: "detail" }) },
    ] },
    { label: "位置", submenu: [
      { label: "吸附屏幕右侧", type: "radio", checked: c.dock.mode === "edge" && c.dock.edge === "right", click: () => updateCfg({ dock: { ...c.dock, mode: "edge", edge: "right" } }) },
      { label: "吸附屏幕左侧", type: "radio", checked: c.dock.mode === "edge" && c.dock.edge === "left", click: () => updateCfg({ dock: { ...c.dock, mode: "edge", edge: "left" } }) },
      { label: "吸附屏幕顶部（横向）", type: "radio", checked: c.dock.mode === "edge" && c.dock.edge === "top", click: () => updateCfg({ dock: { ...c.dock, mode: "edge", edge: "top" } }) },
      { label: "自由摆放", type: "radio", checked: c.dock.mode === "float", click: () => updateCfg({ dock: { ...c.dock, mode: "float" } }) },
      { type: "separator" },
      ...screen.getAllDisplays().map((d, i) => ({ label: `显示在屏幕 ${i + 1}（${d.size.width}×${d.size.height}）`, type: "radio", checked: targetDisplay().id === d.id, click: () => { updateCfg({ dock: { ...store.cfg.dock, displayId: d.id } }); fitOverlay(); } })),
    ] },
    { label: `大小（当前 ${Math.round((c.zoom || 1) * 100)}%，竖条上滚动滚轮可调）`, submenu: [
      { label: "放大", accelerator: "CmdOrCtrl+=", click: () => updateCfg({ zoom: Math.min(2, Math.round(((store.cfg.zoom || 1) + 0.1) * 100) / 100) }) },
      { label: "缩小", accelerator: "CmdOrCtrl+-", click: () => updateCfg({ zoom: Math.max(0.6, Math.round(((store.cfg.zoom || 1) - 0.1) * 100) / 100) }) },
      { label: "恢复默认（100%）", accelerator: "CmdOrCtrl+0", click: () => updateCfg({ zoom: 1 }) },
      { type: "separator" },
      ...[0.8, 1, 1.2, 1.5].map((z) => ({ label: Math.round(z * 100) + "%", type: "radio", checked: Math.abs((c.zoom || 1) - z) < 0.001, click: () => updateCfg({ zoom: z }) })),
    ] },
    { type: "separator" },
    { label: "设置…", accelerator: "CmdOrCtrl+,", click: openSettings },
    { label: "退出", accelerator: "CmdOrCtrl+Q", click: () => app.exit(0) },
  ]);
}

function refreshTrayMenu() { if (tray) tray.setContextMenu(buildMenu()); }

function updateTray(list) {
  if (!tray) return;
  const live = list.filter((s) => s.enabled && (s.state === "ok" || s.state === "stale"));
  const top = live.sort((a, b) => b.headline - a.headline)[0];
  tray.setTitle(store.cfg.trayPercent && top ? ` ${Math.round(top.headline)}%` : "");
  tray.setToolTip(live.map((s) => `${s.short} ${Math.round(s.headline)}%`).join("  ") || "AI 用量监控");
}

// ---------------- 配置 ----------------
function updateCfg(patch) {
  store.normalize();
  const before = JSON.stringify(store.cfg);
  const structural = !!(patch.providers || patch.order || patch.customs);
  // 注意：providers 必须「逐个合并」，不能整体覆盖。
  // 旧版先 Object.assign 整体替换，关闭一个 AI 后其余 AI 的配置全部丢失 → tick 读到 undefined 崩溃。
  const { providers: pPatch, ...rest } = patch;
  Object.assign(store.cfg, rest);
  if (pPatch) for (const id of Object.keys(pPatch)) store.cfg.providers[id] = { ...(store.cfg.providers[id] || {}), ...pPatch[id] };
  store.normalize();
  store.saveCfg();
  if (patch.autoStart !== undefined && process.platform !== "linux") app.setLoginItemSettings({ openAtLogin: !!store.cfg.autoStart, openAsHidden: true });
  if (patch.proxy !== undefined) applyProxy();
  if (patch.hotkey !== undefined) registerHotkey();
  if (patch.dock !== undefined) fitOverlay(); // 贴顶部（macOS）时悬浮层要盖住菜单栏
  if (structural || patch.refreshSeconds || patch.smartRefresh !== undefined || patch.proxy !== undefined) engine.resetSchedule();
  if (before !== JSON.stringify(store.cfg)) { sendConfig(); refreshTrayMenu(); broadcast(); }
}

// ---------------- IPC ----------------
function ipc() {
  ipcMain.handle("state", () => ({ list: engine.list(), cfg: store.cfg, version: app.getVersion(), platform: process.platform }));
  ipcMain.on("ignore", (_e, ignore) => { if (overlay && !overlay.isDestroyed()) overlay.setIgnoreMouseEvents(!!ignore, { forward: true }); });
  ipcMain.handle("refresh", (_e, id) => engine.refreshNow(id || undefined));
  ipcMain.handle("consume-reset", (_e, { id, creditId }) => engine.consumeReset(id, creditId));
  ipcMain.handle("custom-presets", () => ({ presets: custom.PRESETS, fields: custom.FIELDS }));
  ipcMain.handle("custom-test", (_e, c) => custom.testCustom(c));
  ipcMain.handle("custom-add", (_e, c) => {
    store.normalize();
    const s = custom.sanitize({ ...c, id: custom.newId() });
    if (!s) return { ok: false, message: "配置无效" };
    updateCfg({ customs: [...store.cfg.customs, s], order: [...store.cfg.order, s.id] });
    return { ok: true, id: s.id };
  });
  ipcMain.handle("custom-update", (_e, c) => {
    store.normalize();
    const i = store.cfg.customs.findIndex((x) => x.id === (c && c.id));
    if (i < 0) return { ok: false, message: "找不到这个工具" };
    const s = custom.sanitize({ ...store.cfg.customs[i], ...c });
    if (!s) return { ok: false, message: "配置无效" };
    const customs = [...store.cfg.customs];
    customs[i] = s;
    updateCfg({ customs });
    engine.refreshNow(s.id);
    return { ok: true, id: s.id };
  });
  ipcMain.handle("custom-remove", (_e, id) => {
    store.normalize();
    // providers 里多余的条目由 normalize 自动清掉
    updateCfg({ customs: store.cfg.customs.filter((x) => x.id !== id), order: store.cfg.order.filter((x) => x !== id) });
    return { ok: true };
  });
  ipcMain.handle("open-url", (_e, u) => { if (/^https:\/\//.test(u)) shell.openExternal(u); });
  ipcMain.handle("open-task", (_e, ev) => openTask(ev));
  ipcMain.handle("clear-pulse", (_e, ai, why) => clearPulse(ai, why || "鼠标移到了图标上"));
  ipcMain.handle("pulses", () => pulses);
  ipcMain.handle("open-settings", () => openSettings());
  ipcMain.handle("save-config", (_e, patch) => updateCfg(patch));
  ipcMain.handle("hotkey", () => hotkey);
  ipcMain.handle("screen-info", () => screenInfo());
  ipcMain.handle("detected", () => (detector ? detector.found : {}));
  // 设置里录制新快捷键时先暂停全局快捷键，否则按下当前组合会被它截走
  ipcMain.handle("hotkey-pause", (_e, on) => { if (on) { hotkeyPaused = true; try { globalShortcut.unregisterAll(); } catch { /* ignore */ } } else registerHotkey(); });
  ipcMain.handle("login", (_e, id, idp) => openLogin(id, idp));
  ipcMain.handle("logout", (_e, id) => logoutWeb(id));
  ipcMain.handle("web-status", () => webStatus());
  ipcMain.handle("quit", () => app.exit(0));
  ipcMain.handle("log-path", () => logFile);
  ipcMain.handle("open-log", () => shell.showItemInFolder(logFile));
  // 拖拽结束：若松手位置在另一块屏幕上，把悬浮层挪过去
  ipcMain.handle("drag-end", (_e, { screenX, screenY, dock }) => {
    const d = screen.getDisplayNearestPoint({ x: Math.round(screenX), y: Math.round(screenY) });
    const cur = targetDisplay();
    if (d.id !== cur.id) {
      const wa = d.workArea;
      dock = { ...dock, displayId: d.id, mode: "float", x: Math.min(1, Math.max(0, (screenX - wa.x) / wa.width)), y: Math.min(1, Math.max(0, (screenY - wa.y) / wa.height)) };
      store.cfg.dock = dock;
      store.saveCfg();
      fitOverlay();
    } else {
      store.cfg.dock = { ...dock, displayId: cur.id };
      store.saveCfg();
      fitOverlay();
    }
    refreshTrayMenu();
    return store.cfg.dock;
  });
  ipcMain.handle("context-menu", () => { buildMenu().popup({ window: overlay }); });
}

// ---------------- 演示数据（截图 / 预览用） ----------------
function mockEngine() {
  const { EventEmitter } = require("events");
  const e = new EventEmitter();
  const now = Date.now();
  const hist = (a) => a.map((v, i) => ({ date: new Date(now - (6 - i) * 864e5).toISOString().slice(0, 10), value: v }));
  const W = (key, label, p, ms, mins, detail) => ({ key, label, usedPercent: p, resetsAt: now + ms, windowMinutes: mins || 0, detail: detail || "" });
  const b = (d, x) => ({ id: d.id, name: d.name, short: d.short, tagline: d.tagline, color: d.color, dashboard: d.dashboard, login: d.login || "", keyKind: d.keyKind || "", custom: !!d.custom, letter: d.letter || "", enabled: true, state: "ok", message: "", plan: "", account: "", source: "", primary: null, secondary: null, extra: [], headline: 0, headlineKey: "", resetCount: 0, planEndsAt: 0, credits: "", history: hist([0, 0, 0, 0, 0, 0, 0]), historyUnit: "峰值 %", activeDays: [true, true, false, false, false, false, false], updatedAt: now - 4000, ...x });
  const D = Object.fromEntries([...DEFS, ...EXTRA_DEFS].map((d) => [d.id, d]));
  const list = [
    b(D.claude, { plan: "Max 5x", account: "me@example.com", source: "Claude 网页登录", headline: 73, primary: W("5h", "当前会话", 73, 51 * 6e4 + 8000, 300), secondary: W("week", "所有模型 · 本周", 7, 3.5 * 864e5, 10080), extra: [W("week", "Opus · 本周", 3, 3.5 * 864e5, 10080)], resetCount: 2, history: hist([31, 88, 6, 63, 42, 26, 28]), historyUnit: "M tokens", activeDays: [true, true, true, false, false, false, true] }),
    b(D.codex, { plan: "Plus", account: "dev@example.com", source: "本地会话（实时）", headline: 21, primary: W("5h", "当前会话", 21, 3.2 * 36e5, 300), secondary: W("week", "所有模型 · 本周", 12, 5 * 864e5, 10080), resetCount: 3, resets: { available: 2, at: now, credits: [{ id: "c1", title: "完全重置（每周 + 5 小时）", expiresAt: now + 29 * 864e5 }, { id: "c2", title: "完全重置（每周 + 5 小时）", expiresAt: now + 30 * 864e5 }] }, history: hist([12, 30, 8, 22, 40, 18, 9]), historyUnit: "M tokens" }),
    b(D.cursor, { plan: "Pro", account: "me@cursor.dev", source: "Cursor 本机登录", headline: 52, planEndsAt: now + 13 * 864e5, secondary: W("month", "本月 · 套餐总额度", 52, 13 * 864e5, 0, "$10.40 / $20.00"), extra: [W("month", "Auto 模型 · 本月", 40, 13 * 864e5), W("month", "API 模型 · 本月", 12, 13 * 864e5)], history: hist([30, 34, 38, 41, 45, 49, 52]) }),
    b(D.boxai, { plan: "个人 Token 池", account: "berrieslan", source: "BoxAI 额度接口", headline: 1.2, primary: W("month", "本月 · Token 额度", 1.2, 29 * 864e5, 0, "已用 6211 / 50.0 万"), extra: [W("activity", "活动额度", 100, 0, 0, "已用 1400 / 1400")] }),
    b(D.workbuddy, { plan: "Tencent", account: "berrieslan", source: "WorkBuddy 网页登录", headline: 34, primary: W("month", "本月 · 企业额度", 34, 18 * 864e5, 0, "剩余 6600 / 1.0 万") }),
    b(D.deepseek, { plan: "按量付费", source: "自动识别（Claude Code 设置）", headline: 0, headlineText: "¥86.50", primary: { key: "balance", label: "账户余额", usedPercent: 0, resetsAt: 0, windowMinutes: 0, detail: "余额 ¥86.50（赠送 ¥10.00，充值 ¥76.50）" } }),
    b(D.hunyuan, { plan: "我的混元套餐", account: "1000001", source: "腾讯云 TokenHub", headline: 25, planEndsAt: now + 148 * 864e5, primary: { key: "plan", label: "Token Plan · 套餐额度", usedPercent: 25, resetsAt: 0, windowMinutes: 0, detail: "已用 25.0 万 / 100.0 万 credits，2027-04-01 到期" } }),
    b(D.gemini, { state: "nologin", message: "没有检测到 Gemini CLI 的 Google 登录。" }),
    b(D.copilot, { state: "nologin", message: "没有找到 Copilot 令牌。" }),
    b(D.kimi, { state: "nologin", message: "在设置里填写 Kimi Code 的 API Key" }),
    b(D.glm, { state: "nologin", message: "在设置里填写智谱 GLM 的 API Key" }),
  ];
  e.list = () => list;
  e.def = (id) => D[id];
  e.sync = () => {};
  e.start = () => {};
  e.refreshNow = () => {};
  e.resetSchedule = () => {};
  e.pause = () => {};
  e.resume = () => {};
  e.consumeReset = async (id) => {
    const s = list.find((x) => x.id === id);
    if (!s || !s.resets || !s.resets.available) return { ok: false, code: "no_credit", message: "没有可用的重置次数" };
    s.resets = { ...s.resets, available: s.resets.available - 1, credits: s.resets.credits.slice(1) };
    if (s.primary) s.primary = { ...s.primary, usedPercent: 0 };
    if (s.secondary) s.secondary = { ...s.secondary, usedPercent: 0 };
    s.headline = 0;
    s.resetCount = (s.resetCount || 0) + 1;
    e.emit("update");
    return { ok: true, code: "reset", message: "重置成功，已恢复 2 个限额窗口" };
  };
  return e;
}

// ---------------- 诊断：用程序自己的网页登录会话探测 WorkBuddy 接口（只写日志，不含 Cookie 值） ----------------
async function diagWorkBuddy() {
  const out = [];
  const ck = await webSession.cookies.get({});
  out.push("cookies: " + ck.filter((c) => /workbuddy/.test(c.domain || "")).map((c) => `${c.domain}${c.path}:${c.name}`).join(", "));
  const snap = (() => { try { return JSON.parse(fs.readFileSync(path.join(require("os").homedir(), ".workbuddy", "storage", "skeleton", "account-snapshot.json"), "utf8")).primary || {}; } catch { return {}; } })();
  const ent = snap.enterpriseId || "";
  const probe = (method, p, body) => new Promise((resolve) => {
    const req = net.request({ url: wbBase() + p, method, session: webSession, useSessionCookies: true, redirect: "manual" });
    req.setHeader("Accept", "application/json");
    if (ent) { req.setHeader("X-Enterprise-Id", ent); req.setHeader("X-Tenant-Id", ent); }
    if (snap.uid) req.setHeader("X-User-Id", snap.uid);
    if (body) req.setHeader("Content-Type", "application/json");
    let redir = "";
    req.on("redirect", (_s, _m, url) => { redir = url; req.abort(); resolve(`${method} ${p} -> 302 ${url.slice(0, 120)}`); });
    req.on("response", (res) => {
      const ch = []; res.on("data", (c) => ch.push(c));
      res.on("end", () => {
        const t = Buffer.concat(ch).toString("utf8").replace(/("(?:[^"]*(?:token|key|secret|session)[^"]*)"\s*:\s*)"[^"]*"/gi, '$1"***"');
        resolve(`${method} ${p} -> ${res.statusCode} ${res.headers["content-type"] || ""} ${t.slice(0, 300).replace(/\s+/g, " ")}`);
      });
    });
    req.on("error", (e) => { if (!redir) resolve(`${method} ${p} -> ERR ${e.message}`); });
    if (body) req.write(body);
    req.end();
  });
  out.push(await probe("GET", "/console/accounts"));
  for (const p of ["/billing/meter/get-enterprise-user-usage", "/v2/billing/meter/get-enterprise-user-usage", "/console/billing/meter/get-enterprise-user-usage", "/console/v2/billing/meter/get-enterprise-user-usage", "/console/api/billing/meter/get-enterprise-user-usage", "/api/billing/meter/get-enterprise-user-usage"]) out.push(await probe("POST", p, "{}"));
  for (const l of out) log("[diag-wb] " + l);
}

// ---------------- 启动 ----------------
// 任务完成提醒：每 1.5 秒增量读一次各 AI 的本机会话记录，有任务完成 / 需要处理就推给悬浮条。
// 通知卡片 10 秒自动关闭；图标上的脉冲提醒会一直保留，直到：
//   ① 你切回了那个软件（前台窗口检测）  ② 点开了提醒  ③ 鼠标移到该图标上
let taskWatcher = null, fgWatcher = null, winActivator = null;
const pulses = {}; // ai -> {kind, key, title, at}
function sendPulses() { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("pulses", pulses); }
function clearPulse(ai, why) {
  if (!pulses[ai]) return;
  delete pulses[ai];
  log(`[task] 清除 ${ai} 提醒（${why}）`);
  sendPulses();
}
let fgApps = [];
function startForeground() {
  const { ForegroundWatcher, WindowActivator } = require("./core/foreground");
  winActivator = new WindowActivator(log).warm(); // 预热，点击提醒时即时切窗口
  fgWatcher = new ForegroundWatcher(log).start();
  // 切到了这个任务所在的软件 → 清除它的脉冲（只认脉冲出现之后的切换；本来就停在那里不算，等你悬停图标或点开提醒）
  fgWatcher.on("change", (name, apps) => {
    setTimeout(keepOnTop, 120); // 刚切到的窗口如果是置顶的，会盖住悬浮条
    fgApps = apps;
    const n = appKey(name);
    for (const [ai, p] of Object.entries(pulses)) {
      if (Date.now() - p.at < 1500) continue;
      const hit = p.app ? appKey(p.app) === n : apps.includes(ai);
      if (hit) clearPulse(ai, "切到了 " + name);
    }
  });
}
const appKey = (n) => String(n || "").trim().replace(/\.(exe|app)$/i, "").toLowerCase();

// ---------------- 自动识别本机的 AI ----------------
// 启动时、之后每 60 秒、以及主目录 / 应用程序目录有变化时扫描；新装或第一次登录的 AI 自动接入，不用手动配置。
let detector = null;
function startDetector() {
  // 从旧版升级：之前已经在用的 AI 不再提示「已自动接入」
  if (!Array.isArray(store.cfg.connected)) { store.cfg.connected = Object.keys(store.loadSnapshot() || {}); store.saveCfg(); }
  const { Detector } = require("./core/detect");
  detector = new Detector({ log, webSession });
  detector.on("changed", (ids) => {
    for (const id of ids) engine.refreshNow(id);
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send("detected", detector.found);
  });
  detector.on("claude-session", () => engine.refreshNow("claude"));
  detector.start();
  setTimeout(promptLogins, 40000);
}
function toast(ev) { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("task", { at: Date.now(), ...ev }); }
// 第一次拿到某个 AI 的数据：提示「已自动接入」（每个 AI 只提示一次）
function checkConnected() {
  const known = Array.isArray(store.cfg.connected) ? store.cfg.connected : [];
  const fresh = engine.list().filter((s) => s.enabled && s.state === "ok" && !s.fromCache && !known.includes(s.id));
  if (!fresh.length) return;
  store.cfg.connected = [...known, ...fresh.map((s) => s.id)];
  store.saveCfg();
  for (const s of fresh) {
    log(`[detect] 已自动接入 ${s.name}（${s.source || "本机登录"}）`);
    toast({ ai: s.id, kind: "found", label: s.name, title: s.name, preview: s.source ? "来源：" + s.source : "", key: "found:" + s.id });
  }
}
// 装了但读不到登录（例如只装了桌面版、钥匙串没允许）：提示一次「点此登录」，之后不再打扰
function promptLogins() {
  if (!detector) return;
  const asked = Array.isArray(store.cfg.loginPrompted) ? store.cfg.loginPrompted : [];
  const todo = engine.list().filter((s) => s.enabled && s.state === "nologin" && s.login && detector.found[s.id] && !asked.includes(s.id));
  if (!todo.length) return;
  store.cfg.loginPrompted = [...asked, ...todo.map((s) => s.id)];
  store.saveCfg();
  for (const s of todo) toast({ ai: s.id, kind: "login", label: s.name, title: `检测到 ${s.name}（${detector.found[s.id]}）`, preview: "还读不到它的登录，登录一次之后会自动显示用量", key: "login:" + s.id });
}

// 一条「完成 / 需要处理」提醒：图标脉冲 + 通知卡片
function onTaskEvent(ev) {
  const pc = store.cfg.providers[ev.ai];
  if (pc && pc.enabled === false) return; // 用户关掉的 AI 不提醒
  const looking = fgApps.includes(ev.ai);
  log(`[task] ${ev.ai} ${ev.kind} ${ev.title}${ev.chat ? "（对话）" : ""}${ev.hostApp ? " @" + ev.hostApp : ""}`);
  // 脉冲一直保留，直到：鼠标移到图标上 / 点开提醒 / 切到这个任务所在的软件。
  // 「需要处理」优先级高于「已完成」：同一个 AI 已有别的任务在等你处理时，不被覆盖
  const cur = pulses[ev.ai];
  if (!(cur && cur.kind === "input" && ev.kind === "done" && cur.key !== ev.key)) {
    const app = ev.hostApp || (ev.chat ? (ev.ai === "claude" ? "Claude" : "ChatGPT") : "");
    pulses[ev.ai] = { kind: ev.kind, key: ev.key, title: ev.title, at: ev.at || Date.now(), app };
  }
  sendPulses();
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send("task", { ...ev, looking });
}

let chatWatcher = null, paused = false; // 休眠 / 锁屏时暂停查询对话
function startChatWatcher() {
  const { ChatWatcher, claudeSource, chatgptSource, IDLE_MS, BUSY_MS } = require("./core/chatwatch");
  const P = require("./core/providers");
  const { requestJSON } = require("./core/http");
  const getCfg = () => store.cfg;
  chatWatcher = new ChatWatcher({
    sources: [
      claudeSource({ request: requestJSON, webSession, getCfg, SK_RE: P.SK_RE, webHeaders: P.webHeaders }),
      chatgptSource({ chatgptAuth: P.chatgptAuth, chatgptReq: P.chatgptReq, webSession }),
    ],
    front: () => (fgWatcher ? fgWatcher.cur : ""),
    log,
    enabled: (ai) => store.cfg.taskNotify !== false && !(store.cfg.providers[ai] && store.cfg.providers[ai].enabled === false),
  });
  const loop = async () => {
    try {
      if (store.cfg.taskNotify !== false && !paused) for (const ev of await chatWatcher.poll()) onTaskEvent(ev);
    } catch (e) { log("[chat] " + e.message); }
    setTimeout(loop, chatWatcher.busy() ? BUSY_MS : IDLE_MS);
  };
  setTimeout(loop, 3000);
}

function startTaskWatcher() {
  if (MOCK) return;
  const { TaskWatcher } = require("./core/tasks");
  taskWatcher = new TaskWatcher({ log, front: () => (fgWatcher ? fgWatcher.cur : "") });
  try { startChatWatcher(); } catch (e) { log("[chat] 启动失败 " + e.message); }
  try { if (!process.env.AIMON_NO_FG) startForeground(); } catch (e) { log("[fg] 启动失败 " + e.message); }
  const tick = () => {
    if (store.cfg.taskNotify === false) { if (Object.keys(pulses).length) { for (const k of Object.keys(pulses)) delete pulses[k]; sendPulses(); } return; }
    let evs = [];
    try { evs = taskWatcher.tick(); } catch (e) { log("[task] 扫描失败 " + e.message); return; }
    for (const ev of evs) onTaskEvent(ev);
  };
  setTimeout(tick, 500); // 第一轮只建立基线
  setInterval(tick, 1500);
}

// 点击提醒：优先把该软件已经打开的窗口直接切到最前（不重新启动、不新开窗口，几十毫秒）；
// 只有软件没在运行时才用它的链接把它打开。
async function openTask(ev) {
  if (!ev || !ev.ai) return false;
  clearPulse(ev.ai, "点开了提醒");
  if (!winActivator && !MOCK) { try { const { WindowActivator } = require("./core/foreground"); winActivator = new WindowActivator(log); } catch { /* ignore */ } }
  if (winActivator) {
    try { if (await winActivator.activateEvent(ev)) return true; } catch (e) { log("[task] 切换窗口失败 " + e.message); }
  }
  const link = ev.link;
  if (!link || !/^(codex|workbuddy|boxapp|codebuddy|codebuddycn):\/\/|^https:\/\/(claude\.ai|chatgpt\.com)\//.test(link)) return false;
  try { await shell.openExternal(link); log(`[task] 软件未运行，用链接打开 ${link.split("?")[0]}`); return true; } catch (e) { log(`[task] 跳转失败 ${link.split("?")[0]} ${e.message}`); return false; }
}

app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) app.dock.hide();
  const dir = process.env.AIMON_DATA || app.getPath("userData");
  logFile = path.join(dir, "log.txt");
  store = new Store(dir);
  if (process.env.AIMON_STYLE) store.cfg.style = process.env.AIMON_STYLE;
  if (process.env.AIMON_DOCK) store.cfg.dock = { ...store.cfg.dock, ...JSON.parse(process.env.AIMON_DOCK) };
  if (process.env.AIMON_ZOOM) store.cfg.zoom = Number(process.env.AIMON_ZOOM) || 1;
  webSession = session.fromPartition("persist:aimon");
  webSession.setUserAgent(CHROME_UA);
  session.defaultSession.setUserAgent(CHROME_UA);
  await applyProxy();
  if (process.env.AIMON_DIAG_WB) { try { const ok = await wbFinishSso(); log("[diag-wb] 静默补完登录: " + ok); await diagWorkBuddy(); } catch (e) { log("[diag-wb] 失败 " + e.message); } app.exit(0); return; }
  if (process.env.AIMON_DIAG_LOGIN) {
    // 自检：打开登录窗口并自动跳到指定登录方式，记录最终落到的页面后退出
    engine = { def: () => null, refreshNow: () => {} };
    openLogin("workbuddy", process.env.AIMON_DIAG_LOGIN);
    setTimeout(() => { const w = loginWins.workbuddy; log(`[diag-login] ${process.env.AIMON_DIAG_LOGIN} -> ${w && !w.isDestroyed() ? w.webContents.getURL().split("?")[0] : "closed"}`); app.exit(0); }, 12000);
    return;
  }
  engine = MOCK ? mockEngine() : new Engine(store, { webSession, isOnline: () => net.isOnline(), log, autoCfg: (id) => (detector ? detector.autoCfg(id) : null) }, log);
  engine.on("update", broadcast);
  if (!MOCK) engine.on("update", checkConnected);
  ipc();
  createOverlay();
  if (!SHOT) {
    tray = new Tray(trayIcon());
    tray.setContextMenu(buildMenu());
    // Windows：左键单击托盘图标也弹出菜单
    if (process.platform === "win32") tray.on("click", () => tray.popUpContextMenu());
  }
  if (!MOCK) { try { startDetector(); } catch (e) { log("[detect] 启动失败 " + e.message); } }
  engine.start();
  startTaskWatcher();
  registerHotkey();
  log(`==== 启动 v${app.getVersion()} ${process.platform} ${process.arch}`);
  if (process.env.AIMON_OPEN_SETTINGS) openSettings();

  // 休眠时暂停，唤醒/解锁后等网络恢复再刷新（避免唤醒瞬间的「无法连接」）
  if (!MOCK) {
    powerMonitor.on("suspend", () => { paused = true; engine.pause(); log("休眠，暂停刷新"); });
    powerMonitor.on("resume", () => { paused = false; engine.resume(); log("唤醒，稍后刷新"); setTimeout(keepOnTop, 1500); });
    powerMonitor.on("lock-screen", () => { paused = true; engine.pause(); });
    powerMonitor.on("unlock-screen", () => { paused = false; engine.resume(); setTimeout(keepOnTop, 800); });
  }

  screen.on("display-removed", () => { fitOverlay(); refreshScreens(); });
  screen.on("display-added", () => { fitOverlay(); refreshTrayMenu(); refreshScreens(); });
  screen.on("display-metrics-changed", () => { fitOverlay(); refreshScreens(); });
  refreshScreens();
});

app.on("second-instance", () => { if (overlay) { overlay.showInactive(); keepOnTop(); } openSettings(); });
app.on("window-all-closed", (e) => e.preventDefault());
app.on("will-quit", () => { try { globalShortcut.unregisterAll(); } catch { /* ignore */ } try { if (detector) detector.stop(); } catch { /* ignore */ } });
app.on("will-quit", () => { try { if (fgWatcher) fgWatcher.stop(); if (winActivator) winActivator.stop(); } catch { /* ignore */ } });
