const fs = require("fs"), path = require("path");
const HOME = "/tmp/machome2"; fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
const W = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
W(`${HOME}/.codex/auth.json`, JSON.stringify({ tokens: { access_token: "tok" } }));
const http = require("../app/core/http");
let calls = {}, mode = "ok";
http.setTransport(async ({ url }) => {
  const h = new URL(url).host; calls[h] = (calls[h] || 0) + 1;
  if (url.includes("quota/limit")) {
    if (mode === "down") throw new Error("无法连接 open.bigmodel.cn：net::ERR_CONNECTION_RESET");
    return { status: 200, headers: {}, text: JSON.stringify({ data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 40 }] } }) };
  }
  if (url.includes("wham")) return { status: 200, headers: {}, text: JSON.stringify({ rate_limit: { primary_window: { used_percent: 10, reset_after_seconds: 999 } } }) };
  return { status: 404, headers: {}, text: "" };
});
const { Store } = require("../app/core/store");
const { Engine } = require("../app/core/engine");
fs.rmSync("/tmp/eng-data", { recursive: true, force: true });
const store = new Store("/tmp/eng-data");
store.cfg.providers.glm.apiKey = "k";
store.cfg.refreshSeconds = 5;
const eng = new Engine(store, { webSession: { cookies: { get: async () => [] } } });
const seen = {};
eng.on("update", () => { for (const s of eng.list()) { (seen[s.id] ||= []); const a = seen[s.id]; if (a[a.length - 1] !== s.state) a.push(s.state); } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // 1) 未连接的 AI 连续刷新多次，状态不应在 loading / nologin 间来回切
  for (let i = 0; i < 4; i++) { for (const id of ["gemini", "copilot", "kimi"]) await eng.refresh(id); }
  console.log("1) 状态序列:", ["gemini", "copilot", "kimi"].map((id) => `${id}=${seen[id].join(">")}`).join("  "));
  // 2) 偶发失败：有旧数据时前两次不报错，第三次才提示
  await eng.refresh("glm");
  mode = "down";
  const st = [];
  for (let i = 0; i < 3; i++) { await eng.refresh("glm"); const s = eng.status.glm; st.push(`${s.state}${s.lagging ? "(静默)" : ""}`); }
  console.log("2) 网络失败 3 次:", st.join(" > "), "| 消息:", eng.status.glm.message);
  console.log("   退避后下次刷新约在", Math.round((eng.sched.glm.nextAt - Date.now()) / 1000), "秒后；连续失败次数", eng.sched.glm.fails);
  mode = "ok"; await eng.refresh("glm");
  console.log("   恢复后:", eng.status.glm.state, Math.round(eng.status.glm.headline) + "%", "fails=" + eng.sched.glm.fails);
  // 3) Codex：本地会话日志新鲜时不联网
  W(`${HOME}/.codex/sessions/s.jsonl`, JSON.stringify({ timestamp: iso(Date.now()), type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 33, window_minutes: 300, resets_in_seconds: 900 } } } }) + "\n");
  calls = {};
  await eng.refresh("codex"); const c1 = calls["chatgpt.com"] || 0;
  await eng.refresh("codex"); await eng.refresh("codex"); const c2 = calls["chatgpt.com"] || 0;
  console.log(`3) Codex 3 次刷新，联网 ${c2} 次（首次校准 ${c1} 次），当前 ${eng.status.codex.headline}% 来源=${eng.status.codex.source}`);
  // 4) 智能频率：闲置时放慢
  eng.startedAt = 0; eng.sched.kimi.activityAt = 0; eng.sched.kimi.changedAt = 0;
  console.log("4) 智能频率 闲置:", eng.interval("kimi") / 1000, "秒；有活动后:", (eng.activity("kimi", false), eng.interval("kimi") / 1000), "秒");
  // 5) 休眠暂停
  eng.pause(); let ran = false; const orig = eng.refresh; eng.refresh = async () => { ran = true; }; eng.sched.glm.nextAt = 0; eng.tick();
  console.log("5) 休眠中 tick 是否刷新:", ran); eng.resume(); eng.refresh = orig;
  // 6) 快照
  await sleep(2300);
  const snap = new Store("/tmp/eng-data").loadSnapshot();
  const e2 = new Engine(new Store("/tmp/eng-data"), {});
  console.log("6) 重启后立即可显示:", Object.keys(snap).join(","), "→", e2.list().filter((s) => s.primary || s.secondary).map((s) => s.id + ":" + s.state).join(","));
  process.exit(0);
})();
