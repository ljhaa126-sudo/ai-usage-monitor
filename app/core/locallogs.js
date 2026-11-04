"use strict";
// 本地会话日志统计（Claude Code / Codex CLI）。日志只追加写入，这里按文件记住已读偏移，
// 每次只解析新增部分，所以可以秒级频繁调用。
const fs = require("fs");
const path = require("path");
const { home, dayKey } = require("./util");

class LogScanner {
  constructor(parseLine, newState) {
    this.parseLine = parseLine;
    this.newState = newState;
    this.files = new Map(); // path -> {offset, size, state, days:{}, rest:""}
  }

  scan(roots, maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    const seen = new Set();
    const walk = (dir, depth) => {
      if (depth > 6) return;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p, depth + 1); continue; }
        if (!e.name.endsWith(".jsonl")) continue;
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.mtimeMs < cutoff) continue;
        seen.add(p);
        this.readNew(p, st.size);
      }
    };
    for (const r of roots) walk(r, 0);
    for (const p of this.files.keys()) if (!seen.has(p)) this.files.delete(p);
    return [...this.files.values()];
  }

  readNew(p, size) {
    let f = this.files.get(p);
    if (!f || size < f.offset) {
      f = { offset: 0, state: this.newState(), days: {}, rest: "" };
      this.files.set(p, f);
    }
    if (size === f.offset) return;
    let fd;
    try {
      fd = fs.openSync(p, "r");
      const len = size - f.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, f.offset);
      f.offset = size;
      const text = f.rest + buf.toString("utf8");
      const lines = text.split("\n");
      f.rest = lines.pop();
      for (const line of lines) if (line) this.parseLine(line, f);
    } catch { /* ignore */ } finally {
      if (fd != null) fs.closeSync(fd);
    }
  }
}

function sumDays(files) {
  const m = {};
  for (const f of files) for (const [d, v] of Object.entries(f.days)) m[d] = (m[d] || 0) + v;
  return m;
}

function last7(m, scale) {
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = dayKey(Date.now() - i * 864e5);
    out.push({ date: d, value: (m[d] || 0) / scale });
  }
  return out;
}

// ---------- Claude Code ----------
function claudeDirs() {
  const dirs = [];
  if (process.env.CLAUDE_CONFIG_DIR) dirs.push(...process.env.CLAUDE_CONFIG_DIR.split(path.delimiter).filter(Boolean));
  dirs.push(path.join(home(), ".claude"), path.join(home(), ".config", "claude"));
  return dirs;
}

const claudeScanner = new LogScanner((line, f) => {
  if (!line.includes('"usage"')) return;
  let e;
  try { e = JSON.parse(line); } catch { return; }
  const m = e.message;
  if (!e.timestamp || !m || !m.usage) return;
  const key = (m.id || "") + ":" + (e.requestId || "");
  if (m.id) {
    if (f.state.seen.has(key)) return;
    f.state.seen.add(key);
  }
  const u = m.usage;
  const d = dayKey(Date.parse(e.timestamp));
  f.days[d] = (f.days[d] || 0) + (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  f.lastTs = Math.max(f.lastTs || 0, Date.parse(e.timestamp) || 0);
}, () => ({ seen: new Set() }));

function claudeLocal() {
  const files = claudeScanner.scan(claudeDirs().map((d) => path.join(d, "projects")), 9 * 864e5);
  const daily = sumDays(files);
  return { series: last7(daily, 1e6), daily, lastTs: Math.max(0, ...files.map((f) => f.lastTs || 0)) };
}

// ---------- Codex ----------
function codexHome() { return process.env.CODEX_HOME || path.join(home(), ".codex"); }

const codexScanner = new LogScanner((line, f) => {
  if (!line.includes("token_count")) return;
  let e;
  try { e = JSON.parse(line); } catch { return; }
  const pl = e.payload || {};
  if (pl.type !== "token_count") return;
  const ts = Date.parse(e.timestamp) || 0;
  if (pl.info) {
    const cur = (pl.info.total_token_usage || {}).total_tokens || 0;
    const last = (pl.info.last_token_usage || {}).total_tokens || 0;
    let delta = cur - f.state.prev;
    if (f.state.prev === 0 && cur > 0 && last > 0 && cur > last * 50) delta = last;
    if (delta > 0 && ts) { const d = dayKey(ts); f.days[d] = (f.days[d] || 0) + delta; }
    if (cur > 0) f.state.prev = cur;
  }
  if (pl.rate_limits && ts >= (f.rateTs || 0)) { f.rate = pl.rate_limits; f.rateTs = ts; }
}, () => ({ prev: 0 }));

function codexLocal() {
  const files = codexScanner.scan([path.join(codexHome(), "sessions"), path.join(codexHome(), "archived_sessions")], 9 * 864e5);
  const daily = sumDays(files);
  let rate = null, rateTs = 0;
  for (const f of files) if (f.rate && f.rateTs > rateTs) { rate = f.rate; rateTs = f.rateTs; }
  return { series: last7(daily, 1e6), daily, rate, rateTs };
}

module.exports = { claudeLocal, codexLocal, claudeDirs, codexHome };
