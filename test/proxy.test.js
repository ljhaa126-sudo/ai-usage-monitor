const net = require("net");
const { nodeProxiedTransport, pickProxy } = require(process.argv[2] + "/core/http.js");
console.log("pickProxy:", JSON.stringify([pickProxy("PROXY 127.0.0.1:7890; DIRECT"), pickProxy("SOCKS5 127.0.0.1:7891"), pickProxy("DIRECT"), pickProxy("HTTPS [::1]:8080")]));
// 最小 SOCKS5 服务器：把隧道再转发到上游 HTTP 代理（本环境只能经代理出网）
function socks5(upstream) {
  return net.createServer((c) => {
    c.once("data", () => {
      c.write(Buffer.from([5, 0]));
      c.once("data", (req) => {
        const len = req[4], host = req.slice(5, 5 + len).toString(), port = req.readUInt16BE(5 + len);
        const u = net.connect(upstream.port, upstream.host, () => {
          u.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
          u.once("data", () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); c.pipe(u); u.pipe(c); });
        });
        u.on("error", () => c.destroy());
      });
    });
  });
}
(async () => {
  const up = new URL(process.env.HTTPS_PROXY);
  const r1 = await nodeProxiedTransport({ url: "https://api.github.com/zen", headers: { "User-Agent": "aimon-test" } });
  console.log("HTTP CONNECT 代理:", r1.status, r1.via, JSON.stringify(r1.text.slice(0, 60)));
  const srv = socks5({ host: up.hostname, port: Number(up.port) }).listen(0);
  await new Promise((r) => srv.once("listening", r));
  process.env.HTTPS_PROXY = `http://127.0.0.1:${srv.address().port}`; // 让 resolveProxyFor 返回 PROXY，再手动测 SOCKS
  const http = require(process.argv[2] + "/core/http.js");
  // 直接调用 SOCKS 路径：临时替换解析结果
  const orig = process.env.HTTPS_PROXY; delete process.env.HTTPS_PROXY;
  const Module = require("module"); const origLoad = Module._load;
  Module._load = function (req, ...a) { if (req === "electron") return { session: { defaultSession: { resolveProxy: async () => `SOCKS5 127.0.0.1:${srv.address().port}` } } }; return origLoad.call(this, req, ...a); };
  const r2 = await http.nodeProxiedTransport({ url: "https://api.github.com/zen", headers: { "User-Agent": "aimon-test" } });
  console.log("SOCKS5 代理:", r2.status, r2.via, JSON.stringify(r2.text.slice(0, 60)));
  srv.close(); process.exit(0);
})().catch((e) => { console.log("FAIL", e.message); process.exit(1); });
