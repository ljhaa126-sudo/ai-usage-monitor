package main

import (
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

var proxyState struct {
	sync.Mutex
	manual  string
	sys     string
	sysRead time.Time
}

func setManualProxy(p string) {
	proxyState.Lock()
	proxyState.manual = strings.TrimSpace(p)
	proxyState.Unlock()
}

func parseProxy(s, scheme string) *url.URL {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	// 形如 "http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7891"
	if strings.Contains(s, "=") {
		parts := map[string]string{}
		for _, seg := range strings.Split(s, ";") {
			kv := strings.SplitN(seg, "=", 2)
			if len(kv) == 2 {
				parts[strings.ToLower(strings.TrimSpace(kv[0]))] = strings.TrimSpace(kv[1])
			}
		}
		if v := parts[scheme]; v != "" {
			s = v
		} else if v := parts["https"]; v != "" {
			s = v
		} else if v := parts["http"]; v != "" {
			s = v
		} else if v := parts["socks"]; v != "" {
			s = "socks5://" + v
		} else {
			return nil
		}
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return nil
	}
	return u
}

// proxyFor：手动代理 > 环境变量 > Windows 系统代理
func proxyFor(req *http.Request) (*url.URL, error) {
	proxyState.Lock()
	manual := proxyState.manual
	if time.Since(proxyState.sysRead) > 30*time.Second {
		proxyState.sys = systemProxy()
		proxyState.sysRead = time.Now()
	}
	sys := proxyState.sys
	proxyState.Unlock()
	if manual != "" {
		if strings.EqualFold(manual, "direct") || manual == "直连" {
			return nil, nil
		}
		return parseProxy(manual, req.URL.Scheme), nil
	}
	if u, err := http.ProxyFromEnvironment(req); err == nil && u != nil {
		return u, nil
	}
	return parseProxy(sys, req.URL.Scheme), nil
}

func init() {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = proxyFor
	tr.ForceAttemptHTTP2 = true
	httpClient.Transport = tr
}
