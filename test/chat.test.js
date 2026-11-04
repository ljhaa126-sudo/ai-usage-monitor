"use strict";
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const APP = process.argv[2];
const { ChatWatcher, claudeSource, chatgptSource } = require(path.join(APP, "core/chatwatch.js"));
const P = require(path.join(APP, "core/providers.js"));
let pass = 0; const ok = (n) => { pass++; console.log("  ✓ " + n); };

(async () => {
  // ---------- Claude 源：解析真实接口结构 ----------
  let now = Date.now();
  const convs = [{ uuid: "c1", name: "旧对话", updated_at: "2026-11-04T05:00:00Z" }, { uuid: "c2", name: "写周报", updated_at: "2026-11-04T05:00:00Z" }];
  let detail = {};
  const calls = [];
  const request = async (o) => {
    calls.push(o.url);
    assert.ok(o.headers.Cookie === "sessionKey=sk-ant-sid01-abc" || o.useSessionCookies);
    if (o.url.endsWith("/api/organizations")) return [{ uuid: "org1", capabilities: ["chat", "claude_pro"] }];
    if (/chat_conversations\?limit/.test(o.url)) return convs;
    const id = /chat_conversations\/([^?]+)/.exec(o.url)[1];
    return detail[id];
  };
  const cfg = { providers: { claude: { apiKey: "sk-ant-sid01-abc" } } };
  const csrc = claudeSource({ request, webSession: null, getCfg: () => cfg, SK_RE: P.SK_RE, webHeaders: P.webHeaders });
  let front = "Claude";
  const w = new ChatWatcher({ sources: [csrc], now: () => now, front: () => front });
  assert.deepStrictEqual(await w.poll(), []);
  ok("第一轮只记录现状，不提醒");

  // 你发了一条消息
  convs[1].updated_at = "2026-11-04T06:00:01Z";
  detail.c2 = { name: "写周报", current_leaf_message_uuid: "m1", chat_messages: [{ uuid: "m1", sender: "human", text: "帮我写周报", created_at: new Date(now).toISOString() }] };
  assert.deepStrictEqual(await w.poll(), []);
  assert.ok(w.busy());
  ok("你发出消息 → 进行中（加快查询）");
  front = "AI 用量监控";
  // 回复中（没有结束标记字段）：内容还在变 → 不提醒
  now += 3000;
  convs[1].updated_at = "2026-11-04T06:00:05Z";
  detail.c2 = { name: "写周报", current_leaf_message_uuid: "m2", chat_messages: [detail.c2.chat_messages[0], { uuid: "m2", sender: "assistant", text: "本周完成", created_at: new Date(now).toISOString() }] };
  assert.deepStrictEqual(await w.poll(), []);
  detail.c2.chat_messages[1].text = "本周完成了三件事……";
  convs[1].updated_at = "2026-11-04T06:00:08Z";
  now += 3000;
  assert.deepStrictEqual(await w.poll(), []);
  ok("回复还在写 → 不提醒");
  now += 3000;
  let evs = await w.poll();
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].ai, "claude");
  assert.strictEqual(evs[0].chat, true);
  assert.strictEqual(evs[0].title, "写周报");
  assert.strictEqual(evs[0].hostApp, "Claude");
  assert.strictEqual(evs[0].link, "https://claude.ai/chat/c2");
  ok("回复写完 → 提醒（带上你发消息时在用的软件、对话链接）");
  now += 3000;
  assert.deepStrictEqual(await w.poll(), []);
  ok("同一条回复只提醒一次");

  // 有结束标记：一次就确认
  now += 3000;
  convs[1].updated_at = "2026-11-04T06:01:00Z";
  detail.c2.chat_messages.push({ uuid: "m3", sender: "human", text: "再短一点", created_at: new Date(now).toISOString() });
  detail.c2.current_leaf_message_uuid = "m3";
  await w.poll();
  now += 3000;
  convs[1].updated_at = "2026-11-04T06:01:04Z";
  detail.c2.chat_messages.push({ uuid: "m4", sender: "assistant", text: "好的", stop_reason: "end_turn", created_at: new Date(now).toISOString() });
  detail.c2.current_leaf_message_uuid = "m4";
  evs = await w.poll();
  assert.strictEqual(evs.length, 1);
  ok("接口给了结束标记 → 立即提醒");

  // 给旧对话改名：最后一条消息很早 → 不提醒
  now += 3000;
  convs[0].updated_at = "2026-11-04T06:02:00Z"; convs[0].name = "旧对话（改名）";
  detail.c1 = { name: "旧对话（改名）", current_leaf_message_uuid: "o1", chat_messages: [{ uuid: "o1", sender: "assistant", text: "很久以前", stop_reason: "end_turn", created_at: "2026-10-01T00:00:00Z" }] };
  assert.deepStrictEqual(await w.poll(), []);
  ok("改名 / 收藏旧对话 → 不提醒");

  // 重新打开 Claude 后，一个 20 分钟前回复完的对话重新排进最近列表 → 不提醒
  now += 3000;
  convs.push({ uuid: "c3", name: "下午的对话", updated_at: "2026-11-04T06:03:00Z" });
  detail.c3 = { name: "下午的对话", current_leaf_message_uuid: "z1", chat_messages: [{ uuid: "z1", sender: "assistant", text: "早就答完了", stop_reason: "end_turn", created_at: new Date(now - 20 * 60e3).toISOString() }] };
  assert.deepStrictEqual(await w.poll(), []);
  {
    // 本程序已经开了 3 小时；20 分钟前回复完的对话（当时没在最近 8 个里）重新排到前面
    let n3 = Date.now();
    const list3 = [{ uuid: "q1", name: "旧", updated_at: "a" }];
    const det3 = { q1: { name: "旧", current_leaf_message_uuid: "x", chat_messages: [{ uuid: "x", sender: "assistant", text: "旧回复", stop_reason: "end_turn", created_at: new Date(n3 - 3600e3).toISOString() }] } };
    const src3 = claudeSource({ request: async (o) => (o.url.endsWith("/organizations") ? [{ uuid: "org1" }] : /\?limit/.test(o.url) ? list3 : det3[/chat_conversations\/([^?]+)/.exec(o.url)[1]]), webSession: null, getCfg: () => cfg, SK_RE: P.SK_RE, webHeaders: P.webHeaders });
    const w3 = new ChatWatcher({ sources: [src3], now: () => n3 });
    w3.startAt = n3 - 3 * 3600e3;
    await w3.poll();
    n3 += 3000;
    list3.unshift({ uuid: "q2", name: "下午的对话", updated_at: "b" });
    det3.q2 = { name: "下午的对话", current_leaf_message_uuid: "y", chat_messages: [{ uuid: "y", sender: "assistant", text: "20 分钟前就答完了", stop_reason: "end_turn", created_at: new Date(n3 - 20 * 60e3).toISOString() }] };
    assert.deepStrictEqual(await w3.poll(), []);
  }
  ok("旧对话重新排到前面（重新打开 Claude 后同步）→ 不提醒");

  // 没登录 → 不查询、不报错
  const w2 = new ChatWatcher({ sources: [claudeSource({ request, webSession: null, getCfg: () => ({ providers: {} }), SK_RE: P.SK_RE, webHeaders: P.webHeaders })], log: () => {} });
  assert.deepStrictEqual(await w2.poll(), []);
  ok("没登录网页版 → 跳过");

  // ---------- ChatGPT 源 ----------
  let gnow = Date.now();
  const items = [{ id: "g1", title: "旅行计划", update_time: "2026-11-04T06:00:00.000000Z" }];
  let conv;
  const gsrc = chatgptSource({ webSession: null, chatgptAuth: async () => ({ token: "t" }), chatgptReq: async (url) => (url.includes("/conversations?") ? { items } : conv) });
  const gw = new ChatWatcher({ sources: [gsrc], now: () => gnow });
  await gw.poll();
  const t0 = gnow / 1000;
  items[0].update_time = "2026-11-04T06:01:00Z";
  conv = { title: "旅行计划", current_node: "n2", mapping: {
    n0: { message: { id: "n0", author: { role: "system" }, content: { parts: [""] } }, parent: null },
    n1: { message: { id: "n1", author: { role: "user" }, content: { parts: ["东京三天"] }, create_time: t0 }, parent: "n0" },
    n2: { message: { id: "n2", author: { role: "assistant" }, content: { parts: ["第一天…"] }, status: "in_progress", end_turn: null, create_time: t0 + 1 }, parent: "n1" } } };
  assert.deepStrictEqual(await gw.poll(), []);
  ok("ChatGPT 回复中 → 不提醒");
  gnow += 3000;
  conv.mapping.n2.message.status = "finished_successfully"; conv.mapping.n2.message.end_turn = true;
  items[0].update_time = "2026-11-04T06:01:09Z";
  evs = await gw.poll();
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].ai, "codex");
  assert.strictEqual(evs[0].label, "ChatGPT 对话");
  assert.strictEqual(evs[0].preview, "第一天…");
  ok("ChatGPT 回复完 → 提醒");

  // 出错退避，不抛异常
  const bad = new ChatWatcher({ sources: [{ ai: "codex", label: "x", list: async () => { throw new Error("HTTP 403"); } }], log: () => {} });
  assert.deepStrictEqual(await bad.poll(), []);
  assert.deepStrictEqual(await bad.poll(), []);
  ok("查询出错 → 退避重试，不影响其他功能");

  // ---------- 启动前就在跑的本地任务也提醒 ----------
  const { TaskWatcher } = require(path.join(APP, "core/tasks.js"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-"));
  const f = path.join(dir, "s.jsonl");
  fs.writeFileSync(f, JSON.stringify({ type: "user", sessionId: "S", cwd: "/p", entrypoint: "cli", message: { role: "user", content: "跑测试" } }) + "\n");
  let tn = Date.now();
  const tw = new TaskWatcher({ sources: [{ id: "claude", roots: () => [dir], depth: 1, match: (n) => n.endsWith(".jsonl"), link: () => "" }], now: () => tn });
  tw.tick();
  fs.appendFileSync(f, JSON.stringify({ type: "assistant", sessionId: "S", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "通过" }] } }) + "\n");
  tw.tick(); tn += 7000;
  evs = tw.tick();
  assert.strictEqual(evs.length, 1);
  ok("程序启动前就在跑的任务，跑完也提醒");
  const old = path.join(dir, "old.jsonl");
  fs.writeFileSync(old, JSON.stringify({ type: "user", sessionId: "O", message: { role: "user", content: "旧" } }) + "\n");
  fs.utimesSync(old, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  const tw2 = new TaskWatcher({ sources: [{ id: "claude", roots: () => [dir], depth: 1, match: (n) => n === "old.jsonl", link: () => "" }], now: () => tn });
  tw2.tick();
  assert.strictEqual(tw2.files.get(old).s.armed, false);
  ok("一小时前的历史会话不提醒");

  console.log(`\n全部通过：${pass} 项`);
})().catch((e) => { console.error("✗", e); process.exit(1); });
