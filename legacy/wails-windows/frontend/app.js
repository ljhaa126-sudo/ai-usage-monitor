"use strict";
(() => {
  const BAR_W = 64, PANEL_W = 360, PANEL_H = 600;
  let api = null, rt = null;

  const $ = (s, el = document) => el.querySelector(s);
  const root = $("#root"), itemsEl = $("#items"), panel = $("#panel"), bar = $("#bar");

  let list = [];
  let cfg = null;
  let draft = null;
  let view = null; // null | providerId | "settings"
  let side = "right";
  let lastLayoutKey = "";
  let refreshingAll = false;

  // ---------- 图标 ----------
  const GLYPH = {
    claude: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
    codex: '<path d="M5 7.5 10 12l-5 4.5M12.5 17h6.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
    cursor: '<path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4Z M4 7.4 12 12l8-4.6M12 12v9.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>',
    gemini: '<path d="M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10Z" fill="currentColor"/>',
    copilot: '<path d="M8 7 3.5 12 8 17M16 7l4.5 5-4.5 5M13.5 5l-3 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
    kimi: '<path d="M7 4v16M17 4l-8 8 8 8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
    glm: '<path d="M6 5h12L6 19h12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
    settings: '<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  };
  const isLight = (c) => {
    const h = c.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 160;
  };
  const logo = (p, cls = "") =>
    `<div class="logo ${cls}" style="background:${p.color};color:${isLight(p.color) ? "#1c1c1e" : "#fff"}"><svg viewBox="0 0 24 24">${GLYPH[p.id] || ""}</svg></div>`;
  const I = {
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.9-3.9M4 4v4h4M4 13a8 8 0 0 0 14.9 3.9M20 20v-4h-4"/></svg>',
  };

  // ---------- 格式化 ----------
  const pad = (n) => String(n).padStart(2, "0");
  const lvl = (v) => (v >= 95 ? "bad" : v >= 80 ? "warn" : "");
  const col = (v) => (v >= 95 ? "var(--red)" : v >= 80 ? "var(--orange)" : "var(--green)");
  const P = (v) => (v == null ? "—" : Math.round(v) + "%");
  const dur = (ms) => {
    if (ms == null || isNaN(ms)) return "";
    if (ms <= 60000) return "即将";
    const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    if (d > 0) return h ? `${d}天${h}小时` : `${d}天`;
    if (h > 0) return mm ? `${h}小时${mm}分` : `${h}小时`;
    return `${mm}分钟`;
  };
  const afterReset = (ms) => (ms == null ? "重置时间未知" : ms <= 60000 ? "即将重置" : dur(ms) + "后重置");
  const WD = ["日", "一", "二", "三", "四", "五", "六"];
  const when = (ms) => {
    if (!ms) return "—";
    const d = new Date(ms), now = new Date();
    const tm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return tm;
    if (d.toDateString() === new Date(now.getTime() + 864e5).toDateString()) return "明天 " + tm;
    return `${d.getMonth() + 1}月${d.getDate()}日 周${WD[d.getDay()]}`;
  };
  const date = (ms) => { if (!ms) return "—"; const d = new Date(ms); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; };
  const hhmm = (ms) => { const d = ms ? new Date(ms) : new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const left = (w) => (w && w.resetsAt ? w.resetsAt - Date.now() : null);
  const winName = (w) => {
    if (!w) return "";
    if (w.key === "5h") return "5 小时额度";
    if (w.key === "week") return "本周额度";
    return w.label;
  };

  function ring(size, stroke, pct, color, track = "rgba(118,118,128,.24)") {
    const r = (size - stroke) / 2, c = 2 * Math.PI * r;
    const v = Math.max(0, Math.min(100, pct || 0));
    const off = c * (1 - v / 100);
    return `<svg class="r" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}"/>
      ${v > 0 ? `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}"/>` : ""}
    </svg>`;
  }
  const hasData = (p) => p.state !== "nologin" && !!(p.primary || p.secondary || (p.extra && p.extra.length));

  // ---------- 竖条 ----------
  function visibleList() {
    const hide = cfg && cfg.hideIdle;
    return list.filter((p) => p.enabled && !(hide && p.state === "nologin"));
  }

  function renderBar() {
    const vis = visibleList();
    itemsEl.innerHTML = vis.map((p) => {
      const has = hasData(p);
      const loading = p.state === "loading" && !p.updatedAt;
      const v = has ? p.headline : null;
      let dot = "";
      if (p.state === "nologin") dot = '<span class="dot"></span>';
      else if (p.state === "error" || p.state === "stale") dot = '<span class="dot err"></span>';
      return `<div class="item ${view === p.id ? "active" : ""} ${loading ? "loading" : ""}" data-id="${p.id}" title="${esc(p.name)}">
        <div class="ring">${ring(38, 3, loading ? 22 : v, loading ? "rgba(235,235,245,.3)" : col(v))}${logo(p)}</div>
        <div class="pct num ${has ? "" : "muted"}">${loading ? "…" : P(v)}</div>${dot}
      </div>`;
    }).join("") || `<div style="color:var(--label3);font-size:11px;text-align:center;padding:8px 0;line-height:1.5">未启用</div>`;
    itemsEl.querySelectorAll(".item").forEach((el) => el.addEventListener("click", () => toggleView(el.dataset.id)));
    $("#btnRefreshAll").classList.toggle("spin", refreshingAll);
    requestAnimationFrame(() => layout());
  }

  function toggleView(id) {
    if (view === id) view = null;
    else {
      if (id === "settings" && !cfg) return;
      view = id;
      if (id === "settings") draft = JSON.parse(JSON.stringify(cfg));
    }
    renderBar();
    renderPanel();
  }

  function applyRootClass() {
    root.className = "side-" + side + (view ? " expanded" : "");
  }
  async function layout(force) {
    const expanded = !!view;
    applyRootClass();
    // 收起态 bar 为自然高度，可直接测量；展开态 region 为整窗，barH 不影响
    const barH = Math.ceil(bar.getBoundingClientRect().height);
    const key = `${expanded}|${barH}|${side}`;
    if (key === lastLayoutKey && !force) return;
    lastLayoutKey = key;
    try {
      const s = await api.SetLayout(expanded, BAR_W, PANEL_W, barH, PANEL_H);
      if (s && s !== side) { side = s; applyRootClass(); await api.SetLayout(expanded, BAR_W, PANEL_W, barH, PANEL_H); }
    } catch (e) { /* ignore */ }
  }

  // ---------- 详情 ----------
  function renderPanel() {
    if (!view) { panel.classList.add("hidden"); panel.innerHTML = ""; return; }
    panel.classList.remove("hidden");
    if (view === "settings") return renderSettings();
    const p = list.find((x) => x.id === view);
    if (!p) { view = null; return renderPanel(); }
    const scroll = $(".p-body", panel)?.scrollTop || 0;
    const loading = p.state === "loading";
    const main = p.primary || p.secondary;
    const second = p.primary ? p.secondary : null;
    const extras = p.extra || [];

    // 提示
    let note = "";
    if (p.message) {
      const bad = p.state === "error";
      const go = p.state === "nologin" && p.needsKey ? ` <a data-act="settings">去设置</a>` : "";
      note = `<div class="group note ${bad ? "bad" : ""}"><span class="ic">!</span><div>${esc(p.message)}${go}</div></div>`;
    }

    // 主额度
    let hero = "";
    if (main) {
      const v = main.usedPercent, lm = left(main);
      let elapsed = "";
      if (main.windowMinutes && main.windowMinutes <= 1440 && main.resetsAt) {
        const e = main.windowMinutes * 60000 - (main.resetsAt - Date.now());
        if (e > 0) elapsed = dur(e);
      }
      hero = `<div class="group pad">
        <div class="hero">
          <div class="t">
            <div class="k">${esc(winName(main))}</div>
            <div class="v num" style="color:${v >= 80 ? col(v) : "var(--label)"}">${Math.round(v)}<small>% 已用</small></div>
            <div class="s">${main.detail ? esc(main.detail) + " · " : ""}剩余 ${P(100 - v)}</div>
          </div>
          <div class="ringbig">${ring(72, 7, v, col(v))}</div>
        </div>
        <div class="meta"><span>${afterReset(lm)}</span><span>${elapsed ? "窗口已过 <b>" + elapsed + "</b>" : main.resetsAt ? "<b>" + when(main.resetsAt) + "</b> 重置" : ""}</span></div>
      </div>`;
    }

    // 周额度
    let week = "";
    if (second) {
      const v = second.usedPercent, lm = left(second);
      const ad = p.activeDays || [];
      const today = (new Date().getDay() + 6) % 7;
      const days = ad.length === 7
        ? `<div class="days">${["一", "二", "三", "四", "五", "六", "日"].map((d, i) => `<div class="${i === today ? "today" : ""}"><i class="${ad[i] ? "on" : ""}"></i>${d}</div>`).join("")}</div>`
        : "";
      week = `<div class="group pad">
        <div class="line"><span class="n">${esc(winName(second))}</span><span class="p num" style="color:${v >= 80 ? col(v) : "var(--label)"}">${P(v)}</span></div>
        <div class="track" style="margin-top:10px"><div class="fill ${lvl(v)}" style="width:${v}%"></div></div>
        ${days}
        <div class="meta"><span>${afterReset(lm)}</span><span>${p.primary && p.primary.key === "5h" ? `本周已重置 <b>${p.resetCount || 0}</b> 次` : ""}</span></div>
      </div>`;
    }

    // 其他额度
    let extra = "";
    if (extras.length) {
      extra = `<div><div class="hdr">其他额度</div><div class="group">${extras.map((w) => {
        const unl = w.detail === "无限制";
        return `<div class="row col">
          <div class="line"><span class="n">${esc(w.label)}</span><span class="p num">${unl ? "不限" : P(w.usedPercent)}</span></div>
          ${unl ? "" : `<div class="track"><div class="fill ${lvl(w.usedPercent)}" style="width:${w.usedPercent}%"></div></div>`}
          <div class="sub"><span>${unl ? "" : w.detail ? esc(w.detail) : ""}</span><span>${w.resetsAt ? afterReset(left(w)) : ""}</span></div>
        </div>`;
      }).join("")}</div></div>`;
    }

    // 套餐
    const rows = [];
    if (p.plan) rows.push(["套餐", esc(p.plan)]);
    if (p.account) rows.push(["账号", esc(p.account)]);
    if (p.planEndsAt) rows.push([p.id === "codex" ? "订阅有效期至" : "本期结束", date(p.planEndsAt)]);
    if (p.credits) rows.push(["余额", esc(p.credits)]);
    if (p.source) rows.push(["数据来源", esc(p.source)]);
    if (p.updatedAt) rows.push(["上次更新", hhmm(p.updatedAt)]);
    const info = rows.length ? `<div><div class="hdr">套餐</div><div class="group">${rows.map((r) => `<div class="row"><span class="lab">${r[0]}</span><span class="val" title="${r[1]}">${r[1]}</span></div>`).join("")}</div></div>` : "";

    const chart = renderChart(p);

    let st = "额度正常", sd = "";
    const hv = p.headline || 0;
    if (p.state === "nologin") { st = "未连接"; sd = "warn"; }
    else if (p.state === "error") { st = "更新失败"; sd = "bad"; }
    else if (p.state === "stale") { st = "显示的是上次的数据"; sd = "warn"; }
    else if (loading && !p.updatedAt) { st = "正在读取…"; sd = "gray"; }
    else if (hv >= 95) { st = "额度即将用尽"; sd = "bad"; }
    else if (hv >= 80) { st = "额度偏紧"; sd = "warn"; }
    if (p.updatedAt && p.state !== "nologin") st += ` · ${hhmm(p.updatedAt)} 更新`;

    panel.innerHTML = `
      <div class="p-head">${logo(p, "sq")}
        <div class="p-title"><h1>${esc(p.name)}</h1><p>${esc(p.plan ? p.plan + " · " + p.tagline : p.tagline)}</p></div>
        <button class="circ r ${loading ? "spin" : ""}" data-act="refresh" title="刷新">${I.refresh}</button>
        <button class="circ" data-act="close" title="收起">${I.close}</button>
      </div>
      <div class="p-body">${note}${hero}${week}${extra}${chart}${info}</div>
      <div class="p-foot"><div class="st"><span class="sdot ${sd}"></span>${st}</div>
        <button class="tbtn gray" data-act="settings">设置</button>
        <button class="tbtn" data-act="open">用量页 ↗</button>
      </div>`;
    const body = $(".p-body", panel); if (body) body.scrollTop = scroll;
    panel.querySelectorAll("[data-act]").forEach((el) => el.addEventListener("click", () => {
      const a = el.dataset.act;
      if (a === "close") toggleView(view);
      else if (a === "refresh") { api.Refresh(p.id); p.state = "loading"; renderPanel(); }
      else if (a === "settings") toggleView("settings");
      else if (a === "open") api.OpenURL(p.dashboardUrl);
    }));
  }

  function renderChart(p) {
    const h = p.history || [];
    if (!h.length || !h.some((d) => d.value > 0)) return "";
    const tok = p.historyUnit === "M tokens";
    const W = 300, H = 112, B = 18, T = 8;
    const mx0 = Math.max(...h.map((d) => d.value));
    const mx = tok ? niceMax(mx0) : 100;
    const cw = W / h.length, bw = 14;
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%">`;
    [0, 0.5, 1].forEach((f) => {
      const y = T + (H - T - B) * (1 - f);
      s += `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="rgba(84,84,88,${f === 0 ? 0.65 : 0.35})" stroke-width=".5"/>`;
    });
    h.forEach((d, i) => {
      const cx = cw * i + cw / 2;
      const bh = d.value > 0 ? Math.max(3, (H - T - B) * (d.value / mx)) : 0;
      const today = i === h.length - 1;
      if (bh) s += `<rect x="${cx - bw / 2}" y="${H - B - bh}" width="${bw}" height="${bh}" rx="3" fill="var(--green)" opacity="${today ? 1 : 0.55}"/>`;
      const dd = new Date(d.date + "T00:00:00");
      s += `<text x="${cx}" y="${H - 3}" text-anchor="middle" class="${today ? "today" : ""}">${today ? "今天" : "周" + WD[dd.getDay()]}</text>`;
    });
    s += "</svg>";
    const total = h.reduce((a, d) => a + d.value, 0);
    const right = tok ? `合计 ${total >= 10 ? Math.round(total) : total.toFixed(1)}M tokens` : "每日最高使用率";
    return `<div><div class="hdr"><span>近 7 天</span><span>${right}</span></div><div class="group pad">${s}</div></div>`;
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    const e = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * e >= v) return m * e;
    return 10 * e;
  }

  // ---------- 设置 ----------
  const KEY_INFO = {
    claude: { ph: "sessionKey（sk-ant-sid…）或 OAuth Token，可选", hint: "自动读取 Claude Code 或 Claude 桌面版的登录。桌面版运行时登录信息被锁定，可先完全退出 Claude 再点刷新（只需一次）；或从浏览器 claude.ai 的 Cookie 复制 sessionKey 粘贴到这里。" },
    codex: { ph: "Access Token（可选）", hint: "自动读取本机 Codex 登录；在线接口不可用时使用本地会话日志。" },
    cursor: { ph: "WorkosCursorSessionToken（可选）", hint: "自动读取 Cursor 编辑器登录；读不到时，从浏览器 cursor.com 的 Cookie 复制。" },
    gemini: { ph: "", hint: "自动读取 Gemini CLI 的 Google 登录。" },
    copilot: { ph: "GitHub Token（可选）", hint: "自动读取 Copilot 插件登录；读不到时填 gh auth token 的输出。" },
    kimi: { ph: "API Key", hint: "在 kimi.com/code 控制台创建。" },
    glm: { ph: "API Key", hint: "GLM Coding Plan 的 API Key；z.ai 国际版请选「国际」。" },
  };

  function renderSettings() {
    const d = draft;
    const scroll = $(".p-body", panel)?.scrollTop || 0;
    const byId = Object.fromEntries(list.map((p) => [p.id, p]));
    const sw = (on, attr) => `<button class="switch ${on ? "on" : ""}" ${attr}></button>`;
    const stName = { ok: "已连接", nologin: "未连接", error: "出错", stale: "数据过期", loading: "读取中", disabled: "已关闭" };
    const provs = d.order.map((id, idx) => {
      const p = byId[id]; if (!p) return "";
      const pc = d.providers[id] || { enabled: true };
      const ki = KEY_INFO[id] || {};
      const x = pc.enabled && (ki.ph || ki.hint)
        ? `<div class="prov-x">${ki.ph ? `<div class="k"><input type="password" data-key="${id}" placeholder="${esc(ki.ph)}" value="${esc(pc.apiKey || "")}" spellcheck="false"/>${id === "glm" ? `<select data-region="glm"><option value="cn" ${pc.region !== "global" ? "selected" : ""}>国内</option><option value="global" ${pc.region === "global" ? "selected" : ""}>国际</option></select>` : ""}</div>` : ""}<div class="hint">${esc(ki.hint)}</div></div>`
        : "";
      return `<div class="prov"><div class="row">${logo(p)}<div class="lab">${esc(p.name)}<small>${pc.enabled ? stName[p.state] || "" : "已关闭"}</small></div>
        <div class="ord"><button data-up="${idx}" title="上移">▲</button><button data-down="${idx}" title="下移">▼</button></div>${sw(pc.enabled, `data-en="${id}"`)}</div>${x}</div>`;
    }).join("");
    panel.innerHTML = `
      <div class="p-head"><div class="logo sq" style="background:#1c1c1e;color:#f5f5f7"><svg viewBox="0 0 24 24">${GLYPH.settings}</svg></div>
        <div class="p-title"><h1>设置</h1><p>数据只保存在本机</p></div>
        <button class="circ" data-act="close" title="收起">${I.close}</button></div>
      <div class="p-body">
        <div><div class="hdr">通用</div><div class="group">
          <div class="row"><span class="lab">自动刷新</span><select id="sRefresh">${[1, 3, 5, 10, 15, 30].map((m) => `<option value="${m}" ${d.refreshMinutes === m ? "selected" : ""}>每 ${m} 分钟</option>`).join("")}</select></div>
          <div class="row"><span class="lab">窗口置顶</span>${sw(d.alwaysOnTop, 'data-g="alwaysOnTop"')}</div>
          <div class="row"><span class="lab">开机启动</span>${sw(d.autoStart, 'data-g="autoStart"')}</div>
          <div class="row"><span class="lab">隐藏未连接的 AI</span>${sw(d.hideIdle, 'data-g="hideIdle"')}</div>
        </div></div>
        <div><div class="hdr">网络</div><div class="group">
          <div class="row"><span class="lab" style="flex:none">代理</span><input type="text" id="sProxy" placeholder="跟随系统代理（例：127.0.0.1:7890）" value="${esc(d.proxy || "")}" spellcheck="false" style="flex:1"/></div>
        </div><div class="foot-note" style="padding-top:6px">留空会自动使用 Windows 系统代理（Clash、v2rayN 等开启「系统代理」即可）。填 direct 表示不走代理。</div></div>
        <div><div class="hdr">AI</div><div class="group">${provs}</div></div>
        <div class="foot-note">拖动竖条可移动位置；点击图标展开详情，再点一次收起。凭据保存在 %APPDATA%\\AIUsageMonitor。<span id="ver"></span></div>
      </div>
      <div class="p-foot">
        <button class="tbtn red" data-act="quit">退出</button>
        <span style="flex:1"></span>
        <button class="tbtn gray" data-act="cancel">取消</button>
        <button class="tbtn b" data-act="save">完成</button>
      </div>`;
    $(".p-body", panel).scrollTop = scroll;
    api.Version().then((v) => { const el = $("#ver"); if (el) el.textContent = " 版本 " + v; });

    panel.querySelectorAll("[data-g]").forEach((el) => el.addEventListener("click", () => { d[el.dataset.g] = !d[el.dataset.g]; renderSettings(); }));
    panel.querySelectorAll("[data-en]").forEach((el) => el.addEventListener("click", () => {
      const id = el.dataset.en; d.providers[id] = { ...(d.providers[id] || {}), enabled: !(d.providers[id] || {}).enabled }; renderSettings();
    }));
    panel.querySelectorAll("[data-key]").forEach((el) => el.addEventListener("input", () => { d.providers[el.dataset.key].apiKey = el.value.trim(); }));
    panel.querySelectorAll("[data-region]").forEach((el) => el.addEventListener("change", () => { d.providers[el.dataset.region].region = el.value; }));
    $("#sRefresh").addEventListener("change", (e) => { d.refreshMinutes = +e.target.value; });
    $("#sProxy").addEventListener("input", (e) => { d.proxy = e.target.value.trim(); });
    panel.querySelectorAll("[data-up],[data-down]").forEach((el) => el.addEventListener("click", () => {
      const i = +(el.dataset.up ?? el.dataset.down), j = el.dataset.up != null ? i - 1 : i + 1;
      if (j < 0 || j >= d.order.length) return;
      [d.order[i], d.order[j]] = [d.order[j], d.order[i]]; renderSettings();
    }));
    panel.querySelectorAll("[data-act]").forEach((el) => el.addEventListener("click", async () => {
      const a = el.dataset.act;
      if (a === "close" || a === "cancel") toggleView(view);
      else if (a === "quit") api.Quit();
      else if (a === "save") {
        const msg = await api.SaveConfig(d);
        cfg = JSON.parse(JSON.stringify(d));
        list = orderList(list);
        toast(msg || "已保存");
        refreshingAll = true;
        view = null;
        renderBar(); renderPanel();
      }
    }));
  }

  function orderList(l) {
    if (!cfg) return l;
    const idx = Object.fromEntries(cfg.order.map((id, i) => [id, i]));
    return [...l].sort((a, b) => (idx[a.id] ?? 99) - (idx[b.id] ?? 99)).map((p) => ({ ...p, enabled: cfg.providers[p.id]?.enabled ?? p.enabled }));
  }

  let toastT;
  function toast(t) {
    let el = $(".toast");
    if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
    el.textContent = t; el.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 2000);
  }

  function onStatus(data) {
    list = orderList(data || []);
    if (refreshingAll && !list.some((p) => p.state === "loading")) refreshingAll = false;
    renderBar();
    if (view && view !== "settings") renderPanel();
  }

  $("#btnSettings").addEventListener("click", () => toggleView("settings"));
  $("#btnRefreshAll").addEventListener("click", () => {
    refreshingAll = true; $("#btnRefreshAll").classList.add("spin"); api.Refresh("");
    setTimeout(() => { refreshingAll = false; $("#btnRefreshAll").classList.remove("spin"); }, 15000);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && view) toggleView(view); });
  document.addEventListener("contextmenu", (e) => { if (!e.target.closest("input")) e.preventDefault(); });
  setInterval(() => { if (view && view !== "settings") renderPanel(); }, 30000);

  (async function init() {
    for (let i = 0; i < 40 && !(window.go && window.go.main && window.runtime); i++) await new Promise((r) => setTimeout(r, 50));
    if (window.go && window.go.main) { api = window.go.main.App; rt = window.runtime; }
    else { api = window.__mockApi; rt = window.__mockRuntime; }
    cfg = await api.GetConfig();
    onStatus(await api.GetAll());
    rt.EventsOn("status", onStatus);
    layout(true);
  })();
})();
