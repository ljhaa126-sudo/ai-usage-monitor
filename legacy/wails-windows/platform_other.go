//go:build !windows

package main

import "errors"

func dpapiDecrypt(data []byte) ([]byte, error) { return nil, errors.New("DPAPI only on Windows") }

func setAutoStart(on bool) error { return nil }

func nativeGetPos() (int, int, bool)            { return 0, 0, false }
func nativeSetPos(x, y int) bool                { return false }
func nativeWorkArea() (l, t, r, b int, ok bool) { return }
func nativePointOnScreen(x, y int) bool         { return true }
func nativeScale() float64                      { return 1 }

func nativeSetGeom(x, y, w, h int) bool { return false }

func systemProxy() string { return "" }

func protectData(data []byte) ([]byte, error)   { return data, nil }
func unprotectData(data []byte) ([]byte, error) { return data, nil }

func nativeSetRegionRect(x, y, w, h, radius int) {}
func nativeInvalidateRgn()                       {}
