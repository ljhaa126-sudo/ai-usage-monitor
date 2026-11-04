package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	utls "github.com/refraction-networking/utls"
)

// 用 Chrome 的 TLS 指纹握手，绕过 Cloudflare 对非浏览器客户端的拦截（claude.ai 等）。
// 关键：即使走 HTTP 代理，也自己做 CONNECT，再在隧道里用 Chrome 指纹握手，
// 否则 Go 默认会用自身 TLS 指纹，仍会被拦。

func dialTarget(ctx context.Context, addr string) (net.Conn, error) {
	d := &net.Dialer{Timeout: 15 * time.Second}
	// 用 https 规则解析代理
	req := &http.Request{URL: &url.URL{Scheme: "https", Host: addr}}
	px, _ := proxyFor(req)
	if px == nil {
		return d.DialContext(ctx, "tcp", addr)
	}
	switch px.Scheme {
	case "http", "https":
		raw, err := d.DialContext(ctx, "tcp", px.Host)
		if err != nil {
			return nil, err
		}
		connect := "CONNECT " + addr + " HTTP/1.1\r\nHost: " + addr + "\r\n"
		if px.User != nil {
			pass, _ := px.User.Password()
			connect += "Proxy-Authorization: Basic " + basicAuth(px.User.Username(), pass) + "\r\n"
		}
		connect += "\r\n"
		if _, err := raw.Write([]byte(connect)); err != nil {
			raw.Close()
			return nil, err
		}
		br := bufio.NewReader(raw)
		resp, err := http.ReadResponse(br, &http.Request{Method: "CONNECT"})
		if err != nil {
			raw.Close()
			return nil, err
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			raw.Close()
			return nil, fmt.Errorf("代理 CONNECT 失败：%s", resp.Status)
		}
		return raw, nil
	default:
		// socks 等暂不特殊处理，直连
		return d.DialContext(ctx, "tcp", addr)
	}
}

func basicAuth(u, p string) string {
	return base64Std(u + ":" + p)
}

func newUTLSTransport() *http.Transport {
	base := http.DefaultTransport.(*http.Transport).Clone()
	base.Proxy = nil // 代理由 dialTarget 自己处理
	base.ForceAttemptHTTP2 = false
	base.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			host = addr
		}
		raw, err := dialTarget(ctx, addr)
		if err != nil {
			return nil, err
		}
		cfg := &utls.Config{ServerName: host}
		c := utls.UClient(raw, cfg, utls.HelloCustom)
		spec, err := chromeHTTP1Spec()
		if err != nil {
			raw.Close()
			return nil, err
		}
		if err := c.ApplyPreset(spec); err != nil {
			raw.Close()
			return nil, err
		}
		if err := c.HandshakeContext(ctx); err != nil {
			raw.Close()
			return nil, err
		}
		return c, nil
	}
	base.TLSClientConfig = &tls.Config{}
	return base
}

// chromeHTTP1Spec 返回 Chrome 的 ClientHello 指纹，但把 ALPN 改成仅 http/1.1，
// 这样服务器会用 HTTP/1.1 回应（net/http 能正确解析），同时 JA3 指纹仍是 Chrome。
func chromeHTTP1Spec() (*utls.ClientHelloSpec, error) {
	spec, err := utls.UTLSIdToSpec(utls.HelloChrome_133)
	if err != nil {
		return nil, err
	}
	for _, ext := range spec.Extensions {
		if a, ok := ext.(*utls.ALPNExtension); ok {
			a.AlpnProtocols = []string{"http/1.1"}
		}
	}
	return &spec, nil
}

var browserClientOnce sync.Once
var browserClient *http.Client

func browserHTTP() *http.Client {
	browserClientOnce.Do(func() {
		browserClient = &http.Client{Timeout: 25 * time.Second, Transport: newUTLSTransport()}
	})
	return browserClient
}
