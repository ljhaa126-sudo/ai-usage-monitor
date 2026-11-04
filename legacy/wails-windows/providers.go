package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var errNoLogin = errors.New("nologin")

type noLoginErr struct{ msg string }

func (e *noLoginErr) Error() string { return e.msg }

func needLogin(msg string) error { return &noLoginErr{msg: msg} }

var providerDefs = []providerDef{
	{ID: "claude", Name: "Claude", Tagline: "Anthropic · 订阅额度", Color: "#D97757", DashboardURL: "https://claude.ai/settings/usage", Fetch: fetchClaude},
	{ID: "codex", Name: "Codex", Tagline: "AI coding, more possibilities.", Color: "#3BE38B", DashboardURL: "https://chatgpt.com/codex/settings/usage", Fetch: fetchCodex},
	{ID: "cursor", Name: "Cursor", Tagline: "Cursor 编辑器 · 月度额度", Color: "#8B8CF8", DashboardURL: "https://cursor.com/dashboard?tab=usage", NeedsKey: "cookie", Fetch: fetchCursor},
	{ID: "gemini", Name: "Gemini CLI", Tagline: "Google · 每日请求额度", Color: "#4C8DF6", DashboardURL: "https://aistudio.google.com/usage", Fetch: fetchGemini},
	{ID: "copilot", Name: "GitHub Copilot", Tagline: "高级请求 · 每月重置", Color: "#E8EAED", DashboardURL: "https://github.com/settings/copilot/features", NeedsKey: "token", Fetch: fetchCopilot},
	{ID: "kimi", Name: "Kimi Code", Tagline: "Moonshot · Coding 套餐", Color: "#F06B8A", DashboardURL: "https://www.kimi.com/code/console", NeedsKey: "apikey", Fetch: fetchKimi},
	{ID: "glm", Name: "智谱 GLM", Tagline: "GLM Coding Plan", Color: "#3E7BFA", DashboardURL: "https://bigmodel.cn/coding-plan/personal/usage", NeedsKey: "apikey", Fetch: fetchGLM},
}

func newStatus(def providerDef) *ProviderStatus {
	return &ProviderStatus{ID: def.ID, Name: def.Name, Tagline: def.Tagline, Color: def.Color, DashboardURL: def.DashboardURL, NeedsKey: def.NeedsKey, State: "ok"}
}

// ======================= Claude =======================
// 来源（按优先级）：设置里手动填写 → Claude Code 登录 → Claude 桌面版登录 → 上次成功的网页会话

func fetchClaude(cfg ProviderConfig) (*ProviderStatus, error) {
	st := &ProviderStatus{}
	series, daily := claudeLocalHistory()
	st.History, st.HistoryUnit = series, "M tokens"
	st.ActiveDays = activeDaysFromSeries(daily)

	manual := strings.TrimSpace(cfg.APIKey)
	if manual != "" {
		if sk := extractSessionKey(manual); sk != "" {
			return claudeWeb(st, sk, "手动填写的网页登录")
		}
		return claudeOAuth(st, manual, "", "手动填写的 Token")
	}

	// Claude Code CLI
	var oauth struct {
		ClaudeAiOauth struct {
			AccessToken      string  `json:"accessToken"`
			ExpiresAt        float64 `json:"expiresAt"`
			SubscriptionType string  `json:"subscriptionType"`
			RateLimitTier    string  `json:"rateLimitTier"`
		} `json:"claudeAiOauth"`
	}
	for _, d := range claudeConfigDirs() {
		if readJSONFile(filepath.Join(d, ".credentials.json"), &oauth) == nil && oauth.ClaudeAiOauth.AccessToken != "" {
			plan := titleCase(oauth.ClaudeAiOauth.SubscriptionType)
			if m := regexp.MustCompile(`(\d+)x`).FindStringSubmatch(oauth.ClaudeAiOauth.RateLimitTier); m != nil {
				plan += " " + m[1] + "x"
			}
			st.Plan = strings.TrimSpace(plan)
			res, err := claudeOAuth(st, oauth.ClaudeAiOauth.AccessToken, "", "Claude Code 登录")
			if err == nil {
				return res, nil
			}
			if exp := int64(oauth.ClaudeAiOauth.ExpiresAt); isAuthErr(errors.Unwrap(err)) || (exp > 0 && exp < time.Now().UnixMilli()) {
				// 继续尝试桌面版
				logf("[claude] Claude Code 令牌不可用：%v", err)
			} else {
				return res, err
			}
		}
	}

	// Claude 桌面版 / 缓存的网页会话
	sk, derr := claudeDesktopSessionKey()
	src := "Claude 桌面版登录"
	if sk == "" {
		sk = loadCachedSession()
		src = "已保存的网页登录"
	}
	if sk != "" {
		res, err := claudeWeb(st, sk, src)
		if err == nil {
			saveCachedSession(sk)
		}
		return res, err
	}
	if derr != nil {
		logf("[claude] 桌面版登录读取失败：%v", derr)
	}
	return st, needLogin("没有找到 Claude 登录。若使用 Claude 桌面版：先完全退出 Claude 再刷新一次（只需一次，之后会记住）；或在设置里粘贴 claude.ai 的 sessionKey。")
}

type wrapErr struct {
	msg string
	err error
}

func (w *wrapErr) Error() string { return w.msg }
func (w *wrapErr) Unwrap() error { return w.err }

func claudeOAuth(st *ProviderStatus, token, _ string, src string) (*ProviderStatus, error) {
	var data map[string]any
	err := doJSON("GET", "https://api.anthropic.com/api/oauth/usage", map[string]string{
		"Authorization":  "Bearer " + token,
		"anthropic-beta": "oauth-2025-04-20",
		"User-Agent":     "claude-code/2.1.0",
		"Content-Type":   "application/json",
	}, nil, &data)
	if err != nil {
		if isAuthErr(err) {
			return st, &wrapErr{"Claude 登录已过期：打开一次 Claude Code（运行 claude）即可刷新", err}
		}
		return st, err
	}
	st.Source = src
	claudeParseUsage(st, data)
	return st, nil
}

func browserHeaders(cookie string) map[string]string {
	return map[string]string{
		"Cookie":                    cookie,
		"User-Agent":                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		"Accept":                    "*/*",
		"Accept-Language":           "zh-CN,zh;q=0.9,en;q=0.8",
		"Referer":                   "https://claude.ai/settings/usage",
		"Origin":                    "https://claude.ai",
		"sec-ch-ua":                 `"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"`,
		"sec-ch-ua-mobile":          "?0",
		"sec-ch-ua-platform":        `"Windows"`,
		"sec-fetch-dest":            "empty",
		"sec-fetch-mode":            "cors",
		"sec-fetch-site":            "same-origin",
		"anthropic-client-platform": "web_claude_ai",
	}
}

func claudeWeb(st *ProviderStatus, sessionKey, src string) (*ProviderStatus, error) {
	h := browserHeaders("sessionKey=" + sessionKey)
	bc := browserHTTP()
	var orgs []map[string]any
	if err := doJSONWith(bc, "GET", "https://claude.ai/api/organizations", h, nil, &orgs); err != nil {
		if isAuthErr(err) {
			clearCachedSession(sessionKey)
			return st, needLogin("Claude 网页登录已失效，请重新登录 Claude，或在设置里更新 sessionKey")
		}
		return st, err
	}
	if len(orgs) == 0 {
		return st, errors.New("这个 Claude 账号下没有组织信息")
	}
	org := orgs[0]
	for _, o := range orgs {
		caps := fmt.Sprint(o["capabilities"])
		if strings.Contains(caps, "claude_max") || strings.Contains(caps, "claude_pro") || strings.Contains(caps, "chat") {
			org = o
			break
		}
	}
	caps := fmt.Sprint(org["capabilities"])
	switch {
	case strings.Contains(caps, "claude_max"):
		st.Plan = "Max"
	case strings.Contains(caps, "claude_pro"):
		st.Plan = "Pro"
	case strings.Contains(caps, "raven"):
		st.Plan = "Team"
	default:
		st.Plan = "Free"
	}
	if tier := str(org, "rate_limit_tier"); tier != "" {
		if m := regexp.MustCompile(`(\d+)x`).FindStringSubmatch(tier); m != nil {
			st.Plan += " " + m[1] + "x"
		}
	}
	if n := str(org, "name"); n != "" {
		st.Account = strings.TrimSuffix(strings.TrimSuffix(n, "'s Organization"), "’s Organization")
	}
	var data map[string]any
	if err := doJSONWith(bc, "GET", "https://claude.ai/api/organizations/"+str(org, "uuid")+"/usage", h, nil, &data); err != nil {
		if isAuthErr(err) {
			return st, needLogin("Claude 网页登录已失效，请重新登录")
		}
		return st, err
	}
	st.Source = src
	claudeParseUsage(st, data)
	if st.Primary == nil && st.Secondary == nil {
		st.Message = "该账号暂无用量窗口数据"
	}
	return st, nil
}

func claudeParseUsage(st *ProviderStatus, data map[string]any) {
	win := func(key, label string, minutes int, m map[string]any) *Window {
		if m == nil {
			return nil
		}
		u, ok := num(m, "utilization")
		if !ok {
			return nil
		}
		return &Window{Key: key, Label: label, UsedPercent: clampPct(u), ResetsAt: parseTimeAny(m["resets_at"]), WindowMinutes: minutes}
	}
	st.Primary = win("5h", "5 小时", 300, obj(data, "five_hour"))
	st.Secondary = win("week", "本周 · 全部模型", 7*24*60, obj(data, "seven_day"))
	for _, x := range []struct{ k, l string }{{"seven_day_opus", "本周 · Opus"}, {"seven_day_sonnet", "本周 · Sonnet"}, {"seven_day_oauth_apps", "本周 · OAuth 应用"}} {
		if w := win("week", x.l, 7*24*60, obj(data, x.k)); w != nil {
			st.Extra = append(st.Extra, *w)
		}
	}
	if ex := obj(data, "extra_usage"); ex != nil {
		if en, _ := ex["is_enabled"].(bool); en {
			used, _ := num(ex, "used_credits")
			limit, _ := num(ex, "monthly_limit")
			u, _ := num(ex, "utilization")
			st.Extra = append(st.Extra, Window{Key: "month", Label: "额外用量（本月）", UsedPercent: clampPct(u), Detail: fmt.Sprintf("$%.2f / $%.2f", used/100, limit/100)})
		}
	}
}

var sessionKeyRe = regexp.MustCompile(`sk-ant-sid[0-9A-Za-z_\-]+`)

func extractSessionKey(s string) string {
	return sessionKeyRe.FindString(s)
}

// claudeDesktopDirs Claude 桌面版的数据目录（普通安装 + 应用商店安装）
func claudeDesktopDirs() []string {
	dirs := []string{filepath.Join(appDataDir(), "Claude")}
	if m, _ := filepath.Glob(filepath.Join(localAppDataDir(), "Packages", "*Claude*", "LocalCache", "Roaming", "Claude")); len(m) > 0 {
		dirs = append(dirs, m...)
	}
	return dirs
}

// claudeDesktopSessionKey 从 Claude 桌面版的 Cookie 库中解密出 claude.ai 的 sessionKey
func claudeDesktopSessionKey() (string, error) {
	var lastErr error
	for _, dir := range claudeDesktopDirs() {
		if !fileExists(filepath.Join(dir, "Local State")) {
			continue
		}
		key, err := chromiumMasterKey(filepath.Join(dir, "Local State"))
		if err != nil {
			lastErr = fmt.Errorf("读取加密密钥失败：%v", err)
			continue
		}
		for _, f := range []string{filepath.Join(dir, "Network", "Cookies"), filepath.Join(dir, "Cookies")} {
			if !fileExists(f) {
				continue
			}
			data, err := os.ReadFile(f)
			if err != nil {
				lastErr = fmt.Errorf("Cookie 文件被占用（Claude 正在运行）：%v", err)
				continue
			}
			if sk := scanSessionKey(data, key); sk != "" {
				return sk, nil
			}
			lastErr = errors.New("Cookie 库里没有 claude.ai 的登录")
		}
	}
	return "", lastErr
}

func scanSessionKey(data, key []byte) string {
	name := []byte("sessionKey")
	idx := 0
	var best string
	for {
		i := bytes.Index(data[idx:], name)
		if i < 0 {
			break
		}
		pos := idx + i + len(name)
		idx = pos
		if pos+3 > len(data) || string(data[pos:pos+3]) != "v10" {
			continue
		}
		maxL := len(data) - pos
		if maxL > 3+12+1024 {
			maxL = 3 + 12 + 1024
		}
		for L := 3 + 12 + 16 + 20; L <= maxL; L++ {
			pt, err := aesGCMDecryptV10(key, data[pos:pos+L])
			if err != nil {
				continue
			}
			if sk := extractSessionKey(pt); sk != "" {
				best = sk // 后出现的通常更新
			}
			break
		}
	}
	return best
}

func sessionCachePath() string { return filepath.Join(dataDir(), "claude_session.bin") }

func saveCachedSession(sk string) {
	if enc, err := protectData([]byte(sk)); err == nil {
		_ = os.WriteFile(sessionCachePath(), enc, 0o600)
	}
}

func loadCachedSession() string {
	b, err := os.ReadFile(sessionCachePath())
	if err != nil {
		return ""
	}
	pt, err := unprotectData(b)
	if err != nil {
		return ""
	}
	return extractSessionKey(string(pt))
}

func clearCachedSession(sk string) {
	if loadCachedSession() == sk {
		_ = os.Remove(sessionCachePath())
	}
}

// ======================= Codex =======================

func fetchCodex(cfg ProviderConfig) (*ProviderStatus, error) {
	st := &ProviderStatus{}
	series, daily, localRate, localTs := codexLocal()
	st.History, st.HistoryUnit = series, "M tokens"
	st.ActiveDays = activeDaysFromSeries(daily)

	var auth struct {
		Tokens struct {
			AccessToken string `json:"access_token"`
			AccountID   string `json:"account_id"`
			IDToken     string `json:"id_token"`
		} `json:"tokens"`
	}
	_ = readJSONFile(filepath.Join(codexHome(), "auth.json"), &auth)
	token := auth.Tokens.AccessToken
	if k := strings.TrimSpace(cfg.APIKey); k != "" {
		token = k
	}
	if auth.Tokens.IDToken != "" {
		if claims := jwtClaims(auth.Tokens.IDToken); claims != nil {
			if e, ok := claims["email"].(string); ok {
				st.Account = e
			}
			if a := obj(claims, "https://api.openai.com/auth"); a != nil {
				if p := str(a, "chatgpt_plan_type"); p != "" {
					st.Plan = titleCase(p)
				}
				if until := parseTimeAny(a["chatgpt_subscription_active_until"]); until > 0 {
					st.PlanEndsAt = until
				}
			}
		}
	}

	var apiErr error
	if token != "" {
		h := map[string]string{"Authorization": "Bearer " + token, "User-Agent": "codex_cli_rs/0.77.0", "originator": "codex_cli_rs"}
		if auth.Tokens.AccountID != "" {
			h["ChatGPT-Account-Id"] = auth.Tokens.AccountID
		}
		var data map[string]any
		apiErr = doJSON("GET", "https://chatgpt.com/backend-api/wham/usage", h, nil, &data)
		if apiErr == nil {
			st.Source = "ChatGPT API"
			if p := str(data, "plan_type"); p != "" {
				st.Plan = titleCase(p)
			}
			if e := str(data, "email"); e != "" {
				st.Account = e
			}
			rl := obj(data, "rate_limit")
			st.Primary = codexWindow(obj(rl, "primary_window"), "5h", "5 小时")
			st.Secondary = codexWindow(obj(rl, "secondary_window"), "week", "本周")
			if cr := obj(data, "credits"); cr != nil {
				if un, _ := cr["unlimited"].(bool); un {
					st.Credits = "无限额度"
				} else if b := str(cr, "balance"); b != "" && b != "0" {
					st.Credits = "余额 " + b + " credits"
				}
			}
			if arr, ok := data["additional_rate_limits"].([]any); ok {
				for _, it := range arr {
					m, _ := it.(map[string]any)
					name := str(m, "limit_name")
					if name == "" {
						name = str(m, "metered_feature")
					}
					rl2 := obj(m, "rate_limit")
					if w := codexWindow(obj(rl2, "primary_window"), "5h", name+" · 5 小时"); w != nil {
						st.Extra = append(st.Extra, *w)
					}
					if w := codexWindow(obj(rl2, "secondary_window"), "week", name+" · 本周"); w != nil {
						st.Extra = append(st.Extra, *w)
					}
				}
			}
			return st, nil
		}
	}
	// 回退：本地会话日志中的 rate_limits
	if localRate != nil {
		st.Source = "本地日志（" + time.UnixMilli(localTs).Format("01-02 15:04") + "）"
		st.Primary = codexLocalWindow(obj(localRate, "primary"), localTs, "5h", "5 小时")
		st.Secondary = codexLocalWindow(obj(localRate, "secondary"), localTs, "week", "本周")
		if st.Primary != nil || st.Secondary != nil {
			if apiErr != nil {
				st.Message = "在线接口失败，已用本地日志：" + apiErr.Error()
			}
			return st, nil
		}
	}
	if token == "" {
		return st, needLogin("未检测到 Codex 登录（~/.codex/auth.json）。请运行 codex 并用 ChatGPT 账号登录")
	}
	if isAuthErr(apiErr) {
		return st, needLogin("Codex 登录已过期：运行一次 codex 即可刷新")
	}
	return st, apiErr
}

func codexWindow(m map[string]any, key, label string) *Window {
	if m == nil {
		return nil
	}
	u, ok := num(m, "used_percent")
	if !ok {
		return nil
	}
	w := &Window{Key: key, Label: label, UsedPercent: clampPct(u)}
	if s, ok := num(m, "limit_window_seconds"); ok {
		w.WindowMinutes = int(s / 60)
	}
	if r := parseTimeAny(m["reset_at"]); r > 0 {
		w.ResetsAt = r
	} else if s, ok := num(m, "reset_after_seconds"); ok {
		w.ResetsAt = time.Now().Add(time.Duration(s) * time.Second).UnixMilli()
	}
	fixWindowLabel(w)
	return w
}

func codexLocalWindow(m map[string]any, ts int64, key, label string) *Window {
	if m == nil {
		return nil
	}
	u, ok := num(m, "used_percent")
	if !ok {
		return nil
	}
	w := &Window{Key: key, Label: label, UsedPercent: clampPct(u)}
	if wm, ok := num(m, "window_minutes"); ok {
		w.WindowMinutes = int(wm)
	}
	if r := parseTimeAny(m["resets_at"]); r > 0 {
		w.ResetsAt = r
	} else if s, ok := num(m, "resets_in_seconds"); ok {
		w.ResetsAt = ts + int64(s*1000)
	}
	// 本地快照可能已过期：已经过了重置点则视为 0
	if w.ResetsAt > 0 && w.ResetsAt < time.Now().UnixMilli() {
		w.UsedPercent = 0
		if w.WindowMinutes > 0 {
			for w.ResetsAt < time.Now().UnixMilli() {
				w.ResetsAt += int64(w.WindowMinutes) * 60000
			}
		}
	}
	fixWindowLabel(w)
	return w
}

func fixWindowLabel(w *Window) {
	switch {
	case w.WindowMinutes == 0:
	case w.WindowMinutes <= 300 && w.Key == "5h":
	case w.WindowMinutes >= 7*24*60-60 && w.Key == "week":
	case w.WindowMinutes < 24*60:
		w.Label = fmt.Sprintf("%d 小时", int(math.Round(float64(w.WindowMinutes)/60)))
	default:
		w.Label = fmt.Sprintf("%d 天", int(math.Round(float64(w.WindowMinutes)/1440)))
	}
}

func jwtClaims(tok string) map[string]any {
	parts := strings.Split(tok, ".")
	if len(parts) < 2 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	return m
}

// ======================= Cursor =======================

var jwtRe = regexp.MustCompile(`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`)
var safeStorageRe = regexp.MustCompile(`cursor-safe-storage:v1:[A-Za-z0-9+/=]{20,}`)

// 直接扫描 SQLite 文件字节，找出 cursorAuth/accessToken 的值（免 sqlite 依赖）
func cursorTokenFromDB() (string, error) {
	base := filepath.Join(appDataDir(), "Cursor", "User", "globalStorage")
	var best string
	var bestExp float64
	found := false
	for _, f := range []string{"state.vscdb", "state.vscdb-wal"} {
		data, err := os.ReadFile(filepath.Join(base, f))
		if err != nil {
			continue
		}
		found = true
		key := []byte("cursorAuth/accessToken")
		idx := 0
		for {
			i := bytes.Index(data[idx:], key)
			if i < 0 {
				break
			}
			pos := idx + i + len(key)
			end := pos + 4096
			if end > len(data) {
				end = len(data)
			}
			chunk := data[pos:end]
			// 值紧跟在 key 之后（最多隔几个字节）
			var cand string
			if loc := jwtRe.FindIndex(chunk); loc != nil && loc[0] < 8 {
				cand = string(chunk[loc[0]:loc[1]])
			} else if loc := safeStorageRe.FindIndex(chunk); loc != nil && loc[0] < 8 {
				if dec, err := decryptCursorSafeStorage(string(chunk[loc[0]:loc[1]])); err == nil {
					cand = dec
				}
			}
			if cand != "" {
				exp := 0.0
				if c := jwtClaims(cand); c != nil {
					exp, _ = num(c, "exp")
				}
				if best == "" || exp > bestExp {
					best, bestExp = cand, exp
				}
			}
			idx = pos
		}
	}
	if !found {
		return "", needLogin("未检测到 Cursor。请在设置里粘贴 cursor.com 的 WorkosCursorSessionToken Cookie")
	}
	if best == "" {
		return "", needLogin("Cursor 未登录或令牌无法读取，可在设置里手动粘贴 Cookie")
	}
	return best, nil
}

func decryptCursorSafeStorage(v string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(v, "cursor-safe-storage:v1:"))
	if err != nil {
		return "", err
	}
	key, err := chromiumMasterKey(filepath.Join(appDataDir(), "Cursor", "Local State"))
	if err != nil {
		return "", err
	}
	return aesGCMDecryptV10(key, raw)
}

func fetchCursor(cfg ProviderConfig) (*ProviderStatus, error) {
	st := &ProviderStatus{HistoryUnit: "%"}
	cookie := strings.TrimSpace(cfg.APIKey)
	if cookie != "" {
		if !strings.Contains(cookie, "=") {
			cookie = "WorkosCursorSessionToken=" + cookie
		}
		st.Source = "手动 Cookie"
	} else {
		tok, err := cursorTokenFromDB()
		if err != nil {
			return st, err
		}
		c := jwtClaims(tok)
		sub := str(c, "sub")
		if i := strings.LastIndex(sub, "|"); i >= 0 {
			sub = sub[i+1:]
		}
		if sub == "" {
			return st, needLogin("Cursor 令牌格式无法识别，请在设置里手动粘贴 Cookie")
		}
		if exp, ok := num(c, "exp"); ok && int64(exp)*1000 < time.Now().UnixMilli() {
			return st, needLogin("Cursor 令牌已过期：打开一次 Cursor 即可刷新")
		}
		cookie = "WorkosCursorSessionToken=" + sub + "%3A%3A" + tok
		st.Source = "Cursor 本地登录"
	}
	h := map[string]string{"Cookie": cookie, "Origin": "https://cursor.com", "Referer": "https://cursor.com/dashboard", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"}
	var data map[string]any
	if err := doJSON("GET", "https://cursor.com/api/usage-summary", h, nil, &data); err != nil {
		if isAuthErr(err) {
			return st, needLogin("Cursor 登录无效，请重新登录 Cursor 或更新 Cookie")
		}
		return st, err
	}
	var me map[string]any
	if doJSON("GET", "https://cursor.com/api/auth/me", h, nil, &me) == nil {
		st.Account = str(me, "email")
	}
	st.Plan = titleCase(str(data, "membershipType"))
	st.PlanStartAt = parseTimeAny(data["billingCycleStart"])
	st.PlanEndsAt = parseTimeAny(data["billingCycleEnd"])
	minutes := 0
	if st.PlanStartAt > 0 && st.PlanEndsAt > st.PlanStartAt {
		minutes = int((st.PlanEndsAt - st.PlanStartAt) / 60000)
	}
	iu := obj(data, "individualUsage")
	plan := obj(iu, "plan")
	total, ok := num(plan, "totalPercentUsed")
	if !ok {
		used, _ := num(plan, "used")
		limit, _ := num(plan, "limit")
		if limit > 0 {
			total = used / limit * 100
		}
	}
	main := &Window{Key: "month", Label: "本月 · 套餐总额度", UsedPercent: clampPct(total), ResetsAt: st.PlanEndsAt, WindowMinutes: minutes}
	if used, ok := num(plan, "used"); ok {
		if limit, ok2 := num(plan, "limit"); ok2 && limit > 0 {
			main.Detail = fmt.Sprintf("$%.2f / $%.2f", used/100, limit/100)
		}
	}
	st.Secondary = main
	if a, ok := num(plan, "autoPercentUsed"); ok {
		st.Extra = append(st.Extra, Window{Key: "month", Label: "每月限额 · Auto / Cursor 模型", UsedPercent: clampPct(a), ResetsAt: st.PlanEndsAt})
	}
	if a, ok := num(plan, "apiPercentUsed"); ok {
		st.Extra = append(st.Extra, Window{Key: "month", Label: "每月限额 · 其他模型 (API)", UsedPercent: clampPct(a), ResetsAt: st.PlanEndsAt})
	}
	if od := obj(iu, "onDemand"); od != nil {
		if en, _ := od["enabled"].(bool); en {
			used, _ := num(od, "used")
			limit, hasLimit := num(od, "limit")
			w := Window{Key: "month", Label: "按需用量 (On-Demand)", Detail: fmt.Sprintf("$%.2f", used/100)}
			if hasLimit && limit > 0 {
				w.UsedPercent = clampPct(used / limit * 100)
				w.Detail += fmt.Sprintf(" / $%.2f", limit/100)
			}
			st.Extra = append(st.Extra, w)
		}
	}
	return st, nil
}

// ======================= Gemini CLI =======================

const geminiFallbackClientID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"
const geminiFallbackClientSecret = "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"

var geminiCache struct {
	token   string
	expires int64
	project string
	tier    string
}

func geminiClientCreds() (string, string) {
	// 尝试从已安装的 gemini-cli 中读取 OAuth client（与 CLI 保持一致）
	roots := []string{filepath.Join(appDataDir(), "npm", "node_modules", "@google", "gemini-cli")}
	idRe := regexp.MustCompile(`OAUTH_CLIENT_ID\s*=\s*['"]([\w\-.]+)['"]`)
	secRe := regexp.MustCompile(`OAUTH_CLIENT_SECRET\s*=\s*['"]([\w\-]+)['"]`)
	for _, r := range roots {
		var id, sec string
		_ = filepath.Walk(r, func(p string, info os.FileInfo, err error) error {
			if err != nil || id != "" {
				return nil
			}
			if info.IsDir() || !strings.HasSuffix(p, "oauth2.js") {
				return nil
			}
			b, _ := os.ReadFile(p)
			if m := idRe.FindSubmatch(b); m != nil {
				if s := secRe.FindSubmatch(b); s != nil {
					id, sec = string(m[1]), string(s[1])
				}
			}
			return nil
		})
		if id != "" {
			return id, sec
		}
	}
	return geminiFallbackClientID, geminiFallbackClientSecret
}

func fetchGemini(cfg ProviderConfig) (*ProviderStatus, error) {
	st := &ProviderStatus{HistoryUnit: "%"}
	var creds struct {
		AccessToken  string  `json:"access_token"`
		RefreshToken string  `json:"refresh_token"`
		ExpiryDate   float64 `json:"expiry_date"`
		IDToken      string  `json:"id_token"`
	}
	credPath := filepath.Join(homeDir(), ".gemini", "oauth_creds.json")
	if readJSONFile(credPath, &creds) != nil || (creds.AccessToken == "" && creds.RefreshToken == "") {
		return st, needLogin("未检测到 Gemini CLI 的 Google 登录（~/.gemini/oauth_creds.json）。请运行 gemini 并选择 Login with Google")
	}
	if c := jwtClaims(creds.IDToken); c != nil {
		st.Account = str(c, "email")
	}
	token := creds.AccessToken
	now := time.Now().UnixMilli()
	if int64(creds.ExpiryDate) < now+60000 {
		if geminiCache.token != "" && geminiCache.expires > now+60000 {
			token = geminiCache.token
		} else if creds.RefreshToken != "" {
			id, sec := geminiClientCreds()
			form := url.Values{"client_id": {id}, "client_secret": {sec}, "refresh_token": {creds.RefreshToken}, "grant_type": {"refresh_token"}}
			var tr struct {
				AccessToken string  `json:"access_token"`
				ExpiresIn   float64 `json:"expires_in"`
			}
			err := doJSON("POST", "https://oauth2.googleapis.com/token", map[string]string{"Content-Type": "application/x-www-form-urlencoded"}, strings.NewReader(form.Encode()), &tr)
			if err != nil || tr.AccessToken == "" {
				return st, needLogin("Gemini 令牌刷新失败：运行一次 gemini 即可刷新")
			}
			token = tr.AccessToken
			geminiCache.token = token
			geminiCache.expires = now + int64(tr.ExpiresIn*1000)
		}
	}
	gh := map[string]string{"Authorization": "Bearer " + token, "Content-Type": "application/json", "User-Agent": "GeminiCLI/0.12.0 (win32; x64)"}
	if geminiCache.project == "" {
		var la map[string]any
		body := `{"metadata":{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}}`
		if err := doJSON("POST", "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", gh, strings.NewReader(body), &la); err != nil {
			if isAuthErr(err) {
				return st, needLogin("Gemini 登录已失效，请运行 gemini 重新登录")
			}
			return st, err
		}
		if p, ok := la["cloudaicompanionProject"].(string); ok {
			geminiCache.project = p
		} else if p := obj(la, "cloudaicompanionProject"); p != nil {
			geminiCache.project = str(p, "id")
		}
		if t := obj(la, "currentTier"); t != nil {
			geminiCache.tier = str(t, "name")
			if geminiCache.tier == "" {
				geminiCache.tier = titleCase(str(t, "id"))
			}
		}
		if pt := obj(la, "paidTier"); pt != nil && str(pt, "name") != "" {
			geminiCache.tier = str(pt, "name")
		}
	}
	if p := os.Getenv("GOOGLE_CLOUD_PROJECT"); p != "" && geminiCache.project == "" {
		geminiCache.project = p
	}
	st.Plan = geminiCache.tier
	var q map[string]any
	body, _ := json.Marshal(map[string]string{"project": geminiCache.project})
	if err := doJSON("POST", "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", gh, bytes.NewReader(body), &q); err != nil {
		if isAuthErr(err) {
			return st, needLogin("Gemini 登录已失效，请运行 gemini 重新登录")
		}
		return st, err
	}
	st.Source = "Google OAuth"
	buckets, _ := q["buckets"].([]any)
	type b struct {
		model string
		used  float64
		reset int64
	}
	byModel := map[string]b{}
	for _, it := range buckets {
		m, _ := it.(map[string]any)
		rf, ok := num(m, "remainingFraction")
		if !ok {
			continue
		}
		model := str(m, "modelId")
		used := clampPct((1 - rf) * 100)
		if old, ok := byModel[model]; ok && old.used >= used {
			continue
		}
		byModel[model] = b{model: model, used: used, reset: parseTimeAny(m["resetTime"])}
	}
	models := make([]b, 0, len(byModel))
	for _, v := range byModel {
		models = append(models, v)
	}
	sort.Slice(models, func(i, j int) bool { return models[i].model < models[j].model })
	var pro, flash *Window
	for _, m := range models {
		w := Window{Key: "day", Label: m.model + " · 每日", UsedPercent: m.used, ResetsAt: m.reset, WindowMinutes: 1440}
		lm := strings.ToLower(m.model)
		if strings.Contains(lm, "pro") && (pro == nil || w.UsedPercent > pro.UsedPercent) {
			cp := w
			pro = &cp
		} else if strings.Contains(lm, "flash") && !strings.Contains(lm, "lite") && (flash == nil || w.UsedPercent > flash.UsedPercent) {
			cp := w
			flash = &cp
		}
		st.Extra = append(st.Extra, w)
	}
	if pro != nil {
		st.Primary = pro
	}
	if flash != nil {
		st.Secondary = flash
	}
	if st.Primary == nil && len(st.Extra) > 0 {
		cp := st.Extra[0]
		st.Primary = &cp
	}
	rest := []Window{}
	for _, w := range st.Extra {
		if (st.Primary != nil && w.Label == st.Primary.Label) || (st.Secondary != nil && w.Label == st.Secondary.Label) {
			continue
		}
		rest = append(rest, w)
	}
	st.Extra = rest
	if st.Primary == nil {
		st.Message = "暂无额度数据"
	}
	return st, nil
}

// ======================= GitHub Copilot =======================

func copilotTokenFromDisk() string {
	for _, f := range []string{"apps.json", "hosts.json"} {
		var m map[string]map[string]any
		p := filepath.Join(localAppDataDir(), "github-copilot", f)
		if readJSONFile(p, &m) != nil {
			p = filepath.Join(homeDir(), ".config", "github-copilot", f)
			if readJSONFile(p, &m) != nil {
				continue
			}
		}
		for k, v := range m {
			if strings.HasPrefix(k, "github.com") {
				if t, ok := v["oauth_token"].(string); ok && t != "" {
					return t
				}
			}
		}
	}
	return ""
}

func fetchCopilot(cfg ProviderConfig) (*ProviderStatus, error) {
	st := &ProviderStatus{HistoryUnit: "%"}
	token := strings.TrimSpace(cfg.APIKey)
	st.Source = "手动 Token"
	if token == "" {
		token = copilotTokenFromDisk()
		st.Source = "Copilot 插件登录"
	}
	if token == "" {
		return st, needLogin("未找到 Copilot 令牌。可在设置里粘贴 GitHub Token（如 gh auth token 的输出）")
	}
	var data map[string]any
	err := doJSON("GET", "https://api.github.com/copilot_internal/user", map[string]string{
		"Authorization":         "token " + token,
		"Editor-Version":        "vscode/1.99.0",
		"Editor-Plugin-Version": "copilot-chat/0.26.7",
		"User-Agent":            "GitHubCopilotChat/0.26.7",
		"X-Github-Api-Version":  "2025-04-01",
	}, nil, &data)
	if err != nil {
		if isAuthErr(err) {
			return st, needLogin("GitHub Token 无效或无 Copilot 权限")
		}
		return st, err
	}
	st.Plan = titleCase(str(data, "copilot_plan"))
	st.Account = str(data, "login")
	reset := parseTimeAny(data["quota_reset_date_utc"])
	if reset == 0 {
		reset = parseTimeAny(data["quota_reset_date"])
	}
	st.PlanEndsAt = reset
	snaps := obj(data, "quota_snapshots")
	mk := func(key, label string) *Window {
		m := obj(snaps, key)
		if m == nil {
			return nil
		}
		if un, _ := m["unlimited"].(bool); un {
			return &Window{Key: "month", Label: label, UsedPercent: 0, ResetsAt: reset, Detail: "无限制"}
		}
		pr, ok := num(m, "percent_remaining")
		if !ok {
			return nil
		}
		w := &Window{Key: "month", Label: label, UsedPercent: clampPct(100 - pr), ResetsAt: reset}
		ent, _ := num(m, "entitlement")
		rem, _ := num(m, "remaining")
		if ent > 0 {
			w.Detail = fmt.Sprintf("已用 %.0f / %.0f", ent-rem, ent)
		}
		return w
	}
	st.Secondary = mk("premium_interactions", "本月 · 高级请求")
	if w := mk("chat", "本月 · Chat"); w != nil {
		st.Extra = append(st.Extra, *w)
	}
	if w := mk("completions", "本月 · 代码补全"); w != nil {
		st.Extra = append(st.Extra, *w)
	}
	if st.Secondary == nil && len(st.Extra) > 0 {
		cp := st.Extra[0]
		st.Secondary = &cp
	}
	return st, nil
}

// ======================= Kimi Code =======================

func fetchKimi(cfg ProviderConfig) (*ProviderStatus, error) {
	st := &ProviderStatus{HistoryUnit: "%"}
	key := strings.TrimSpace(cfg.APIKey)
	if key == "" {
		key = os.Getenv("KIMI_API_KEY")
	}
	if key == "" {
		return st, needLogin("请在设置里填写 Kimi Code 的 API Key（kimi.com/code 控制台获取）")
	}
	var data map[string]any
	if err := doJSON("GET", "https://api.kimi.com/coding/v1/usages", map[string]string{"Authorization": "Bearer " + key}, nil, &data); err != nil {
		if isAuthErr(err) {
			return st, needLogin("Kimi API Key 无效")
		}
		return st, err
	}
	st.Source = "Kimi API"
	if u := obj(data, "user"); u != nil {
		if m := obj(u, "membership"); m != nil {
			st.Plan = titleCase(strings.ToLower(strings.TrimPrefix(str(m, "level"), "LEVEL_")))
		}
	}
	detailWin := func(d map[string]any, key, label string) *Window {
		if d == nil {
			return nil
		}
		limit, _ := num(d, "limit")
		used, okU := num(d, "used")
		if !okU {
			if rem, ok := num(d, "remaining"); ok {
				used = limit - rem
			}
		}
		if limit <= 0 {
			return nil
		}
		w := &Window{Key: key, Label: label, UsedPercent: clampPct(used / limit * 100), Detail: fmt.Sprintf("已用 %.0f / %.0f", used, limit)}
		for _, k := range []string{"resetTime", "reset_time", "resetAt"} {
			if r := parseTimeAny(d[k]); r > 0 {
				w.ResetsAt = r
				break
			}
		}
		return w
	}
	if w := detailWin(obj(data, "usage"), "week", "本周"); w != nil {
		w.WindowMinutes = 7 * 24 * 60
		st.Secondary = w
	}
	if arr, ok := data["limits"].([]any); ok {
		for _, it := range arr {
			m, _ := it.(map[string]any)
			wd := obj(m, "window")
			dur, _ := num(wd, "duration")
			unit := strings.ToUpper(str(wd, "timeUnit"))
			minutes := int(dur)
			if strings.Contains(unit, "HOUR") {
				minutes = int(dur * 60)
			} else if strings.Contains(unit, "DAY") {
				minutes = int(dur * 1440)
			} else if strings.Contains(unit, "SECOND") {
				minutes = int(dur / 60)
			}
			label := fmt.Sprintf("%d 分钟", minutes)
			if minutes%60 == 0 && minutes > 0 {
				label = fmt.Sprintf("%d 小时", minutes/60)
			}
			w := detailWin(obj(m, "detail"), "5h", label)
			if w == nil {
				continue
			}
			w.WindowMinutes = minutes
			if st.Primary == nil && minutes <= 600 {
				st.Primary = w
			} else {
				st.Extra = append(st.Extra, *w)
			}
		}
	}
	// 另一种返回结构：usages.limit_5h / limit_7d
	if pools := obj(data, "usages"); pools != nil {
		ratio := func(k string) *Window {
			p := obj(pools, k)
			if p == nil {
				return nil
			}
			r, ok := num(p, "used_ratio")
			if !ok {
				return nil
			}
			if r <= 1 {
				r *= 100
			}
			return &Window{UsedPercent: clampPct(r), ResetsAt: parseTimeAny(p["reset_time"])}
		}
		if w := ratio("limit_5h"); w != nil && st.Primary == nil {
			w.Key, w.Label, w.WindowMinutes = "5h", "5 小时", 300
			st.Primary = w
		}
		if w := ratio("limit_7d"); w != nil && st.Secondary == nil {
			w.Key, w.Label, w.WindowMinutes = "week", "本周", 7*24*60
			st.Secondary = w
		}
	}
	if st.Primary == nil && st.Secondary == nil {
		return st, errors.New("Kimi 返回了无法识别的用量格式")
	}
	return st, nil
}

// ======================= 智谱 GLM / Z.ai =======================

func fetchGLM(cfg ProviderConfig) (*ProviderStatus, error) {
	st := &ProviderStatus{HistoryUnit: "%"}
	key := strings.TrimSpace(cfg.APIKey)
	if key == "" {
		return st, needLogin("请在设置里填写智谱 GLM Coding Plan 的 API Key")
	}
	base := "https://open.bigmodel.cn"
	if cfg.Region == "global" {
		base = "https://api.z.ai"
		st.DashboardURL = "https://z.ai/manage-apikey/coding-plan/personal/my-plan"
	}
	var data map[string]any
	if err := doJSON("GET", base+"/api/monitor/usage/quota/limit", map[string]string{"Authorization": key, "Accept-Language": "zh-CN,zh"}, nil, &data); err != nil {
		if isAuthErr(err) {
			return st, needLogin("GLM API Key 无效")
		}
		return st, err
	}
	st.Source = "智谱开放平台"
	d := obj(data, "data")
	if d == nil {
		d = data
	}
	if lv := str(d, "level"); lv != "" {
		st.Plan = titleCase(lv)
	}
	limits, _ := d["limits"].([]any)
	for _, it := range limits {
		m, _ := it.(map[string]any)
		typ := strings.ToUpper(str(m, "type"))
		pct, ok := num(m, "percentage")
		if !ok {
			continue
		}
		unit, _ := num(m, "unit")
		w := Window{UsedPercent: clampPct(pct), ResetsAt: parseTimeAny(m["nextResetTime"])}
		if cur, ok := num(m, "currentValue"); ok {
			if tot, ok2 := num(m, "usage"); ok2 && tot > 0 {
				w.Detail = fmt.Sprintf("已用 %.0f / %.0f", cur, tot)
			}
		}
		switch {
		case typ == "TOKENS_LIMIT" && unit == 3:
			w.Key, w.Label, w.WindowMinutes = "5h", "5 小时", 300
			st.Primary = &w
		case typ == "TOKENS_LIMIT" && unit == 6:
			w.Key, w.Label, w.WindowMinutes = "week", "本周", 7*24*60
			st.Secondary = &w
		case typ == "TIME_LIMIT":
			w.Key, w.Label = "month", "MCP 工具调用（每月）"
			st.Extra = append(st.Extra, w)
		default:
			w.Key, w.Label = "other", typ
			st.Extra = append(st.Extra, w)
		}
	}
	if st.Primary == nil && st.Secondary == nil && len(st.Extra) == 0 {
		return st, errors.New("GLM 返回了无法识别的用量格式")
	}
	return st, nil
}
