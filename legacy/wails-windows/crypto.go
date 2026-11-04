package main

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"errors"
	"strings"
)

// Chromium/Electron safeStorage（Windows）：v10 + 12 字节 nonce + 密文 + tag
func aesGCMDecryptV10(key, raw []byte) (string, error) {
	if len(raw) < 3+12+16 || string(raw[:3]) != "v10" {
		return "", errors.New("unsupported format")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	pt, err := gcm.Open(nil, raw[3:15], raw[15:], nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

func chromiumMasterKey(localStatePath string) ([]byte, error) {
	var ls struct {
		OSCrypt struct {
			EncryptedKey string `json:"encrypted_key"`
		} `json:"os_crypt"`
	}
	if err := readJSONFile(localStatePath, &ls); err != nil {
		return nil, err
	}
	enc, err := base64.StdEncoding.DecodeString(ls.OSCrypt.EncryptedKey)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(string(enc), "DPAPI") {
		return nil, errors.New("unknown key format")
	}
	return dpapiDecrypt(enc[5:])
}
