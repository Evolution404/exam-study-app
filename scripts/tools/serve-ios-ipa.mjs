import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { basename, resolve } from "node:path";
import process from "node:process";

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} 缺少参数`);
  }
  return value;
}

function isPrivateIPv4(address) {
  if (/^10\./.test(address)) return true;
  if (/^192\.168\./.test(address)) return true;
  const match = address.match(/^172\.(\d+)\./);
  if (match) {
    const second = Number(match[1]);
    return second >= 16 && second <= 31;
  }
  return /^172\.20\.10\./.test(address); // iPhone Personal Hotspot
}

function localIPv4Candidates() {
  const entries = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const item of addresses ?? []) {
      if (item.family !== "IPv4" || item.internal) continue;
      entries.push({ name, address: item.address, private: isPrivateIPv4(item.address) });
    }
  }
  return entries.sort((a, b) => {
    const score = (item) => {
      if (item.name === "en0" && item.private) return 0;
      if (item.name === "en1" && item.private) return 1;
      if (item.private) return 2;
      return 3;
    };
    return score(a) - score(b);
  });
}

const ipaPath = resolve(readArg("--file", "artifacts/ios/shijuan.ipa"));
const portText = readArg("--port", "8765");
const port = Number(portText);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`无效端口：${portText}`);
}
if (!existsSync(ipaPath)) {
  throw new Error(`找不到 IPA：${ipaPath}`);
}

const ipaName = basename(ipaPath);
const ipaSize = statSync(ipaPath).size;
const candidates = localIPv4Candidates();
const primaryAddress = candidates[0]?.address;
const downloadPath = `/${encodeURIComponent(ipaName)}`;

function installPage(origin) {
  const downloadUrl = `${origin}${downloadPath}`;
  const sideStoreUrl = `sidestore://install?url=${encodeURIComponent(downloadUrl)}`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>安装拾卷</title>
  <style>
    :root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1ea;color:#1f2b25}
    main{width:min(460px,calc(100% - 32px));padding:28px;border:1px solid #d7d8d2;border-radius:22px;background:#fff;box-shadow:0 18px 50px #1b30241a}
    h1{margin:0 0 8px;font-size:28px}p{margin:0 0 22px;color:#68736d;line-height:1.6}
    a{min-height:48px;margin-top:10px;border-radius:12px;display:flex;align-items:center;justify-content:center;text-decoration:none;font-weight:700}
    .primary{color:#fff;background:#2e634a}.secondary{border:1px solid #cfd6d1;color:#2e634a;background:#f7faf8}
    code{display:block;margin-top:18px;padding:10px;border-radius:10px;overflow-wrap:anywhere;background:#f1f3f0;font-size:11px}
    @media(prefers-color-scheme:dark){body{background:#101612;color:#edf2ef}main{border-color:#36423b;background:#18201b}p{color:#a9b3ad}.secondary{border-color:#46534b;color:#b8d8c5;background:#202a24}code{background:#111813}}
  </style>
</head>
<body>
  <main>
    <h1>拾卷 iOS</h1>
    <p>最新版 IPA 已由 Mac 局域网提供。优先直接交给 SideStore；如果系统拦截自定义链接，可先下载 IPA 再从 SideStore 导入。</p>
    <a class="primary" href="${sideStoreUrl}">用 SideStore 安装</a>
    <a class="secondary" href="${downloadUrl}">下载 ${ipaName}</a>
    <code>${downloadUrl}</code>
  </main>
</body>
</html>`;
}

const server = createServer((req, res) => {
  const host = req.headers.host || `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const requestPath = new URL(req.url || "/", origin).pathname;

  if (requestPath === "/" || requestPath === "/index.html") {
    const html = installPage(origin);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(html),
    });
    res.end(html);
    return;
  }

  if (requestPath === decodeURIComponent(downloadPath)) {
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": ipaSize,
      "Content-Disposition": `attachment; filename="${ipaName}"`,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    createReadStream(ipaPath).pipe(res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found\n");
});

server.on("error", (error) => {
  if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
    console.error(`端口 ${port} 已被占用。可改用：make ios-serve IOS_SERVE_PORT=8766`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});

server.listen(port, "0.0.0.0", () => {
  console.log("\niOS IPA 局域网服务器已启动（Ctrl+C 停止）");
  if (!primaryAddress) {
    console.log(`未检测到局域网 IPv4；本机可访问：http://127.0.0.1:${port}/`);
    console.log("请确认 Mac 与 iPhone 已连接到同一局域网。\n");
    return;
  }

  const origin = `http://${primaryAddress}:${port}`;
  const downloadUrl = `${origin}${downloadPath}`;
  const sideStoreUrl = `sidestore://install?url=${encodeURIComponent(downloadUrl)}`;
  console.log(`安装页：${origin}/`);
  console.log(`IPA：   ${downloadUrl}`);
  console.log(`SideStore：${sideStoreUrl}`);
  if (candidates.length > 1) {
    console.log("其他可用地址：");
    for (const candidate of candidates.slice(1)) {
      console.log(`  ${candidate.name}: http://${candidate.address}:${port}/`);
    }
  }
  console.log("");
});
