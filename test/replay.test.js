"use strict";
// 重新打开 Claude / Codex 后：旧会话被复制成新文件、或被重写，不应该再弹「已完成」
const assert = require("assert");
const fs = require("fs"), os = require("os"), path = require("path");
const APP = process.argv[2] || path.join(__dirname, "..", "app");
const { TaskWatcher } = require(path.join(APP, "core/tasks.js"));
let pass = 0; const ok = (n) => { pass++; console.log("  ✓ " + n); };

function setup(id) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-"));
  let now = Date.now();
  const src = id === "codex"
    ? { id: "codex", roots: () => [dir], depth: 1, match: (n) => /^rollout-.*\.jsonl$/.test(n), link: () => "" }
    : { id: "claude", roots: () => [dir], depth: 1, match: (n) => n.endsWith(".jsonl"), link: () => "" };
  const tw = new TaskWatcher({ sources: [src], now: () => now });
  tw.tick();
  const all = [];
  return { dir, now: () => now, step: (ms = 1500) => { const e = tw.tick(); now += ms; e.push(...tw.tick()); all.push(...e); }, all };
}
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
// 一段已经完成的旧 Claude 会话（3 小时前）
const oldClaude = (sid, t0) => [
  { type: "user", sessionId: sid, cwd: "/p", timestamp: iso(t0), message: { role: "user", content: "旧任务 " + sid } },
  { type: "assistant", sessionId: sid, timestamp: iso(t0 - 60e3), message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] } },
  { type: "user", sessionId: sid, timestamp: iso(t0 - 70e3), message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
  { type: "assistant", sessionId: sid, timestamp: iso(t0 - 90e3), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "做完了" }] } },
  { type: "system", subtype: "turn_duration", sessionId: sid, timestamp: iso(t0 - 91e3) },
].map((o) => JSON.stringify(o)).join("\n") + "\n";

// 1) 重新打开后，旧会话被「接着用」：生成一个包含完整旧对话的新文件
{
  const t = setup("claude");
  for (let i = 0; i < 4; i++) { fs.writeFileSync(path.join(t.dir, `resumed-${i}.jsonl`), oldClaude("S" + i, 3 * 3600e3 + i * 600e3)); t.step(); }
  t.step(7000);
  assert.strictEqual(t.all.length, 0, t.all.map((e) => e.title).join(","));
  ok("旧会话被复制成新文件（重新打开 / 恢复会话）→ 不弹窗");
}

// 2) 旧会话文件被重写（变短再写回）
{
  const t = setup("claude");
  const f = path.join(t.dir, "s.jsonl");
  fs.writeFileSync(f, oldClaude("R", 2 * 3600e3) + oldClaude("R", 3600e3));
  t.step(7000);
  fs.writeFileSync(f, oldClaude("R", 2 * 3600e3)); // 重写成更短的内容
  t.step(); t.step(7000);
  assert.strictEqual(t.all.length, 0);
  ok("旧会话文件被重写 → 不弹窗");

  // 之后你在这个会话里真的发了新消息
  fs.appendFileSync(f, [
    { type: "user", sessionId: "R", timestamp: iso(0), message: { role: "user", content: "新的需求" } },
    { type: "assistant", sessionId: "R", timestamp: iso(0), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "好了" }] } },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n");
  t.step(); t.step(7000);
  assert.strictEqual(t.all.length, 1);
  assert.strictEqual(t.all[0].title, "新的需求");
  ok("在旧会话里发新消息 → 完成时正常弹一次");
}

// 3) Codex：旧的会话记录被复制成新文件
{
  const t = setup("codex");
  const ev = (type, ago, extra = {}) => JSON.stringify({ timestamp: iso(ago), type: "event_msg", payload: { type, ...extra } });
  fs.writeFileSync(path.join(t.dir, "rollout-old.jsonl"), [
    JSON.stringify({ timestamp: iso(5 * 3600e3), type: "session_meta", payload: { id: "O", cwd: "/p", source: "cli" } }),
    JSON.stringify({ timestamp: iso(5 * 3600e3), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "旧的 Codex 任务" }] } }),
    ev("task_started", 5 * 3600e3), ev("task_complete", 5 * 3600e3 - 60e3),
  ].join("\n") + "\n");
  t.step(); t.step(7000);
  assert.strictEqual(t.all.length, 0);
  ok("Codex 旧记录被复制 → 不弹窗");
}

console.log(`\n全部通过：${pass} 项`);
