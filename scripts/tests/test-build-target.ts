import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveBuildBase } from "../../vite.config";

assert.equal(resolveBuildBase({}), "/exam-study-app/", "默认构建必须保持 GitHub Pages 子路径");
assert.equal(resolveBuildBase({ CF_PAGES: "1" }), "/", "Cloudflare Pages 构建必须使用根路径");
assert.equal(resolveBuildBase({ APP_TARGET: "ios" }), "./", "iOS 容器构建必须使用相对资源路径");
assert.equal(resolveBuildBase({ APP_TARGET: "ios", CF_PAGES: "1" }), "./", "iOS target 优先于部署环境变量");

const capacitorConfig = readFileSync(new URL("../../capacitor.config.ts", import.meta.url), "utf8");
const platformRuntime = readFileSync(new URL("../../src/platform/runtime.ts", import.meta.url), "utf8");
assert.match(capacitorConfig, /overlaysWebView:\s*false/, "iOS 静态配置必须让状态栏独立占位，WKWebView 从其下方开始");
assert.match(capacitorConfig, /backgroundColor:\s*"#f3f0e9"/, "iOS 静态配置必须覆盖 StatusBar 插件的黑色默认背景");
assert.match(capacitorConfig, /style:\s*"LIGHT"/, "iOS 浅色启动画面必须使用深色状态栏图标");
assert.match(platformRuntime, /setOverlaysWebView\(\{\s*overlay:\s*false\s*\}\)/, "iOS 运行时必须保持状态栏与网页内容分层");
assert.match(platformRuntime, /setBackgroundColor\(\{\s*color:\s*currentStatusBarBackgroundColor\(\)\s*\}\)/, "iOS 状态栏背景必须跟随当前主题");
assert.doesNotMatch(platformRuntime, /setOverlaysWebView\(\{\s*overlay:\s*true\s*\}\)/, "iOS 运行时不得让搜索栏进入状态栏区域");

console.log("build target tests passed: web, Cloudflare Pages, iOS base paths and status-bar geometry");
