"use strict";
// 对话完成提醒：Claude（网页版 / 桌面版 / 手机 App 的普通聊天）和 ChatGPT 的普通聊天。
// 这些聊天不在本机留日志，所以用「登录网页版」留下的登录状态，定时看一眼最近的对话列表：
//   有对话更新了 → 看最后一条消息：是你发的 = 进行中；是 AI 的回复并且已经写完 = 完成 → 发提醒。
// 只看最近 8 个对话；没有对话在进行时 8 秒看一次，有对话在进行时 3 秒看一次。
// 不需要额外登录：Claude 用「登录 Claude 网页版」（或手动填的 sessionKey），ChatGPT 用「登录网页版」或 Codex 的登录。
const LIST_N = 8;
const IDLE_MS = 8000, BUSY_MS = 3000;
const WAIT_MAX = 20 * 60e3;          // 一条对话最多跟踪 20 分钟
const SELF_APP = /^(AI 用量监控|AI Usage Monitor|Electron)$/i;

const toMs = (t) => (typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t) || 0);
const cut = (t, n) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

// ---------------- Claude ----------------
function claudeSource({ request, webSession, getCfg, SK_RE, webHeaders }) {
  let org = null;
  const base = async () => {
    const pc = (getCfg().providers || {}).claude || {};
    const sk = SK_RE.exec(String(pc.apiKey || ""));
    if (sk) return { headers: webHeaders("https://claude.ai", { "anthropic-client-platform": "web_claude_ai", Cookie: "sessionKey=" + sk[0] }) };
    if (!webSession) return null;
    const c = await webSession.cookies.get({ url: "https://claude.ai", name: "sessionKey" });
    if (!c.length) return null;
    return { headers: webHeaders("https://claude.ai", { "anthropic-client-platform": "web_claude_ai" }), session: webSession, useSessionCookies: true };
  };
  return {
    ai: "claude", label: "Claude 对话", desktop: "Claude",
    link: (id) => "https://claude.ai/chat/" + id,
    async list() {
      const b = await base();
      if (!b) return null; // 没登录网页版：不查
      if (!org) {
        const orgs = await request({ ...b, url: "https://claude.ai/api/organizations" });
        const o = (Array.isArray(orgs) && (orgs.find((x) => /claude_max|claude_pro|chat/.test(JSON.stringify(x.capabilities || []))) || orgs[0])) || null;
        if (!o) return null;
        org = o.uuid;
      }
      const d = await request({ ...b, url: `https://claude.ai/api/organizations/${org}/chat_conversations?limit=${LIST_N}` });
      const arr = Array.isArray(d) ? d : (d && d.data) || [];
      return arr.slice(0, LIST_N).map((c) => ({ id: c.uuid, title: c.name || "", u: String(c.updated_at || "") }));
    },
    async detail(id) {
      const b = await base();
      const d = await request({ ...b, url: `https://claude.ai/api/organizations/${org}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true` });
      const msgs = (d && d.chat_messages) || [];
      const m = msgs.find((x) => x.uuid === d.current_leaf_message_uuid) || msgs[msgs.length - 1];
      if (!m) return { title: d && d.name, last: null };
      const text = m.text || (Array.isArray(m.content) ? m.content.filter((c) => c && c.type === "text").map((c) => c.text || "").join(" ") : "");
      const sr = Object.prototype.hasOwnProperty.call(m, "stop_reason") ? m.stop_reason : undefined;
      return {
        title: d.name || "",
        last: {
          id: m.uuid, role: m.sender === "assistant" ? "assistant" : "user", text, at: toMs(m.created_at),
          done: sr === undefined ? null : sr ? !/tool_use|pause/.test(sr) : false,
          ask: sr === "tool_use",
        },
      };
    },
  };
}

// ---------------- ChatGPT ----------------
function chatgptSource({ chatgptAuth, chatgptReq, webSession }) {
  let auth = null, authAt = 0;
  const getAuth = async () => {
    if (!auth || Date.now() - authAt > 20 * 60e3) { auth = await chatgptAuth({ webSession }); authAt = Date.now(); }
    return auth;
  };
  return {
    ai: "codex", label: "ChatGPT 对话", desktop: "ChatGPT",
    link: (id) => "https://chatgpt.com/c/" + id,
    resetAuth() { auth = null; },
    async list() {
      const a = await getAuth();
      if (!a) return null;
      const d = await chatgptReq(`https://chatgpt.com/backend-api/conversations?offset=0&limit=${LIST_N}&order=updated`, a);
      return ((d && d.items) || []).slice(0, LIST_N).map((c) => ({ id: c.id, title: c.title || "", u: String(c.update_time || "") }));
    },
    async detail(id) {
      const a = await getAuth();
      const d = await chatgptReq(`https://chatgpt.com/backend-api/conversation/${id}`, a);
      const map = (d && d.mapping) || {};
      let node = map[d.current_node];
      // 跳过系统 / 隐藏消息，找到最后一条真正的消息
      for (let i = 0; node && i < 20; i++) {
        const m = node.message;
        const role = m && m.author && m.author.role;
        const hidden = m && m.metadata && m.metadata.is_visually_hidden_from_conversation;
        if (m && role !== "system" && !hidden) break;
        node = map[node.parent];
      }
      const m = node && node.message;
      if (!m) return { title: d && d.title, last: null };
      const role = m.author && m.author.role;
      const parts = (m.content && m.content.parts) || [];
      const text = parts.filter((x) => typeof x === "string").join(" ");
      let done = null;
      if (role === "assistant") done = m.status ? m.status === "finished_successfully" && m.end_turn !== false : m.end_turn === true ? true : null;
      if (role === "tool") done = false;
      return { title: d.title || "", last: { id: m.id, role: role === "user" ? "user" : role === "assistant" ? "assistant" : "other", text, at: toMs(m.create_time), done } };
    },
  };
}

// ---------------- 通用：跟踪每个对话的状态 ----------------
class ChatWatcher {
  constructor({ sources, now = () => Date.now(), front = () => "", log = () => {}, enabled = () => true }) {
    this.sources = sources.map((src) => ({ src, base: false, convs: new Map(), off: 0, fails: 0, note: "" }));
    this.now = now;
    this.front = front;
    this.log = log;
    this.enabled = enabled;
    this.startAt = now();
  }

  busy() { return this.sources.some((x) => [...x.convs.values()].some((c) => c.waiting)); }

  // 看一轮，返回新完成的对话提醒
  async poll() {
    const out = [];
    for (const x of this.sources) {
      if (!this.enabled(x.src.ai) || this.now() < x.off) continue;
      try {
        const evs = await this.pollOne(x);
        out.push(...evs);
        if (x.fails) this.log(`[chat] ${x.src.label} 恢复`);
        x.fails = 0;
      } catch (e) {
        x.fails++;
        x.off = this.now() + Math.min(5 * 60e3, 15e3 * 2 ** Math.min(x.fails - 1, 4)); // 出错退避：15 秒起，最长 5 分钟
        if (e.auth && x.src.resetAuth) x.src.resetAuth();
        if (x.fails === 1 || x.fails % 10 === 0) this.log(`[chat] ${x.src.label} 查询失败（第 ${x.fails} 次）：${String(e.message || e).slice(0, 120)}`);
      }
    }
    return out;
  }

  async pollOne(x) {
    const src = x.src;
    const list = await src.list();
    if (!list) { if (x.note !== "nologin") { x.note = "nologin"; this.log(`[chat] ${src.label}：未登录网页版，跳过`); } return []; }
    if (x.note === "nologin") { x.note = ""; this.log(`[chat] ${src.label}：已开始监听`); }
    const now = this.now();
    if (!x.base) {
      // 第一轮只记下现状，不提醒
      for (const c of list) x.convs.set(c.id, { u: c.u, waiting: false, notified: "", stable: null, hostApp: "", since: 0 });
      x.base = true;
      return [];
    }
    const evs = [];
    for (const c of list) {
      let st = x.convs.get(c.id);
      if (!st) { st = { u: null, waiting: false, notified: "", stable: null, hostApp: "", since: 0 }; x.convs.set(c.id, st); }
      if (st.waiting && now - st.since > WAIT_MAX) st.waiting = false;
      if (st.u === c.u && !st.waiting) continue;
      const changed = st.u !== c.u;
      st.u = c.u;
      const d = await src.detail(c.id);
      const m = d.last;
      if (!m || m.at && m.at < this.startAt - 60e3) { st.waiting = false; continue; } // 改名 / 收藏旧对话等：不提醒
      if (m.role !== "assistant" || m.done === false) {
        if (!st.waiting) {
          st.waiting = true;
          st.since = now;
          let fa = "";
          try { fa = String(this.front() || "").trim(); } catch { /* ignore */ }
          if (fa && !SELF_APP.test(fa)) st.hostApp = fa; // 你发消息时在用的软件（Claude 桌面版 / 浏览器）
        }
        st.stable = null;
        continue;
      }
      if (m.id === st.notified) { st.waiting = false; continue; }
      // 旧对话重新排到前面（重新打开 Claude 后同步、改名、收藏……）：回复是很早以前写的，而且没看到你发消息 → 不提醒
      if (!st.waiting && m.at && m.at < now - 10 * 60e3) { st.notified = m.id; continue; }
      // 回复是否已经写完：接口给了结束标记就直接用；没给就等两次查询内容都不再变化
      const sig = m.text.length + "|" + c.u;
      const done = m.done === true || (st.stable && st.stable.id === m.id && st.stable.sig === sig && !changed);
      if (!done) {
        st.stable = { id: m.id, sig };
        if (!st.waiting) { st.waiting = true; st.since = now; }
        continue;
      }
      st.notified = m.id;
      st.waiting = false;
      st.stable = null;
      evs.push({
        ai: src.ai, kind: m.ask ? "input" : "done", chat: true, label: src.label,
        title: cut(d.title || c.title || "（未命名对话）", 60), preview: cut(m.text, 80), error: false,
        sessionId: c.id, key: `${src.ai}-chat:${c.id}`, link: src.link(c.id), at: now,
        cwd: "", host: "desktop", hostApp: st.hostApp || "",
      });
    }
    // 只保留列表里还在的对话
    const ids = new Set(list.map((c) => c.id));
    for (const k of x.convs.keys()) if (!ids.has(k)) x.convs.delete(k);
    return evs;
  }
}

module.exports = { ChatWatcher, claudeSource, chatgptSource, IDLE_MS, BUSY_MS };
