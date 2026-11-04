package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeRT struct{}

func (fakeRT) RoundTrip(r *http.Request) (*http.Response, error) {
	u := r.URL.String()
	body := `{}`
	rs := time.Now().Add(2 * time.Hour).UTC().Format(time.RFC3339)
	switch {
	case strings.HasSuffix(u, "claude.ai/api/organizations"):
		body = `[{"uuid":"org-1","name":"me@x.com's Organization","capabilities":["chat","claude_max"],"rate_limit_tier":"default_claude_max_5x"}]`
	case strings.Contains(u, "oauth/usage") || strings.Contains(u, "org-1/usage"):
		body = `{"five_hour":{"utilization":89,"resets_at":"` + rs + `"},"seven_day":{"utilization":22,"resets_at":"` + time.Now().Add(80*time.Hour).UTC().Format(time.RFC3339) + `"},"seven_day_opus":{"utilization":5,"resets_at":null},"extra_usage":{"is_enabled":true,"monthly_limit":5000,"used_credits":1234,"utilization":24.7}}`
	case strings.Contains(u, "wham/usage"):
		body = `{"plan_type":"plus","email":"a@b.c","rate_limit":{"primary_window":{"used_percent":40,"limit_window_seconds":18000,"reset_after_seconds":3600,"reset_at":` + fmt.Sprint(time.Now().Add(time.Hour).Unix()) + `},"secondary_window":{"used_percent":12,"limit_window_seconds":604800,"reset_after_seconds":300000}},"credits":{"has_credits":false,"unlimited":false,"balance":"0"}}`
	case strings.Contains(u, "usage-summary"):
		body = `{"billingCycleStart":"2026-10-15T00:00:00.000Z","billingCycleEnd":"2026-11-15T00:00:00.000Z","membershipType":"pro","individualUsage":{"plan":{"enabled":true,"used":400,"limit":2000,"totalPercentUsed":20,"autoPercentUsed":2,"apiPercentUsed":0},"onDemand":{"enabled":false}}}`
	case strings.Contains(u, "auth/me"):
		body = `{"email":"me@cursor.dev"}`
	case strings.Contains(u, "copilot_internal"):
		body = `{"login":"octo","copilot_plan":"individual","quota_reset_date":"2026-12-01","quota_snapshots":{"premium_interactions":{"entitlement":300,"remaining":210,"percent_remaining":70,"unlimited":false},"chat":{"unlimited":true},"completions":{"unlimited":true}}}`
	case strings.Contains(u, "kimi.com"):
		body = `{"user":{"membership":{"level":"LEVEL_INTERMEDIATE"}},"usage":{"limit":"100","used":"35","remaining":"65","resetTime":"` + time.Now().Add(100*time.Hour).UTC().Format(time.RFC3339) + `"},"limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":"100","used":"60","remaining":"40","resetTime":"` + rs + `"}}]}`
	case strings.Contains(u, "quota/limit"):
		body = `{"code":200,"data":{"level":"pro","limits":[{"type":"TOKENS_LIMIT","unit":3,"percentage":33,"nextResetTime":` + fmt.Sprint(time.Now().Add(3*time.Hour).UnixMilli()) + `},{"type":"TOKENS_LIMIT","unit":6,"percentage":8,"nextResetTime":` + fmt.Sprint(time.Now().Add(90*time.Hour).UnixMilli()) + `},{"type":"TIME_LIMIT","unit":5,"percentage":2,"currentValue":20,"usage":1000}]}}`
	case strings.Contains(u, "loadCodeAssist"):
		body = `{"cloudaicompanionProject":"proj-1","currentTier":{"id":"free-tier","name":"Gemini Code Assist for individuals"}}`
	case strings.Contains(u, "retrieveUserQuota"):
		body = `{"buckets":[{"modelId":"gemini-2.5-pro","tokenType":"REQUESTS","remainingFraction":0.7,"resetTime":"` + rs + `"},{"modelId":"gemini-2.5-flash","tokenType":"REQUESTS","remainingFraction":0.95,"resetTime":"` + rs + `"}]}`
	case strings.Contains(u, "oauth2.googleapis"):
		body = `{"access_token":"ya29.x","expires_in":3600}`
	}
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
}

func jwt(claims string) string {
	e := base64.RawURLEncoding.EncodeToString
	return e([]byte(`{"alg":"HS256"}`)) + "." + e([]byte(claims)) + "." + e([]byte("signature-signature"))
}

func TestAll(t *testing.T) {
	home := "/tmp/fakehome"
	os.RemoveAll(home)
	os.Setenv("USERPROFILE", home)
	os.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
	os.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	httpClient.Transport = fakeRT{}
	w := func(p, s string) { os.MkdirAll(filepath.Dir(p), 0o755); os.WriteFile(p, []byte(s), 0o644) }
	w(home+"/.claude/.credentials.json", `{"claudeAiOauth":{"accessToken":"sk-ant-oat","expiresAt":9999999999999,"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}`)
	now := time.Now().UTC()
	var cl strings.Builder
	for i := 0; i < 5; i++ {
		ts := now.AddDate(0, 0, -i).Format(time.RFC3339Nano)
		fmt.Fprintf(&cl, `{"type":"assistant","timestamp":"%s","requestId":"r%d","message":{"id":"m%d","usage":{"input_tokens":1000,"output_tokens":%d,"cache_read_input_tokens":2000000}}}`+"\n", ts, i, i, 500000*(i+1))
		fmt.Fprintf(&cl, `{"type":"assistant","timestamp":"%s","requestId":"r%d","message":{"id":"m%d","usage":{"input_tokens":1000,"output_tokens":%d,"cache_read_input_tokens":2000000}}}`+"\n", ts, i, i, 500000*(i+1))
	}
	w(home+"/.claude/projects/p1/a.jsonl", cl.String())
	idt := jwt(`{"email":"x@y.z","https://api.openai.com/auth":{"chatgpt_plan_type":"pro"}}`)
	w(home+"/.codex/auth.json", `{"tokens":{"access_token":"tok","account_id":"acc","id_token":"`+idt+`"}}`)
	ts := now.Format(time.RFC3339Nano)
	w(home+"/.codex/sessions/2026/11/01/r.jsonl", `{"timestamp":"`+ts+`","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":1000000},"last_token_usage":{"total_tokens":1000000}},"rate_limits":{"primary":{"used_percent":55,"window_minutes":300,"resets_in_seconds":1000},"secondary":{"used_percent":20,"window_minutes":10080,"resets_in_seconds":200000}}}}
{"timestamp":"`+ts+`","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":3500000},"last_token_usage":{"total_tokens":2500000}},"rate_limits":null}}
`)
	// cursor sqlite
	cjwt := jwt(fmt.Sprintf(`{"sub":"auth0|user_ABC123","exp":%d}`, time.Now().Add(24*time.Hour).Unix()))
	db := filepath.Join(home, "AppData/Roaming/Cursor/User/globalStorage/state.vscdb")
	os.MkdirAll(filepath.Dir(db), 0o755)
	out, err := exec.Command("python3", "-c", `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
for i in range(300): c.execute("insert into ItemTable values (?,?)",("k%d"%i,"v"*200))
c.execute("insert into ItemTable values (?,?)",("cursorAuth/accessToken",sys.argv[2]))
c.execute("insert into ItemTable values (?,?)",("cursorAuth/refreshToken",sys.argv[2]))
c.commit()`, db, cjwt).CombinedOutput()
	if err != nil {
		t.Fatal(string(out))
	}
	w(home+"/AppData/Local/github-copilot/apps.json", `{"github.com:Iv1.b507a08c87ecfe98":{"user":"octo","oauth_token":"gho_xxx"}}`)
	w(home+"/.gemini/oauth_creds.json", `{"access_token":"old","refresh_token":"rt","expiry_date":1}`)

	for _, d := range providerDefs {
		cfg := ProviderConfig{Enabled: true}
		if d.ID == "kimi" || d.ID == "glm" {
			cfg.APIKey = "key"
		}
		st, err := d.Fetch(cfg)
		b, _ := json.Marshal(st)
		fmt.Printf("== %s err=%v\n%s\n\n", d.ID, err, b)
	}
	// 回退：Codex API 401 -> 本地
	httpClient.Transport = errRT{}
	st, err := fetchCodex(ProviderConfig{})
	b, _ := json.Marshal(st)
	fmt.Printf("== codex-fallback err=%v\n%s\n", err, b)
	httpClient.Transport = fakeRT{}
	os.Remove(home + "/.claude/.credentials.json")
	st, err = fetchClaude(ProviderConfig{APIKey: "sessionKey=sk-ant-sid01-xyz; other=1"})
	b, _ = json.Marshal(st)
	fmt.Printf("== claude-web err=%v\n%s\n", err, string(b)[:400])
	st, err = fetchClaude(ProviderConfig{})
	fmt.Printf("== claude-none err=%v\n", err)
	a := NewApp()
	a.refreshOne(providerDefs[0])
	fmt.Println("app status:", a.status["claude"].State, a.status["claude"].Message)
}

type errRT struct{}

func (errRT) RoundTrip(r *http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: 401, Body: io.NopCloser(strings.NewReader(`{"error":"x"}`)), Header: http.Header{}}, nil
}
