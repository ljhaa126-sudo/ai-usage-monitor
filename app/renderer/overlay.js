"use strict";
(() => {
  const { glyph, color, left, resetText, ago, esc, P, has, rows } = window.UI;
  const api = window.aimon;
  const $ = (s) => document.querySelector(s);
  const bar = $("#bar"), shapeSvg = $("#shape"), shapePath = $("#shapePath"), itemsEl = $("#items"), pop = $("#pop"), card = $("#card");

  // 竖条尺寸（与图示比例一致）
  const BW = 74;   // 宽度
  const F = 26;    // 贴边时上下与屏幕边缘相接的弧形半径
  const R = 30;    // 竖条外侧圆角
  const PAD = 24;  // 上下内边距
  const GAP = 15;  // 竖条与气泡之间（尾巴所在）的距离

  let list = [], cfg = null;
  // 任务完成提醒
  const TOAST_MS = 10000, TOAST_W = 272;
  const toasts = []; // {ev, el, timer, born}
  const AI_NAME = { codex: "Codex", claude: "Claude Code", workbuddy: "WorkBuddy", codebuddy: "CodeBuddy", boxai: "BoxAI" };
  let pulses = {}; // 主进程维护：ai -> {kind}；通知关了脉冲也保留，回到该软件 / 点开 / 悬停图标才清除
  // 整体缩放：竖条、气泡、面板统一用 CSS scale（原点左上角）放大缩小。
  // 内部布局仍按 100% 的尺寸计算，定位时一律换算成屏幕上的实际像素（× Z）。
  const ZMIN = 0.6, ZMAX = 2;
  const clampZ = (z) => Math.max(ZMIN, Math.min(ZMAX, Math.round((Number(z) || 1) * 100) / 100));
  let Z = 1;
  let zoomSaveT = 0, zoomHudT = 0, zoomBusyUntil = 0;
  let pinned = null;   // 极简模式下点击固定的气泡
  let popId = null;    // 当前显示气泡的 AI
  let cardId = null;   // 详细面板
  let geo = { left: 0, top: 0, bodyTop: 0, bodyH: 0, mode: "edge", edge: "right" };
  let drag = null;
  let ignoring = true;
  let showT = 0, hideT = 0;

  // ---------------- 点击穿透：只有鼠标在竖条/气泡/面板上时才接收点击 ----------------
  function setIgnore(v) { if (v !== ignoring) { ignoring = v; api.setIgnore(v); } }
  document.addEventListener("mousemove", (e) => {
    if (drag) return setIgnore(false);
    const el = document.elementFromPoint(e.clientX, e.clientY);
    setIgnore(!(el && el.closest(".hit")));
  });
  document.addEventListener("mouseleave", () => { if (!drag) setIgnore(true); });

  // ---------------- 数据 ----------------
  const visible = () => {
    const hide = cfg && cfg.hideIdle;
    return list.filter((s) => s.enabled && (!hide || has(s) || pulses[s.id])); // 有提醒脉冲的图标即使未连接也显示
  };
  const byId = (id) => list.find((s) => s.id === id);
  // 显示方式：已用（默认）/ 剩余。颜色始终按「已用」算（快用完时仍然变红）
  const remainMode = () => !!cfg && cfg.valueMode === "remain";
  const shown = (v) => (remainMode() ? 100 - v : v);
  const verb = () => (remainMode() ? "剩余" : "已用");
  // 「已用 25 / 200」→「剩余 175 / 200」（两边单位相同时才换算）
  function detailText(d) {
    if (!remainMode() || !d) return d;
    return String(d).replace(/已用 ([\d.]+)( ?[万亿KMB]?) \/ ([\d.]+)( ?[万亿KMB]?)/, (m, a, ua, b, ub) => {
      if (ua.trim() !== ub.trim()) return m;
      const dec = (b.split(".")[1] || "").length;
      return `剩余 ${Math.max(0, Number(b) - Number(a)).toFixed(dec)}${ua} / ${b}${ub}`;
    });
  }

  // ---------------- 竖条 ----------------
  // 竖条图标的圆环：外圈 = 当前会话（5 小时）用量；内圈 = 本周 / 总用量（设置里可以关掉）
  const IN_R = 17, IN_W = 2.6, IN_C = 2 * Math.PI * IN_R;
  function ringSVG(size, stroke, pct, col, track) {
    const r = (size - stroke) / 2, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, pct || 0));
    return `<svg class="r" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}"/>
      <circle class="arc" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${col}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${v > 0 ? c * (1 - v / 100) : c}"/>
      <g class="inner"><circle cx="${size / 2}" cy="${size / 2}" r="${IN_R}" fill="none" stroke="#1d1d1f" stroke-width="${IN_W}"/>
      <circle class="arc2" cx="${size / 2}" cy="${size / 2}" r="${IN_R}" fill="none" stroke="#30D158" stroke-width="${IN_W}" stroke-linecap="round" stroke-dasharray="${IN_C}" stroke-dashoffset="${IN_C}"/></g>
    </svg>`;
  }

  function renderBar() {
    const vis = visible();
    const want = vis.map((s) => s.id).join(",") || "_empty";
    // 结构变化才重建 DOM（否则只更新数值，圆环动画更顺滑）
    if (itemsEl.dataset.ids !== want) {
      itemsEl.dataset.ids = want;
      itemsEl.innerHTML = vis.length
        ? vis.map((s) => `<div class="item" data-id="${s.id}"><div class="ring">${ringSVG(48, 4, 0, "#30D158", "#2a2a2c")}<div class="g">${glyph(s.id, 20)}</div></div><div class="pct num">—</div></div>`).join("")
        : `<div class="item" data-id="_settings" title="设置"><div class="ring">${ringSVG(48, 4, 0, "#30D158", "#2a2a2c")}<div class="g">${glyph("gear", 20)}</div></div><div class="pct" style="font-size:12px;color:rgba(255,255,255,.5)">设置</div></div>`;
    }
    for (const el of itemsEl.querySelectorAll(".item")) {
      const s = byId(el.dataset.id);
      if (!s) continue;
      const ok = has(s);
      const loading = s.state === "loading" && !s.updatedAt;
      const v = ok ? s.headline : 0;
      const bal = !!s.headlineText; // 余额类（DeepSeek）不换算剩余
      const sv = ok && !bal ? Math.max(0, Math.min(100, shown(v))) : v;
      const arc = el.querySelector(".arc");
      const c = 2 * Math.PI * 22;
      arc.setAttribute("stroke", loading ? "rgba(255,255,255,.35)" : color(v));
      arc.setAttribute("stroke-dashoffset", loading ? c * 0.78 : sv > 0 ? c * (1 - Math.min(100, sv) / 100) : c);
      // 内圈：同时有「当前会话」和「本周 / 总额度」两种额度时显示后者
      const second = ok && s.primary && s.secondary ? s.secondary : null;
      const showIn = !!second && cfg && cfg.innerRing !== false && !loading;
      el.classList.toggle("in2", showIn);
      if (showIn) {
        const v2 = Math.max(0, Math.min(100, second.usedPercent || 0));
        const s2 = Math.max(0, Math.min(100, shown(v2)));
        const a2 = el.querySelector(".arc2");
        if (a2) { a2.setAttribute("stroke", color(v2)); a2.setAttribute("stroke-dashoffset", s2 > 0 ? IN_C * (1 - s2 / 100) : IN_C); }
      }
      el.classList.toggle("idle", !ok && !loading);
      el.classList.toggle("loading", loading);
      el.classList.toggle("on", s.id === cardId || s.id === pinned);
      const pu = pulses[s.id];
      el.classList.toggle("notify", !!pu);
      el.classList.toggle("need", !!pu && pu.kind === "input");
      el.querySelector(".pct").textContent = loading ? "…" : ok ? (s.headlineText || Math.round(shown(v)) + "%") : "—"; // 余额类（DeepSeek）显示金额
      let dot = el.querySelector(".dot");
      const want = s.state === "error" || s.state === "stale" ? "dot err" : s.state === "nologin" ? "dot" : "";
      if (want && !dot) { dot = document.createElement("span"); el.appendChild(dot); }
      if (dot) { if (want) dot.className = want; else dot.remove(); }
      el.title = s.state === "nologin" ? `${s.name}：未连接` : "";
    }
    layout();
  }

  function pathEdge(W, H) {
    // 贴右边的形状：外侧两个圆角 + 上下各一段与屏幕边缘相接的内凹弧（图示效果）
    return `M ${W} 0 A ${F} ${F} 0 0 1 ${W - F} ${F} L ${R} ${F} A ${R} ${R} 0 0 0 0 ${F + R} L 0 ${F + H - R} A ${R} ${R} 0 0 0 ${R} ${F + H} L ${W - F} ${F + H} A ${F} ${F} 0 0 1 ${W} ${2 * F + H} Z`;
  }
  function pathFloat(W, H) {
    const r = W / 2;
    return `M ${r} 0 H ${W - r} A ${r} ${r} 0 0 1 ${W} ${r} V ${H - r} A ${r} ${r} 0 0 1 ${W - r} ${H} H ${r} A ${r} ${r} 0 0 1 0 ${H - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
  }

  // 贴顶部时横向排列
  const HPAD = 22, TPAD = 9; // 横向：两端内边距、上下内边距
  const isTop = () => !!cfg && cfg.dock.mode === "edge" && cfg.dock.edge === "top" && !(drag && drag.moved);
  // 屏幕信息（主进程）：刘海位置、是否盖住菜单栏
  let scr = { notch: null, menuBar: 0, fullTop: false };
  function clearNotchGap() { for (const x of itemsEl.querySelectorAll(":scope > .ngap, :scope > .ghost")) x.remove(); }
  // 刘海屏：图标平分在刘海两侧，中间留出刘海的宽度；两边数量不等时补一个看不见的占位，保持对称
  function applyNotchGap(n) {
    clearNotchGap();
    if (!n) return null;
    const items = [...itemsEl.querySelectorAll(":scope > .item")];
    if (!items.length) return null;
    const k = Math.ceil(items.length / 2);
    const gap = document.createElement("div");
    gap.className = "ngap";
    gap.style.width = Math.round((n.x1 - n.x0 + 18) / Z) + "px";
    gap.style.flex = "none";
    itemsEl.insertBefore(gap, items[k] || null);
    if (items.length % 2) { const g = document.createElement("div"); g.className = "item ghost"; itemsEl.appendChild(g); }
    return gap;
  }
  function layoutTop() {
    const Wv = window.innerWidth;
    const d = cfg.dock;
    const n = scr.fullTop && scr.notch && cfg.notchSplit !== false ? scr.notch : null;
    // 先按拖放的位置正常摆放
    clearNotchGap();
    const size = () => {
      const len = itemsEl.offsetWidth + HPAD * 2; // 主体长度（不含两端内凹弧）
      const th = itemsEl.offsetHeight + TPAD * 2; // 厚度
      Z = Math.max(ZMIN, Math.min(clampZ(cfg.zoom), Wv / (len + 2 * F + 16)));
      return { len, th, w: len + 2 * F };
    };
    let { len, th, w } = size();
    const cx = (d.tx == null ? 0.5 : Math.max(0, Math.min(1, d.tx))) * Wv; // 记录的是中心位置
    let left = Math.round(Math.max(0, Math.min(Wv - w * Z, cx - (w * Z) / 2)));
    // 只有放在刘海区域（和刘海有重叠，图标可能被摄像头挡住）时才适配刘海：以刘海为中心、图标分在两侧；
    // 放在别处就按原位置正常显示，不强行挪到刘海
    if (n && left < n.x1 && left + w * Z > n.x0) {
      const gapEl = applyNotchGap(n);
      ({ len, th, w } = size());
      const gc = (F + HPAD + gapEl.offsetLeft + gapEl.offsetWidth / 2) * Z;
      left = Math.round((n.x0 + n.x1) / 2 - gc);
    }
    const top = 0;
    itemsEl.style.top = TPAD + "px";
    itemsEl.style.left = F + HPAD + "px";
    // 复用竖条的贴边形状：转置 + 翻转，贴在屏幕顶边，两端是内凹弧
    shapePath.setAttribute("d", pathEdge(th, len));
    shapeSvg.setAttribute("width", th);
    shapeSvg.setAttribute("height", w);
    shapeSvg.setAttribute("viewBox", `0 0 ${th} ${w}`);
    shapeSvg.style.transformOrigin = "0 0";
    shapeSvg.style.transform = `matrix(0,-1,1,0,0,${th})`;
    Object.assign(bar.style, { left: left + "px", top: top + "px", width: w + "px", height: th + "px", transform: Z === 1 ? "" : `scale(${Z})`, transformOrigin: "0 0" });
    bar.classList.remove("float", "dragging");
    geo = { left, top, bodyTop: top, bodyH: th * Z, w: w * Z, mode: "edge", edge: "top", bodyLeft: left + F * Z, bodyW: len * Z };
    if (popId) placeBubble(pop, popId, 272);
    if (cardId) placeBubble(card, cardId, 360);
    placeToasts();
  }

  function layout() {
    if (!cfg) return;
    bar.classList.toggle("h", isTop());
    bar.classList.toggle("nonum", !!cfg.hideNumbers);
    if (isTop()) return layoutTop();
    clearNotchGap();
    itemsEl.style.left = "";
    shapeSvg.style.transformOrigin = "";
    const Wv = window.innerWidth, Hv = window.innerHeight;
    const bodyH = itemsEl.offsetHeight + PAD * 2;
    const d = cfg.dock;
    Z = clampZ(cfg.zoom);
    // 放太大时竖条可能超出屏幕高度：自动限制到刚好放得下
    Z = Math.max(ZMIN, Math.min(Z, Hv / (bodyH + 2 * F + 16)));
    const sW = BW * Z; // 屏幕上的实际宽度
    const mode = drag && drag.moved ? "float" : d.mode;
    let left, top, h, bodyTop;
    if (mode === "edge") {
      h = bodyH + 2 * F;
      top = Math.round(Math.max(0, Math.min(1, d.y)) * Math.max(0, Hv - h * Z));
      left = d.edge === "left" ? 0 : Wv - sW;
      bodyTop = top + F * Z;
      itemsEl.style.top = F + PAD + "px";
      shapePath.setAttribute("d", pathEdge(BW, bodyH));
      shapeSvg.style.transform = d.edge === "left" ? "scaleX(-1)" : "";
    } else {
      h = bodyH;
      if (drag && drag.moved) { left = drag.left; top = drag.top; }
      else {
        left = Math.round(Math.max(0, Math.min(1, d.x)) * Math.max(0, Wv - sW));
        top = Math.round(Math.max(0, Math.min(1, d.y)) * Math.max(0, Hv - bodyH * Z));
      }
      bodyTop = top;
      itemsEl.style.top = PAD + "px";
      shapePath.setAttribute("d", pathFloat(BW, bodyH));
      shapeSvg.style.transform = "";
    }
    Object.assign(bar.style, { left: left + "px", top: top + "px", width: BW + "px", height: h + "px", transform: Z === 1 ? "" : `scale(${Z})`, transformOrigin: "0 0" });
    shapeSvg.setAttribute("width", BW);
    shapeSvg.setAttribute("height", h);
    shapeSvg.setAttribute("viewBox", `0 0 ${BW} ${h}`);
    bar.classList.toggle("float", mode === "float");
    bar.classList.toggle("dragging", !!(drag && drag.moved));
    // geo 一律是屏幕像素：w = 竖条实际宽度，bodyH = 实际高度
    geo = { left, top, bodyTop, bodyH: bodyH * Z, w: sW, mode, edge: d.edge };
    if (popId) placeBubble(pop, popId, 272);
    if (cardId) placeBubble(card, cardId, 360);
    placeToasts();
  }

  // ---------------- 气泡 / 面板定位（带尾巴，指向对应图标） ----------------
  function side() {
    if (geo.mode === "edge" && geo.edge === "top") return "below";
    if (geo.mode === "edge") return geo.edge === "right" ? "left" : "right";
    return geo.left + geo.w / 2 < window.innerWidth / 2 ? "right" : "left";
  }

  function anchorY(id) {
    const el = itemsEl.querySelector(`.item[data-id="${id}"] .ring`);
    if (!el) return geo.bodyTop + geo.bodyH / 2;
    const r = el.getBoundingClientRect();
    return r.top + r.height / 2;
  }

  function anchorX(id) {
    const el = itemsEl.querySelector(`.item[data-id="${id}"] .ring`);
    if (!el) return geo.left + geo.w / 2;
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2;
  }
  // 尾巴朝上（顶部横向时，气泡在竖条下方）
  function tailUp(el, tx) {
    let tail = el.querySelector(":scope > .tail");
    if (!tail) {
      tail = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      tail.setAttribute("class", "tail");
      tail.setAttribute("viewBox", "0 0 16 34");
      tail.innerHTML = '<path d="M0 0 C5 5.5 9.5 11.5 16 17 C9.5 22.5 5 28.5 0 34 Z"/>';
      el.appendChild(tail);
    }
    tail.style.display = "";
    Object.assign(tail.style, { left: tx - 17 + "px", top: "1px", right: "", transformOrigin: "0 0", transform: "rotate(-90deg)" });
  }

  function placeBubble(el, id, w) {
    const Hv = window.innerHeight;
    const h = el.offsetHeight;
    const sd = side();
    if (sd === "below") {
      const Wv = window.innerWidth, ax = anchorX(id);
      const x = Math.round(Math.max(8, Math.min(Wv - w * Z - 8, ax - (w * Z) / 2)));
      const y = Math.round(geo.top + geo.bodyH + GAP * Z);
      Object.assign(el.style, { left: x + "px", top: y + "px", transform: Z === 1 ? "" : `scale(${Z})`, transformOrigin: "0 0" });
      tailUp(el, Math.max(26, Math.min(w - 26, (ax - x) / Z)));
      return;
    }
    const ay = anchorY(id);
    const x = sd === "left" ? geo.left - (GAP + w) * Z : geo.left + geo.w + GAP * Z;
    const y = Math.round(Math.max(8, Math.min(Hv - h * Z - 8, ay - (h * Z) / 2)));
    Object.assign(el.style, { left: x + "px", top: y + "px", transform: Z === 1 ? "" : `scale(${Z})`, transformOrigin: "0 0" });
    let tail = el.querySelector(":scope > .tail");
    if (!tail) {
      tail = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      tail.setAttribute("class", "tail");
      tail.setAttribute("viewBox", "0 0 16 34");
      tail.innerHTML = '<path d="M0 0 C5 5.5 9.5 11.5 16 17 C9.5 22.5 5 28.5 0 34 Z"/>';
      el.appendChild(tail);
    }
    const ty = Math.max(16, Math.min(h - 50, (ay - y) / Z - 17));
    tail.style.transformOrigin = "";
    Object.assign(tail.style, sd === "left" ? { left: w - 1 + "px", right: "", top: ty + "px", transform: "" } : { left: "-15px", top: ty + "px", transform: "scaleX(-1)" });
  }

  // ---------------- 极简气泡内容（复刻图示） ----------------
  function popHTML(s) {
    let h = `<h4>${glyph(s.id, 19)}<span>${esc(s.short)} 用量</span></h4>`;
    if (!has(s)) {
      if (s.state === "loading") return h + `<div class="msg">正在读取…</div>`;
      return h + `<div class="msg ${s.state === "error" ? "err" : ""}">${esc(s.message || "暂无数据")}</div><span class="lnk" data-act="settings">打开设置</span>`;
    }
    for (const w of rows(s)) {
      const v = w.usedPercent;
      const unl = w.detail === "不限";
      if (w.key === "balance") { // 余额类（DeepSeek）：没有百分比，只显示余额
        h += `<div class="sec"><div class="l"><span>${esc(w.label)}</span><span class="num">${v >= 100 ? "已用完" : ""}</span></div>
        <div class="u num" style="font-size:15px;color:${v >= 100 ? "#FF453A" : "#fff"}">${esc(w.detail || "")}</div></div>`;
        continue;
      }
      const sv = Math.max(0, Math.min(100, shown(v)));
      const nums = !(cfg && cfg.hideNumbers); // 「只显示进度」时不写数字
      h += `<div class="sec"><div class="l"><span>${esc(w.label)}</span><span class="num" ${unl || !w.resetsAt ? "" : `data-cd="${w.resetsAt}" data-fmt="reset"`}>${unl || !w.resetsAt ? "" : resetText(w)}</span></div>
        <div class="track"><div class="fill" style="width:${unl ? (remainMode() ? 100 : 0) : Math.max(sv > 0 ? 2 : 0, sv)}%;background:${color(v)}"></div></div>
        ${nums ? `<div class="u num">${unl ? "不限量" : `${verb()} ${Math.round(sv)}%`}${w.detail && !unl ? `<span style="color:rgba(235,235,245,.45)"> · ${esc(detailText(w.detail))}</span>` : ""}</div>` : ""}</div>`;
    }
    if (s.resets) {
      const n = s.resets.available || 0;
      const first = (s.resets.credits || [])[0];
      const m = rsMsg && rsMsg.id === s.id ? `<div class="rs-msg ${rsMsg.ok ? "ok" : "err"}">${esc(rsMsg.text)}</div>` : "";
      const cs = n > 0 ? (s.resets.credits || []).slice(0, n) : [];
      if (cs.length) {
        // 每次重置单独一行：标题 + 到期时间 + 各自的按钮（按到期时间先后排列）
        h += `<div class="rs-mini rs-head"><span>可用重置 <b class="rs-n on">${n}</b> 次</span></div>`;
        h += cs.map((c) => `<div class="rs-row"><div class="rs-t"><div class="n">${esc(c.title || "限额重置")}</div><div class="sub">${esc(expText(c.expiresAt) || (c.grantedAt ? "获得于 " + new Date(c.grantedAt).toLocaleDateString() : ""))}</div></div>${rsBtn(s, c.id, "立即重置")}</div>`).join("") + m;
      } else {
        h += `<div class="rs-mini"><span>可用重置 <b class="rs-n ${n ? "on" : ""}">${n}</b> 次</span>${n ? rsBtn(s, first ? first.id : "", "立即重置") : ""}</div>${m}`;
      }
    }
    if (s.state === "stale" || s.state === "error") h += `<div class="foot"><span style="color:#ff8a80">${esc(s.message)}</span></div>`;
    else if (s.lagging || s.fromCache) {
      // 刷新失败时写清楚原因，而不是一直显示「正在更新…」
      const cf = /Cloudflare|登录网页版/.test(s.lastErrorFull || "");
      const why = s.fromCache ? "正在更新…" : cf ? "被 Cloudflare 拦截 · 去设置里登录网页版" : s.lastError ? `更新失败（${s.lastError.length > 16 ? s.lastError.slice(0, 16) + "…" : s.lastError}）· 稍后重试` : "稍后自动重试";
      h += `<div class="foot"><span data-ago="${s.updatedAt}">${ago(s.updatedAt)}</span><span style="${s.fromCache ? "" : "color:#FF9F0A"}" title="${esc(s.lastErrorFull || "")}">${esc(why)}</span></div>`;
    }
    return h;
  }

  function setPop(s) {
    let pc = pop.querySelector(":scope > .pc");
    if (!pc) { pc = document.createElement("div"); pc.className = "pc"; pop.prepend(pc); }
    const html = popHTML(s);
    if (pc._html !== html) { pc.innerHTML = html; pc._html = html; }
  }

  // 每秒只更新倒计时 / 「x 秒前更新」文字，不重绘整个气泡或面板（不闪）
  function tickText(root) {
    for (const el of root.querySelectorAll("[data-cd]")) {
      const t = Number(el.dataset.cd);
      const txt = el.dataset.fmt === "left" ? left(t - Date.now()) : resetText({ resetsAt: t });
      if (el.textContent !== txt) el.textContent = txt;
    }
    for (const el of root.querySelectorAll("[data-ago]")) {
      const txt = ago(Number(el.dataset.ago));
      if (el.textContent !== txt) el.textContent = txt;
    }
  }

  function showPop(id) {
    const s = byId(id);
    if (!s || drag) return;
    if (cardId === id) return;
    popId = id;
    setPop(s);
    pop.classList.remove("hidden");
    placeBubble(pop, id, 272);
    requestAnimationFrame(() => pop.classList.add("show"));
  }
  function hidePop(force) {
    if (pinned && !force) return;
    popId = null;
    pinned = null;
    pop.classList.remove("show");
    setTimeout(() => { if (!popId) pop.classList.add("hidden"); }, 150);
    renderBar();
  }

  // ---------------- 详细面板（当前 Windows 版的完整内容） ----------------
  function bigRing(v, cv = v) { // v：圆环长度；cv：按「已用」算的颜色
    const sz = 70, st = 7, r = (sz - st) / 2, c = 2 * Math.PI * r;
    return `<svg viewBox="0 0 ${sz} ${sz}" width="${sz}" height="${sz}"><circle cx="35" cy="35" r="${r}" fill="none" stroke="#2a2a2c" stroke-width="${st}"/>${v > 0 ? `<circle cx="35" cy="35" r="${r}" fill="none" stroke="${color(cv)}" stroke-width="${st}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - Math.min(100, v) / 100)}"/>` : ""}</svg>`;
  }

  function chart(s) {
    const h = s.history || [];
    if (!h.some((d) => d.value > 0)) return "";
    const tok = s.historyUnit === "M tokens";
    const Wc = 300, Hc = 108, B = 18, T = 8;
    const mx0 = Math.max(...h.map((d) => d.value));
    let mx = 100;
    if (tok) { const e = Math.pow(10, Math.floor(Math.log10(mx0 || 1))); mx = [1, 2, 2.5, 5, 10].map((m) => m * e).find((v) => v >= mx0) || mx0; }
    const cw = Wc / h.length;
    const WD = ["日", "一", "二", "三", "四", "五", "六"];
    let svg = `<svg class="chart" viewBox="0 0 ${Wc} ${Hc}" width="100%">`;
    for (const f of [0, 0.5, 1]) { const y = T + (Hc - T - B) * (1 - f); svg += `<line x1="0" x2="${Wc}" y1="${y}" y2="${y}" stroke="rgba(255,255,255,${f ? 0.06 : 0.14})" stroke-width=".5"/>`; }
    h.forEach((d, i) => {
      const cx = cw * i + cw / 2, bh = d.value > 0 ? Math.max(3, (Hc - T - B) * (d.value / mx)) : 0, today = i === h.length - 1;
      if (bh) svg += `<rect x="${cx - 7}" y="${Hc - B - bh}" width="14" height="${bh}" rx="3" fill="${color(tok ? 30 : d.value)}" opacity="${today ? 1 : 0.55}"/>`;
      svg += `<text x="${cx}" y="${Hc - 3}" text-anchor="middle" class="${today ? "today" : ""}">${today ? "今天" : "周" + WD[new Date(d.date + "T00:00:00").getDay()]}</text>`;
    });
    svg += "</svg>";
    const total = h.reduce((a, d) => a + d.value, 0);
    return `<div><div class="hdr"><span>${tok ? "近 7 天 · 本机" : "近 7 天"}</span><span>${tok ? `合计 ${total >= 10 ? Math.round(total) : total.toFixed(1)}M tokens` : "每日最高使用率"}</span></div><div class="grp pd">${svg}</div></div>`;
  }

  // ---------------- 限额重置（参考官方「使用限额重置」面板） ----------------
  // 点击「使用重置额度」→ 按钮变为「确认使用？」（4 秒内再点一次才真正执行，防误触）
  let rsConfirm = null;   // `${id}|${creditId}`
  let rsBusy = null;      // 正在执行的 AI id
  let rsMsg = null;       // { id, text, ok, at }
  let rsConfirmT = 0;

  function expText(ms) {
    if (!ms) return "";
    const d = new Date(ms), pad = (n) => String(n).padStart(2, "0");
    const left = ms - Date.now();
    const tail = left > 0 && left < 3 * 864e5 ? `（剩 ${Math.max(1, Math.ceil(left / 36e5))} 小时）` : "";
    return `将于 ${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())} 到期${tail}`;
  }

  function rsBtn(s, cid, label) {
    const key = `${s.id}|${cid || ""}`;
    if (rsBusy === s.id) return `<span class="rbtn busy">正在重置…</span>`;
    if (rsConfirm === key) return `<span class="rbtn warn" data-act="reset" data-cid="${esc(cid || "")}">确认使用？</span>`;
    return `<span class="rbtn" data-act="reset" data-cid="${esc(cid || "")}">${label || "使用重置额度"}</span>`;
  }

  function resetHTML(s) {
    const r = s.resets;
    if (!r) return "";
    const n = r.available || 0;
    const msg = rsMsg && rsMsg.id === s.id ? `<div class="rs-msg ${rsMsg.ok ? "ok" : "err"}">${esc(rsMsg.text)}</div>` : "";
    let items = "";
    if (n > 0) {
      const cs = (r.credits || []).slice(0, Math.max(n, 1));
      items = cs.length
        ? cs.map((c) => `<div class="row rs-item"><div class="rs-t"><div class="n">${esc(c.title || "限额重置")}</div><div class="sub">${esc(expText(c.expiresAt))}</div></div>${rsBtn(s, c.id)}</div>`).join("")
        : `<div class="row rs-item"><div class="rs-t"><div class="n">限额重置 × ${n}</div><div class="sub">由服务端自动选择最早到期的一次</div></div>${rsBtn(s, "")}</div>`;
    } else {
      items = `<div class="row rs-item"><div class="rs-t"><div class="sub">暂无可用的重置次数</div></div></div>`;
    }
    return `<div><div class="hdr"><span>使用限额重置</span><span>可用 <b class="rs-n ${n ? "on" : ""}">${n}</b> 次</span></div>
      <div class="grp"><div class="row rs-intro">使用一次重置，即可恢复 5 小时限额、每周限额，或同时恢复两者</div>${items}</div>${msg}</div>`;
  }

  function rerender() {
    if (cardId) renderCardContent();
    const ps = popId && byId(popId);
    if (ps) setPop(ps);
  }

  async function doReset(s, cid) {
    const key = `${s.id}|${cid || ""}`;
    if (rsBusy) return;
    if (rsConfirm !== key) {
      rsConfirm = key;
      clearTimeout(rsConfirmT);
      rsConfirmT = setTimeout(() => { rsConfirm = null; rerender(); }, 4000);
      return rerender();
    }
    clearTimeout(rsConfirmT);
    rsConfirm = null;
    rsBusy = s.id;
    rsMsg = null;
    rerender();
    let r;
    try { r = await api.consumeReset(s.id, cid || undefined); } catch (e) { r = { ok: false, message: "重置失败：" + (e && e.message || e) }; }
    rsBusy = null;
    rsMsg = { id: s.id, text: (r && r.message) || "已提交", ok: !!(r && r.ok), at: Date.now() };
    rerender();
    setTimeout(() => { if (rsMsg && Date.now() - rsMsg.at >= 7900) { rsMsg = null; rerender(); } }, 8000);
  }

  function cardHTML(s) {
    const main = s.primary || s.secondary;
    const second = s.primary ? s.secondary : null;
    const loading = s.state === "loading";
    let note = "";
    if (s.message) note = `<div class="grp note ${s.state === "error" || s.state === "stale" ? "err" : ""}">${esc(s.message)}${s.state === "nologin" ? ` <a data-act="settings">去设置</a>` : ""}</div>`;
    let hero = "";
    if (main) {
      const v = main.usedPercent;
      let elapsed = "";
      if (main.windowMinutes && main.windowMinutes <= 1440 && main.resetsAt) {
        const e = main.windowMinutes * 60000 - (main.resetsAt - Date.now());
        if (e > 0) { const m = Math.floor(e / 60000); elapsed = m >= 60 ? `${Math.floor(m / 60)}小时${m % 60}分` : `${m}分钟`; }
      }
      if (main.key === "balance") hero = `<div class="grp pd"><div class="hero"><div class="t"><div class="k">${esc(main.label)}</div>
        <div class="v num" style="color:${v >= 100 ? "#FF453A" : "#fff"}">${esc(s.headlineText || "")}</div>
        <div class="s">${esc(main.detail || "")}</div></div></div></div>`;
      else hero = `<div class="grp pd"><div class="hero"><div class="t"><div class="k">${esc(main.label)}</div>
        <div class="v num" style="color:${v >= 70 ? color(v) : "#fff"}">${P(shown(v)).replace("%", "")}<small>% ${verb()}</small></div>
        <div class="s">${main.detail ? esc(detailText(main.detail)) + " · " : ""}${remainMode() ? "已用 " + P(v) : "剩余 " + P(100 - v)}</div></div><div class="bigring">${bigRing(shown(v), v)}</div></div>
        <div class="meta"><span class="num" ${main.resetsAt ? `data-cd="${main.resetsAt}" data-fmt="left"` : ""}>${main.resetsAt ? left(main.resetsAt - Date.now()) : "重置时间未知"}</span><span>${elapsed ? `窗口已过 <b>${elapsed}</b>` : main.resetsAt ? `<b>${window.UI.at(main.resetsAt)}</b>` : ""}</span></div></div>`;
    }
    let week = "";
    if (second) {
      const v = second.usedPercent, ad = s.activeDays || [], today = (new Date().getDay() + 6) % 7;
      const sv2 = shown(v);
      week = `<div class="grp pd"><div class="line"><span class="n">${esc(second.label)}</span><span class="p num" style="color:${v >= 70 ? color(v) : "#fff"}">${verb()} ${P(sv2)}</span></div>
        <div class="track"><div class="fill" style="width:${Math.max(sv2 > 0 ? 2 : 0, sv2)}%;background:${color(v)}"></div></div>
        ${ad.length === 7 ? `<div class="days">${["一", "二", "三", "四", "五", "六", "日"].map((d, i) => `<div class="${i === today ? "today" : ""}"><i class="${ad[i] ? "on" : ""}"></i>${d}</div>`).join("")}</div>` : ""}
        <div class="meta"><span class="num" ${second.resetsAt ? `data-cd="${second.resetsAt}" data-fmt="reset"` : ""}>${resetText(second) || "重置时间未知"}</span><span>${s.primary && s.primary.key === "5h" ? `本周已重置 <b>${s.resetCount || 0}</b> 次` : ""}</span></div></div>`;
    }
    const ex = (s.extra || []).length ? `<div><div class="hdr">其他额度</div><div class="grp">${s.extra.map((w) => {
      const unl = w.detail === "不限";
      return `<div class="row col"><div class="line"><span class="n">${esc(w.label)}</span><span class="p num">${unl ? "不限" : verb() + " " + P(shown(w.usedPercent))}</span></div>
      ${unl ? "" : `<div class="track"><div class="fill" style="width:${shown(w.usedPercent)}%;background:${color(w.usedPercent)}"></div></div>`}
      <div class="sub"><span>${unl ? "" : esc(detailText(w.detail))}</span><span class="num" ${w.resetsAt ? `data-cd="${w.resetsAt}" data-fmt="reset"` : ""}>${resetText(w)}</span></div></div>`;
    }).join("")}</div></div>` : "";
    const rs = resetHTML(s);
    const rowsI = [];
    if (s.plan) rowsI.push(["套餐", s.plan]);
    if (s.account) rowsI.push(["账号", s.account]);
    if (s.planEndsAt) { const d = new Date(s.planEndsAt); rowsI.push([s.id === "codex" ? "订阅有效期至" : "本期结束", `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`]); }
    if (s.credits) rowsI.push(["余额", s.credits]);
    if (s.source) rowsI.push(["数据来源", s.source]);
    const info = rowsI.length ? `<div><div class="hdr">套餐</div><div class="grp">${rowsI.map((r) => `<div class="row"><span class="lab">${r[0]}</span><span class="val" title="${esc(r[1])}">${esc(r[1])}</span></div>`).join("")}</div></div>` : "";

    let st = "额度正常", sd = "";
    const hv = s.headline || 0;
    if (s.state === "nologin") { st = "未连接"; sd = "warn"; }
    else if (s.state === "error") { st = "更新失败"; sd = "bad"; }
    else if (s.state === "stale") { st = "显示的是上次的数据"; sd = "warn"; }
    else if (loading && !s.updatedAt) { st = "正在读取…"; sd = "gray"; }
    else if (hv >= 90) { st = "额度即将用尽"; sd = "bad"; }
    else if (hv >= 70) { st = "额度偏紧"; sd = "warn"; }
    const agoHTML = s.updatedAt && s.state !== "nologin" ? ` · <span data-ago="${s.updatedAt}">${ago(s.updatedAt)}</span>` : "";

    return `<div class="in"><div class="c-head"><div class="sq">${glyph(s.id, 22)}</div>
        <div class="c-title"><h3>${esc(s.name)}</h3><p>${esc(s.plan ? s.plan + " · " + s.tagline : s.tagline)}</p></div>
        <span class="circ ${loading ? "spin" : ""}" data-act="refresh" title="刷新"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.9-3.9M4 4v4h4M4 13a8 8 0 0 0 14.9 3.9M20 20v-4h-4"/></svg></span>
        <span class="circ" data-act="close" title="收起"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></span></div>
      <div class="c-body">${note}${hero}${week}${rs}${ex}${chart(s)}${info}</div>
      <div class="c-foot"><div class="st"><span class="sd ${sd}"></span><span class="num">${st}${agoHTML}</span></div>
        <span class="tb gray" data-act="settings">设置</span><span class="tb" data-act="open">用量页 ↗</span></div></div>`;
  }

  function openCard(id) {
    const s = byId(id);
    if (!s) return;
    hidePop(true);
    cardId = id;
    renderCardContent();
    card.classList.remove("hidden");
    placeBubble(card, id, 360);
    requestAnimationFrame(() => card.classList.add("show"));
    renderBar();
  }
  function renderCardContent() {
    const s = byId(cardId);
    if (!s) return closeCard();
    const body = card.querySelector(".c-body");
    const sc = body ? body.scrollTop : 0;
    const html = cardHTML(s);
    if (card._html === html) return;
    card._html = html;
    const tail = card.querySelector(":scope > .tail");
    card.innerHTML = html;
    if (tail) card.appendChild(tail);
    card.style.height = Math.round(Math.min(600, window.innerHeight / Z - 24)) + "px";
    const nb = card.querySelector(".c-body");
    if (nb) nb.scrollTop = sc;
  }
  function closeCard() {
    cardId = null;
    card.classList.remove("show");
    setTimeout(() => { if (!cardId) card.classList.add("hidden"); }, 160);
    renderBar();
  }

  // ---------------- 交互 ----------------
  function onItemClick(id) {
    if (id === "_settings") return api.openSettings();
    const s = byId(id);
    if (cfg.style === "detail") {
      if (cardId === id) closeCard(); else openCard(id);
      return;
    }
    if (s && !has(s) && s.state === "nologin") { if (pinned === id) hidePop(true); else { pinned = id; showPop(id); renderBar(); } return; }
    if (pinned === id) hidePop(true);
    else { pinned = id; showPop(id); renderBar(); }
  }

  itemsEl.addEventListener("mouseover", (e) => {
    const it = e.target.closest(".item");
    if (!it || drag || it.dataset.id === "_settings") return;
    if (pulses[it.dataset.id]) { delete pulses[it.dataset.id]; renderBar(); api.clearPulse(it.dataset.id, "鼠标移到了图标上"); }
    clearTimeout(hideT);
    if (cardId) return;
    if (pinned && pinned !== it.dataset.id) return;
    clearTimeout(showT);
    showT = setTimeout(() => showPop(it.dataset.id), popId ? 0 : 90);
  });
  itemsEl.addEventListener("mouseout", (e) => {
    const it = e.target.closest(".item");
    if (!it || (e.relatedTarget && it.contains(e.relatedTarget))) return;
    clearTimeout(showT);
    hideT = setTimeout(() => hidePop(), 260);
  });
  pop.addEventListener("mouseenter", () => clearTimeout(hideT));
  pop.addEventListener("mouseleave", () => { hideT = setTimeout(() => hidePop(), 260); });

  for (const el of [pop, card]) {
    el.addEventListener("click", (e) => {
      const a = e.target.closest("[data-act]");
      if (!a) return;
      const id = el === card ? cardId : popId;
      const s = byId(id);
      switch (a.dataset.act) {
        case "settings": api.openSettings(); break;
        case "close": closeCard(); break;
        case "refresh": api.refresh(id); if (s) { s.state = "loading"; renderCardContent(); } break;
        case "open": if (s) api.openUrl(s.dashboard); break;
        case "reset": if (s) doReset(s, a.dataset.cid || ""); break;
      }
    });
  }

  // 拖动：按住竖条移动；靠近屏幕左右边缘松手会吸附，否则自由悬浮
  function onDown(e) {
    if (e.button !== 0) return;
    const it = e.target.closest(".item");
    drag = { x: e.clientX, y: e.clientY, left: geo.left, top: geo.bodyTop, id: it ? it.dataset.id : null, moved: false, pid: e.pointerId };
    setIgnore(false);
    bar.classList.remove("anim");
  }
  function onMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.startLeft = drag.left; drag.startTop = drag.top;
      clearTimeout(showT);
      hidePop(true);
      if (cardId) closeCard();
      try { document.documentElement.setPointerCapture(drag.pid); } catch { /* ignore */ }
    }
    drag.left = drag.startLeft + dx;
    drag.top = drag.startTop + dy;
    layout();
  }
  async function onUp(e) {
    if (!drag) return;
    const d = drag;
    if (!d.moved) { drag = null; if (d.id) onItemClick(d.id); return; }
    const Wv = window.innerWidth, Hv = window.innerHeight, bodyH = geo.bodyH;
    const sW = geo.w || BW * Z;
    const l = Math.max(0, Math.min(Wv - sW, d.left)), t = Math.max(0, Math.min(Hv - bodyH, d.top));
    const distL = l, distR = Wv - (l + sW), distT = t;
    let dock;
    if (distT < 60 && distT < Math.min(distL, distR)) {
      dock = { ...cfg.dock, mode: "edge", edge: "top", tx: Math.max(0, Math.min(1, (l + sW / 2) / Wv)) };
    } else if (Math.min(distL, distR) < 70) {
      const tot = bodyH + 2 * F * Z;
      dock = { ...cfg.dock, mode: "edge", edge: distL < distR ? "left" : "right", y: Math.max(0, Math.min(1, (t - F * Z) / Math.max(1, Hv - tot))) };
    } else {
      dock = { ...cfg.dock, mode: "float", x: l / Math.max(1, Wv - sW), y: t / Math.max(1, Hv - bodyH) };
    }
    drag = null;
    cfg.dock = dock;
    bar.classList.add("anim");
    layout();
    setTimeout(() => bar.classList.remove("anim"), 320);
    try { cfg.dock = await api.dragEnd({ screenX: e.screenX, screenY: e.screenY, dock }); layout(); } catch { /* ignore */ }
  }
  itemsEl.addEventListener("pointerdown", onDown);
  shapePath.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  for (const el of [itemsEl, shapePath]) el.addEventListener("contextmenu", (e) => { e.preventDefault(); api.contextMenu(); });
  window.addEventListener("resize", layout);
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") { hidePop(true); closeCard(); } });

  // 滚轮缩放: 在竖条上直接滚轮; 在气泡/面板上按住 Ctrl(mac 为 Cmd) 再滚轮 (面板内普通滚轮仍用于滚动内容)
  window.addEventListener("wheel", (e) => {
    if (!cfg) return;
    const onBar = !!(e.target.closest && e.target.closest("#bar"));
    if (!onBar && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.1 : -0.1;
    const nz = clampZ(clampZ(cfg.zoom) + delta);
    if (nz === clampZ(cfg.zoom)) return;
    cfg.zoom = nz;
    if (cardId) card._html = "";
    if (cardId) renderCardContent();
    layout();
    const hud = document.getElementById("zoomHud") || (() => {
      const h = document.createElement("div");
      h.id = "zoomHud";
      h.className = "zoom-hud";
      document.body.appendChild(h);
      return h;
    })();
    hud.textContent = Math.round(nz * 100) + "%";
    const b = bar.getBoundingClientRect();
    Object.assign(hud.style, { left: Math.round(b.left + b.width / 2) + "px", top: Math.round(b.top - 12) + "px" });
    hud.classList.add("show");
    clearTimeout(zoomHudT);
    zoomHudT = setTimeout(() => hud.classList.remove("show"), 900);
    clearTimeout(zoomSaveT);
    zoomSaveT = setTimeout(() => api.saveConfig({ zoom: nz }), 500);
  }, { passive: false });


  // 每秒刷新倒计时（秒级）
  setInterval(() => {
    if (popId && !pop.classList.contains("hidden")) tickText(pop);
    if (cardId) tickText(card);
  }, 1000);

  function onList(l) {
    list = l || [];
    window.UI.setLetters(list);
    renderBar();
    if (popId) { const s = byId(popId); if (s && visible().includes(s)) { setPop(s); placeBubble(pop, popId, 272); } else hidePop(true); }
    if (cardId) { if (visible().some((s) => s.id === cardId)) renderCardContent(); else closeCard(); }
  }

  api.onUpdate(onList);
  api.screenInfo().then((s) => { scr = s || scr; layout(); }).catch(() => {});
  api.onScreen((s) => { scr = s || scr; layout(); });
  api.onConfig((c) => { cfg = c; if (cfg.style !== "detail" && cardId) closeCard(); if (cfg.style === "detail") hidePop(true); renderBar(); });
  api.state().then((s) => { cfg = s.cfg; onList(s.list); });

  // ---------------- 任务完成提醒（从对应图标旁弹出，10 秒自动关闭，点击跳转） ----------------

  // 对应 AI 不在竖条上（被隐藏 / 未启用）时，指向竖条中部
  function toastAnchor(ai) {
    const el = itemsEl.querySelector(`.item[data-id="${ai}"] .ring`);
    if (el) { const r = el.getBoundingClientRect(); return r.top + r.height / 2; }
    return geo.bodyTop + geo.bodyH / 2;
  }

  function toastHTML(ev) {
    if (ev.kind === "found" || ev.kind === "login") {
      const found = ev.kind === "found";
      return `<div class="t-in">
      <div class="t-head"><span class="t-g">${glyph(ev.ai, 17)}</span><span class="t-ai">${esc(ev.label || AI_NAME[ev.ai] || ev.title)}</span>
        <span class="t-st ${found ? "ok" : "need"}">${found ? "✓ 已自动接入" : "● 检测到"}</span><span class="t-x" data-x="1" title="关闭">✕</span></div>
      <div class="t-title">${esc(ev.title)}</div>
      ${ev.preview ? `<div class="t-pre">${esc(ev.preview)}</div>` : ""}
      <div class="t-foot"><span>${found ? "点击查看用量" : "点击登录（只需一次）"}</span><span class="t-cd"></span></div>
      <div class="t-bar"><i></i></div></div>`;
    }
    const need = ev.kind === "input";
    const label = need ? (ev.error ? "任务出错，需要你处理" : "需要你处理") : ev.chat ? "已回复" : "任务已完成";
    const name = ev.label || AI_NAME[ev.ai] || ev.ai;
    const HOST = { desktop: ev.ai === "claude" ? "Claude 桌面版" : "Codex", ide: "编辑器", cli: "终端" };
    const hint = ev.hostApp ? `点击切到 ${ev.hostApp}`
      : ev.chat ? "点击打开这个对话"
      : HOST[ev.host] ? `点击切到 ${HOST[ev.host]}`
      : ev.ai === "claude" ? "点击切到终端 / 编辑器" : `点击切到 ${AI_NAME[ev.ai] || ev.ai}`;
    return `<div class="t-in">
      <div class="t-head"><span class="t-g">${glyph(ev.ai, 17)}</span><span class="t-ai">${esc(name)}</span>
        <span class="t-st ${need ? "need" : "ok"}">${need ? "●" : "✓"} ${label}</span><span class="t-x" data-x="1" title="关闭">✕</span></div>
      <div class="t-title">${esc(ev.title)}</div>
      ${ev.preview ? `<div class="t-pre">${esc(ev.preview)}</div>` : ""}
      <div class="t-foot"><span>${hint}</span><span class="t-cd"></span></div>
      <div class="t-bar"><i></i></div></div>`;
  }

  function placeToasts() {
    if (!toasts.length) return;
    const sd = side();
    const Hv = window.innerHeight;
    if (sd === "below") {
      const Wv = window.innerWidth;
      let y = geo.top + geo.bodyH + GAP * Z;
      // 气泡 / 面板开着时排在它下面，不重叠
      for (const o of [popId && pop, cardId && card]) if (o && o.offsetHeight) y = Math.max(y, o.getBoundingClientRect().bottom + 10 * Z);
      toasts.forEach((t, i) => {
        const ax = anchorX(t.ev.ai);
        const x = Math.round(Math.max(8, Math.min(Wv - TOAST_W * Z - 8, ax - (TOAST_W * Z) / 2)));
        Object.assign(t.el.style, { left: x + "px", top: Math.round(y) + "px", transform: Z === 1 ? "" : `scale(${Z})`, transformOrigin: "0 0" });
        if (i === 0) tailUp(t.el, Math.max(26, Math.min(TOAST_W - 26, (ax - x) / Z)));
        else { const tl = t.el.querySelector(":scope > .tail"); if (tl) tl.style.display = "none"; }
        y += t.el.offsetHeight * Z + 8 * Z;
      });
      return;
    }
    // 先按锚点排，再自上而下避让，避免多条重叠
    const items = toasts.map((t) => ({ t, h: t.el.offsetHeight * Z, ay: toastAnchor(t.ev.ai) })).sort((a, b) => a.ay - b.ay);
    let floor = 8;
    for (const it of items) {
      let y = Math.max(floor, Math.min(Hv - it.h - 8, it.ay - it.h / 2));
      floor = y + it.h + 8 * Z;
      const x = sd === "left" ? geo.left - (GAP + TOAST_W) * Z : geo.left + geo.w + GAP * Z;
      Object.assign(it.t.el.style, { left: x + "px", top: Math.round(y) + "px", transform: Z === 1 ? "" : `scale(${Z})`, transformOrigin: "0 0" });
      let tail = it.t.el.querySelector(":scope > .tail");
      if (!tail) {
        tail = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        tail.setAttribute("class", "tail");
        tail.setAttribute("viewBox", "0 0 16 34");
        tail.innerHTML = '<path d="M0 0 C5 5.5 9.5 11.5 16 17 C9.5 22.5 5 28.5 0 34 Z"/>';
        it.t.el.appendChild(tail);
      }
      const h0 = it.h / Z;
      const ty = Math.max(10, Math.min(h0 - 44, (it.ay - y) / Z - 17));
      tail.style.display = ""; tail.style.transformOrigin = "";
      Object.assign(tail.style, sd === "left" ? { left: TOAST_W - 1 + "px", top: ty + "px", transform: "" } : { left: "-15px", top: ty + "px", transform: "scaleX(-1)" });
    }
  }

  function closeToast(t) {
    const i = toasts.indexOf(t);
    if (i < 0) return;
    toasts.splice(i, 1);
    clearTimeout(t.timer);
    t.el.classList.remove("show");
    setTimeout(() => t.el.remove(), 180);
    renderBar();
    placeToasts();
  }

  function showToast(ev) {
    if (!cfg || cfg.taskNotify === false) return;
    // 同一个任务的旧提醒直接替换
    for (const t of [...toasts]) if (t.ev.key === ev.key) closeToast(t);
    while (toasts.length >= 3) closeToast(toasts[0]);
    const el = document.createElement("div");
    el.className = "toast hit " + (ev.kind === "input" || ev.kind === "login" ? "need" : "ok");
    el.innerHTML = toastHTML(ev);
    document.body.appendChild(el);
    const t = { ev, el, born: Date.now(), left: TOAST_MS, timer: 0 };
    const arm = () => { t.timer = setTimeout(() => closeToast(t), t.left); t.armedAt = Date.now(); el.classList.remove("paused"); };
    // 鼠标停在提醒上时暂停倒计时，移开后继续
    el.addEventListener("mouseenter", () => { clearTimeout(t.timer); t.left = Math.max(1500, t.left - (Date.now() - t.armedAt)); el.classList.add("paused"); });
    el.addEventListener("mouseleave", arm);
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      closeToast(t);
      if (e.target.closest("[data-x]")) return;
      if (ev.kind === "found") { pinned = ev.ai; showPop(ev.ai); renderBar(); return; }
      if (ev.kind === "login") { try { await api.login(ev.ai, ""); } catch { /* ignore */ } return; }
      try { await api.openTask(ev); } catch { /* ignore */ }
    });
    el.style.setProperty("--toast-ms", TOAST_MS + "ms");
    toasts.push(t);
    arm();
    renderBar();
    placeToasts();
    requestAnimationFrame(() => el.classList.add("show"));
  }

  api.onTask(showToast);
  api.onPulses((p) => { pulses = p || {}; renderBar(); });
  api.getPulses().then((p) => { pulses = p || {}; renderBar(); }).catch(() => {});

  // 截图测试用
  window.__test = { showPop: (id) => { pinned = id; showPop(id); }, openCard, hidePop, closeCard, toast: showToast, pulse: (p) => { pulses = p || {}; renderBar(); } };
})();
