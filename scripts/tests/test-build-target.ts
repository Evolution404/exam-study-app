import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveBuildBase } from "../../vite.config";

assert.equal(resolveBuildBase({}), "/exam-study-app/", "默认构建必须保持 GitHub Pages 子路径");
assert.equal(resolveBuildBase({ CF_PAGES: "1" }), "/", "Cloudflare Pages 构建必须使用根路径");
assert.equal(resolveBuildBase({ APP_TARGET: "ios" }), "./", "iOS 容器构建必须使用相对资源路径");
assert.equal(resolveBuildBase({ APP_TARGET: "ios", CF_PAGES: "1" }), "./", "iOS target 优先于部署环境变量");

const capacitorConfig = readFileSync(new URL("../../capacitor.config.ts", import.meta.url), "utf8");
const platformRuntime = readFileSync(new URL("../../src/platform/runtime.ts", import.meta.url), "utf8");
assert.match(capacitorConfig, /overlaysWebView:\s*true/, "iOS 静态配置必须让 WKWebView 覆盖状态栏并由 safe-area CSS 布局");
assert.match(platformRuntime, /setOverlaysWebView\(\{\s*overlay:\s*true\s*\}\)/, "iOS 运行时不得把 WKWebView 重新缩到状态栏下方");
assert.doesNotMatch(platformRuntime, /setOverlaysWebView\(\{\s*overlay:\s*false\s*\}\)/, "iOS 运行时不得暴露原生黑色状态栏背景");

console.log("build target tests passed: web, Cloudflare Pages, iOS base paths and status-bar geometry");
