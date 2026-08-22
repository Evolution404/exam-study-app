# exam-study-app 常用命令一键入口
# 用法：make <target>，输入 make 或 make help 查看全部目标。
# 浏览器测试默认使用项目专用 Chromium 并在 headless 后台运行；需要肉眼观看时
# 使用 `make test-browser-visible` 或 `make test-browser HEADLESS=0`。

.DEFAULT_GOAL := help

# 浏览器测试模式：1 = headless 后台运行，0 = 可见 Chromium 窗口。
HEADLESS ?= 1
MSG ?= chore: publish verified updates
export RELEASE_MESSAGE := $(MSG)
XCODE_DEVELOPER_DIR ?= /Applications/Xcode.app/Contents/Developer
IOS_PROJECT ?= ios/App/App.xcodeproj
IOS_SCHEME ?= App
IOS_TARGET ?=
IOS_CONFIGURATION ?= Debug
IOS_IPA_CONFIGURATION ?= Release
IOS_IPA_DERIVED_DATA ?= artifacts/ios/DerivedData
IOS_IPA_STAGING ?= artifacts/ios/ipa-staging
IOS_IPA_OUTPUT ?= artifacts/ios/shijuan.ipa
IOS_BUNDLE_ID ?= com.evolution404.shijuan
IOS_ICLOUD_DIR ?= $(HOME)/Library/Mobile Documents/com~apple~CloudDocs
IOS_ICLOUD_IPA ?= $(IOS_ICLOUD_DIR)/$(notdir $(IOS_IPA_OUTPUT))
XCODE_ENV = DEVELOPER_DIR="$(XCODE_DEVELOPER_DIR)"

.PHONY: help doctor status install ci browser-install dev mock build clean preview template-xlsx lint typecheck test test-full verify test-fast test-unit test-source test-integration test-sync test-architecture test-pwa test-pwa-smoke test-browser test-browser-headless test-browser-visible test-browser-desktop test-browser-mobile test-browser-management test-browser-review test-browser-search test-browser-history test-fast-serial test-browser-inflight release-check release publish ios-setup ios-build ios-sync ios-open ios-run ios-clean ios-build-simulator ios-ipa verify-ios

help: ## 显示本帮助
	@echo "exam-study-app 一键命令"
	@echo ""
	@echo "环境与开发："
	@echo "  make doctor                 检查 Node/npm/Git 与依赖是否就绪"
	@echo "  make status                 查看分支、远端、最近提交和工作区状态"
	@echo "  make install                安装依赖（npm install）"
	@echo "  make ci                     严格按锁文件安装依赖（npm ci）"
	@echo "  make browser-install        安装与 Playwright 版本匹配的专用 Chromium"
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
	@echo "浏览器测试（默认使用专用 Chromium 后台运行；HEADLESS=0 或 make test-browser-visible 打开窗口）："
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
	@echo ""
	@echo "iOS 原生（需要 macOS + Xcode；首次签名在 Xcode 内完成）："
	@echo "  make ios-setup              安装依赖、检查 Xcode、构建并同步 iOS 工程（默认 SPM）"
	@echo "  make ios-build              构建 iOS 相对路径资源并同步 Capacitor 工程"
	@echo "  make ios-sync               将已有 dist 同步到 iOS 工程"
	@echo "  make ios-open               构建并在 Xcode 打开 iOS 工程"
	@echo "  make ios-run IOS_TARGET=... 构建并运行到明确指定的模拟器/设备"
	@echo "  make ios-clean              使用 Xcode 清理 App target 构建产物"
	@echo "  make ios-build-simulator    无签名编译 iOS Simulator target"
	@echo "  make ios-ipa                生成 SideStore IPA，并在检测到 iCloud Drive 时自动复制 shijuan.ipa"
	@echo "  make verify-ios             iOS 构建、同步、模拟器编译和平台专项测试"

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

browser-install: ## 安装与 Playwright 版本匹配的专用 Chromium
	npm run browser:install

dev: ## 启动开发服务器
	npm run dev

mock: ## 启动内存 mock GitHub 服务器（手动验证同步中转地址）
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

test-integration: ## 集成测试（fake-indexeddb + mock 后端）
	npm run test:integration

test-sync: ## 同步模块测试
	npm run test:sync

test-architecture: ## 架构、样式和测试注册门禁
	npm run test:architecture

test-pwa: ## PWA 源码与缓存边界测试
	npm run test:pwa

test-pwa-smoke: browser-install ## 生产构建与真实 Service Worker 冒烟
	npm run test:pwa-smoke

test-browser: browser-install ## 浏览器全部场景分组（受 HEADLESS 控制）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:browser

test-browser-headless: browser-install ## 浏览器全部场景分组（强制 headless）
	BROWSER_HEADLESS=1 npm run test:browser

test-browser-visible: browser-install ## 浏览器全部场景分组（强制可见 Chromium）
	BROWSER_HEADLESS=0 npm run test:browser

test-browser-desktop: browser-install ## 浏览器：桌面端场景（受 HEADLESS 控制）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:browser:desktop

test-browser-mobile: browser-install ## 浏览器：移动端场景（受 HEADLESS 控制，自动先跑 desktop 准备数据）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:browser:mobile

test-browser-management: browser-install ## 浏览器：题库/知识/事件管理场景（受 HEADLESS 控制）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:browser:management

test-browser-review: browser-install ## 浏览器：复习轮次（受 HEADLESS 控制）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:browser:review

test-browser-search: browser-install ## 浏览器：搜索与批量操作（受 HEADLESS 控制）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:browser:search

test-browser-history: browser-install ## 浏览器：练习记录与结果（受 HEADLESS 控制）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:browser:history

test-browser-inflight: browser-install ## 浏览器：练习中删除题目/题库的竞争状态（受 HEADLESS 控制）
	BROWSER_HEADLESS=$(HEADLESS) npm run test:browser:inflight

release-check: ## 发布预演：完整验证但不提交或推送
	RELEASE_DRY_RUN=1 BROWSER_HEADLESS=$(HEADLESS) node scripts/tools/release.mjs

release: ## 一键验证、提交、推送 main 并等待部署；可用 MSG 覆盖提交说明
	BROWSER_HEADLESS=$(HEADLESS) node scripts/tools/release.mjs

publish: release ## release 的易记别名

ios-setup: ## 安装依赖、检查 Xcode 并初始化 iOS 工程
	@test -d node_modules || npm ci
	@test -d "$(XCODE_DEVELOPER_DIR)" || { echo "找不到 Xcode Developer 目录：$(XCODE_DEVELOPER_DIR)"; exit 1; }
	@$(XCODE_ENV) xcodebuild -version
	npm run build:ios
	@$(XCODE_ENV) npm run cap:sync:ios

ios-build: ## 构建 iOS 资源并同步 Capacitor 工程
	npm run build:ios
	@$(XCODE_ENV) npm run cap:sync:ios

ios-sync: ## 将已有 dist 同步到 iOS 工程
	@$(XCODE_ENV) npm run cap:sync:ios

ios-open: ios-build ## 构建并在 Xcode 打开 iOS 工程
	@$(XCODE_ENV) npm run cap:open:ios

ios-run: ## 运行到显式指定的 iOS target，不猜测设备
	@test -n "$(IOS_TARGET)" || { echo "请显式设置 IOS_TARGET，例如 make ios-run IOS_TARGET='iPhone 17'"; exit 2; }
	$(MAKE) ios-build
	@$(XCODE_ENV) npx cap run ios --target "$(IOS_TARGET)" --configuration "$(IOS_CONFIGURATION)"

ios-clean: ## 使用 Xcode 清理 iOS App target（不删除签名配置）
	@$(XCODE_ENV) xcodebuild -project "$(IOS_PROJECT)" -scheme "$(IOS_SCHEME)" -configuration "$(IOS_CONFIGURATION)" clean

ios-build-simulator: ios-build ## 无签名编译 iOS Simulator target
	@$(XCODE_ENV) xcodebuild -project "$(IOS_PROJECT)" -scheme "$(IOS_SCHEME)" -configuration "$(IOS_CONFIGURATION)" -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build

ios-ipa: ios-build ## 生成 SideStore 可重签的无签名真机 IPA
	@rm -rf "$(IOS_IPA_STAGING)"
	@mkdir -p "$(IOS_IPA_DERIVED_DATA)" "$(IOS_IPA_STAGING)/Payload" "$(dir $(IOS_IPA_OUTPUT))"
	@echo "构建无签名 iPhoneOS $(IOS_IPA_CONFIGURATION) App..."
	@$(XCODE_ENV) xcodebuild -project "$(IOS_PROJECT)" -scheme "$(IOS_SCHEME)" -configuration "$(IOS_IPA_CONFIGURATION)" -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath "$(IOS_IPA_DERIVED_DATA)" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build
	@APP_PATH="$(IOS_IPA_DERIVED_DATA)/Build/Products/$(IOS_IPA_CONFIGURATION)-iphoneos/App.app"; \
		test -d "$$APP_PATH" || { echo "找不到真机构建产物：$$APP_PATH"; exit 1; }; \
		BUNDLE_ID=$$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$$APP_PATH/Info.plist" 2>/dev/null || true); \
		test "$$BUNDLE_ID" = "$(IOS_BUNDLE_ID)" || { echo "Bundle ID 校验失败：期望 $(IOS_BUNDLE_ID)，实际 $$BUNDLE_ID"; exit 1; }; \
		/usr/bin/ditto "$$APP_PATH" "$(IOS_IPA_STAGING)/Payload/App.app"; \
		rm -f "$(IOS_IPA_STAGING)/Payload/App.app/embedded.mobileprovision"; \
		rm -f "$(IOS_IPA_OUTPUT)"; \
		(cd "$(IOS_IPA_STAGING)" && /usr/bin/ditto -c -k --sequesterRsrc --keepParent Payload "$(abspath $(IOS_IPA_OUTPUT))"); \
		/usr/bin/unzip -tq "$(IOS_IPA_OUTPUT)" >/dev/null; \
		/usr/bin/unzip -Z1 "$(IOS_IPA_OUTPUT)" | grep -qx 'Payload/App.app/Info.plist' || { echo "IPA 结构校验失败：缺少 Payload/App.app/Info.plist"; exit 1; }; \
		rm -rf "$(IOS_IPA_STAGING)"; \
		echo "SideStore IPA 已生成：$(IOS_IPA_OUTPUT)"; \
		ls -lh "$(IOS_IPA_OUTPUT)"
	@if test -d "$(IOS_ICLOUD_DIR)"; then \
		/bin/cp -f "$(IOS_IPA_OUTPUT)" "$(IOS_ICLOUD_IPA)"; \
		echo "iCloud Drive IPA 已更新：$(IOS_ICLOUD_IPA)"; \
		ls -lh "$(IOS_ICLOUD_IPA)"; \
	else \
		echo "未检测到 iCloud Drive，跳过 IPA 复制：$(IOS_ICLOUD_DIR)"; \
	fi

verify-ios: ios-build ## iOS 构建、同步、模拟器编译和平台专项测试
	npm run test:build-target
	npm run test:platform-environment
	npm run test:platform-transport
	npm run test:secure-credentials
	npm run test:persistent-config
	npm run test:platform-lifecycle
	npm run test:native-haptics
	npm run test:native-files
	npm run test:native-token-ui
	npm run test:platform-service-worker
	npm run test:architecture
	@$(XCODE_ENV) xcodebuild -project "$(IOS_PROJECT)" -scheme "$(IOS_SCHEME)" -configuration "$(IOS_CONFIGURATION)" -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
