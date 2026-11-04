package main

import (
	"io"
	"testing"
)

func TestUTLSHandshake(t *testing.T) {
	resp, err := browserHTTP().Get("https://api.github.com/zen")
	if err != nil {
		t.Fatalf("utls request failed: %v", err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
	t.Logf("status=%d body=%q", resp.StatusCode, string(b))
	if resp.StatusCode == 0 {
		t.Fatalf("status %d", resp.StatusCode)
	}
}
