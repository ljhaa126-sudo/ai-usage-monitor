package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Window 一个额度窗口（5 小时 / 一周 / 每月 / 每日 …）
type Window struct {
	Key           string  `json:"key"`   // "5h" "week" "month" "day" ...
	Label         string  `json:"label"` // 显示名
	UsedPercent   float64 `json:"usedPercent"`
	ResetsAt      int64   `json:"resetsAt"`      // unix 毫秒，0 = 未知
	WindowMinutes int     `json:"windowMinutes"` // 窗口长度（分钟），0 = 未知
	Detail        string  `json:"detail"`        // 额外说明，比如 "已用 120 / 300 次"
}

type DayPoint struct {
	Date  string  `json:"date"` // 2006-01-02
	Value float64 `json:"value"`
}

type ProviderStatus struct {
	ID           string     `json:"id"`
	Name         string     `json:"name"`
	Tagline      string     `json:"tagline"`
	Color        string     `json:"color"`
	Enabled      bool       `json:"enabled"`
	State        string     `json:"state"` // ok | error | nologin | loading | disabled
	Message      string     `json:"message"`
	Plan         string     `json:"plan"`
	Account      string     `json:"account"`
	Source       string     `json:"source"`
	Primary      *Window    `json:"primary"`   // 短窗口（5h）
	Secondary    *Window    `json:"secondary"` // 长窗口（周）
	Extra        []Window   `json:"extra"`
	Headline     float64    `json:"headline"` // 竖条上显示的百分比
	HeadlineKey  string     `json:"headlineKey"`
	ResetCount   int        `json:"resetCount"` // 本周期内 5h 窗口已重置次数
	PlanEndsAt   int64      `json:"planEndsAt"` // 套餐/计费周期结束（毫秒）
	PlanStartAt  int64      `json:"planStartAt"`
	Credits      string     `json:"credits"`
	History      []DayPoint `json:"history"`
	HistoryUnit  string     `json:"historyUnit"`
	ActiveDays   []bool     `json:"activeDays"` // 本周一..周日 是否有使用
	UpdatedAt    int64      `json:"updatedAt"`
	DashboardURL string     `json:"dashboardUrl"`
	NeedsKey     string     `json:"needsKey"` // 需要用户填写的凭据类型：apikey | cookie | token | ""
}

type providerDef struct {
	ID           string
	Name         string
	Tagline      string
	Color        string
	DashboardURL string
	NeedsKey     string
	Fetch        func(cfg ProviderConfig) (*ProviderStatus, error)
}

// ---------- 通用工具 ----------

var httpClient = &http.Client{Timeout: 20 * time.Second}

type httpError struct {
	Status int
	Body   string
}

func (e *httpError) Error() string {
	b := e.Body
	if len(b) > 160 {
		b = b[:160] + "…"
	}
	return fmt.Sprintf("HTTP %d %s", e.Status, strings.TrimSpace(b))
}

func doJSON(method, url string, headers map[string]string, body io.Reader, out any) error {
	return doJSONWith(httpClient, method, url, headers, body, out)
}

func doJSONWith(client *http.Client, method, url string, headers map[string]string, body io.Reader, out any) error {
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "Client.Timeout") || strings.Contains(msg, "timeout") {
			return fmt.Errorf("连接 %s 超时，请检查网络或代理（设置 → 网络代理）", req.URL.Host)
		}
		return fmt.Errorf("无法连接 %s：%v。如需代理，请在设置里填写", req.URL.Host, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body := string(data)
		if strings.Contains(body, "<html") || strings.Contains(body, "<!DOCTYPE") {
			body = "（服务器返回了网页，可能被拦截或需要代理）"
		}
		return &httpError{Status: resp.StatusCode, Body: body}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("返回数据无法解析：%v", err)
	}
	return nil
}

func isAuthErr(err error) bool {
	if he, ok := err.(*httpError); ok {
		return he.Status == 401 || (he.Status == 403 && !strings.Contains(he.Body, "网页"))
	}
	return false
}

func homeDir() string {
	if h := os.Getenv("USERPROFILE"); h != "" {
		return h
	}
	h, _ := os.UserHomeDir()
	return h
}

func appDataDir() string {
	if a := os.Getenv("APPDATA"); a != "" {
		return a
	}
	h, _ := os.UserConfigDir()
	return h
}

func localAppDataDir() string {
	if a := os.Getenv("LOCALAPPDATA"); a != "" {
		return a
	}
	return filepath.Join(homeDir(), "AppData", "Local")
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func readJSONFile(p string, out any) error {
	data, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	// 去掉 UTF-8 BOM
	data = []byte(strings.TrimPrefix(string(data), "\ufeff"))
	return json.Unmarshal(data, out)
}

// 解析多种时间格式 -> unix 毫秒
func parseTimeAny(v any) int64 {
	switch t := v.(type) {
	case nil:
		return 0
	case float64:
		return normalizeEpoch(int64(t))
	case int64:
		return normalizeEpoch(t)
	case json.Number:
		if i, err := t.Int64(); err == nil {
			return normalizeEpoch(i)
		}
		if f, err := t.Float64(); err == nil {
			return normalizeEpoch(int64(f))
		}
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0
		}
		if i, err := strconv.ParseInt(s, 10, 64); err == nil {
			return normalizeEpoch(i)
		}
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02"} {
			if tm, err := time.Parse(layout, s); err == nil {
				return tm.UnixMilli()
			}
		}
	}
	return 0
}

func normalizeEpoch(i int64) int64 {
	if i <= 0 {
		return 0
	}
	if i < 1e11 { // 秒
		return i * 1000
	}
	return i
}

func toFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		return f, err == nil
	}
	return 0, false
}

func clampPct(p float64) float64 {
	if p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return p
}

func titleCase(s string) string {
	if s == "" {
		return s
	}
	parts := strings.FieldsFunc(s, func(r rune) bool { return r == '_' || r == '-' || r == ' ' })
	for i, p := range parts {
		if p == "" {
			continue
		}
		parts[i] = strings.ToUpper(p[:1]) + p[1:]
	}
	return strings.Join(parts, " ")
}

// m 是 map[string]any 时取子字段
func obj(v any, key string) map[string]any {
	if m, ok := v.(map[string]any); ok {
		if c, ok := m[key].(map[string]any); ok {
			return c
		}
	}
	return nil
}

func str(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if s, ok := m[key].(string); ok {
		return s
	}
	if f, ok := m[key].(float64); ok {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return ""
}

func num(m map[string]any, keys ...string) (float64, bool) {
	if m == nil {
		return 0, false
	}
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			if f, ok := toFloat(v); ok {
				return f, true
			}
		}
	}
	return 0, false
}

func base64Std(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
