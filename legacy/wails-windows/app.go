package main

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const AppVersion = "1.5.0"

type App struct {
	ctx      context.Context
	mu       sync.Mutex
	cfg      *Config
	status   map[string]*ProviderStatus
	hist     *historyStore
	kick     chan struct{}
	inflight map[string]bool

	// 窗口布局
	layoutMu   sync.Mutex
	expanded   bool
	side       string
	barW       int
	panelW     int
	winH       int
	anchorX    int
	anchorY    int
	winX       int
	winY       int
	lastLayout time.Time
	lastSaveX  int
	lastSaveY  int
}

func NewApp() *App {
	a := &App{
		cfg:      loadConfig(),
		status:   map[string]*ProviderStatus{},
		hist:     newHistoryStore(),
		kick:     make(chan struct{}, 1),
		inflight: map[string]bool{},
		side:     "right",
		barW:     64,
		panelW:   360,
		winH:     600,
	}
	setManualProxy(a.cfg.Proxy)
	for _, d := range providerDefs {
		st := newStatus(d)
		st.State = "loading"
		st.Enabled = a.cfg.Providers[d.ID].Enabled
		if !st.Enabled {
			st.State = "disabled"
		}
		st.History = a.hist.peakSeries(d.ID)
		a.status[d.ID] = st
	}
	return a
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	logf("==== 启动 v%s", AppVersion)
	go func() {
		a.placeInitial()
		runtime.WindowShow(ctx)
		runtime.WindowSetAlwaysOnTop(ctx, a.cfg.AlwaysOnTop)
		go a.trackPosition()
	}()
	go a.loop()
}

func (a *App) loop() {
	a.refreshAll()
	for {
		mins := a.cfg.RefreshMinutes
		if mins <= 0 {
			mins = 5
		}
		select {
		case <-time.After(time.Duration(mins) * time.Minute):
		case <-a.kick:
		}
		a.refreshAll()
	}
}

func (a *App) refreshAll() {
	var wg sync.WaitGroup
	for _, d := range providerDefs {
		d := d
		wg.Add(1)
		go func() {
			defer wg.Done()
			a.refreshOne(d)
		}()
	}
	wg.Wait()
}

func (a *App) refreshOne(d providerDef) {
	a.mu.Lock()
	pc := a.cfg.Providers[d.ID]
	if a.inflight[d.ID] {
		a.mu.Unlock()
		return
	}
	prev := a.status[d.ID]
	if !pc.Enabled {
		st := newStatus(d)
		st.Enabled = false
		st.State = "disabled"
		a.status[d.ID] = st
		a.mu.Unlock()
		a.emit()
		return
	}
	a.inflight[d.ID] = true
	if prev != nil {
		cp := *prev
		cp.State = "loading"
		if prev.State != "loading" && prev.UpdatedAt > 0 {
			cp.State = prev.State
		}
		a.status[d.ID] = &cp
	}
	a.mu.Unlock()

	var st *ProviderStatus
	var err error
	func() {
		defer func() {
			if r := recover(); r != nil {
				err = errorf("内部错误：%v", r)
			}
		}()
		st, err = d.Fetch(pc)
	}()
	if st == nil {
		st = &ProviderStatus{}
	}
	base := newStatus(d)
	// 合并默认字段
	if st.DashboardURL == "" {
		st.DashboardURL = base.DashboardURL
	}
	st.ID, st.Name, st.Tagline, st.Color, st.NeedsKey = base.ID, base.Name, base.Tagline, base.Color, base.NeedsKey
	st.Enabled = true
	st.UpdatedAt = time.Now().UnixMilli()

	switch e := err.(type) {
	case nil:
		st.State = "ok"
	case *noLoginErr:
		st.State = "nologin"
		st.Message = e.msg
	default:
		st.State = "error"
		st.Message = "更新失败：" + err.Error()
		if prev != nil && (prev.Primary != nil || prev.Secondary != nil) {
			st.Primary, st.Secondary, st.Extra = prev.Primary, prev.Secondary, prev.Extra
			st.Plan, st.Account, st.Credits, st.PlanEndsAt, st.ResetCount = prev.Plan, prev.Account, prev.Credits, prev.PlanEndsAt, prev.ResetCount
			st.Source = prev.Source
			st.UpdatedAt = prev.UpdatedAt
			st.State = "stale"
		}
	}

	// 竖条显示的主百分比
	switch {
	case st.Primary != nil:
		st.Headline, st.HeadlineKey = st.Primary.UsedPercent, st.Primary.Label
	case st.Secondary != nil:
		st.Headline, st.HeadlineKey = st.Secondary.UsedPercent, st.Secondary.Label
	case len(st.Extra) > 0:
		st.Headline, st.HeadlineKey = st.Extra[0].UsedPercent, st.Extra[0].Label
	}
	if st.State == "ok" && (st.Primary != nil || st.Secondary != nil) {
		st.ResetCount = a.hist.record(st)
	}
	if st.HistoryUnit != "M tokens" {
		st.HistoryUnit = "峰值 %"
		st.History = a.hist.peakSeries(d.ID)
		st.ActiveDays = activeDaysFromSeries(a.hist.peakMap(d.ID))
	}

	if st.State != "ok" {
		logf("[%s] %s: %s", d.ID, st.State, st.Message)
	}
	a.mu.Lock()
	a.status[d.ID] = st
	delete(a.inflight, d.ID)
	a.mu.Unlock()
	a.emit()
}

func (a *App) emit() {
	if a.ctx != nil {
		runtime.EventsEmit(a.ctx, "status", a.GetAll())
	}
}

// ---------------- 前端可调用 ----------------

func (a *App) GetAll() []ProviderStatus {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := []ProviderStatus{}
	for _, id := range a.cfg.Order {
		if st, ok := a.status[id]; ok {
			out = append(out, *st)
		}
	}
	return out
}

func (a *App) Refresh(id string) {
	if id == "" {
		select {
		case a.kick <- struct{}{}:
		default:
		}
		return
	}
	for _, d := range providerDefs {
		if d.ID == id {
			go a.refreshOne(d)
		}
	}
}

func (a *App) GetConfig() Config {
	a.mu.Lock()
	defer a.mu.Unlock()
	c := *a.cfg
	c.Providers = map[string]ProviderConfig{}
	for k, v := range a.cfg.Providers {
		c.Providers[k] = v
	}
	return c
}

func (a *App) SaveConfig(c Config) string {
	a.mu.Lock()
	if c.RefreshMinutes < 1 {
		c.RefreshMinutes = 1
	}
	a.cfg.RefreshMinutes = c.RefreshMinutes
	a.cfg.AlwaysOnTop = c.AlwaysOnTop
	a.cfg.HideIdle = c.HideIdle
	a.cfg.Proxy = strings.TrimSpace(c.Proxy)
	setManualProxy(a.cfg.Proxy)
	autoChanged := a.cfg.AutoStart != c.AutoStart
	a.cfg.AutoStart = c.AutoStart
	for id, pc := range c.Providers {
		if _, ok := a.cfg.Providers[id]; ok {
			a.cfg.Providers[id] = pc
		}
	}
	if len(c.Order) == len(a.cfg.Order) {
		a.cfg.Order = c.Order
	}
	cfg := *a.cfg
	a.mu.Unlock()

	saveConfig(&cfg)
	msg := "已保存"
	if a.ctx != nil {
		runtime.WindowSetAlwaysOnTop(a.ctx, cfg.AlwaysOnTop)
	}
	if autoChanged {
		if err := setAutoStart(cfg.AutoStart); err != nil {
			msg = "已保存，但开机自启设置失败：" + err.Error()
		}
	}
	a.Refresh("")
	return msg
}

func (a *App) OpenURL(u string) {
	if a.ctx != nil && u != "" {
		runtime.BrowserOpenURL(a.ctx, u)
	}
}

func (a *App) Quit() {
	a.savePos()
	if a.ctx != nil {
		runtime.Quit(a.ctx)
	}
}

func (a *App) Minimize() {
	if a.ctx != nil {
		runtime.WindowMinimise(a.ctx)
	}
}

func (a *App) Version() string { return AppVersion }

// ---------------- 窗口布局 ----------------
// 坐标统一使用物理像素（绝对屏幕坐标）；尺寸交给 Wails（逻辑像素，会按 DPI 缩放）

func (a *App) getPos() (int, int) {
	if x, y, ok := nativeGetPos(); ok {
		return x, y
	}
	return runtime.WindowGetPosition(a.ctx)
}

func (a *App) setPos(x, y int) {
	if !nativeSetPos(x, y) {
		runtime.WindowSetPosition(a.ctx, x, y)
	}
}

func (a *App) workArea() (l, t, r, b int) {
	if l, t, r, b, ok := nativeWorkArea(); ok {
		return l, t, r, b
	}
	if a.ctx != nil {
		if screens, err := runtime.ScreenGetAll(a.ctx); err == nil {
			for _, s := range screens {
				if s.IsCurrent || s.IsPrimary {
					return 0, 0, s.Size.Width, s.Size.Height
				}
			}
		}
	}
	return 0, 0, 1920, 1080
}

func (a *App) placeInitial() {
	// 等待原生窗口创建完成
	for i := 0; i < 50; i++ {
		if _, _, ok := nativeGetPos(); ok {
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	a.layoutMu.Lock()
	defer a.layoutMu.Unlock()
	if a.cfg.HasPos && nativePointOnScreen(a.cfg.PosX+10, a.cfg.PosY+10) {
		a.anchorX, a.anchorY = a.cfg.PosX, a.cfg.PosY
	} else {
		l, t, r, _ := a.workArea()
		sc := nativeScale()
		a.anchorX = r - int(float64(a.barW)*sc) - int(24*sc)
		a.anchorY = t + int(110*sc)
		_ = l
	}
	a.winX, a.winY = a.anchorX, a.anchorY
	a.setPos(a.anchorX, a.anchorY)
	sc := nativeScale()
	nativeSetRegionRect(0, 0, int(float64(a.barW)*sc+0.5), int(220*sc), int(18*sc)) // 临时竖条形状，前端随后修正
	a.lastSaveX, a.lastSaveY = a.anchorX, a.anchorY
}

// SetLayout 前端请求改变窗口尺寸（CSS 像素）；返回详情面板在哪一侧（left / right）
// 展开时窗口是一整张卡片：侧边栏 + 详情，没有任何透明区域。
// SetLayout 窗口尺寸恒为 barW+panelW × winH（展开时能正常工作的尺寸），从不缩放；
// 收起/展开只改「可见区域」(窗口裁剪 region)：收起只显示竖条，其余透明且点击穿透。
func (a *App) SetLayout(expanded bool, barW, panelW, barH, winH int) string {
	a.layoutMu.Lock()
	defer a.layoutMu.Unlock()
	if a.ctx == nil {
		return "right"
	}
	a.syncAnchorLocked()
	a.lastLayout = time.Now()
	a.barW, a.panelW, a.winH = barW, panelW, winH
	sc := nativeScale()
	px := func(v int) int { return int(float64(v)*sc + 0.5) }
	radius := px(18)
	W, H := barW+panelW, winH
	Wp, Hp := px(W), px(H)
	l, t, r, b := a.workArea()

	side := "right"
	if a.anchorX+Wp > r {
		side = "left"
	}
	winX := a.anchorX
	if side == "left" {
		winX = a.anchorX - px(panelW)
	}
	if winX < l {
		winX = l
	}
	if winX+Wp > r {
		winX = r - Wp
	}
	winY := a.anchorY
	if expanded && winY+Hp > b {
		winY = b - Hp
	}
	if winY < t {
		winY = t
	}
	a.side = side
	a.expanded = expanded
	a.winX, a.winY = winX, winY

	// 窗口整体固定在 W×H，位置为 winX,winY
	a.setPos(winX, winY)
	runtime.WindowSetSize(a.ctx, W, H)

	if expanded {
		nativeSetRegionRect(0, 0, Wp, Hp, radius)
	} else {
		barX := 0
		if side == "left" {
			barX = px(panelW)
		}
		nativeSetRegionRect(barX, 0, px(barW), px(barH), radius)
	}
	logf("layout expanded=%v side=%s win=%d,%d size=%dx%d barH=%d sc=%.2f work=%d,%d,%d,%d anchor=%d,%d",
		expanded, side, winX, winY, W, H, barH, sc, l, t, r, b, a.anchorX, a.anchorY)
	return side
}

// 根据当前窗口位置更新竖条锚点（用户可能拖动过窗口）
func (a *App) syncAnchorLocked() {
	if time.Since(a.lastLayout) < 800*time.Millisecond {
		return // 上一次布局可能还没应用完
	}
	x, y := a.getPos()
	if x == a.winX && y == a.winY {
		return // 未被拖动
	}
	// 窗口被拖动：竖条锚点随之更新
	sc := nativeScale()
	if a.side == "left" {
		a.anchorX = x + int(float64(a.panelW)*sc+0.5)
	} else {
		a.anchorX = x
	}
	a.anchorY = y
	a.winX, a.winY = x, y
}

func (a *App) trackPosition() {
	for {
		time.Sleep(3 * time.Second)
		a.layoutMu.Lock()
		if a.ctx != nil {
			a.syncAnchorLocked()
		}
		a.layoutMu.Unlock()
		a.savePos()
	}
}

func (a *App) savePos() {
	a.layoutMu.Lock()
	x, y := a.anchorX, a.anchorY
	a.layoutMu.Unlock()
	if x == a.lastSaveX && y == a.lastSaveY && a.cfg.HasPos {
		return
	}
	a.lastSaveX, a.lastSaveY = x, y
	a.mu.Lock()
	a.cfg.PosX, a.cfg.PosY, a.cfg.HasPos = x, y, true
	cfg := *a.cfg
	a.mu.Unlock()
	saveConfig(&cfg)
}
