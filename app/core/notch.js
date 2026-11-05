"use strict";
// macOS 刘海屏：向系统读取每块屏幕的刘海位置（NSScreen.auxiliaryTopLeftArea / auxiliaryTopRightArea，macOS 12+）。
// 用系统自带的 osascript（JavaScript for Automation）读取，不需要任何授权。
const { execFile } = require("child_process");

const JXA = `ObjC.import("AppKit");
var a = $.NSScreen.screens, out = [];
for (var i = 0; i < a.count; i++) {
  var s = a.objectAtIndex(i), f = s.frame, r = { x: f.origin.x, w: f.size.width, h: f.size.height };
  try {
    var L = s.auxiliaryTopLeftArea, R = s.auxiliaryTopRightArea;
    if (L.size.width > 0 && R.size.width > 0) { r.left = L.size.width; r.right = R.size.width; r.top = s.safeAreaInsets.top || L.size.height; }
  } catch (e) {}
  out.push(r);
}
JSON.stringify(out);`;

function readScreens() {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") return resolve([]);
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", JXA], { timeout: 5000 }, (err, out) => {
      if (err) return resolve([]);
      try { resolve(JSON.parse(String(out).trim())); } catch { resolve([]); }
    });
  });
}

// 把系统给的屏幕信息对到 Electron 的显示器（同一坐标原点的 x、宽、高相同）
// 返回 { x0, x1, h }：刘海相对这块屏幕左边的起止位置和高度（单位：点，与 CSS 像素一致）；没有刘海返回 null
function notchFor(display, screens) {
  const b = display.bounds;
  const s = screens.find((x) => Math.round(x.x) === Math.round(b.x) && Math.round(x.w) === Math.round(b.width) && Math.round(x.h) === Math.round(b.height));
  if (!s || !s.left || !s.right) return null;
  const x0 = s.left, x1 = s.w - s.right;
  if (x1 - x0 < 60 || x1 - x0 > 400) return null; // 不像刘海就不当刘海
  return { x0, x1, h: s.top || 32 };
}

module.exports = { readScreens, notchFor };
