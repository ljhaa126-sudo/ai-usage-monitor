// 仅用于浏览器预览：在 Wails 外运行时提供假数据
(function () {
  const H = 3600e3, now = Date.now();
  const hist = (arr) => arr.map((v, i) => ({ date: new Date(now - (6 - i) * 864e5).toISOString().slice(0, 10), value: v }));
  const base = (id, name, tagline, color, x) => Object.assign({ id, name, tagline, color, enabled: true, state: "ok", message: "", extra: [], resetCount: 0, history: hist([0,0,0,0,0,0,0]), historyUnit: "峰值 %", activeDays: [true,true,false,false,false,false,false], updatedAt: now - 120e3, dashboardUrl: "#", needsKey: "" }, x);
  const data = [
    base("claude", "Claude Code", "Anthropic · 订阅额度", "#D97757", { plan: "Max 20x", account: "", source: "OAuth API", headline: 37, headlineKey: "5 小时",
      primary: { key: "5h", label: "5 小时", usedPercent: 37, resetsAt: now + 2.6 * H, windowMinutes: 300 },
      secondary: { key: "week", label: "本周 · 全部模型", usedPercent: 22, resetsAt: now + 58 * H, windowMinutes: 10080 },
      extra: [{ key: "week", label: "本周 · Opus", usedPercent: 9, resetsAt: now + 58 * H }, { key: "month", label: "额外用量（本月）", usedPercent: 24.7, detail: "$12.34 / $50.00" }],
      resetCount: 3, history: hist([31, 88, 6, 63, 42, 26, 28]), historyUnit: "M tokens", activeDays: [true, true, true, false, false, false, true] }),
    base("codex", "Codex", "AI coding, more possibilities.", "#3BE38B", { plan: "Plus", account: "dev@example.com", source: "ChatGPT API", headline: 89, headlineKey: "5 小时",
      primary: { key: "5h", label: "5 小时", usedPercent: 89, resetsAt: now + 4.1 * H, windowMinutes: 300 },
      secondary: { key: "week", label: "本周", usedPercent: 22, resetsAt: now + 9.6 * H, windowMinutes: 10080 }, resetCount: 3, history: hist([30, 88, 6, 63, 42, 26, 27]), historyUnit: "M tokens", activeDays: [true, true, false, false, false, false, false] }),
    base("cursor", "Cursor", "Cursor 编辑器 · 月度额度", "#8B8CF8", { plan: "Pro", account: "me@cursor.dev", source: "Cursor 本地登录", headline: 2, planEndsAt: now + 13 * 24 * H,
      secondary: { key: "month", label: "本月 · 套餐总额度", usedPercent: 2, resetsAt: now + 13 * 24 * H, detail: "$0.40 / $20.00" },
      extra: [{ key: "month", label: "每月限额 · Auto / Cursor 模型", usedPercent: 2, resetsAt: now + 13 * 24 * H }, { key: "month", label: "每月限额 · 其他模型 (API)", usedPercent: 0, resetsAt: now + 13 * 24 * H }], history: hist([1, 1, 1, 2, 2, 2, 2]) }),
    base("gemini", "Gemini CLI", "Google · 每日请求额度", "#4C8DF6", { plan: "Gemini Code Assist for individuals", source: "Google OAuth", headline: 13,
      primary: { key: "day", label: "gemini-2.5-pro · 每日", usedPercent: 13, resetsAt: now + 7 * H, windowMinutes: 1440 },
      secondary: { key: "day", label: "gemini-2.5-flash · 每日", usedPercent: 4, resetsAt: now + 7 * H, windowMinutes: 1440 }, history: hist([5, 0, 12, 30, 8, 0, 13]) }),
    base("copilot", "GitHub Copilot", "高级请求 · 每月重置", "#E8EAED", { state: "nologin", headline: 0, needsKey: "token", message: "未找到 Copilot 令牌。可在设置里粘贴 GitHub Token（如 gh auth token 的输出）" }),
    base("kimi", "Kimi Code", "Moonshot · Coding 套餐", "#F06B8A", { plan: "Allegretto", source: "Kimi API", headline: 1,
      primary: { key: "5h", label: "5 小时", usedPercent: 1, resetsAt: now + 1.2 * H, windowMinutes: 300, detail: "已用 1 / 100" },
      secondary: { key: "week", label: "本周", usedPercent: 0, resetsAt: now + 100 * H, windowMinutes: 10080 } }),
    base("glm", "智谱 GLM", "GLM Coding Plan", "#3E7BFA", { state: "nologin", headline: 0, needsKey: "apikey", message: "请在设置里填写智谱 GLM Coding Plan 的 API Key" }),
  ];
  const cfg = { providers: {}, order: data.map((d) => d.id), refreshMinutes: 5, alwaysOnTop: true, autoStart: false, hideIdle: true, schemaV: 2 };
  data.forEach((d) => (cfg.providers[d.id] = { enabled: true, region: "cn" }));
  window.__mockApi = {
    GetConfig: async () => JSON.parse(JSON.stringify(cfg)),
    GetAll: async () => JSON.parse(JSON.stringify(data)),
    Refresh: async () => {}, SaveConfig: async () => "已保存", OpenURL: async () => {}, Quit: async () => {}, Version: async () => "1.0.0",
    SetLayout: async (...a) => { window.__layout = a; return new URLSearchParams(location.search).get("side") || "right"; },
    
  };
  window.__mockRuntime = { EventsOn: () => {} };
})();
