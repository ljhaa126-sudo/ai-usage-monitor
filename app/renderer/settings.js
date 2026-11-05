"use strict";
(() => {
  const { glyph, esc } = window.UI;
  const api = window.aimon;
  const root = document.getElementById("root");
  let cfg = null, list = [], web = {}, version = "";
  let found = {};            // 自动识别：id -> 在本机发现的说明
  const manual = {};         // 哪些 AI 展开了「手动设置」
  let showMissing = false;   // 展开「本机没有检测到的 AI」
  let presets = null;
  let editing = null;   // 正在编辑的自定义工具（表单草稿）{ id?, ...fields }
  let testRes = null;   // { ok, message, sample }
  let testing = false;
  let confirmDel = null;
  let hk = { active: "", error: "", def: "" }; // 快捷键状态（主进程）
  let hkRec = false;                           // 正在录制新快捷键
  let recErr = "";
  const MAC = /Mac/i.test(navigator.platform);
  // Electron 写法 → 显示：⌃⌥⌘U / Ctrl + Alt + Shift + U
  const prettyKey = (k) => {
    if (!k) return "";
    const p = k.split("+");
    if (MAC) { const m = { Control: "⌃", Ctrl: "⌃", Alt: "⌥", Option: "⌥", Shift: "⇧", Command: "⌘", Cmd: "⌘", Super: "⌘" }; return p.map((x) => m[x] || x).join(""); }
    return p.map((x) => (x === "Control" ? "Ctrl" : x === "Super" ? "Win" : x)).join(" + ");
  };

  const HINT = {
    claude: "装了 Claude Code 会自动识别（首次会弹出钥匙串授权，选「始终允许」）。只用 Claude 网页版或桌面 App 的，点「登录网页版」登录一次即可。登录网页版后，网页版 / 桌面版 / 手机上的普通聊天回复完也会提醒。",
    codex: "自动读取 Codex CLI / 桌面版的登录（~/.codex/auth.json）；对话时直接读取本地会话日志，秒级更新。在线接口如果被 Cloudflare 拦截（报 403 网页），点「登录网页版」登录 chatgpt.com 并通过一次验证即可。登录后 ChatGPT 普通聊天回复完也会提醒。",
    cursor: "自动读取 Cursor 编辑器的登录（可能弹出钥匙串授权）；读不到时点「登录网页版」。",
    gemini: "自动读取 Gemini CLI 的 Google 登录（~/.gemini/oauth_creds.json）。",
    copilot: "自动读取 Copilot 插件登录；读不到时在终端运行 gh auth token，把结果粘贴到这里。",
    kimi: "在 kimi.com/code 控制台创建 API Key 后填入。",
    glm: "填写 GLM Coding Plan 的 API Key；z.ai 国际版请选「国际」。",
    boxai: "自动读取本机 Box 登录的 RTX 账号，查询本月个人 Token 额度（需连接公司内网 / iOA）。",
    deepseek: "DeepSeek 开放平台按量付费，显示账户余额。会自动从 DeepSeek Harness（~/.dsh）、环境变量 DEEPSEEK_API_KEY、shell 配置文件、Claude Code / cc-switch / Continue / Cherry Studio 等配置里找 API Key；找不到时在这里填。",
    hunyuan: "腾讯云 TokenHub 的混元 Token Plan 额度。按腾讯云规定，额度只能用腾讯云 API 密钥查询（调用模型的 API Key 查不了）：会自动读取 tccli 和环境变量 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY；也可以在这里填「SecretId SecretKey」。建议用只读子账号的密钥（权限 QcloudTokenHubReadOnlyAccess）。",
    tokendash: "读取腾讯官方「用量健康助手」(Tencent Token Dashboard) 的本地登录态，显示全公司 AI Token 的本月用量（人民币）。需先安装并登录过那个助手；它的登录每隔约两小时自动续，半个月后需重新登录一次。",
    workbuddy: "腾讯员工是企业 SSO 账号，需在企业专属站点走 iOA 登录（手机号 / 微信登录的是另一个账号，查不到企业额度）。若登录窗口空白，说明 iOA 拦截了本程序访问内网，需要在 iOA 里给「AI Usage Monitor.exe」授信。",
  };
  const ST = { ok: ["已连接", "ok"], stale: ["数据过期", "warn"], error: ["出错", "err"], nologin: ["未连接", "warn"], loading: ["读取中…", ""], disabled: ["已关闭", ""] };

  const sw = (on, attrs) => `<button class="sw ${on ? "on" : ""}" ${attrs}></button>`;
  const seg = (key, val, opts) => `<div class="seg" data-seg="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(val) === String(v) ? "on" : ""}">${l}</button>`).join("")}</div>`;
  const pcOf = (id) => (cfg.providers && cfg.providers[id]) || { enabled: true, apiKey: "" };
  const customOf = (id) => (cfg.customs || []).find((c) => c.id === id);

  // ---------------- 自定义工具编辑表单 ----------------
  function field(k, label, ph, opts = {}) {
    const v = esc(editing[k] || "");
    const tag = opts.area ? `<textarea data-f="${k}" rows="${opts.rows || 2}" placeholder="${esc(ph)}" spellcheck="false">${v}</textarea>` : `<input data-f="${k}" placeholder="${esc(ph)}" value="${v}" spellcheck="false" />`;
    return `<label class="fl"><span>${label}</span>${tag}</label>`;
  }

  function editorHTML() {
    if (!editing) return "";
    const pre = presets ? Object.entries(presets).map(([k, p]) => `<button class="chip" data-preset="${k}">${k === "blank" ? "空白" : esc(p.name)}</button>`).join("") : "";
    const tr = testRes ? `<div class="test ${testRes.ok ? "ok" : "err"}">${esc(testRes.message)}</div>${testRes.sample ? `<pre class="sample">${esc(testRes.sample)}</pre>` : ""}` : "";
    return `<div class="editor">
      <div class="eh">${editing.id ? "编辑自定义工具" : "添加自定义工具"}</div>
      ${editing.id ? "" : `<div class="chips"><span>从模板开始：</span>${pre}</div>`}
      ${field("name", "名称", "例如：公司中转站")}
      <div class="two">${field("url", "用量接口地址", "https://…（返回 JSON）")}<label class="fl sm"><span>方法</span><select data-f="method"><option ${editing.method !== "POST" ? "selected" : ""}>GET</option><option ${editing.method === "POST" ? "selected" : ""}>POST</option></select></label></div>
      ${field("headers", "请求头（每行一个，可用 {{env:变量名}} 引用环境变量）", "Authorization: Bearer xxx", { area: true, rows: 2 })}
      ${editing.method === "POST" ? field("body", "请求体（JSON）", "{}", { area: true, rows: 2 }) : ""}
      <div class="eh2">字段路径（按 JSON 路径填写，如 data.quota 或 list.0.used；以下任选其一组合即可）</div>
      <div class="two">${field("percentPath", "已用百分比", "如 data.used_percent")}${field("usedPath", "已用量", "如 data.used")}</div>
      <div class="two">${field("limitPath", "总额度", "如 data.limit")}${field("remainPath", "剩余量 / 余额", "如 data.remaining")}</div>
      <div class="two">${field("resetPath", "重置时间（可选）", "如 data.reset_at")}${field("label", "显示名称", "如 本月额度")}</div>
      <div class="two">${field("unit", "单位（可选）", "如 元 / tokens / 次")}${field("dashboard", "用量页网址（可选）", "https://…")}</div>
      <div class="acts"><button class="btn gray" data-act="c-test" ${testing ? "disabled" : ""}>${testing ? "测试中…" : "测试"}</button><span style="flex:1"></span><button class="btn gray" data-act="c-cancel">取消</button><button class="btn" data-act="c-save">${editing.id ? "保存" : "添加"}</button></div>
      ${tr}
    </div>`;
  }

  function render() {
    if (!cfg) return;
    window.UI.setLetters(list);
    const ae = document.activeElement;
    const focus = ae && ae.dataset ? (ae.dataset.key ? `[data-key="${ae.dataset.key}"]` : ae.dataset.f ? `[data-f="${ae.dataset.f}"]` : null) : null;
    const caret = focus && ae.selectionStart != null ? [ae.selectionStart, ae.selectionEnd] : null;
    const scroll = window.scrollY;
    const byId = Object.fromEntries(list.map((s) => [s.id, s]));
    const pos = cfg.dock.mode === "float" ? "float" : cfg.dock.edge;
    const missing = [];
    const provs = cfg.order.map((id, i) => {
      const s = byId[id]; if (!s) return "";
      const pc = pcOf(id);
      const live = s.state === "ok" || s.state === "stale" || s.state === "error" || (s.state === "loading" && s.updatedAt);
      const detected = live || !!found[id] || s.custom || web[id] || !!String(pc.apiKey || "").trim();
      if (!detected) { missing.push([id, i, s, pc]); return ""; }
      // 状态行：已自动接入 / 检测到但读不到登录 / 出错
      let stT, stC;
      if (!pc.enabled) [stT, stC] = ST.disabled;
      else if (s.state === "ok" || s.state === "stale") { stT = /^手动/.test(s.source || "") ? "已连接" : "已自动接入"; stC = s.state === "ok" ? "ok" : "warn"; }
      else if (s.state === "nologin") { stT = `检测到${found[id] ? "（" + found[id] + "）" : ""}，还读不到登录`; stC = "warn"; }
      else [stT, stC] = ST[s.state] || ["", ""];
      const detail = [stT, s.plan, s.account].filter(Boolean).join(" · ");
      const srcLine = pc.enabled && (s.state === "ok" || s.state === "stale") && s.source ? `<div class="hint" style="margin:0">来源：${esc(s.source)}</div>` : "";
      // 检测到了但读不到登录：直接给「登录」按钮（只需一次）
      const needLogin = pc.enabled && s.state === "nologin" && s.login && !web[id];
      const quick = needLogin ? `<div class="web"><button class="btn" data-login="${id}">${id === "workbuddy" ? "企业登录（iOA）" : "登录"}</button><span>登录一次，之后自动显示用量</span></div>` : "";
      let x = "";
      if (pc.enabled || s.custom) {
        const loginBtns = id === "workbuddy"
          ? `<button class="btn" data-login="${id}">企业登录（iOA）</button>`
          : `<button class="btn" data-login="${id}">登录网页版</button>`;
        const webRow = pc.enabled && s.login ? `<div class="web">${web[id] ? `<span>✓ 已登录网页版</span><button class="btn red" data-logout="${id}">退出登录</button>` : loginBtns}</div>` : "";
        const key = pc.enabled && s.keyKind ? `<div class="k"><input type="password" data-key="${id}" placeholder="${esc(String(s.keyKind).replace(/（必填）|\(必填\)/, "（自动识别不到时再填）"))}" value="${esc(pc.apiKey || "")}" spellcheck="false" />${id === "glm" ? `<select data-region="glm"><option value="cn" ${pc.region !== "global" ? "selected" : ""}>国内</option><option value="global" ${pc.region === "global" ? "selected" : ""}>国际</option></select>` : ""}</div>` : "";
        const msg = pc.enabled && s.state !== "ok" && s.message ? `<div class="hint" style="margin:0;color:${s.state === "error" ? "#ff8a80" : "rgba(235,235,245,.5)"}">${esc(s.message)}</div>` : "";
        const hint = s.custom ? (() => { const c = customOf(id); return c ? `<div class="hint" style="margin:0">${esc(c.method)} ${esc(c.url)}</div>` : ""; })() : `<div class="hint" style="margin:0">${esc(HINT[id] || "")}</div>`;
        const cust = s.custom ? `<div class="web">${confirmDel === id ? `<span style="color:#FF9F0A">确定删除？</span><button class="btn red" data-cdel="${id}">删除</button><button class="btn gray" data-act="c-undel">取消</button>` : `<button class="btn gray" data-cedit="${id}">编辑</button><button class="btn red" data-cdelask="${id}">删除</button>`}</div>` : "";
        // 手动设置（网页登录 / Key / 说明）默认收起：只在自动识别不到时才需要
        const open = manual[id] || s.custom || (editing && editing.id === id);
        const body = open ? `${webRow}${key}${hint}${s.state === "nologin" ? "" : msg}${cust}` : "";
        const toggle = s.custom ? "" : `<div class="web"><span class="link" data-manual="${id}">${open ? "收起手动设置 ▴" : "手动设置 ▾"}</span></div>`;
        x = `<div class="x">${srcLine}${quick}${s.state === "error" ? msg : ""}${toggle}${body}</div>`;
        if (editing && editing.id === id) x += editorHTML();
      }
      return `<div class="prov"><div class="row"><div class="ic">${glyph(id, 18)}</div><div class="lab">${esc(s.name)}${s.custom ? ' <span class="tag">自定义</span>' : ""}<div class="st ${stC}">${esc(detail)}</div></div>
        <div class="ord"><button data-up="${i}">▲</button><button data-down="${i}">▼</button></div>${sw(pc.enabled, `data-en="${id}"`)}</div>${x}</div>`;
    }).join("");
    // 本机没有检测到的 AI：收在一行里，展开后可以手动设置
    const missingRows = missing.map(([id, i, s, pc]) => {
      const open = manual[id];
      const webRow = s.login ? `<div class="web">${web[id] ? `<span>✓ 已登录网页版</span><button class="btn red" data-logout="${id}">退出登录</button>` : `<button class="btn gray" data-login="${id}">${id === "workbuddy" ? "企业登录（iOA）" : "登录网页版"}</button>`}</div>` : "";
      const key = s.keyKind ? `<div class="k"><input type="password" data-key="${id}" placeholder="${esc(String(s.keyKind).replace(/（必填）|\(必填\)/, ""))}" value="${esc(pc.apiKey || "")}" spellcheck="false" />${id === "glm" ? `<select data-region="glm"><option value="cn" ${pc.region !== "global" ? "selected" : ""}>国内</option><option value="global" ${pc.region === "global" ? "selected" : ""}>国际</option></select>` : ""}</div>` : "";
      const body = open ? `${webRow}${key}<div class="hint" style="margin:0">${esc(HINT[id] || "")}</div>` : "";
      return `<div class="prov"><div class="row"><div class="ic" style="opacity:.45">${glyph(id, 18)}</div><div class="lab" style="opacity:.7">${esc(s.name)}<div class="st">未检测到 · 安装或登录后会自动出现</div></div>
        <span class="link" data-manual="${id}" style="font-size:12px">${open ? "收起" : "手动设置"}</span></div>${body ? `<div class="x">${body}</div>` : ""}</div>`;
    }).join("");
    const missingGrp = missing.length ? `<div class="grp" style="margin-top:10px"><div class="row" data-act="missing"><div class="lab" style="opacity:.75">本机没有检测到的 AI（${missing.length}）<small>${missing.map(([, , s]) => s.name).join("、")}</small></div><span class="link" style="font-size:12px">${showMissing ? "收起" : "展开"}</span></div>${showMissing ? missingRows : ""}</div>` : "";

    const addRow = editing && !editing.id ? `<div class="prov">${editorHTML()}</div>` : `<div class="prov"><div class="row add" data-act="c-new"><div class="ic">${glyph("plus", 16)}</div><div class="lab">添加自定义 AI 工具<small>任何能返回 JSON 用量的接口都能接入：中转站、DeepSeek 余额、公司内部平台…</small></div></div></div>`;

    root.innerHTML = `
      <div class="hdr">外观</div>
      <div class="grp">
        <div class="row"><div class="lab">展示样式<small>极简：悬停图标弹出小气泡；详细：点击图标展开完整面板</small></div>${seg("style", cfg.style, [["minimal", "极简"], ["detail", "详细"]])}</div>
        <div class="row"><div class="lab">位置<small>也可以直接拖动竖条：靠近屏幕边缘松手会吸附，拖到中间就自由悬浮</small></div>${seg("pos", pos, [["right", "贴右侧"], ["left", "贴左侧"], ["float", "自由摆放"]])}</div>
        <div class="row"><div class="lab">显示内圈（本周 / 总用量）<small>外圈是当前会话（5 小时）用量，内圈是本周 / 总用量；只有同时有这两种额度的 AI（如 Claude、Codex）才显示内圈</small></div>${sw(cfg.innerRing !== false, 'data-b="innerRing"')}</div>
        <div class="row"><div class="lab">隐藏未连接的 AI<small>竖条上只显示已登录、有数据的 AI</small></div>${sw(cfg.hideIdle, 'data-b="hideIdle"')}</div>
        <div class="row"><div class="lab">任务完成提醒<small>Codex / Claude Code / WorkBuddy / CodeBuddy / BoxAI 的任务，以及 Claude、ChatGPT 的普通聊天（需登录网页版），完成或需要你处理时在对应图标旁弹出提醒（10 秒后自动关闭）；图标上的脉冲会一直保留，直到你把鼠标移到图标上、点开提醒，或切到这个任务所在的窗口</small></div>${sw(cfg.taskNotify !== false, 'data-b="taskNotify"')}</div>
        <div class="row"><div class="lab">显示 / 隐藏悬浮条的快捷键<small>${hkRec ? (recErr ? `<span style="color:#FF9F0A">${esc(recErr)}</span>` : "请按下新的组合键（至少两个修饰键 + 一个字母 / 数字 / F 键），按 Esc 取消") : hk.error ? `<span style="color:#FF9F0A">${esc(hk.error)}</span>` : cfg.hotkey === "off" ? "已关闭" : "在任何软件里按下都能切换悬浮条；也可以点托盘菜单"}</small></div>
          <div style="display:flex;gap:6px;align-items:center">
            <button class="btn gray" data-act="hk-rec" style="min-width:96px">${hkRec ? "录制中…" : cfg.hotkey === "off" ? "未设置" : esc(prettyKey(hk.active)) || "未设置"}</button>
            ${(cfg.hotkey && !hkRec) ? `<button class="btn gray" data-act="hk-def">恢复默认</button>` : ""}
            ${(cfg.hotkey !== "off" && !hkRec) ? `<button class="btn gray" data-act="hk-off">关闭</button>` : ""}
          </div></div>
        <div class="row"><div class="lab">菜单栏显示最高用量</div>${sw(cfg.trayPercent, 'data-b="trayPercent"')}</div>
      </div>
      <div class="hdr">刷新</div>
      <div class="grp">
        <div class="row"><div class="lab">刷新频率<small>正在使用时多久查一次</small></div>${seg("refreshSeconds", cfg.refreshSeconds, [[5, "5 秒"], [10, "10 秒"], [30, "30 秒"], [60, "1 分钟"], [300, "5 分钟"]])}</div>
        <div class="row"><div class="lab">智能频率（推荐）<small>最近 5 分钟有在用、或用量在变化时按上面的频率；闲置时自动放慢到 2 分钟</small></div>${sw(cfg.smartRefresh !== false, 'data-b="smartRefresh"')}</div>
      </div>
      <div class="hint">更新是「事件驱动」的：Claude Code、Codex、Gemini CLI 一有新对话，Claude 桌面版一有新消息，都会在几秒内自动刷新，不需要把频率调得很高。偶尔一次网络失败不会报错，会继续显示上次的数据并自动重试；Mac 休眠时暂停，唤醒后自动恢复。</div>
      <div class="hdr">通用</div>
      <div class="grp">
        <div class="row"><div class="lab">登录时自动启动</div>${sw(cfg.autoStart, 'data-b="autoStart"')}</div>
        <div class="row"><div class="lab" style="flex:none">网络代理</div><input data-proxy="1" placeholder="留空 = 跟随系统代理；例：127.0.0.1:7890；填 direct 不走代理" value="${esc(cfg.proxy || "")}" spellcheck="false" /></div>
      </div>
      <div class="hdr">AI 账号与顺序</div>
      <div class="hint" style="margin-top:0">本机的 AI 会自动识别并接入，不用手动配置：已登录的 Claude Code / Codex / Cursor / Gemini CLI / Copilot、Claude 桌面版的登录、Claude Code 或 cc-switch 里配置的 Kimi / 智谱 GLM / DeepSeek Key、tccli 里的腾讯云密钥（混元）、腾讯 Box 客户端和「用量健康助手」（token.woa.com）都会自动读取。之后新装或第一次登录的 AI 几秒内会自动出现。「手动设置」只在自动识别不到时才需要。</div>
      <div class="grp">${provs}${addRow}</div>
      ${missingGrp}
      <div class="foot"><span>版本 ${esc(version)} · <span class="link" data-act="log">查看日志</span></span><button class="btn red" data-act="quit">退出程序</button></div>`;
    if (focus) {
      const el = root.querySelector(focus);
      if (el) { el.focus(); try { if (caret) el.setSelectionRange(caret[0], caret[1]); else el.setSelectionRange(el.value.length, el.value.length); } catch { /* select */ } }
    }
    window.scrollTo(0, scroll);
  }

  const save = (patch) => api.saveConfig(patch);
  let keyT = {};

  async function loadPresets() {
    if (presets) return;
    try { const r = await api.customPresets(); presets = r.presets; } catch { presets = {}; }
  }

  root.addEventListener("click", async (e) => {
    const t = e.target.closest("button, [data-act], [data-seg] button") || e.target;
    const segEl = t.closest("[data-seg]");
    if (segEl && t.dataset.v != null) {
      const k = segEl.dataset.seg, v = t.dataset.v;
      if (k === "pos") save({ dock: v === "float" ? { ...cfg.dock, mode: "float" } : { ...cfg.dock, mode: "edge", edge: v } });
      else if (k === "refreshSeconds") save({ refreshSeconds: Number(v) });
      else save({ [k]: v });
      return;
    }
    if (t.dataset.b === "smartRefresh") return save({ smartRefresh: cfg.smartRefresh === false });
    if (t.dataset.b) return save({ [t.dataset.b]: !cfg[t.dataset.b] });
    if (t.dataset.en) { const id = t.dataset.en; return save({ providers: { [id]: { enabled: !pcOf(id).enabled } } }); }
    if (t.dataset.manual) { manual[t.dataset.manual] = !manual[t.dataset.manual]; return render(); }
    if (t.closest("[data-act=missing]")) { showMissing = !showMissing; return render(); }
    if (t.dataset.login) return api.login(t.dataset.login, t.dataset.idp || "");
    if (t.dataset.logout) return api.logout(t.dataset.logout).then(refreshWeb);
    if (t.dataset.up != null || t.dataset.down != null) {
      const i = Number(t.dataset.up ?? t.dataset.down), j = t.dataset.up != null ? i - 1 : i + 1;
      if (j < 0 || j >= cfg.order.length) return;
      const order = [...cfg.order];
      [order[i], order[j]] = [order[j], order[i]];
      return save({ order });
    }
    // ---- 自定义工具 ----
    if (t.dataset.preset) { editing = { ...presets[t.dataset.preset] }; testRes = null; return render(); }
    if (t.dataset.cedit) { await loadPresets(); editing = { ...customOf(t.dataset.cedit) }; testRes = null; confirmDel = null; return render(); }
    if (t.dataset.cdelask) { confirmDel = t.dataset.cdelask; return render(); }
    if (t.dataset.cdel) { const id = t.dataset.cdel; confirmDel = null; if (editing && editing.id === id) editing = null; await api.customRemove(id); return; }
    switch (t.dataset.act) {
      case "hk-rec": if (hkRec) return stopRec(); hkRec = true; await api.hotkeyPause(true); return render();
      case "hk-def": return save({ hotkey: "" });
      case "hk-off": return save({ hotkey: "off" });
      case "quit": return api.quit();
      case "log": return api.openLog();
      case "c-undel": confirmDel = null; return render();
      case "c-new": await loadPresets(); editing = { ...(presets.blank || {}) }; testRes = null; return render();
      case "c-cancel": editing = null; testRes = null; return render();
      case "c-test": {
        testing = true; testRes = null; render();
        try { testRes = await api.customTest(editing); } catch (err) { testRes = { ok: false, message: String(err && err.message || err) }; }
        testing = false; return render();
      }
      case "c-save": {
        if (!String(editing.url || "").trim()) { testRes = { ok: false, message: "请填写用量接口地址" }; return render(); }
        const r = editing.id ? await api.customUpdate(editing) : await api.customAdd(editing);
        if (r && r.ok) { editing = null; testRes = null; } else testRes = { ok: false, message: (r && r.message) || "保存失败" };
        return render();
      }
    }
  });
  root.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.f && editing) { editing[t.dataset.f] = t.value; return; }
    if (t.dataset.key) {
      const id = t.dataset.key, v = t.value.trim();
      clearTimeout(keyT[id]);
      keyT[id] = setTimeout(() => save({ providers: { [id]: { apiKey: v } } }), 700);
    }
    if (t.dataset.proxy) { clearTimeout(keyT._p); keyT._p = setTimeout(() => save({ proxy: t.value.trim() }), 900); }
  });
  root.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.f && editing) { editing[t.dataset.f] = t.value; if (t.dataset.f === "method") render(); return; }
    if (t.dataset.region) save({ providers: { glm: { region: t.value } } });
  });

  // ---- 录制快捷键 ----
  async function stopRec(acc) {
    hkRec = false;
    recErr = "";
    if (acc) await save({ hotkey: acc }); // 主进程会重新注册并回传状态
    else await api.hotkeyPause(false);
    render();
  }
  const KEYNAME = (e) => {
    const c = e.code || "";
    if (/^Key[A-Z]$/.test(c)) return c.slice(3);
    if (/^Digit\d$/.test(c)) return c.slice(5);
    if (/^F([1-9]|1\d|2[0-4])$/.test(c)) return c;
    const m = { Space: "Space", Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
      ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert" };
    return m[c] || "";
  };
  window.addEventListener("keydown", (e) => {
    if (!hkRec) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === "Escape") return stopRec();
    const key = KEYNAME(e);
    if (!key) return; // 只按了修饰键：继续等
    const mods = [];
    if (e.ctrlKey) mods.push("Control");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push(MAC ? "Command" : "Super");
    const fkey = /^F\d+$/.test(key);
    // 至少两个修饰键（F 键至少一个），避免和普通快捷键冲突
    if (mods.length < (fkey ? 1 : 2)) { recErr = "至少要两个修饰键，例如 " + (MAC ? "⌃⌥⌘ + 字母" : "Ctrl + Alt + Shift + 字母") + "；按 Esc 取消"; render(); return; }
    stopRec([...mods, key].join("+"));
  }, true);
  api.onHotkey((h) => { hk = h; if (!typing()) render(); });

  // 正在输入时不重绘，避免光标跳动
  const typing = () => { const a = document.activeElement; return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT"); };
  const refreshWeb = () => api.webStatus().then((w) => { web = w; render(); });
  api.onUpdate((l) => { list = l; if (!typing()) render(); });
  api.onConfig((c) => { cfg = c; if (!typing()) render(); });
  api.onWebStatus((w) => { web = w; render(); });
  api.state().then((s) => { cfg = s.cfg; list = s.list; version = s.version; refreshWeb(); });
  api.hotkey().then((h) => { hk = h; render(); }).catch(() => {});
  api.detected().then((f) => { found = f || {}; render(); }).catch(() => {});
  api.onDetected((f) => { found = f || {}; if (!typing()) render(); });
  window.__settingsTest = { newCustom: async (p) => { await loadPresets(); editing = { ...(presets[p] || presets.blank) }; render(); } };
})();
