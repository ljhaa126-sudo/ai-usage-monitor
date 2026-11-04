package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

type ProviderConfig struct {
	Enabled bool   `json:"enabled"`
	APIKey  string `json:"apiKey,omitempty"` // API Key / Token / Cookie
	Region  string `json:"region,omitempty"` // glm: cn | global
}

type Config struct {
	Providers      map[string]ProviderConfig `json:"providers"`
	Order          []string                  `json:"order"`
	RefreshMinutes int                       `json:"refreshMinutes"`
	AlwaysOnTop    bool                      `json:"alwaysOnTop"`
	AutoStart      bool                      `json:"autoStart"`
	HideIdle       bool                      `json:"hideIdle"` // 隐藏未登录 / 未配置的 AI
	Proxy          string                    `json:"proxy"`    // 手动代理，空 = 跟随系统
	SchemaV        int                       `json:"schemaV"`  // 配置结构版本（用于迁移默认值）
	PosX           int                       `json:"posX"`
	PosY           int                       `json:"posY"`
	HasPos         bool                      `json:"hasPos"`
}

func dataDir() string {
	d := filepath.Join(appDataDir(), "AIUsageMonitor")
	_ = os.MkdirAll(d, 0o755)
	return d
}

func defaultConfig() *Config {
	c := &Config{
		Providers:      map[string]ProviderConfig{},
		RefreshMinutes: 5,
		AlwaysOnTop:    true,
		HideIdle:       true,
		SchemaV:        curSchemaV,
	}
	for _, p := range providerDefs {
		c.Providers[p.ID] = ProviderConfig{Enabled: true, Region: "cn"}
		c.Order = append(c.Order, p.ID)
	}
	return c
}

const curSchemaV = 2

var cfgMu sync.Mutex

func loadConfig() *Config {
	c := defaultConfig()
	var disk Config
	if err := readJSONFile(filepath.Join(dataDir(), "config.json"), &disk); err == nil {
		if disk.RefreshMinutes > 0 {
			c.RefreshMinutes = disk.RefreshMinutes
		}
		c.AlwaysOnTop = disk.AlwaysOnTop
		c.AutoStart = disk.AutoStart
		c.Proxy = disk.Proxy
		c.SchemaV = disk.SchemaV
		// 迁移：v2 起默认自动隐藏未连接的 AI；旧配置只在升级时套用一次新默认值
		if disk.SchemaV >= 2 {
			c.HideIdle = disk.HideIdle
		} else {
			c.HideIdle = true
			c.SchemaV = curSchemaV
		}
		c.PosX, c.PosY, c.HasPos = disk.PosX, disk.PosY, disk.HasPos
		for id, pc := range disk.Providers {
			if _, ok := c.Providers[id]; ok {
				if pc.Region == "" {
					pc.Region = "cn"
				}
				c.Providers[id] = pc
			}
		}
		if len(disk.Order) > 0 {
			seen := map[string]bool{}
			order := []string{}
			for _, id := range disk.Order {
				if _, ok := c.Providers[id]; ok && !seen[id] {
					order = append(order, id)
					seen[id] = true
				}
			}
			for _, id := range c.Order {
				if !seen[id] {
					order = append(order, id)
				}
			}
			c.Order = order
		}
	}
	return c
}

func saveConfig(c *Config) {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	data, _ := json.MarshalIndent(c, "", "  ")
	tmp := filepath.Join(dataDir(), "config.json.tmp")
	if os.WriteFile(tmp, data, 0o600) == nil {
		_ = os.Rename(tmp, filepath.Join(dataDir(), "config.json"))
	}
}

// ---------- 历史记录（本地） ----------

type dayRecord struct {
	PeakHeadline float64 `json:"peak"`
	Samples      int     `json:"n"`
}

type historyFile struct {
	Days   map[string]map[string]*dayRecord `json:"days"`   // provider -> date -> record
	Resets map[string][]int64               `json:"resets"` // provider -> 观察到的 5h 窗口重置时间点（毫秒）
}

type historyStore struct {
	mu   sync.Mutex
	data historyFile
}

func newHistoryStore() *historyStore {
	h := &historyStore{data: historyFile{Days: map[string]map[string]*dayRecord{}, Resets: map[string][]int64{}}}
	_ = readJSONFile(filepath.Join(dataDir(), "history.json"), &h.data)
	if h.data.Days == nil {
		h.data.Days = map[string]map[string]*dayRecord{}
	}
	if h.data.Resets == nil {
		h.data.Resets = map[string][]int64{}
	}
	return h
}

func (h *historyStore) save() {
	data, _ := json.Marshal(h.data)
	tmp := filepath.Join(dataDir(), "history.json.tmp")
	if os.WriteFile(tmp, data, 0o600) == nil {
		_ = os.Rename(tmp, filepath.Join(dataDir(), "history.json"))
	}
}

// record 记录一次成功采样，并返回：本周期 5h 窗口已重置次数
func (h *historyStore) record(st *ProviderStatus) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	day := now.Format("2006-01-02")
	pd := h.data.Days[st.ID]
	if pd == nil {
		pd = map[string]*dayRecord{}
		h.data.Days[st.ID] = pd
	}
	r := pd[day]
	if r == nil {
		r = &dayRecord{}
		pd[day] = r
	}
	if st.Headline > r.PeakHeadline {
		r.PeakHeadline = st.Headline
	}
	r.Samples++
	// 清理 40 天前
	cut := now.AddDate(0, 0, -40).Format("2006-01-02")
	for d := range pd {
		if d < cut {
			delete(pd, d)
		}
	}

	count := 0
	if st.Primary != nil && st.Primary.ResetsAt > 0 {
		// 以 10 分钟粒度去重
		key := (st.Primary.ResetsAt / 600000) * 600000
		list := h.data.Resets[st.ID]
		found := false
		for _, v := range list {
			if v == key {
				found = true
				break
			}
		}
		if !found {
			list = append(list, key)
		}
		sort.Slice(list, func(i, j int) bool { return list[i] < list[j] })
		if len(list) > 200 {
			list = list[len(list)-200:]
		}
		h.data.Resets[st.ID] = list

		// 周期起点：长窗口 resetsAt - 窗口长度；未知则按 7 天
		start := now.Add(-7 * 24 * time.Hour).UnixMilli()
		if st.Secondary != nil && st.Secondary.ResetsAt > 0 {
			wm := st.Secondary.WindowMinutes
			if wm <= 0 {
				wm = 7 * 24 * 60
			}
			start = st.Secondary.ResetsAt - int64(wm)*60000
		}
		nowMs := now.UnixMilli()
		for _, v := range list {
			if v > start && v <= nowMs {
				count++
			}
		}
	}
	h.save()
	return count
}

// peakSeries 返回近 7 天每日峰值（百分比）
func (h *historyStore) peakSeries(id string) []DayPoint {
	h.mu.Lock()
	defer h.mu.Unlock()
	pd := h.data.Days[id]
	out := make([]DayPoint, 0, 7)
	for i := 6; i >= 0; i-- {
		d := time.Now().AddDate(0, 0, -i).Format("2006-01-02")
		v := 0.0
		if pd != nil && pd[d] != nil {
			v = pd[d].PeakHeadline
		}
		out = append(out, DayPoint{Date: d, Value: v})
	}
	return out
}

// activeDays 本周（周一开始）每天是否有使用
func activeDaysFromSeries(series map[string]float64) []bool {
	now := time.Now()
	wd := int(now.Weekday())
	if wd == 0 {
		wd = 7
	}
	monday := now.AddDate(0, 0, -(wd - 1))
	out := make([]bool, 7)
	for i := 0; i < 7; i++ {
		d := monday.AddDate(0, 0, i).Format("2006-01-02")
		out[i] = series[d] > 0
	}
	return out
}

func (h *historyStore) peakMap(id string) map[string]float64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := map[string]float64{}
	for d, r := range h.data.Days[id] {
		m[d] = r.PeakHeadline
	}
	return m
}
