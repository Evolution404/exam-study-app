# exam-study-app 常用命令一键入口
# 用法：make <target>，输入 make 或 make help 查看全部目标。
# 浏览器测试默认 headless 后台运行（不弹 Chrome 窗口）；需要肉眼观看时
# 使用 `make test-browser-visible` 或 `make test-browser HEADLESS=0`。

.DEFAULT_GOAL := help

# 浏览器测试模式：1 = headless 后台运行，0 = 可见 Chrome 窗口。
HEADLESS ?= 1
MSG ?= chore: publish verified updates
export RELEASE_MESSAGE := $(MSG)

.PHONY: help doctor status install ci dev mock build clean preview template-xlsx lint typecheck test test-full verify test-fast test-unit test-source test-integration test-sync test-architecture test-pwa test-pwa-smoke test-browser test-browser-headless test-browser-visible test-browser-desktop test-browser-mobile test-browser-management test-browser-review test-browser-search test-browser-history test-fast-serial test-browser-inflight release-check release publish

help: ## 显示本帮助
	@echo "exam-study-app 一键命令"
	@echo ""
	@echo "环境与开发："
	@echo "  make doctor                 检查 Node/npm/Git 与依赖是否就绪"
	@echo "  make status                 查看分支、远端、最近提交和工作区状态"
	@echo "  make install                安装依赖（npm install）"
	@echo "  make ci                     严格按锁文件安装依赖（npm ci）"
	@echo "  make dev                    启动开发服务器（vite）"
	@echo "  make mock                   启动内存 mock GitHub 服务器（手动验证同步中转地址）"
	@echo "  make build                  构建产物（vite build）"
	@echo "  make clean                  清理所有本地生成产物与缓存（不删 node_modules）"
	@echo "  make preview               预览构建产物"
	@echo "  make template-xlsx         重新生成 public/题库模板.xlsx"
	@echo ""
	@echo "代码检查："
	@echo "  make lint                   ESLint"
	@echo "  make typecheck              TypeScript 类型检查"
	@echo "  make test-architecture      架构、样式和测试注册门禁"
	@echo "  make test-pwa               PWA 源码与缓存边界测试"
	@echo "  make test-pwa-smoke         生产构建 + 真实 Service Worker 冒烟"
	@echo ""
	@echo "测试（逻辑 / 源码断言 / 集成 / 快测 / 完整 / 全量）："
	@echo "  make test-unit              纯逻辑测试（快捷键、导入、筛选、同步 payload 等）"
	@echo "  make test-source            源码断言（架构门、PWA、UI 行为、v6 数据流等）"
	@echo "  make test-integration       集成测试（fake-indexeddb + mock 后端）"
	@echo "  make test-fast              快测 = unit + source + integration + typecheck + lint（不含构建）"
	@echo "  make test-fast-serial       串行快测（排查偶发失败用）"
	@echo "  make test-sync              同步模块测试"
	@echo "  make test                   完整 CI 测试（含构建，不含浏览器）"
	@echo "  make test-full              全量 = test + 浏览器全部场景"
	@echo "  make verify                 发布级验证 = 全量测试 + PWA smoke"
	@echo ""
	@echo "浏览器测试（默认 headless 后台运行；HEADLESS=0 或 make test-browser-visible 开可见 Chrome）："
	@echo "  make test-browser           全部场景分组（受 HEADLESS 控制）"
	@echo "  make test-browser-headless  全部场景分组（强制 headless）"
	@echo "  make test-browser-visible   全部场景分组（强制可见 Chrome）"
	@echo "  make test-browser-desktop   桌面端（首页/题库/配置/练习/同步）"
	@echo "  make test-browser-mobile    移动端（含 desktop 数据准备，跨设备验证）"
	@echo "  make test-browser-management 题库/知识/事件管理"
	@echo "  make test-browser-review    复习轮次"
	@echo "  make test-browser-search    搜索与批量操作"
	@echo "  make test-browser-history   练习记录与结果"
	@echo "  make test-browser-inflight  练习中删除题目/题库（竞争状态）"
	@echo ""
	@echo "发布："
	@echo '  make release-check          执行发布预检和全部验证，但不提交、不推送'
	@echo '  make release MSG="fix: ..." 一键验证、提交、推送 main、等待部署并核验线上版本'
	@echo '  make publish MSG="fix: ..." 与 make release 相同'

doctor: ## 检查本地开发环境
	@command -v git >/dev/null || { echo "缺少 git"; exit 1; }
	@command -v node >/dev/null || { echo "缺少 node"; exit 1; }
	@command -v npm >/dev/null || { echo "缺少 npm"; exit 1; }
	@node -e 'const major=Number(process.versions.node.split(".")[0]);if(major<22){console.error(`需要 Node >=22，当前 $${process.versions.node}`);process.exit(1)}console.log(`Node $${process.versions.node}`)'
	@npm --version
	@test -d node_modules || { echo "依赖尚未安装，请先运行 make ci"; exit 1; }
	@echo "开发环境检查通过"

status: ## 查看 Git 与发布状态
	@git status --short --branch
	@git remote -v
	@git log -5 --oneline

install: ## 安装依赖
	npm install

ci: ## 严格按锁文件安装依赖
	npm ci

dev: ## 启动开发服务器
	npm run dev

mock: ## 启动内存 mock GitHub 服务器（手动验证）
	node scripts/tools/mock-github-server.mjs

build: ## 构建产物
	npm run build

clean: ## 清理所有本地生成产物与缓存（不删 node_modules）
	rm -rf dist functions src/generated build .next .vinext .wrangler artifacts coverage
	find . -name .DS_Store -not -path "./node_modules/*" -delete

preview: ## 预览构建产物
	npm run preview

template-xlsx: ## 重新生成 public/题库模板.xlsx
	npm run template:xlsx

lint: ## ESLint
	npm run lint

typecheck: ## TypeScript 类型检查
	npm run typecheck

test: ## 完整 CI 测试（含构建，不含浏览器）
	npm test

test-full: ## 全量测试（含浏览器全部场景，受 HEADLESS 控制）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:full

verify: ## 发布级验证（全量测试 + 真实 PWA smoke）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:full
	npm run test:pwa-smoke

test-fast: ## 快测（不含构建与浏览器）
	npm run test:fast

test-unit: ## 纯逻辑测试
	npm run test:unit

test-source: ## 源码断言测试
	npm run test:source

test-integration: ## 集成测试
	npm run test:integration

test-sync: ## 同步模块测试
	npm run test:sync

test-architecture: ## 架构、样式和测试注册门禁
	npm run test:architecture

test-pwa: ## PWA 源码与缓存边界测试
	npm run test:pwa

test-pwa-smoke: ## 生产构建与真实 Service Worker 冒烟
	npm run test:pwa-smoke

test-browser: ## 浏览器全部场景分组（受 HEADLESS 控制）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:browser

test-browser-headless: ## 浏览器全部场景分组（强制 headless）
	BROWSER_HEADLESS=1 npm run test:browser

test-browser-visible: ## 浏览器全部场景分组（强制可见 Chrome）
	BROWSER_HEADLESS=0 npm run test:browser

test-browser-desktop: ## 浏览器：桌面端场景（受 HEADLESS 控制）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:browser:desktop

test-browser-mobile: ## 浏览器：移动端场景（受 HEADLESS 控制，自动先跑 desktop 准备数据）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:browser:mobile

test-browser-management: ## 浏览器：题库/知识/事件管理场景（受 HEADLESS 控制）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:browser:management

test-browser-review: ## 浏览器：复习轮次场景（受 HEADLESS 控制）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:browser:review

test-browser-search: ## 浏览器：搜索与批量操作场景（受 HEADLESS 控制）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:browser:search

test-browser-history: ## 浏览器：练习记录与结果场景（受 HEADLESS 控制）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:browser:history

test-browser-inflight: ## 浏览器：练习中删除题目/题库的竞争状态（受 HEADLESS 控制）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:browser:inflight

release-check: ## 发布预演：完整验证但不提交或推送
	RELEASE_DRY_RUN=1 BROWSER_HEADLESS=$(HEADLESS) node scripts/tools/release.mjs

release: ## 一键验证、提交、推送 main 并等待部署；可用 MSG 覆盖提交说明
	BROWSER_HEADLESS=$(HEADLESS) node scripts/tools/release.mjs

publish: release ## release 的易记别名
