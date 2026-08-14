# exam-study-app 常用命令一键入口
# 用法：make <target>，输入 make 或 make help 查看全部目标。
# 浏览器测试需要本机装有可见 Chrome（可用 CHROME_PATH 指定），
# 且会在真实窗口中自动启动 vite dev server。

.DEFAULT_GOAL := help

.PHONY: help install dev mock build preview lint typecheck test test-fast test-unit test-source test-integration test-sync test-browser test-browser-desktop test-browser-mobile test-browser-management test-browser-review test-browser-search test-browser-history test-browser-inflight

help: ## 显示本帮助
	@echo "exam-study-app 一键命令"
	@echo ""
	@echo "环境与开发："
	@echo "  make install                安装依赖（npm install）"
	@echo "  make dev                    启动开发服务器（vite）"
	@echo "  make mock                   启动内存 mock GitHub 服务器（手动验证同步中转地址）"
	@echo "  make build                  构建产物（vite build）"
	@echo "  make preview               预览构建产物"
	@echo ""
	@echo "代码检查："
	@echo "  make lint                   ESLint"
	@echo "  make typecheck              TypeScript 类型检查"
	@echo ""
	@echo "测试（逻辑 / 源码断言 / 集成 / 快测 / 完整 / 全量）："
	@echo "  make test-unit              纯逻辑测试（快捷键、导入、筛选、同步 payload 等）"
	@echo "  make test-source            源码断言（架构门、PWA、UI 行为、v6 数据流等）"
	@echo "  make test-integration       集成测试（fake-indexeddb + mock 后端）"
	@echo "  make test-fast              快测 = unit + source + integration + typecheck + lint（不含构建）"
	@echo "  make test-sync              同步模块测试"
	@echo "  make test                   完整 CI 测试（含构建，不含浏览器）"
	@echo "  make test-full              全量 = test + 浏览器全部场景"
	@echo ""
	@echo "浏览器测试（可见 Chrome 场景分组，BROWSER_GROUPS 选择）："
	@echo "  make test-browser           全部场景分组"
	@echo "  make test-browser-desktop   桌面端（首页/题库/配置/练习/同步）"
	@echo "  make test-browser-mobile    移动端（含 desktop 数据准备，跨设备验证）"
	@echo "  make test-browser-management 题库/知识/事件管理"
	@echo "  make test-browser-review    复习轮次"
	@echo "  make test-browser-search    搜索与批量操作"
	@echo "  make test-browser-history   练习记录与结果"
	@echo "  make test-browser-inflight  练习中删除题目/题库（竞争状态）"

install: ## 安装依赖
	npm install

dev: ## 启动开发服务器
	npm run dev

mock: ## 启动内存 mock GitHub 服务器（手动验证）
	node scripts/mock-github-server.mjs

build: ## 构建产物
	npm run build

preview: ## 预览构建产物
	npm run preview

lint: ## ESLint
	npm run lint

typecheck: ## TypeScript 类型检查
	npm run typecheck

test: ## 完整 CI 测试（含构建，不含浏览器）
	npm test

test-full: ## 全量测试（含浏览器全部场景）
	npm run test:full

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

test-browser: ## 浏览器全部场景分组
	npm run test:browser

test-browser-desktop: ## 浏览器：桌面端场景
	npm run test:browser:desktop

test-browser-mobile: ## 浏览器：移动端场景（自动先跑 desktop 准备数据）
	npm run test:browser:mobile

test-browser-management: ## 浏览器：题库/知识/事件管理场景
	npm run test:browser:management

test-browser-review: ## 浏览器：复习轮次场景
	npm run test:browser:review

test-browser-search: ## 浏览器：搜索与批量操作场景
	npm run test:browser:search

test-browser-history: ## 浏览器：练习记录与结果场景
	npm run test:browser:history

test-browser-inflight: ## 浏览器：练习中删除题目/题库的竞争状态
	npm run test:browser:inflight
