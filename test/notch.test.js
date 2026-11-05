"use strict";
const assert = require("assert");
const path = require("path");
const APP = process.argv[2] || path.join(__dirname, "..", "app");
const { notchFor } = require(path.join(APP, "core/notch.js"));
let pass = 0; const ok = (n) => { pass++; console.log("  ✓ " + n); };
// MacBook Air 13"（1470×956 点）：刘海两侧的菜单栏区域各 643 点宽
const screens = [{ x: 0, w: 1470, h: 956, left: 643, right: 643, top: 32 }, { x: 1470, w: 2560, h: 1440 }];
assert.deepStrictEqual(notchFor({ bounds: { x: 0, y: 0, width: 1470, height: 956 } }, screens), { x0: 643, x1: 827, h: 32 });
ok("内建屏：读出刘海位置 643–827（宽 184），高 32");
assert.strictEqual(notchFor({ bounds: { x: 1470, y: 0, width: 2560, height: 1440 } }, screens), null);
ok("外接显示器：没有刘海");
assert.strictEqual(notchFor({ bounds: { x: 0, y: 0, width: 1470, height: 956 } }, []), null);
ok("读不到系统信息：当作没有刘海（仍然贴在菜单栏里）");
console.log(`\n全部通过：${pass} 项`);
