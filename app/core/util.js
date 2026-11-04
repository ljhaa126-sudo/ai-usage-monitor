"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = () => os.homedir();

function fileExists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readJSON(p) {
  try {
    const t = fs.readFileSync(p, "utf8").replace(/^﻿/, "");
    return JSON.parse(t);
  } catch { return null; }
}

function normalizeEpoch(n) {
  if (!n || n <= 0) return 0;
  return n < 1e11 ? n * 1000 : n;
}

// 多种时间格式 -> 毫秒
function parseTime(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return normalizeEpoch(v);
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d+(\.\d+)?$/.test(s)) return normalizeEpoch(Number(s));
    const t = Date.parse(s);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

function num(o, ...keys) {
  if (!o || typeof o !== "object") return null;
  for (const k of keys) {
    const v = o[k];
    if (v == null) continue;
    const n = typeof v === "number" ? v : Number(v);
    if (!isNaN(n)) return n;
  }
  return null;
}

const clamp = (p) => Math.max(0, Math.min(100, p || 0));

function titleCase(s) {
  if (!s) return "";
  return String(s).split(/[_\-\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function jwtClaims(tok) {
  try {
    const p = String(tok).split(".")[1];
    return JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch { return null; }
}

function dayKey(t = Date.now()) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

class NoLogin extends Error {
  constructor(msg) { super(msg); this.noLogin = true; }
}

class HttpError extends Error {
  constructor(status, body, headers) {
    let b = String(body || "");
    const html = /<html|<!DOCTYPE/i.test(b);
    if (html) b = "（服务器返回了网页，可能被拦截）";
    super(`HTTP ${status} ${b.slice(0, 160)}`.trim());
    this.status = status;
    this.html = html;
    this.headers = headers || {};
  }
  get auth() { return this.status === 401 || (this.status === 403 && !this.html); }
}

const mac = process.platform === "darwin";

function appSupport(...p) {
  if (mac) return path.join(home(), "Library", "Application Support", ...p);
  if (process.platform === "win32") return path.join(process.env.APPDATA || "", ...p);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home(), ".config"), ...p);
}

module.exports = { home, fileExists, readJSON, parseTime, num, clamp, titleCase, jwtClaims, dayKey, NoLogin, HttpError, mac, appSupport };
