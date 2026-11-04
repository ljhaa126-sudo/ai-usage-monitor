//go:build windows

package main

import (
	"errors"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func dpapiDecrypt(data []byte) ([]byte, error) {
	in := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(&in, nil, nil, 0, nil, 0, &out); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	res := make([]byte, out.Size)
	copy(res, unsafe.Slice(out.Data, out.Size))
	return res, nil
}

func protectData(data []byte) ([]byte, error) {
	in := windows.DataBlob{Size: uint32(len(data)), Data: &data[0]}
	var out windows.DataBlob
	if err := windows.CryptProtectData(&in, nil, nil, 0, nil, 0, &out); err != nil {
		return nil, err
	}
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	res := make([]byte, out.Size)
	copy(res, unsafe.Slice(out.Data, out.Size))
	return res, nil
}

func unprotectData(data []byte) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("empty")
	}
	return dpapiDecrypt(data)
}

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`
const runName = "AIUsageMonitor"

func setAutoStart(on bool) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if on {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		return k.SetStringValue(runName, `"`+exe+`"`)
	}
	err = k.DeleteValue(runName)
	if err == registry.ErrNotExist {
		return nil
	}
	return err
}

// ---------- 原生窗口定位（物理像素，绝对屏幕坐标） ----------

var (
	user32                = windows.NewLazySystemDLL("user32.dll")
	procFindWindowW       = user32.NewProc("FindWindowW")
	procGetWindowRect     = user32.NewProc("GetWindowRect")
	procSetWindowPos      = user32.NewProc("SetWindowPos")
	procMonitorFromWindow = user32.NewProc("MonitorFromWindow")
	procMonitorFromPoint  = user32.NewProc("MonitorFromPoint")
	procGetMonitorInfoW   = user32.NewProc("GetMonitorInfoW")
	procGetDpiForWindow   = user32.NewProc("GetDpiForWindow")
	cachedHwnd            uintptr
)

type rect32 struct{ L, T, R, B int32 }
type monitorInfo struct {
	Size    uint32
	Monitor rect32
	Work    rect32
	Flags   uint32
}

func hwnd() uintptr {
	if cachedHwnd != 0 {
		return cachedHwnd
	}
	t, _ := windows.UTF16PtrFromString(windowTitle)
	h, _, _ := procFindWindowW.Call(0, uintptr(unsafe.Pointer(t)))
	if h != 0 {
		var pid uint32
		windows.GetWindowThreadProcessId(windows.HWND(h), &pid)
		if pid == uint32(os.Getpid()) {
			cachedHwnd = h
		}
	}
	return cachedHwnd
}

func nativeGetPos() (int, int, bool) {
	h := hwnd()
	if h == 0 {
		return 0, 0, false
	}
	var r rect32
	ok, _, _ := procGetWindowRect.Call(h, uintptr(unsafe.Pointer(&r)))
	return int(r.L), int(r.T), ok != 0
}

func nativeSetPos(x, y int) bool {
	h := hwnd()
	if h == 0 {
		return false
	}
	const SWP_NOSIZE, SWP_NOZORDER, SWP_NOACTIVATE = 0x1, 0x4, 0x10
	ok, _, _ := procSetWindowPos.Call(h, 0, uintptr(int32(x)), uintptr(int32(y)), 0, 0, SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE)
	return ok != 0
}

func nativeWorkArea() (l, t, r, b int, ok bool) {
	h := hwnd()
	if h == 0 {
		return
	}
	mon, _, _ := procMonitorFromWindow.Call(h, 2) // MONITOR_DEFAULTTONEAREST
	mi := monitorInfo{Size: uint32(unsafe.Sizeof(monitorInfo{}))}
	res, _, _ := procGetMonitorInfoW.Call(mon, uintptr(unsafe.Pointer(&mi)))
	if res == 0 {
		return
	}
	return int(mi.Work.L), int(mi.Work.T), int(mi.Work.R), int(mi.Work.B), true
}

func nativePointOnScreen(x, y int) bool {
	pt := uintptr(uint32(int32(x))) | uintptr(uint32(int32(y)))<<32
	mon, _, _ := procMonitorFromPoint.Call(pt, 0) // MONITOR_DEFAULTTONULL
	return mon != 0
}

func nativeScale() float64 {
	h := hwnd()
	if h == 0 || procGetDpiForWindow.Find() != nil {
		return 1
	}
	dpi, _, _ := procGetDpiForWindow.Call(h)
	if dpi == 0 {
		return 1
	}
	return float64(dpi) / 96.0
}

// systemProxy 读取 Windows「设置 → 网络 → 代理」里的手动代理（Clash / v2rayN 等会写这里）
func systemProxy() string {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Internet Settings`, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	en, _, err := k.GetIntegerValue("ProxyEnable")
	if err != nil || en == 0 {
		return ""
	}
	s, _, err := k.GetStringValue("ProxyServer")
	if err != nil {
		return ""
	}
	return s
}

// ---------- 圆角：按窗口当前实际大小设置一个圆角矩形区域 ----------
// 不改窗口过程、不碰尺寸（尺寸交给 Wails），只把四个角裁圆。角外变透明，不会是黑色。

var (
	gdi32                  = windows.NewLazySystemDLL("gdi32.dll")
	procCreateRoundRectRgn = gdi32.NewProc("CreateRoundRectRgn")
	procSetWindowRgn       = user32.NewProc("SetWindowRgn")
)

var lastRgnKey [5]int32

// nativeSetRegionRect 把窗口裁成一个指定位置的圆角矩形（物理像素，相对窗口左上角）。
// 矩形之外的区域变成透明且点击穿透——既不会是黑色，也不挡住下面的东西。
func nativeSetRegionRect(x, y, w, h, radius int) {
	hw := hwnd()
	if hw == 0 || w <= 0 || h <= 0 {
		return
	}
	key := [5]int32{int32(x), int32(y), int32(w), int32(h), int32(radius)}
	if key == lastRgnKey {
		return
	}
	lastRgnKey = key
	rgn, _, _ := procCreateRoundRectRgn.Call(uintptr(int32(x)), uintptr(int32(y)), uintptr(int32(x+w+1)), uintptr(int32(y+h+1)), uintptr(radius*2), uintptr(radius*2))
	if rgn == 0 {
		return
	}
	procSetWindowRgn.Call(hw, rgn, 1) // 系统接管 rgn 并重绘
}

func nativeInvalidateRgn() { lastRgnKey = [5]int32{} }
