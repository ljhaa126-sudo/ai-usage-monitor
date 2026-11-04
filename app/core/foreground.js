"use strict";
// 前台应用检测：告诉主进程「用户当前切到了哪个软件」，用来清除对应图标上的「已完成」脉冲提醒。
// 只读取前台窗口所属的进程名，不读窗口内容、不截屏、不需要额外权限。
//   Windows：常驻一个隐藏的 PowerShell，调用 user32 GetForegroundWindow，前台变化时输出进程名
//   macOS  ：系统自带的 lsappinfo（无需「辅助功能 / 自动化」授权）
//   Linux  ：有 xdotool 就用，没有就不支持（只能靠鼠标悬停或点击提醒来清除）
const { spawn, execFile } = require("child_process");
const { EventEmitter } = require("events");

// 各 AI 的界面对应哪些进程名（小写、去掉 .exe）
const APP_MATCH = {
  codex: /^(codex|chatgpt)$/,                 // Codex 桌面版（Windows 上进程名是 ChatGPT）
  workbuddy: /^workbuddy$/,
  codebuddy: /^codebuddy( cn)?$/,
  boxai: /^(box|box ai studio|boxai)$/,
  // Claude Code 跑在终端 / 编辑器里：切回任意终端或编辑器即视为回到了它
  claude: /^(claude|windowsterminal|wt|cmd|powershell|pwsh|conhost|openconsole|mintty|code|code - insiders|visual studio code|cursor|windsurf|terminal|iterm2|warp|wezterm(-gui)?|alacritty|kitty|ghostty|tabby|hyper|rio)$/,
};
// 点击提醒时要切到前台的窗口：各系统里对应的进程名 / 应用名（按优先级）
const ACTIVATE = {
  win32: {
    codex: ["ChatGPT", "Codex"], workbuddy: ["WorkBuddy"], codebuddy: ["CodeBuddy CN", "CodeBuddy"], boxai: ["Box"],
    claude: ["Claude", "WindowsTerminal", "Code", "Cursor", "Windsurf", "powershell", "pwsh", "cmd"],
  },
  darwin: {
    codex: ["Codex", "ChatGPT"], workbuddy: ["WorkBuddy"], codebuddy: ["CodeBuddy", "CodeBuddy CN"], boxai: ["Box AI Studio", "Box", "BoxAI"],
    claude: ["Claude", "iTerm", "Warp", "Ghostty", "WezTerm", "Terminal", "Visual Studio Code", "Cursor"],
  },
  linux: {
    codex: ["codex", "chatgpt"], workbuddy: ["workbuddy"], codebuddy: ["codebuddy"], boxai: ["box"],
    claude: ["gnome-terminal", "konsole", "kitty", "alacritty", "wezterm", "code", "cursor", "xterm"],
  },
};

// Windows：常驻一个隐藏的 PowerShell 专门负责「把某个程序的窗口切到最前」。
// 预先编译好 user32 调用，点击时只需一行命令，几十毫秒内完成，不会重新启动程序 / 新开窗口。
const WIN_ACTIVATOR = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class AimonAct {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte sc, uint fl, UIntPtr ex);
  public static bool Activate(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    if (IsIconic(h)) ShowWindow(h, 9); else if (!IsWindowVisible(h)) ShowWindow(h, 5);
    if (GetForegroundWindow() == h) return true;
    // Windows 不允许后台程序随意抢前台：先模拟一次 Alt 键解除限制，再切换
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
    if (GetForegroundWindow() != h) {
      uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero), me = GetCurrentThreadId();
      AttachThreadInput(me, fg, true); BringWindowToTop(h); SetForegroundWindow(h); AttachThreadInput(me, fg, false);
    }
    return GetForegroundWindow() == h;
  }
}
"@
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $res = 'NONE'
  foreach ($n in $line.Split([char]124)) {
    if (-not $n) { continue }
    # 同名进程很多（Electron 多进程）：取有主窗口、最近启动的那个
    $p = Get-Process -Name $n | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
    if ($p) { if ([AimonAct]::Activate($p.MainWindowHandle)) { $res = 'OK ' + $n } else { $res = 'TRIED ' + $n }; break }
  }
  [Console]::Out.WriteLine($res); [Console]::Out.Flush()
}`;

class WindowActivator {
  constructor(log = () => {}) { this.log = log; this.proc = null; this.queue = []; this.buf = ""; this.ready = null; }

  // 提前启动（编译 user32 调用约 1 秒），点击时就是即时的
  warm() { if (process.platform === "win32") this.ensureWin(); return this; }

  ensureWin() {
    if (this.proc) return this.ready;
    const enc = Buffer.from(WIN_ACTIVATOR, "utf16le").toString("base64");
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    this.proc = p;
    let readyRes;
    this.ready = new Promise((r) => { readyRes = r; setTimeout(() => r(false), 8000); });
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line === "READY") { readyRes(true); continue; }
        const q = this.queue.shift();
        if (q) { clearTimeout(q.t); q.res(line); }
      }
    });
    p.on("exit", () => { this.proc = null; this.ready = null; for (const q of this.queue.splice(0)) { clearTimeout(q.t); q.res("NONE"); } });
    p.stdin.on("error", () => {});
    return this.ready;
  }

  async activateWin(names) {
    await this.ensureWin();
    if (!this.proc) return false;
    const line = await new Promise((res) => {
      const q = { res, t: setTimeout(() => { const i = this.queue.indexOf(q); if (i >= 0) this.queue.splice(i, 1); res("TIMEOUT"); }, 3000) };
      this.queue.push(q);
      this.proc.stdin.write(names.join("|") + "\n");
    });
    this.log("[fg] 切换窗口 " + names[0] + " → " + line);
    return /^(OK|TRIED)/.test(line); // TRIED：找到了窗口但系统没让它到最前（任务栏会闪烁提示），也算已处理
  }

  run(cmd, args) {
    return new Promise((res) => execFile(cmd, args, { timeout: 3000 }, (err, out) => res({ ok: !err, out: String(out || "") })));
  }

  async macFrontPid() {
    const r = await this.run("/usr/bin/lsappinfo", ["front"]);
    const asn = r.out.trim();
    if (!r.ok || !asn) return 0;
    const i = await this.run("/usr/bin/lsappinfo", ["info", "-only", "pid", asn]);
    const m = /"pid"\s*=\s*(\d+)/.exec(i.out);
    return m ? Number(m[1]) : 0;
  }

  // macOS：把指定的 App 切到最前（等同于点 Dock 图标；新版 macOS 后台激活被忽略时用 AppleScript activate 补一次）
  async macActivate(app, ai, how) {
    let o = app.bundleId ? await this.run("/usr/bin/open", ["-b", app.bundleId]) : { ok: false };
    if (!o.ok) o = await this.run("/usr/bin/open", [app.path]);
    await new Promise((r) => setTimeout(r, 250));
    let front = await this.macFrontPid();
    let via = "open";
    if (app.pid && front !== app.pid) {
      const id = app.bundleId ? `application id "${app.bundleId.replace(/"/g, "")}"` : `application "${String(app.name).replace(/"/g, "")}"`;
      await this.run("/usr/bin/osascript", ["-e", `tell ${id} to activate`]);
      await new Promise((r) => setTimeout(r, 200));
      front = await this.macFrontPid();
      via = "open+activate";
    }
    this.log(`[fg] 切换窗口 ${ai} → ${app.name}（依据：${how}）${via} ${!app.pid || front === app.pid ? "OK" : "前台未变化(pid " + front + ")"}`);
    return true;
  }

  // macOS：找到真正在跑这个会话的 claude / codex 进程，顺着父进程找到它所在的 App
  //（终端、VS Code / Cursor、Claude 桌面版、Codex 桌面版……）。只用系统自带的 ps / lsof，不需要授权。
  async macHostBundle(ev) {
    const re = AGENT_PROC[ev.ai];
    if (!re || !ev.cwd || ev.chat) return null; // 没有工作目录就不靠进程树猜
    const [ps, args] = await Promise.all([this.run("/bin/ps", ["-axww", "-o", "pid=,ppid=,comm="]), this.run("/bin/ps", ["-axww", "-o", "pid=,args="])]);
    if (!ps.ok) return null;
    const procs = parsePs(ps.out, args.out);
    const cands = agentPids(procs, re);
    if (!cands.length) return null;
    let cwds = {};
    if (ev.cwd) {
      const l = await this.run("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn", "-p", cands.join(",")]);
      cwds = parseLsofCwd(l.out);
    }
    return hostBundle(procs, cands, cwds, ev.cwd);
  }

  // 点击任务提醒：切到「这个任务所在」的窗口
  //   ① 进程树（最准）：会话的工作目录 → 对应的 claude / codex 进程 → 它所在的 App
  //   ② 你发这条消息时所在的软件
  //   ③ 会话记录里的来源：桌面版 / 编辑器 / 终端
  //   ④ 旧规则（按优先级找正在运行的终端 / 编辑器 / 桌面版）
  async activateEvent(ev) {
    if (!ev || !ev.ai) return false;
    const plat = process.platform;
    try {
      if (plat === "darwin") {
        const r = await this.run("/usr/bin/lsappinfo", ["list"]);
        const apps = r.ok ? parseLsappinfo(r.out) : [];
        let app = null, how = "";
        try {
          const b = await this.macHostBundle(ev);
          if (b) { app = apps.find((a) => normPath(a.path) === b) || { name: b.split("/").pop().replace(/\.app$/i, ""), path: b, bundleId: "", pid: 0 }; how = "运行该任务的进程"; }
        } catch (e) { this.log("[fg] 进程树查找失败 " + e.message); }
        if (!app && ev.hostApp) { app = macFindByName(apps, ev.hostApp); if (app) how = "发消息时所在的软件"; }
        if (!app) for (const n of ev.chat ? [ev.ai === "claude" ? "Claude" : "ChatGPT"] : hostNames("darwin", ev)) { app = macFindByName(apps, n); if (app) { how = "会话来源（" + ev.host + "）"; break; } }
        if (!app && !ev.chat) { app = macFindApp(apps, ev.ai); how = "默认规则"; }
        if (!app) { this.log(`[fg] 切换窗口 ${ev.ai} → 未找到正在运行的应用`); return false; }
        return await this.macActivate(app, ev.ai, how);
      }
      if (plat === "win32") {
        const names = ev.chat
          ? [...new Set([ev.hostApp, ev.ai === "claude" ? "Claude" : "ChatGPT"].filter(Boolean))]
          : [...new Set([ev.hostApp, ...hostNames("win32", ev), ...((ACTIVATE.win32 || {})[ev.ai] || [])].filter(Boolean))];
        return await this.activateWin(names);
      }
    } catch (e) { this.log("[fg] 切换窗口失败 " + e.message); }
    return ev.chat ? false : this.activate(ev.ai);
  }

  // 把某个 AI 的窗口切到最前；找不到正在运行的窗口时返回 false（由调用方改用链接打开）
  async activate(ai) {
    const names = (ACTIVATE[process.platform] || ACTIVATE.linux)[ai];
    if (!names) return false;
    try {
      if (process.platform === "win32") return await this.activateWin(names);
      if (process.platform === "darwin") {
        const r = await this.run("/usr/bin/lsappinfo", ["list"]);
        const app = r.ok ? macFindApp(parseLsappinfo(r.out), ai) : null;
        if (!app) { this.log(`[fg] 切换窗口 ${ai} → 未找到正在运行的应用（lsappinfo ${r.ok ? "ok" : "失败"}）`); return false; }
        return await this.macActivate(app, ai, "默认规则"); // 已发出激活；即使系统没让它到最前，也不要再用链接新开一个
      }
      for (const n of names) {
        const r = await this.run("xdotool", ["search", "--onlyvisible", "--class", n, "windowactivate"]);
        if (r.ok) return true;
      }
    } catch (e) { this.log("[fg] 切换窗口失败 " + e.message); }
    return false;
  }

  stop() { if (this.proc) try { this.proc.kill(); } catch { /* ignore */ } }
}

// ---------------- 定位任务所在的软件 ----------------
// 运行会话的进程：Claude Code（原生二进制或 node 脚本）、Codex（CLI 或桌面版内置的 app-server）
const AGENT_PROC = {
  claude: /(^|\/)claude(-code)?$|@anthropic-ai\/claude-code|claude-code\/(cli|bin)/i,
  codex: /(^|\/)codex(-[a-z0-9_-]+)?$|@openai\/codex|\/codex app-server/i,
};
// 各种「来源」对应的软件名（按优先级）
const HOSTS = {
  darwin: {
    desktop: { claude: ["Claude"], codex: ["Codex", "ChatGPT"] },
    ide: ["Visual Studio Code", "Cursor", "Windsurf", "Code"],
    cli: ["iTerm2", "iTerm", "Warp", "Ghostty", "WezTerm", "Terminal", "kitty", "Alacritty", "Hyper", "Tabby"],
  },
  win32: {
    desktop: { claude: ["Claude"], codex: ["Codex", "ChatGPT"] },
    ide: ["Code", "Cursor", "Windsurf"],
    cli: ["WindowsTerminal", "pwsh", "powershell", "cmd"],
  },
};
function hostNames(plat, ev) {
  const h = HOSTS[plat];
  if (!h || !ev.host) return [];
  if (ev.host === "desktop") return h.desktop[ev.ai] || [];
  return h[ev.host] || [];
}
const normPath = (p) => String(p || "").replace(/\/+$/, "");

// ps -o pid=,ppid=,comm= 与 ps -o pid=,args= 合并为 {pid: {ppid, comm, args}}
function parsePs(commOut, argsOut) {
  const procs = {};
  for (const line of String(commOut || "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) procs[m[1]] = { ppid: Number(m[2]), comm: m[3], args: "" };
  }
  for (const line of String(argsOut || "").split("\n")) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (m && procs[m[1]]) procs[m[1]].args = m[2];
  }
  return procs;
}
// 正在跑会话的进程（排除各 App 自己的主程序，比如 Claude 桌面版本身）
function agentPids(procs, re) {
  return Object.keys(procs).filter((pid) => {
    const p = procs[pid];
    if (/\.app\/Contents\/MacOS\//i.test(p.comm)) return false;
    return re.test(p.comm) || re.test(String(p.args).split(/\s+--?\w/)[0]) || re.test(p.args);
  }).map(Number);
}
// lsof -Fpn 输出 → {pid: cwd}
function parseLsofCwd(out) {
  const m = {};
  let pid = null;
  for (const line of String(out || "").split("\n")) {
    if (line[0] === "p") pid = line.slice(1);
    else if (line[0] === "n" && pid) m[pid] = line.slice(1);
  }
  return m;
}
// 进程 → 往上找第一个位于 xxx.app 里的祖先，取最外层的 .app（VS Code 的 Helper 也会归到 Visual Studio Code.app）
function bundleOfChain(procs, pid) {
  for (let i = 0; i < 40 && pid > 1; i++) {
    const p = procs[pid];
    if (!p) break;
    const k = p.comm.toLowerCase().indexOf(".app/");
    if (k >= 0) {
      const b = p.comm.slice(0, k + 4);
      if (!/AI Usage Monitor\.app$/i.test(b)) return b;
    }
    pid = p.ppid;
  }
  return null;
}
function hostBundle(procs, cands, cwds, cwd) {
  let pick = cands;
  if (cwd) {
    const want = normPath(cwd);
    pick = cands.filter((p) => normPath(cwds[p]) === want);
    if (!pick.length) return null; // 对不上就不猜
  } else if (cands.length !== 1) return null;
  for (const pid of pick.sort((a, b) => b - a)) { // 同一目录开了多个：取最新的
    const b = bundleOfChain(procs, pid);
    if (b) return b;
  }
  return null;
}
// 按软件名找正在运行的 App（显示名 / .app 名 / 可执行文件名，忽略大小写）
function macFindByName(apps, name) {
  const n = norm(name);
  if (!n) return null;
  const isRealApp = (a) => /\.app\/?$/i.test(a.path) && !/\.app\/Contents\//i.test(a.path) && a.type !== "BackgroundOnly" && a.type !== "UIElement";
  const names = (a) => [a.name, a.path.replace(/\/$/, "").split("/").pop().replace(/\.app$/i, ""), a.exe].map(norm);
  return apps.find((a) => isRealApp(a) && names(a).includes(n)) || null;
}

// macOS：解析 `lsappinfo list`（系统自带，不需要任何授权）
function parseLsappinfo(text) {
  const apps = [];
  let cur = null;
  for (const line of String(text || "").split("\n")) {
    const h = /^\s*\d+\)\s+"([^"]*)"\s+ASN:/.exec(line);
    if (h) { cur = { name: h[1], bundleId: "", path: "", exe: "", pid: 0, type: "" }; apps.push(cur); continue; }
    if (!cur) continue;
    let m;
    if ((m = /bundleID="([^"]*)"/.exec(line))) cur.bundleId = m[1];
    if ((m = /bundle path="([^"]*)"/.exec(line))) cur.path = m[1];
    if ((m = /executable path="([^"]*)"/.exec(line))) cur.exe = m[1].split("/").pop();
    if ((m = /\bpid\s*=\s*(\d+)/.exec(line))) cur.pid = Number(m[1]);
    if ((m = /\btype="([^"]*)"/.exec(line))) cur.type = m[1];
  }
  return apps;
}
// 在正在运行的应用里找属于某个 AI 的（按显示名 / .app 名 / 可执行文件名匹配，只要有界面的前台类应用）
function macFindApp(apps, ai) {
  const re = APP_MATCH[ai];
  if (!re) return null;
  // 只要真正的 .app 应用：
  //  · 没有打包成 .app 的命令行程序（如 Codex 桌面版内部的 codex 进程、终端里跑的 codex / claude CLI），
  //    lsappinfo 给出的 bundle path 是可执行文件本身——对它执行 open 会弹出「终端」，必须排除；
  //  · 嵌在别的 .app 里面的 Helper（.../Xxx.app/Contents/...）也排除。
  const isRealApp = (a) => /\.app\/?$/i.test(a.path) && !/\.app\/Contents\//i.test(a.path);
  const hits = apps.filter((a) => a.type !== "BackgroundOnly" && a.type !== "UIElement" && isRealApp(a) &&
    [a.name, a.path.replace(/\/$/, "").split("/").pop().replace(/\.app$/i, ""), a.exe].some((n) => re.test(norm(n))));
  if (!hits.length) return null;
  // Claude Code：按 ACTIVATE 里的优先级挑终端 / 编辑器
  const pref = (ACTIVATE.darwin[ai] || []).map((x) => x.toLowerCase());
  const rank = (a) => { const i = pref.findIndex((p) => [a.name, a.exe].some((n) => norm(n).startsWith(p))); return i < 0 ? 99 : i; };
  return hits.sort((x, y) => rank(x) - rank(y))[0];
}

const norm = (n) => String(n || "").trim().replace(/\.exe$/i, "").toLowerCase();
const matchApps = (name) => { const n = norm(name); return Object.keys(APP_MATCH).filter((id) => APP_MATCH[id].test(n)); };

const WIN_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class AimonFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$last = ''
while ($true) {
  $h = [AimonFg]::GetForegroundWindow(); $p = 0
  [void][AimonFg]::GetWindowThreadProcessId($h, [ref]$p)
  $n = ''
  if ($p -gt 0) { $n = (Get-Process -Id $p).ProcessName }
  if ($n -ne $last) { [Console]::Out.WriteLine($n); [Console]::Out.Flush(); $last = $n }
  Start-Sleep -Milliseconds 700
}`;

class ForegroundWatcher extends EventEmitter {
  constructor(log = () => {}) { super(); this.log = log; this.cur = ""; this.stopped = false; this.fails = 0; }

  start() {
    if (process.platform === "win32") this.startWin();
    else if (process.platform === "darwin") this.startPoll(() => this.macFront());
    else this.startPoll(() => this.linuxFront());
    return this;
  }

  set(name) {
    const n = String(name || "").trim();
    if (!n || n === this.cur) return;
    this.cur = n;
    this.emit("change", n, matchApps(n));
  }

  startWin() {
    if (this.stopped) return;
    let p;
    try {
      // 用 -EncodedCommand 传脚本（从 stdin 传时 PowerShell 逐行解析，here-string 会失效）
      const enc = Buffer.from(WIN_SCRIPT, "utf16le").toString("base64");
      p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) { this.log("[fg] 无法启动 " + e.message); return; }
    this.proc = p;
    let buf = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { this.set(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    p.on("exit", () => {
      this.proc = null;
      if (this.stopped) return;
      this.fails++;
      if (this.fails > 5) { this.log("[fg] 前台检测多次退出，停用"); return; }
      setTimeout(() => this.startWin(), 3000 * this.fails);
    });
  }

  startPoll(fn) {
    const tick = () => { if (!this.stopped) fn().then((n) => this.set(n)).catch(() => {}).finally(() => { this.timer = setTimeout(tick, 1200); }); };
    tick();
  }

  run(cmd, args) {
    return new Promise((res) => execFile(cmd, args, { timeout: 2000 }, (err, out) => res(err ? "" : String(out))));
  }

  async macFront() {
    const asn = (await this.run("/usr/bin/lsappinfo", ["front"])).trim();
    if (!asn) return "";
    const info = await this.run("/usr/bin/lsappinfo", ["info", "-only", "name", asn]);
    const m = /"(?:LSDisplayName|CFBundleName)"\s*=\s*"([^"]+)"/.exec(info);
    return m ? m[1] : "";
  }

  async linuxFront() {
    const pid = (await this.run("xdotool", ["getactivewindow", "getwindowpid"])).trim();
    if (!/^\d+$/.test(pid)) return "";
    return (await this.run("ps", ["-o", "comm=", "-p", pid])).trim();
  }

  stop() { this.stopped = true; clearTimeout(this.timer); if (this.proc) try { this.proc.kill(); } catch { /* ignore */ } }
}

module.exports = { ForegroundWatcher, WindowActivator, matchApps, APP_MATCH, ACTIVATE, parseLsappinfo, macFindApp, parsePs, parseLsofCwd, agentPids, hostBundle, bundleOfChain, macFindByName, hostNames, AGENT_PROC };
