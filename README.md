# 拾卷（Exam Study App）

公开访问的本地优先背题软件。网页本身只包含程序代码，不包含任何用户题库、解析或练习记录。每位用户通过自己的 GitHub 令牌连接自己的私有资料库，数据彼此隔离。

线上地址：<https://evolution404.github.io/exam-study-app/>

## 支持平台

- Desktop Web / PWA：GitHub Pages、Cloudflare Pages，以及本地浏览器开发环境。
- iOS native App：Capacitor 8 + WKWebView，复用同一套 React、Dexie 和 Sync v8 业务代码；不另建一套 iOS 页面，也不发布 App Store。

## 数据边界

- 公开仓库：界面、练习逻辑和 GitHub 同步代码。
- 业务数据：无论浏览器还是 iOS WKWebView，题库、作答、练习、解析、change sets 和图片 descriptor 都继续保存在独立 IndexedDB `shijuan-study-v7`；不迁移 SQLite。
- Web 凭据：浏览器端 GitHub 令牌保存在本机浏览器存储中，直到你主动清除；不会写入题库或同步到远端资料库。
- iOS 凭据：iOS native App 的 GitHub 令牌只保存在 Keychain，不写入 `localStorage`、IndexedDB、题库快照或同步对象。
- iOS 配置：非秘密的少量配置使用 Preferences / UserDefaults mirror；它不替代 Dexie，也不保存令牌。
- 用户自己的私有 GitHub 仓库：跨设备同步事件、检查点、分段、对象和私有图片，格式保持 Sync v8。
- GitHub API 中继：Cloudflare Pages 默认使用同源 `/api-github`；GitHub Pages 与 iOS 默认使用配套的 `https://sync.980923.xyz` Worker。iOS 允许用户显式填写自定义 Relay，但不会在 Relay 出错时静默直连 `api.github.com`。中继只允许同步所需的 GitHub API 路径与方法；请只使用自己信任的部署，因为中转服务会处理带令牌的请求。
- iOS 网络边界：同步请求继续使用 WKWebView 可用的 `fetch` 兼容路径；当前不启用 Capacitor Native HTTP，也不绕过 Relay。
- Service Worker：仅浏览器 Web/PWA 注册；iOS native 不注册 Service Worker，使用 Capacitor 打包的本地资源。

本仓库不允许提交真实题库文件。项目所有者的送电线路工题库位于私有 `exam-study-vault` 中。

## 使用

1. 打开线上地址，进入“同步”。
2. 填写自己的私有资料库名称，默认 `exam-study-vault`。
3. 输入只授权该私有仓库、具有 Contents 读写权限的细粒度 GitHub 令牌。令牌会保存在这台设备的浏览器中，方便下次同步；共享设备上请在“同步”页清除本机数据，或在令牌管理页面撤销它。
4. 点击“立即同步”。软件会通过令牌识别 GitHub 用户，并只读取该用户有权访问的资料库。

也可以不连接 GitHub，直接导入本地 JSON 题库；此时数据只保存在当前浏览器。

在 iOS 上首次运行时，先在 Xcode 中完成个人签名（见下方），再从同步设置确认默认中转地址为 `https://sync.980923.xyz`。若不连接 GitHub，题库仍只保存在该 iPhone 的 WKWebView IndexedDB 中。

## 支持的题库格式

```json
[
  {
    "q": "题干",
    "ans": "AC",
    "a": ["选项A", "选项B", "选项C", "选项D"]
  }
]
```

## 本地开发

```bash
npm install
npm run dev
```

生产构建与检查：

```bash
npm run lint
npm test
```

## iOS 构建与签名

iOS 工程固定 Bundle ID `com.evolution404.shijuan`，不把 Team ID、证书或 Apple ID 写入仓库。首次在本机使用时：

```bash
make ios-setup
make ios-open
```

然后在 Xcode 中登录自己的 Apple ID，在 Signing & Capabilities 选择 Personal Team（或付费 Team），保持 Automatically manage signing，选择自己的 iPhone 后 Run。覆盖安装会沿用稳定 Bundle ID 和本机数据。

日常更新代码后：

```bash
git pull
make ios-run IOS_TARGET="你的模拟器或已连接设备名称"
```

`ios-run` 要求显式提供 `IOS_TARGET`，不会猜测或误选设备。其他已提供的本地检查入口包括 `make ios-build`、`make ios-sync`、`make ios-clean`、`make ios-build-simulator` 和 `make verify-ios`。`npm run build:ios` 使用相对资源基路径 `./`，之后由 `npx cap sync ios` 同步到 Capacitor 工程。

当前没有经过验证的 `ios-ipa-unsigned` / SideStore 打包目标；不要把 unsigned IPA 当作已支持交付路径。稳定路线仍是 Xcode + Personal Team 重新签名。

推送 `main` 后，GitHub Actions 自动构建并发布 GitHub Pages。
