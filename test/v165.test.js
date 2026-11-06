"use strict";
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const APP = process.argv[2];
const fg = require(path.join(APP, "core/foreground.js"));
let pass = 0;
const ok = (name) => { pass++; console.log("  ✓ " + name); };

// ---------- 1. 进程树：找到任务所在的 App ----------
{
  const comm = `
    1     0 /sbin/launchd
  500     1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
  501   500 login
  502   501 -zsh
  503   502 claude
  600     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron
  601   600 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)
  602   601 /Users/me/.vscode/extensions/anthropic.claude-code-2.1.0/resources/native-binary/claude
  700     1 /Applications/Claude.app/Contents/MacOS/Claude
  701   700 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper
  702   701 /Users/me/Library/Application Support/Claude/claude-code/2.1.0/claude
  800     1 tmux
  801   800 -zsh
  802   801 node
  900     1 /Applications/Codex.app/Contents/MacOS/Codex
  901   900 /Applications/Codex.app/Contents/Resources/codex
  950     1 /Applications/AI Usage Monitor.app/Contents/MacOS/AI Usage Monitor`;
  const args = `
  503 claude
  602 /Users/me/.vscode/extensions/anthropic.claude-code-2.1.0/resources/native-binary/claude --output-format stream-json
  702 /Users/me/Library/Application Support/Claude/claude-code/2.1.0/claude --print
  802 node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js
  901 /Applications/Codex.app/Contents/Resources/codex app-server`;
  const procs = fg.parsePs(comm, args);
  const cl = fg.agentPids(procs, fg.AGENT_PROC.claude).sort();
  assert.deepStrictEqual(cl, [503, 602, 702, 802]);
  ok("找出所有 Claude Code 进程（排除 Claude 桌面版主程序）");
  const cwds = fg.parseLsofCwd("p503\nfcwd\nn/Users/me/proj-a\np602\nfcwd\nn/Users/me/proj-b\np702\nfcwd\nn/Users/me/proj-c\np802\nfcwd\nn/Users/me/proj-d\n");
  assert.strictEqual(fg.hostBundle(procs, cl, cwds, "/Users/me/proj-a"), "/System/Applications/Utilities/Terminal.app");
  ok("终端里的任务 → Terminal");
  assert.strictEqual(fg.hostBundle(procs, cl, cwds, "/Users/me/proj-b/"), "/Applications/Visual Studio Code.app");
  ok("VS Code 插件里的任务 → Visual Studio Code（Helper 归到外层 App）");
  assert.strictEqual(fg.hostBundle(procs, cl, cwds, "/Users/me/proj-c"), "/Applications/Claude.app");
  ok("Claude 桌面版里的任务 → Claude（不再跳终端）");
  assert.strictEqual(fg.hostBundle(procs, cl, cwds, "/Users/me/proj-d"), null);
  ok("tmux 里的任务（找不到所属 App）→ 交给下一步，不乱猜");
  assert.strictEqual(fg.hostBundle(procs, cl, cwds, "/Users/me/other"), null);
  ok("目录对不上 → 不乱猜");
  const cx = fg.agentPids(procs, fg.AGENT_PROC.codex);
  assert.deepStrictEqual(cx, [901]);
  assert.strictEqual(fg.hostBundle(procs, cx, {}, ""), "/Applications/Codex.app");
  ok("Codex 桌面版 → Codex");
}

// ---------- 2. 按名字找 App / 来源提示 ----------
{
  const apps = [
    { name: "Terminal", path: "/System/Applications/Utilities/Terminal.app", bundleId: "com.apple.Terminal", exe: "Terminal", pid: 500, type: "Foreground" },
    { name: "Code", path: "/Applications/Visual Studio Code.app", bundleId: "com.microsoft.VSCode", exe: "Electron", pid: 600, type: "Foreground" },
    { name: "Claude", path: "/Applications/Claude.app", bundleId: "com.anthropic.claudefordesktop", exe: "Claude", pid: 700, type: "Foreground" },
    { name: "Claude Helper", path: "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app", bundleId: "", exe: "", pid: 701, type: "UIElement" },
  ];
  assert.strictEqual(fg.macFindByName(apps, "Visual Studio Code").pid, 600);
  assert.strictEqual(fg.macFindByName(apps, "code").pid, 600);
  assert.strictEqual(fg.macFindByName(apps, "Claude").pid, 700);
  assert.strictEqual(fg.macFindByName(apps, "Cursor"), null);
  ok("按显示名 / .app 名找到正在运行的 App");
  assert.deepStrictEqual(fg.hostNames("darwin", { ai: "claude", host: "desktop" }), ["Claude"]);
  assert.ok(fg.hostNames("darwin", { ai: "codex", host: "ide" }).includes("Cursor"));
  assert.deepStrictEqual(fg.hostNames("darwin", { ai: "claude", host: "" }), []);
  ok("会话来源 → 候选软件");
}

// ---------- 3. activateEvent 的整体顺序（模拟 macOS 命令） ----------
(async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  const lsapp = `
1) "Terminal" ASN:0x0-0x1:
    bundleID="com.apple.Terminal"
    bundle path="/System/Applications/Utilities/Terminal.app"
    executable path="/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"
    pid = 500 type="Foreground" flavor=3 Version="1" fileType="APPL" creator="????"
2) "Claude" ASN:0x0-0x2:
    bundleID="com.anthropic.claudefordesktop"
    bundle path="/Applications/Claude.app"
    executable path="/Applications/Claude.app/Contents/MacOS/Claude"
    pid = 700 type="Foreground" flavor=3 Version="1" fileType="APPL" creator="????"
3) "Cursor" ASN:0x0-0x3:
    bundleID="com.todesktop.cursor"
    bundle path="/Applications/Cursor.app"
    executable path="/Applications/Cursor.app/Contents/MacOS/Cursor"
    pid = 650 type="Foreground" flavor=3 Version="1" fileType="APPL" creator="????"
`;
  const mk = (psComm, lsof) => {
    const a = new fg.WindowActivator(() => {});
    const calls = [];
    let front = 1;
    a.run = async (cmd, argv) => {
      calls.push([cmd, ...argv].join(" "));
      if (cmd.endsWith("lsappinfo") && argv[0] === "list") return { ok: true, out: lsapp };
      if (cmd.endsWith("lsappinfo")) return { ok: true, out: "" };
      if (cmd === "/bin/ps") return { ok: true, out: argv[2].includes("comm") ? psComm : "" };
      if (cmd === "/usr/sbin/lsof") return { ok: true, out: lsof };
      if (cmd === "/usr/bin/open") { const app = parse.find((x) => x.bundleId === argv[1]); if (app) front = app.pid; return { ok: true, out: "" }; }
      return { ok: true, out: "" };
    };
    a.macFrontPid = async () => front;
    return { a, calls, get front() { return front; } };
  };
  const parse = fg.parseLsappinfo(lsapp);
  assert.ok(parse.length === 3, "lsappinfo 解析 " + parse.length);

  // Claude 桌面版里跑的任务：以前固定跳 Terminal，现在应该到 Claude
  let t = mk("  1 0 /sbin/launchd\n 700 1 /Applications/Claude.app/Contents/MacOS/Claude\n 702 700 /Users/me/Library/Application Support/Claude/claude-code/2.1.0/claude\n 500 1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", "p702\nn/Users/me/x\n");
  await t.a.activateEvent({ ai: "claude", cwd: "/Users/me/x", host: "desktop", hostApp: "" });
  assert.strictEqual(t.front, 700, t.calls.join("\n"));
  ok("Claude 桌面版的任务 → 切到 Claude，而不是终端");

  // 进程树找不到（比如 tmux），但发消息时你在 Cursor 里
  t = mk("  1 0 /sbin/launchd", "");
  await t.a.activateEvent({ ai: "claude", cwd: "/Users/me/x", host: "cli", hostApp: "Cursor" });
  assert.strictEqual(t.front, 650);
  ok("退回到「发消息时所在的软件」");

  // 只知道来源是桌面版
  t = mk("  1 0 /sbin/launchd", "");
  await t.a.activateEvent({ ai: "claude", cwd: "", host: "desktop", hostApp: "" });
  assert.strictEqual(t.front, 700);
  ok("退回到「会话来源」");

  // 什么都不知道：默认规则现在也优先 Claude 桌面版
  t = mk("  1 0 /sbin/launchd", "");
  await t.a.activateEvent({ ai: "claude" });
  assert.strictEqual(t.front, 700);
  ok("默认规则");

  // 自己（监控程序）不能被当成「发消息时所在的软件」
  const { TaskWatcher } = require(path.join(APP, "core/tasks.js"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-"));
  let now = Date.now(), fa = "Visual Studio Code";
  const src = { id: "claude", roots: () => [dir], depth: 1, match: (n) => n.endsWith(".jsonl"), link: () => "" };
  const tw = new TaskWatcher({ sources: [src], now: () => now, front: () => fa });
  tw.tick();
  const f = path.join(dir, "s.jsonl");
  const line = (o) => fs.appendFileSync(f, JSON.stringify(o) + "\n");
  line({ type: "user", sessionId: "S1", cwd: "/Users/me/proj", entrypoint: "claude-vscode", message: { role: "user", content: "修一下登录 bug" } });
  tw.tick();
  fa = "AI 用量监控"; // 用户随后点了监控程序
  line({ type: "user", sessionId: "S1", cwd: "/Users/me/proj", entrypoint: "claude-vscode", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });
  line({ type: "assistant", sessionId: "S1", cwd: "/Users/me/proj", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "改好了" }] } });
  tw.tick();
  now += 7000;
  const evs = tw.tick();
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].cwd, "/Users/me/proj");
  assert.strictEqual(evs[0].host, "ide");
  assert.strictEqual(evs[0].hostApp, "Visual Studio Code");
  ok("任务提醒带上目录 / 来源 / 发消息时的软件");

  // ---------- 4. Codex：三种请求方式 + 本地兜底 ----------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cx-"));
  process.env.CODEX_HOME = tmp;
  fs.writeFileSync(path.join(tmp, "auth.json"), JSON.stringify({ tokens: { access_token: "tok", account_id: "acc" } }));
  const html403 = { status: 403, headers: { "content-type": "text/html" }, text: "<!DOCTYPE html><html>Just a moment...</html>" };
  const usage = { plan_type: "plus", rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 3600 }, secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_after_seconds: 86400 } } };
  const load = () => { for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(APP, "core"))) delete require.cache[k]; return { http: require(path.join(APP, "core/http.js")), prov: require(path.join(APP, "core/providers.js")) }; };

  let { http, prov } = load();
  let seen = [];
  http.setTransport(async (o) => { const way = o.via === "node" ? "node-cli" : /Mozilla/.test(o.headers["User-Agent"]) ? "web" : "net-cli"; seen.push(way); return way === "web" ? { status: 200, headers: {}, text: JSON.stringify(usage) } : html403; });
  let st = await prov.FETCHERS.codex({}, {});
  assert.strictEqual(st.source, "ChatGPT 在线接口");
  assert.deepStrictEqual(seen, ["node-cli", "web"]);
  ok("node-cli 被 Cloudflare 拦 → 自动换 web 方式成功");
  seen = [];
  await new Promise((r) => setTimeout(r, 5));
  st = await prov.FETCHERS.codex({}, {});
  assert.deepStrictEqual(seen, ["web"]);
  ok("下次直接用上次成功的方式");

  // 两台电脑：本机日志停在 33%（另一台电脑后来又用了），线上是账号的真实用量 70%
  ({ http, prov } = load());
  const sd = path.join(tmp, "sessions", "2026", "11", "06"); fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, "rollout-x.jsonl"), JSON.stringify({ timestamp: new Date(Date.now() - 30e3).toISOString(), type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: 33, window_minutes: 300, resets_in_seconds: 5000 }, secondary: { used_percent: 55, window_minutes: 10080, resets_in_seconds: 90000 } } } }) + "\n");
  const usage70 = { ...usage, rate_limit: { ...usage.rate_limit, primary_window: { ...usage.rate_limit.primary_window, used_percent: 70 } } };
  http.setTransport(async () => ({ status: 200, headers: {}, text: JSON.stringify(usage70) }));
  st = await prov.FETCHERS.codex({}, {});
  assert.strictEqual(st.primary.usedPercent, 70);
  assert.strictEqual(st.source, "ChatGPT 在线接口");
  ok("两台电脑都在用：始终取线上账号用量（70%），不用本机日志里的旧数值（33%）");

  // 全部被 Cloudflare 拦：报错（界面会显示上次的线上数据），不再拿本机日志顶替
  ({ http, prov } = load());
  seen = [];
  http.setTransport(async () => { seen.push(1); return html403; });
  await assert.rejects(prov.FETCHERS.codex({}, {}), /Cloudflare/);
  assert.strictEqual(seen.length, 3);
  ok("线上被拦 → 提示并显示上次的线上数据，不用本机日志");
  seen = [];
  await assert.rejects(prov.FETCHERS.codex({}, {}), /Cloudflare/);
  assert.strictEqual(seen.length, 0);
  ok("被拦后 15 分钟内不再撞墙");

  // 这台电脑上 Codex 的登录过期了，但登录过网页版 → 用网页登录查
  ({ http, prov } = load());
  const ws = { cookies: { get: async (q) => (q.name || "").includes("session-token") || !q.name ? [{ name: "__Secure-next-auth.session-token", value: "x" }] : [] } };
  http.setTransport(async (o) => {
    if (o.url.includes("/api/auth/session")) return { status: 200, headers: {}, text: JSON.stringify({ accessToken: "webtok", account: { id: "acc2" }, user: { email: "me@x.com" } }) };
    if ((o.headers.Authorization || "") === "Bearer tok") return { status: 401, headers: {}, text: '{"detail":"token expired"}' };
    return { status: 200, headers: {}, text: JSON.stringify(usage70) };
  });
  st = await prov.FETCHERS.codex({}, { webSession: ws });
  assert.strictEqual(st.primary.usedPercent, 70);
  assert.strictEqual(st.source, "ChatGPT 在线接口（网页登录）");
  ok("这台电脑上 Codex 登录过期 → 自动改用网页登录查线上用量");

  // 过期且没有网页登录 → 提示怎么恢复
  ({ http, prov } = load());
  http.setTransport(async () => ({ status: 401, headers: {}, text: '{"detail":"token expired"}' }));
  await assert.rejects(prov.FETCHERS.codex({}, {}), (e) => e.noLogin && /登录已过期/.test(e.message));
  ok("过期且没有网页登录 → 提示运行 codex 或登录网页版");

  console.log(`\n全部通过：${pass} 项`);
})().catch((e) => { console.error("✗", e); process.exit(1); });
