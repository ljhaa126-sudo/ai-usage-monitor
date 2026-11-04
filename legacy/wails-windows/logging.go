package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var logMu sync.Mutex

// logf 写入 %APPDATA%\AIUsageMonitor\log.txt（超过 512KB 自动清空），方便排查问题
func logf(format string, a ...any) {
	logMu.Lock()
	defer logMu.Unlock()
	p := filepath.Join(dataDir(), "log.txt")
	if fi, err := os.Stat(p); err == nil && fi.Size() > 512*1024 {
		_ = os.Remove(p)
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s  %s\n", time.Now().Format("01-02 15:04:05"), fmt.Sprintf(format, a...))
}
