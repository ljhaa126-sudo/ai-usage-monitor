package main

import (
	"bufio"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 本地日志 token 统计（Claude Code / Codex CLI），按文件 mtime+size 缓存

type fileStat struct {
	mod  int64
	size int64
	days map[string]float64 // 日期 -> tokens
	// codex 专用：文件里最后一次出现的 rate_limits
	lastRate   map[string]any
	lastRateTs int64
}

type logScanner struct {
	mu    sync.Mutex
	cache map[string]*fileStat
}

var claudeLogs = &logScanner{cache: map[string]*fileStat{}}
var codexLogs = &logScanner{cache: map[string]*fileStat{}}

func (s *logScanner) scan(roots []string, maxAge time.Duration, parse func(path string) *fileStat) map[string]*fileStat {
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := time.Now().Add(-maxAge)
	seen := map[string]bool{}
	for _, root := range roots {
		if !fileExists(root) {
			continue
		}
		_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".jsonl") {
				return nil
			}
			info, err := d.Info()
			if err != nil || info.ModTime().Before(cutoff) {
				return nil
			}
			seen[p] = true
			c := s.cache[p]
			if c != nil && c.mod == info.ModTime().UnixNano() && c.size == info.Size() {
				return nil
			}
			st := parse(p)
			if st != nil {
				st.mod = info.ModTime().UnixNano()
				st.size = info.Size()
				s.cache[p] = st
			}
			return nil
		})
	}
	for p := range s.cache {
		if !seen[p] {
			delete(s.cache, p)
		}
	}
	out := map[string]*fileStat{}
	for k, v := range s.cache {
		out[k] = v
	}
	return out
}

func sumDays(files map[string]*fileStat) map[string]float64 {
	m := map[string]float64{}
	for _, f := range files {
		for d, v := range f.days {
			m[d] += v
		}
	}
	return m
}

func last7(m map[string]float64, scale float64) []DayPoint {
	out := make([]DayPoint, 0, 7)
	for i := 6; i >= 0; i-- {
		d := time.Now().AddDate(0, 0, -i).Format("2006-01-02")
		out = append(out, DayPoint{Date: d, Value: m[d] / scale})
	}
	return out
}

func localDay(ts string) string {
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return ""
	}
	return t.Local().Format("2006-01-02")
}

func openLines(p string, fn func(line []byte)) {
	f, err := os.Open(p)
	if err != nil {
		return
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			fn(line)
		}
		if err != nil {
			return
		}
	}
}

// ---------- Claude Code: ~/.claude/projects/**/*.jsonl ----------

func claudeConfigDirs() []string {
	dirs := []string{}
	if env := os.Getenv("CLAUDE_CONFIG_DIR"); env != "" {
		for _, d := range strings.Split(env, string(os.PathListSeparator)) {
			if d != "" {
				dirs = append(dirs, d)
			}
		}
	}
	dirs = append(dirs, filepath.Join(homeDir(), ".claude"), filepath.Join(homeDir(), ".config", "claude"))
	return dirs
}

func parseClaudeLog(p string) *fileStat {
	st := &fileStat{days: map[string]float64{}}
	seen := map[string]bool{}
	openLines(p, func(line []byte) {
		if !strings.Contains(string(line), `"usage"`) {
			return
		}
		var e struct {
			Timestamp string `json:"timestamp"`
			RequestID string `json:"requestId"`
			Message   struct {
				ID    string `json:"id"`
				Usage struct {
					In     float64 `json:"input_tokens"`
					Out    float64 `json:"output_tokens"`
					CacheW float64 `json:"cache_creation_input_tokens"`
					CacheR float64 `json:"cache_read_input_tokens"`
				} `json:"usage"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &e) != nil || e.Timestamp == "" {
			return
		}
		key := e.Message.ID + ":" + e.RequestID
		if e.Message.ID != "" {
			if seen[key] {
				return
			}
			seen[key] = true
		}
		d := localDay(e.Timestamp)
		if d == "" {
			return
		}
		u := e.Message.Usage
		st.days[d] += u.In + u.Out + u.CacheW + u.CacheR
	})
	return st
}

func claudeLocalHistory() (series []DayPoint, daily map[string]float64) {
	roots := []string{}
	for _, d := range claudeConfigDirs() {
		roots = append(roots, filepath.Join(d, "projects"))
	}
	files := claudeLogs.scan(roots, 9*24*time.Hour, parseClaudeLog)
	daily = sumDays(files)
	return last7(daily, 1e6), daily
}

// ---------- Codex CLI: ~/.codex/sessions/**/*.jsonl ----------

func codexHome() string {
	if env := os.Getenv("CODEX_HOME"); env != "" {
		return env
	}
	return filepath.Join(homeDir(), ".codex")
}

func parseCodexLog(p string) *fileStat {
	st := &fileStat{days: map[string]float64{}}
	var prevTotal float64
	openLines(p, func(line []byte) {
		if !strings.Contains(string(line), `token_count`) {
			return
		}
		var e struct {
			Timestamp string `json:"timestamp"`
			Payload   struct {
				Type string `json:"type"`
				Info *struct {
					Total struct {
						Total float64 `json:"total_tokens"`
					} `json:"total_token_usage"`
					Last struct {
						Total float64 `json:"total_tokens"`
					} `json:"last_token_usage"`
				} `json:"info"`
				RateLimits map[string]any `json:"rate_limits"`
			} `json:"payload"`
		}
		if json.Unmarshal(line, &e) != nil || e.Payload.Type != "token_count" {
			return
		}
		if e.Payload.Info != nil {
			cur := e.Payload.Info.Total.Total
			delta := cur - prevTotal
			if prevTotal == 0 && cur > 0 && e.Payload.Info.Last.Total > 0 && cur > e.Payload.Info.Last.Total*50 {
				// 续接的旧会话：只计最后一次
				delta = e.Payload.Info.Last.Total
			}
			if delta > 0 {
				if d := localDay(e.Timestamp); d != "" {
					st.days[d] += delta
				}
			}
			if cur > 0 {
				prevTotal = cur
			}
		}
		if e.Payload.RateLimits != nil {
			if t, err := time.Parse(time.RFC3339Nano, e.Timestamp); err == nil {
				if t.UnixMilli() >= st.lastRateTs {
					st.lastRate = e.Payload.RateLimits
					st.lastRateTs = t.UnixMilli()
				}
			}
		}
	})
	return st
}

func codexLocal() (series []DayPoint, daily map[string]float64, rate map[string]any, rateTs int64) {
	roots := []string{filepath.Join(codexHome(), "sessions"), filepath.Join(codexHome(), "archived_sessions")}
	files := codexLogs.scan(roots, 9*24*time.Hour, parseCodexLog)
	daily = sumDays(files)
	for _, f := range files {
		if f.lastRate != nil && f.lastRateTs > rateTs {
			rate, rateTs = f.lastRate, f.lastRateTs
		}
	}
	return last7(daily, 1e6), daily, rate, rateTs
}
