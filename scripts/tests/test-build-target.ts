import assert from "node:assert/strict";
import { resolveBuildBase } from "../../vite.config";

assert.equal(resolveBuildBase({}), "/exam-study-app/", "默认构建必须保持 GitHub Pages 子路径");
assert.equal(resolveBuildBase({ CF_PAGES: "1" }), "/", "Cloudflare Pages 构建必须使用根路径");
assert.equal(resolveBuildBase({ APP_TARGET: "ios" }), "./", "iOS 容器构建必须使用相对资源路径");
assert.equal(resolveBuildBase({ APP_TARGET: "ios", CF_PAGES: "1" }), "./", "iOS target 优先于部署环境变量");

console.log("build target tests passed: web, Cloudflare Pages and iOS base paths");
