package main

import "testing"

func TestParseProxy(t *testing.T) {
	cases := map[string]string{
		"127.0.0.1:7890": "http://127.0.0.1:7890",
		"http=127.0.0.1:7890;https=127.0.0.1:7891": "http://127.0.0.1:7891",
		"socks=127.0.0.1:7891":                     "socks5://127.0.0.1:7891",
		"socks5://127.0.0.1:1080":                  "socks5://127.0.0.1:1080",
	}
	for in, want := range cases {
		u := parseProxy(in, "https")
		if u == nil || u.String() != want {
			t.Errorf("%s -> %v, want %s", in, u, want)
		}
	}
}
