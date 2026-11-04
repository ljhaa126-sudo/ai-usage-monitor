"use strict";
// 「彻底完成才提醒」：子代理、自动续跑的多轮、完成后又继续干活，都不应该在中途弹窗
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const APP = process.argv[2] || path.join(__dirname, "..", "app");
const { TaskWatcher } = require(path.join(APP, "core/tasks.js"));
let pass = 0; const ok = (n) => { pass++; console.log("  ✓ " + n); };

function setup(id) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "done-"));
  let now = Date.now();
  const src = id === "codex"
    ? { id: "codex", roots: () => [dir], depth: 1, match: (n) => /^rollout-.*\.jsonl$/.test(n), link: () => "" }
    : { id: "claude", roots: () => [dir], depth: 1, match: (n) => n.endsWith(".jsonl"), link: () => "" };
  const tw = new TaskWatcher({ sources: [src], now: () => now });
  tw.tick(); // 基线
  const all = [];
  return {
    dir,
    write: (file, o) => fs.appendFileSync(path.join(dir, file), JSON.stringify(o) + "\n"),
    // 推进时间并扫描，收集所有提醒
    // 和真实运行一样：先读到新日志，过一段时间再扫一次
    step: (ms = 1500) => { const e = tw.tick(); now += ms; e.push(...tw.tick()); all.push(...e); return e; },
    all,
  };
}
const ev = (type, extra = {}) => ({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type, ...extra } });
const meta = (id, source, extra = {}) => ({ type: "session_meta", payload: { id, cwd: "/p", originator: "codex_cli_rs", source, ...extra } });
const umsg = (t) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: t }] } });

// 1) Codex：主任务派生子代理；子代理每一步都会 task_complete
{
  const t = setup("codex");
  t.write("rollout-main.jsonl", meta("M", "cli"));
  t.write("rollout-main.jsonl", umsg("重构登录模块"));
  t.write("rollout-main.jsonl", ev("task_started"));
  t.step();
  for (const [i, src] of [[1, { subagent: { thread_spawn: { parent_thread_id: "M", depth: 1 } } }], [2, { subagent: "review" }], [3, { subagent: "compact" }]]) {
    const f = `rollout-sub${i}.jsonl`;
    t.write(f, meta("S" + i, src));
    t.write(f, umsg("子任务 " + i));
    t.write(f, ev("task_started"));
    t.step();
    t.write(f, ev("task_complete", { last_agent_message: "子任务完成" }));
    t.step(7000);
  }
  assert.strictEqual(t.all.length, 0, JSON.stringify(t.all.map((e) => e.title)));
  ok("Codex 子代理（并行子任务 / 审查 / 压缩上下文）完成 → 不弹窗");

  // 主任务：自己连续跑了三轮（中间没有你的新消息）
  for (let k = 0; k < 3; k++) {
    t.write("rollout-main.jsonl", ev("agent_message", { message: "第 " + k + " 步" }));
    t.write("rollout-main.jsonl", ev("task_complete", { last_agent_message: "第 " + k + " 轮结束" }));
    t.step(2000);
    if (k < 2) { t.write("rollout-main.jsonl", ev("task_started")); t.step(1000); t.write("rollout-main.jsonl", ev("exec_command_begin")); t.step(2000); }
  }
  t.step(7000);
  assert.strictEqual(t.all.length, 1);
  assert.strictEqual(t.all[0].title, "重构登录模块");
  ok("Codex 自己接着跑的多轮 → 只在最后彻底完成时弹一次");

  // 你又发了一条
  t.write("rollout-main.jsonl", umsg("再加个测试"));
  t.write("rollout-main.jsonl", ev("task_started"));
  t.step();
  t.write("rollout-main.jsonl", ev("task_complete", { last_agent_message: "好了" }));
  t.step(7000);
  assert.strictEqual(t.all.length, 2);
  ok("你发出新请求 → 完成时再提醒一次");
}

// 2) Codex：task_complete 之后马上又有动作（还没彻底完成）
{
  const t = setup("codex");
  t.write("rollout-a.jsonl", meta("A", "vscode"));
  t.write("rollout-a.jsonl", umsg("跑一下"));
  t.write("rollout-a.jsonl", ev("task_started"));
  t.step();
  t.write("rollout-a.jsonl", ev("task_complete"));
  t.step(3000);
  t.write("rollout-a.jsonl", { type: "response_item", payload: { type: "function_call", name: "shell" } });
  t.step(7000);
  assert.strictEqual(t.all.length, 0);
  ok("「完成」后 6 秒内又有动作 → 不弹窗");
  t.write("rollout-a.jsonl", ev("token_count"));
  t.write("rollout-a.jsonl", ev("task_complete"));
  t.write("rollout-a.jsonl", ev("token_count"));
  t.step(7000);
  assert.strictEqual(t.all.length, 1);
  ok("真正结束后（只剩统计信息）→ 弹一次");
}

// 3) Claude Code：子代理（sidechain）的 end_turn 不算
{
  const t = setup("claude");
  const L = (o) => t.write("s.jsonl", { sessionId: "C", cwd: "/p", ...o });
  L({ type: "user", message: { role: "user", content: "写完整的测试" } });
  t.step();
  L({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Task" }] } });
  L({ type: "assistant", isSidechain: true, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "子代理完成" }] } });
  t.step(7000);
  assert.strictEqual(t.all.length, 0);
  ok("Claude Code 子代理完成 → 不弹窗");
  L({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });
  L({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "全部完成" }] } });
  L({ type: "system", subtype: "turn_duration" });
  t.step(7000);
  assert.strictEqual(t.all.length, 1);
  ok("主任务完成 → 弹一次");
}

// 4) 需要你处理：照常立即提醒
{
  const t = setup("codex");
  t.write("rollout-b.jsonl", meta("B", "cli"));
  t.write("rollout-b.jsonl", umsg("删除旧文件"));
  t.write("rollout-b.jsonl", ev("task_started"));
  t.step();
  t.write("rollout-b.jsonl", ev("exec_approval_request"));
  t.step(1000);
  assert.strictEqual(t.all.length, 1);
  assert.strictEqual(t.all[0].kind, "input");
  ok("需要你批准 → 立即提醒");
}

console.log(`\n全部通过：${pass} 项`);
