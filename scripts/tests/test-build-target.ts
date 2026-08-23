import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveBuildBase, resolveViteBase } from "../../vite.config";

assert.equal(resolveBuildBase({}), "/exam-study-app/", "默认构建必须保持 GitHub Pages 子路径");
assert.equal(resolveBuildBase({ CF_PAGES: "1" }), "/", "Cloudflare Pages 构建必须使用根路径");
assert.equal(resolveBuildBase({ APP_TARGET: "ios" }), "./", "iOS 容器构建必须使用相对资源路径");
assert.equal(resolveBuildBase({ APP_TARGET: "ios", CF_PAGES: "1" }), "./", "iOS target 优先于部署环境变量");
assert.equal(resolveViteBase("serve", {}), "/", "本地 Vite dev 必须固定根路径，避免浏览器测试探测部署子路径");
assert.equal(resolveViteBase("build", {}), "/exam-study-app/", "Vite build 必须继续遵守 GitHub Pages 子路径");
assert.equal(resolveViteBase("build", { CF_PAGES: "1" }), "/", "Cloudflare Pages build 必须继续使用根路径");
assert.equal(resolveViteBase("build", { APP_TARGET: "ios" }), "./", "iOS build 必须继续使用相对资源路径");

const capacitorConfig = readFileSync(new URL("../../capacitor.config.ts", import.meta.url), "utf8");
const platformRuntime = readFileSync(new URL("../../src/platform/runtime.ts", import.meta.url), "utf8");
const bridgeViewController = readFileSync(new URL("../../ios/App/App/BridgeViewController.swift", import.meta.url), "utf8");
const sceneDelegate = readFileSync(new URL("../../ios/App/App/SceneDelegate.swift", import.meta.url), "utf8");
assert.match(capacitorConfig, /overlaysWebView:\s*false/, "iOS 静态配置必须让状态栏独立占位，WKWebView 从其下方开始");
assert.match(capacitorConfig, /backgroundColor:\s*"#00000000"/, "iOS StatusBar 静态背景必须透明，不能在启动时把原生主题刷回浅色");
assert.match(capacitorConfig, /style:\s*"DEFAULT"/, "iOS StatusBar 静态样式必须遵循原生界面风格，不能写死浅色启动");
assert.match(bridgeViewController, /CapacitorStorage\.study-v7-preferences/, "iOS 原生启动必须读取 Capacitor Preferences 中的主题偏好");
assert.match(bridgeViewController, /override func setStatusBarDefaults\(\)/, "Bridge 必须在 WKWebView 创建前设置初始状态栏样式");
assert.match(bridgeViewController, /webView\?\.backgroundColor\s*=\s*background/, "WKWebView 首帧背景必须匹配原生主题，避免白色画布闪烁");
assert.match(sceneDelegate, /overrideUserInterfaceStyle\s*=\s*initialInterfaceStyle/, "iOS window/controller 必须在显示前应用持久化主题");
assert.match(sceneDelegate, /window\.backgroundColor\s*=\s*AppThemeAppearance\.backgroundColor/, "iOS 状态栏区域底色必须在 makeKeyAndVisible 前匹配主题");
assert.ok(sceneDelegate.indexOf("window.backgroundColor") < sceneDelegate.indexOf("window.makeKeyAndVisible()"), "iOS 原生背景必须先于窗口显示设置");
assert.match(platformRuntime, /setOverlaysWebView\(\{\s*overlay:\s*false\s*\}\)/, "iOS 运行时必须保持状态栏与网页内容分层");
assert.match(platformRuntime, /setBackgroundColor\(\{\s*color:\s*currentStatusBarBackgroundColor\(\)\s*\}\)/, "iOS 状态栏背景必须继续跟随运行中主题变化");
assert.doesNotMatch(platformRuntime, /setOverlaysWebView\(\{\s*overlay:\s*true\s*\}\)/, "iOS 运行时不得让搜索栏进入状态栏区域");

console.log("build target tests passed: local/web/iOS bases, early native theme and status-bar geometry");
