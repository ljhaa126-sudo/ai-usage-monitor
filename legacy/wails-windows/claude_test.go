package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"testing"
)

func TestScanSessionKey(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, 12)
	rand.Read(nonce)
	h := sha256.Sum256([]byte(".claude.ai"))
	pt := append(h[:], []byte("sk-ant-sid01-AbC_def-123")...)
	enc := append(append([]byte("v10"), nonce...), gcm.Seal(nil, nonce, pt, nil)...)
	data := []byte("junk\x00\x01.claude.ai\x00sessionKey")
	data = append(data, enc...)
	data = append(data, []byte("/\x00\x01\x02more junk sessionKeyLC 1234")...)
	if got := scanSessionKey(data, key); got != "sk-ant-sid01-AbC_def-123" {
		t.Fatalf("got %q", got)
	}
}
