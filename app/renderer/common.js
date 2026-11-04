"use strict";
// 渲染进程共用：图标、颜色、时间格式
window.UI = (() => {
  // 统一的白色单色图标（通用图形，不使用各家商标）
  const GLYPH = {
    claude: '<path d="M12 2.6v18.8M2.6 12h18.8M5.35 5.35l13.3 13.3M18.65 5.35 5.35 18.65M7.3 3.6l9.4 16.8M16.7 3.6 7.3 20.4M3.6 7.3l16.8 9.4M20.4 7.3 3.6 16.7" stroke="currentColor" stroke-width="1.55" stroke-linecap="round"/>',
    codex: '<path d="M5.5 8 10 12l-4.5 4M12.5 16.5h6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><rect x="2.5" y="3.5" width="19" height="17" rx="5" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    cursor: '<path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4Z M4 7.4 12 12l8-4.6M12 12v9.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
    gemini: '<path d="M12 2.5c.6 5.1 4.4 8.9 9.5 9.5-5.1.6-8.9 4.4-9.5 9.5-.6-5.1-4.4-8.9-9.5-9.5 5.1-.6 8.9-4.4 9.5-9.5Z" fill="currentColor"/>',
    copilot: '<path d="M8 7 3.5 12 8 17M16 7l4.5 5-4.5 5M13.5 5l-3 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    kimi: '<path d="M7.5 4.5v15M17 4.5l-7.5 7.5 7.5 7.5" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>',
    glm: '<path d="M6 5.5h12L6 18.5h12" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>',
    gear: '<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M5.5 18.5l1.8-1.8M16.7 7.3l1.8-1.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    boxai: '<path d="M12 2.8 20.2 7.4v9.2L12 21.2 3.8 16.6V7.4Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M3.8 7.4 12 12l8.2-4.6M12 12v9.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>',
    workbuddy: '<path d="M3.5 6.5 7 18l5-9 5 9 3.5-11.5" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>',
    plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
    deepseek: '<path d="M3 13.5c2.2-2.6 4.4-2.6 6.6 0s4.4 2.6 6.6 0 3.3-2 4.8-1.2M3 9c2.2-2.6 4.4-2.6 6.6 0s4.4 2.6 6.6 0 3.3-2 4.8-1.2M3 18c2.2-2.6 4.4-2.6 6.6 0s4.4 2.6 6.6 0 3.3-2 4.8-1.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    hunyuan: '<circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 3.4a4.3 4.3 0 0 1 0 8.6 4.3 4.3 0 0 0 0 8.6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="7.7" r="1.3" fill="currentColor"/><circle cx="12" cy="16.3" r="1.3" fill="currentColor"/>',
    codebuddy: '<path d="M16.5 7.2A6.4 6.4 0 1 0 16.5 16.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/>',
  };
  // 自定义工具：用名字首字母画一个圆角方块图标
  const LETTERS = {};
  const setLetters = (list) => { for (const s of list || []) if (s && s.custom) LETTERS[s.id] = s.letter || (s.name || "?")[0]; };
  const escTxt = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const glyph = (id, size = 20) => {
    if (!GLYPH[id] && (LETTERS[id] || /^c_/.test(id))) {
      const ch = escTxt(String(LETTERS[id] || "?").toUpperCase());
      return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="color:#fff"><rect x="3" y="3" width="18" height="18" rx="5.5" fill="none" stroke="currentColor" stroke-width="1.7"/><text x="12" y="16.3" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor" font-family="-apple-system,'Segoe UI','Microsoft YaHei UI',sans-serif">${ch}</text></svg>`;
    }
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="color:#fff">${GLYPH[id] || GLYPH.gear}</svg>`;
  };

  // 图示配色：绿 → 黄 → 橙红 → 红
  const color = (p) => (p >= 90 ? "#FF3B30" : p >= 70 ? "#FF5A1F" : p >= 50 ? "#FFD60A" : "#30D158");

  const pad = (n) => String(n).padStart(2, "0");
  const WD = ["日", "一", "二", "三", "四", "五", "六"];

  function left(ms) {
    if (ms == null) return "";
    if (ms <= 0) return "即将重置";
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d > 0) return `${d}天${h}小时后重置`;
    if (h > 0) return `${h}小时${pad(m)}分后重置`;
    return `${m}分${pad(sec)}秒后重置`;
  }

  function at(ms) {
    const d = new Date(ms), now = new Date();
    const tm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return `今天 ${tm}`;
    if (d.toDateString() === new Date(now.getTime() + 864e5).toDateString()) return `明天 ${tm}`;
    if (ms - Date.now() < 7 * 864e5) return `周${WD[d.getDay()]} ${tm}`;
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  // 图示风格：一天以内显示倒计时，更远显示具体时间
  function resetText(w) {
    if (!w || !w.resetsAt) return "";
    const ms = w.resetsAt - Date.now();
    return ms < 864e5 ? left(ms) : `${at(w.resetsAt)} 重置`;
  }

  function ago(ms) {
    if (!ms) return "";
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return `${s} 秒前更新`;
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前更新`;
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())} 更新`;
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const P = (v) => (v == null ? "—" : Math.round(v) + "%");
  const has = (s) => s.state !== "nologin" && !!(s.primary || s.secondary || (s.extra && s.extra.length));

  // 气泡里展示的两条（图示：当前会话 + 所有模型）
  function rows(s) {
    const out = [s.primary, s.secondary].filter(Boolean);
    for (const w of s.extra || []) { if (out.length >= 2) break; out.push(w); }
    return out.slice(0, 2);
  }

  return { GLYPH, glyph, setLetters, color, left, at, resetText, ago, esc, P, has, rows, pad };
})();
