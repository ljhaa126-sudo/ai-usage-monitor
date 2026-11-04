package main

import (
	"embed"
	"fmt"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend
var assets embed.FS

const windowTitle = "AI 用量监控"

func errorf(format string, a ...any) error { return fmt.Errorf(format, a...) }

func main() {
	app := NewApp()
	err := wails.Run(&options.App{
		Title:             windowTitle,
		Width:             424,
		Height:            600,
		MinWidth:          40,
		MinHeight:         80,
		Frameless:         true,
		DisableResize:     true,
		AlwaysOnTop:       app.cfg.AlwaysOnTop,
		BackgroundColour:  &options.RGBA{R: 0, G: 0, B: 0, A: 255},
		AssetServer:       &assetserver.Options{Assets: assets},
		OnStartup:         app.startup,
		Bind:              []interface{}{app},
		StartHidden:       true,
		HideWindowOnClose: false,
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "ai-usage-monitor-7c1e2f",
			OnSecondInstanceLaunch: func(_ options.SecondInstanceData) {
				if app.ctx != nil {
					runtime.WindowUnminimise(app.ctx)
					runtime.WindowShow(app.ctx)
				}
			},
		},
		Windows: &windows.Options{
			WebviewIsTransparent:              false,
			WindowIsTranslucent:               false,
			DisableFramelessWindowDecorations: true,
			BackdropType:                      windows.None,
			Theme:                             windows.Dark,
			ZoomFactor:                        1.0,
			IsZoomControlEnabled:              false,
			WebviewUserDataPath:               dataDir() + "\\webview",
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
