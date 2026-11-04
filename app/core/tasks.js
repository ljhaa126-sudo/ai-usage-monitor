"use strict";
// 任务完成提醒：监听各 AI 本机的会话记录，某个任务「完成」或「需要你处理」时发出事件。
// 只读本机日志，不联网。支持：Codex（桌面版 / CLI）、Claude Code、WorkBuddy、CodeBuddy、BoxAI（Box 客户端）。
// 通用性：日志位置都按各工具在 Windows / macOS / Linux 上的标准目录（用户主目录下）查找，不依赖本机特定路径；
// 某个工具没装就找不到它的目录，自动跳过。
//
// 判断规则（按各家日志格式）：
//   Codex      event_msg/task_started → 进行中；task_complete → 已完成；*approval_request / request_user_input → 需要处理
//   Claude     用户消息 / 工具调用 → 进行中；system/turn_duration 或 end_turn → 已完成；AskUserQuestion / ExitPlanMode → 需要处理
//   WorkBuddy  用户消息 / 工具调用 → 进行中；assistant 消息 completed → 已完成；AskUserQuestion 未答 → 需要处理
//   Box        用户消息 / 带工具调用的回复 → 进行中；不带工具调用的回复 → 已完成；ask_followup_question → 需要处理
//
// 防误报：程序启动前就存在的历史记录只用来建立状态，不提醒；必须在本程序运行期间看到「进行中」，
// 之后再出现「完成 / 需要处理」才提醒。「完成」要静默 2.5 秒（期间没有新动作）才确认，避免多步任务中途误报。
const fs = require("fs");
const path = require("path");
const util = require("./util");
// AIMON_TASK_HOME：测试用，把各 AI 的日志根目录指到别处
const home = () => process.env.AIMON_TASK_HOME || util.home();

const RECENT_MS = 6 * 3600e3;   // 只看 6 小时内有改动的会话
const HEAD_BYTES = 64 * 1024;   // 历史文件：读开头拿标题
const TAIL_BYTES = 384 * 1024;  // 历史文件：读末尾拿当前状态（标题取最后一条需求，在末尾附近）
const SETTLE = { done: 2500, input: 800 };

// ---------------- 文本工具 ----------------
function clean(s) {
  return String(s || "")
    .replace(/<(timestamp|attachments|system-reminder|environment_context|user-interjection|command-[a-z]+|local-command-[a-z]+)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]{1,40}>/g, " ")
    .replace(/\[使用Skills:[^\]]*\]|\[知识库:[^\]]*\]/g, " ")
    .replace(/`[^`]*\((file|image)[^)]*\)`/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const cut = (s, n = 60) => { const t = clean(s).replace(/^\S*\s*\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, ""); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
function textOf(content, types) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c && (!types || types.includes(c.type)) && typeof c.text === "string").map((c) => c.text).join(" ");
}
// Codex 桌面版会把附件列表和真正的需求拼在一起："# Files mentioned…  ## My request[ for Codex]: xxx"
function codexAsk(t) {
  const m = /##\s*My request(?: for Codex)?:\s*([\s\S]*)$/i.exec(t);
  if (m && m[1].trim()) return m[1];
  // 只有附件没有文字：用第一个附件名
  const f = /^##\s*([^:\n]+):/m.exec(t);
  return f ? "处理 " + f[1].trim() : t;
}
// 各种工具自动注入的「系统提示」开头，不是用户的任务名
const isSystemish = (t) => { const c = clean(t); return !c || SYSTEMISH.test(c); };
// 其他工具在后台派发给 AI 的任务（没有可跳转的界面，用户也不关心中间过程）
const AGENT_DISPATCH = /^(Assigned project directory|You are taking part in an ai-collab)/i;
const isDispatch = (t) => AGENT_DISPATCH.test(clean(t));
const SYSTEMISH = /^(<|Assigned project directory|You are taking part|You are an? |# AGENTS\.md|以下是之前对话的上下文摘要)/i;

// ---------------- 各家解析：每行返回 {sig, ...} ----------------
// sig: "run" 进行中 / "done" 完成 / "input" 需要处理 / "idle" 中止（不提醒）
const PARSERS = {
  codex(e, s) {
    const pl = e.payload || {};
    if (e.type === "session_meta") {
      s.sid = pl.id || pl.session_id || s.sid;
      if (pl.cwd) s.cwd = pl.cwd;
      if (pl.originator) s.origin = String(pl.originator);
      const src = typeof pl.source === "string" ? pl.source : (pl.source && Object.keys(pl.source)[0]) || "";
      if (src) s.srcKind = src;
      s.skip = src === "exec" || pl.thread_source === "subagent"; // 别的工具在后台调起的一次性任务，没有界面可跳转
      return null;
    }
    if (e.type === "response_item" && pl.type === "message" && pl.role === "user") {
      const t = textOf(pl.content, ["input_text", "text"]);
      if (t && isDispatch(t)) s.skip = true;
      if (t && !isSystemish(t)) s.title = cut(codexAsk(t)); // 每轮更新为最新一条需求
      return null;
    }
    if (e.type !== "event_msg") return null;
    if (pl.type === "task_started") return { sig: "run", user: true };
    if (pl.type === "task_complete") return { sig: pl.error ? "input" : "done", preview: cut(pl.last_agent_message || "", 80), error: !!pl.error };
    if (pl.type === "turn_aborted") return { sig: "idle" };
    if (/approval_request|request_user_input|elicitation_request/.test(pl.type || "")) return { sig: "input", preview: "等待你批准操作" };
    return null;
  },
  claude(e, s) {
    s.sid = e.sessionId || s.sid;
    if (e.cwd) s.cwd = e.cwd;
    if (e.entrypoint) s.origin = String(e.entrypoint);
    if (e.type === "summary" && e.summary) { s.title = cut(e.summary); return null; }
    if (e.type === "user" && e.message) {
      const c = e.message.content;
      if (Array.isArray(c) && c.some((x) => x && x.type === "tool_result")) return { sig: "run" };
      const t = textOf(c, ["text"]);
      if (t && isDispatch(t)) s.skip = true;
      if (t && !isSystemish(t) && !e.isMeta) s.title = cut(t);
      return { sig: "run", user: !e.isMeta };
    }
    if (e.type === "assistant" && e.message) {
      const c = Array.isArray(e.message.content) ? e.message.content : [];
      const tu = c.filter((x) => x && x.type === "tool_use");
      if (tu.some((x) => /^(AskUserQuestion|ExitPlanMode)$/.test(x.name))) return { sig: "input", preview: "等待你回答或确认方案" };
      if (tu.length) return { sig: "run" };
      if (/^(end_turn|stop_sequence)$/.test(e.message.stop_reason || "")) return { sig: "done", preview: cut(textOf(c, ["text"]), 80) };
      return null;
    }
    if (e.type === "system" && e.subtype === "turn_duration") return { sig: "done" };
    return null;
  },
  workbuddy(e, s) {
    s.sid = e.sessionId || s.sid;
    if (e.type === "ai-title" && e.aiTitle) { s.title = cut(e.aiTitle); s.hasAiTitle = true; return null; }
    if (e.type === "message" && e.role === "user") {
      const t = textOf(e.content, ["input_text", "text"]);
      if (t && isDispatch(t)) s.skip = true;
      if (!s.hasAiTitle && t && !isSystemish(t)) s.title = cut(t);
      return { sig: "run", user: true };
    }
    if (e.type === "function_call") {
      if (e.name === "AskUserQuestion") { s.askId = e.callId; return { sig: "input", preview: "等待你回答问题" }; }
      return { sig: "run" };
    }
    if (e.type === "function_call_result") { if (s.askId && e.callId === s.askId) s.askId = null; return { sig: "run" }; }
    if (e.type === "message" && e.role === "assistant" && e.status === "completed") return { sig: "done", preview: cut(textOf(e.content, ["output_text", "text"]), 80) };
    return null;
  },
  codebuddy(e, s) { return PARSERS.workbuddy(e, s); },
  boxai(e, s) {
    if (e.role === "user") {
      const t = typeof e.content === "string" ? e.content : textOf(e.content);
      // 上下文压缩后的第一条是摘要；ai-collab 等工具派发的任务以系统提示开头，都不当作任务名
      if (t && !isSystemish(t)) { const c = cut(t); if (c) s.title = c; }
      else if (t && isDispatch(t)) s.skip = true; // 后台代理任务，没有界面
      return { sig: "run", user: true };
    }
    if (e.role === "assistant") {
      const tc = Array.isArray(e.toolCalls) ? e.toolCalls : [];
      const ask = tc.some((t) => t && (t.name === "ask_followup_question" || (t.name === "mcp_call_tool" && t.arguments && t.arguments.toolName === "ask_followup_question")));
      if (ask) return { sig: "input", preview: "等待你选择或回答" };
      if (tc.length) return { sig: "run" };
      return { sig: "done", preview: cut(typeof e.content === "string" ? e.content : textOf(e.content), 80) };
    }
    return null;
  },
};

// ---------------- 各家日志在哪 & 怎么跳转 ----------------
function codexHome() { return process.env.CODEX_HOME || path.join(home(), ".codex"); }
function claudeRoots() {
  const out = [];
  if (process.env.CLAUDE_CONFIG_DIR) for (const d of process.env.CLAUDE_CONFIG_DIR.split(path.delimiter).filter(Boolean)) out.push(path.join(d, "projects"));
  out.push(path.join(home(), ".claude", "projects"), path.join(home(), ".config", "claude", "projects"));
  return out;
}

const SOURCES = [
  { id: "codex", roots: () => [path.join(codexHome(), "sessions")], depth: 4, match: (n) => /^rollout-.*\.jsonl$/.test(n),
    link: (s) => (s.sid ? `codex://threads/${encodeURIComponent(s.sid)}` : "codex://") },
  { id: "claude", roots: claudeRoots, depth: 1, match: (n) => n.endsWith(".jsonl"), link: () => "" },
  { id: "workbuddy", roots: () => [path.join(home(), ".workbuddy", "projects")], depth: 1, match: (n) => n.endsWith(".jsonl"),
    link: (s, file) => `workbuddy://chat/${encodeURIComponent(s.sid || path.basename(file, ".jsonl"))}` },
  { id: "codebuddy", roots: () => [path.join(home(), ".codebuddy", "projects")], depth: 1, match: (n) => n.endsWith(".jsonl"),
    link: () => (process.platform === "win32" ? "codebuddycn://" : "codebuddy://") },
  { id: "boxai", roots: () => [path.join(home(), ".box", "ctx")], depth: 1, match: (n) => n === "transcript.jsonl",
    link: () => "boxapp://", sidOf: (file) => path.basename(path.dirname(file)) },
];

// ---------------- 任务跑在哪个软件里 ----------------
const SELF_APP = /^(AI 用量监控|AI Usage Monitor|Electron)$/i;
// 会话记录里的来源 → desktop（桌面 App）/ ide（编辑器插件）/ cli（终端）/ ""（不确定）
function hostKind(ai, s) {
  const o = String(s.origin || "") + " " + String(s.srcKind || "");
  if (/desktop|codex[_ ]?app/i.test(o)) return "desktop";
  if (/vscode|jetbrains|cursor|windsurf|\bide\b|extension/i.test(o)) return "ide";
  if (/\bcli\b|codex_cli|codex_exec|^cli/i.test(o)) return "cli";
  return "";
}

// ---------------- 监视器 ----------------
class TaskWatcher {
  constructor({ sources = SOURCES, now = () => Date.now(), log = () => {}, front = () => "" } = {}) {
    this.sources = sources;
    this.front = front;
    this.now = now;
    this.log = log;
    this.files = new Map(); // file -> {src, offset, rest, s}
    this.started = false;
  }

  listFiles(src) {
    const out = [];
    const cutoff = this.now() - RECENT_MS;
    const walk = (dir, depth) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < src.depth && e.name !== "subagents" && e.name !== "tool-outputs") walk(p, depth + 1); continue; }
        if (!src.match(e.name)) continue;
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.mtimeMs >= cutoff) out.push([p, st.size]);
      }
    };
    for (const r of src.roots()) walk(r, 0);
    return out;
  }

  // 返回本轮新确认的提醒事件
  tick() {
    const events = [];
    const first = !this.started;
    const seen = new Set();
    for (const src of this.sources) {
      for (const [file, size] of this.listFiles(src)) {
        seen.add(file);
        let f = this.files.get(file);
        if (!f) {
          f = { src, offset: 0, rest: "", s: { armed: false, title: "", sid: src.sidOf ? src.sidOf(file) : "", pending: null, lastSig: null } };
          this.files.set(file, f);
          // 启动时已存在的文件 = 历史：只建立状态。启动后才出现的文件 = 新会话：正常处理
          if (first) { this.readHistory(f, file, size); continue; }
        }
        if (size < f.offset) { f.offset = 0; f.rest = ""; }
        if (size > f.offset) this.readNew(f, file, size, true);
      }
    }
    for (const k of this.files.keys()) if (!seen.has(k)) this.files.delete(k);
    this.started = true;

    // 静默期满的「完成 / 需要处理」→ 发出提醒
    const now = this.now();
    for (const [file, f] of this.files) {
      const s = f.s, p = s.pending;
      if (!p || now - p.at < SETTLE[p.kind]) continue;
      s.pending = null;
      if (!s.armed || s.skip) continue;
      s.armed = p.kind === "input"; // 需要处理之后用户回复会再次进入「进行中」；完成后要等下一轮任务
      events.push({
        ai: f.src.id, kind: p.kind, title: s.title || "（未命名任务）", preview: p.preview || "", error: !!p.error,
        sessionId: s.sid || "", link: f.src.link(s, file), at: now, key: `${f.src.id}:${s.sid || file}`,
        cwd: s.cwd || "", host: hostKind(f.src.id, s), hostApp: s.hostApp || "",
      });
    }
    return events;
  }

  readHistory(f, file, size) {
    // 头部取标题，尾部取当前状态；全程不 armed，所以不会对历史任务提醒
    const parse = (text, skipFirst) => {
      const lines = text.split("\n");
      if (skipFirst) lines.shift();
      for (const l of lines) this.apply(f, l, false);
    };
    try {
      if (size <= HEAD_BYTES + TAIL_BYTES) {
        parse(this.readRange(file, 0, size), false);
      } else {
        parse(this.readRange(file, 0, HEAD_BYTES).replace(/[^\n]*$/, ""), false);
        parse(this.readRange(file, size - TAIL_BYTES, size), true);
      }
    } catch { /* ignore */ }
    f.offset = size;
    f.rest = "";
    // 程序启动时这个会话正在跑（最近 10 分钟有动静、最后状态是「进行中」）：也算数，跑完照样提醒；
    // 正在等你处理的：直接提醒。更早的历史仍然不提醒。
    const s = f.s;
    let recent = false;
    try { recent = fs.statSync(file).mtimeMs > this.now() - 10 * 60e3; } catch { /* ignore */ }
    if (recent && !s.skip && s.lastSig === "run") { s.armed = true; s.pending = null; }
    else if (recent && !s.skip && s.pending && s.pending.kind === "input") { s.armed = true; s.pending.at = this.now(); }
    else s.pending = null;
  }

  readNew(f, file, size, live) {
    let text;
    try { text = f.rest + this.readRange(file, f.offset, size); } catch { return; }
    f.offset = size;
    const lines = text.split("\n");
    f.rest = lines.pop();
    for (const l of lines) this.apply(f, l, live);
  }

  readRange(file, from, to) {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.max(0, to - from));
      fs.readSync(fd, buf, 0, buf.length, from);
      return buf.toString("utf8");
    } finally { fs.closeSync(fd); }
  }

  apply(f, line, live) {
    if (!line || line.length < 2 || line.length > 400000) return; // 超大行一般是工具输出 / 图片，跳过
    let e;
    try { e = JSON.parse(line); } catch { return; }
    let r;
    try { r = PARSERS[f.src.id](e, f.s); } catch { r = null; }
    if (!r) return;
    const s = f.s;
    if (r.sig === "run") {
      s.pending = null;
      if (live) s.armed = true;
      // 你发出这条消息时停在哪个软件里——任务多半就跑在那里，点提醒时优先切回它
      if (live && r.user) {
        let fa = "";
        try { fa = String(this.front() || "").trim(); } catch { /* ignore */ }
        if (fa && !SELF_APP.test(fa)) s.hostApp = fa;
      }
    } else if (r.sig === "idle") {
      s.pending = null;
      s.armed = false;
    } else if (r.sig === "done" || r.sig === "input") {
      // 已有「需要处理」在等，不被随后的普通完成覆盖
      if (!(s.pending && s.pending.kind === "input" && r.sig === "done")) s.pending = { kind: r.sig, at: this.now(), preview: r.preview, error: r.error };
    }
    s.lastSig = r.sig;
  }
}

module.exports = { TaskWatcher, PARSERS, SOURCES, clean, cut, SETTLE, isDispatch, hostKind };
