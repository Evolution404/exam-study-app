# 拾卷（Exam Study App）

公开访问的本地优先背题软件。网页本身只包含程序代码，不包含任何用户题库、解析或练习记录。每位用户通过自己的 GitHub 令牌连接自己的私有资料库，数据彼此隔离。

线上地址：<https://evolution404.github.io/exam-study-app/>

## 支持平台

- Desktop Web / PWA：GitHub Pages、Cloudflare Pages，以及本地浏览器开发环境。
- iOS native App：Capacitor 8 + WKWebView，复用同一套 React、Dexie 和 Sync v9 业务代码；不另建一套 iOS 页面，也不发布 App Store。
- SideStore：生产发布链会为 `main` 的 exact commit 构建无签名 IPA、SideStore source 与不可变 GitHub Release assets；设备端仍由 SideStore + 用户 Apple ID 完成重新签名。

## 数据边界

- 公开仓库：界面、练习逻辑和 GitHub 同步代码。
- 业务数据：无论浏览器还是 iOS WKWebView，题库、作答、练习、解析、change sets 和图片 descriptor 都继续保存在独立 IndexedDB `shijuan-study-v7`；不迁移 SQLite。
- Web 凭据：浏览器端 GitHub 令牌保存在本机浏览器存储中，直到你主动清除；不会写入题库或同步到远端资料库。
- iOS 凭据：iOS native App 的 GitHub 令牌只保存在 Keychain，不写入 `localStorage`、IndexedDB、题库快照或同步对象。
- iOS 配置：非秘密的少量配置使用 Preferences / UserDefaults mirror；它不替代 Dexie，也不保存令牌。
- 用户自己的私有 GitHub 仓库：跨设备同步事件、检查点、分段、对象、历史与私有图片，公开远端格式为 Sync v9，唯一可变入口为 `sync/v9/head.json`。
- 图片远端只使用 Asset Pack：`sync/v9/assets/index.json` → 固定 shard → immutable pack；不恢复逐图远端布局。
- GitHub API 中继：Cloudflare Pages 默认使用同源 `/api-github`；GitHub Pages 与 iOS 默认使用配套的 `https://sync.980923.xyz` Worker。iOS 允许用户显式填写自定义 Relay，但不会在 Relay 出错时静默直连 `api.github.com`。
- iOS 网络边界：同步请求继续使用 WKWebView 可用的 `fetch` 兼容路径；当前不启用 Capacitor Native HTTP，也不绕过 Relay。
- Service Worker：仅浏览器 Web/PWA 注册；iOS native 不注册 Service Worker，使用 Capacitor 打包的本地资源。

本仓库不允许提交真实题库文件。项目所有者的题库位于私有数据仓库中。

## 使用

1. 打开线上地址，进入“同步”。
2. 填写自己的私有资料库名称，默认 `exam-study-vault`。
3. 输入只授权该私有仓库、具有 Contents 读写权限的细粒度 GitHub 令牌。共享设备上请在“同步”页清除本机数据，或在令牌管理页面撤销它。
4. 点击“立即同步”。软件会通过令牌识别 GitHub 用户，并只读取该用户有权访问的资料库。

也可以不连接 GitHub，直接导入本地 JSON 题库；此时数据只保存在当前浏览器。

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

## iOS 构建、SideStore 与签名

iOS 工程固定 Bundle ID `com.evolution404.shijuan`，不把 Team ID、证书或 Apple ID 写入仓库。本地 Xcode 路径：

```bash
make ios-setup
make ios-open
make ios-run IOS_TARGET="你的模拟器或已连接设备名称"
```

生成可由 SideStore 重签的无签名 IPA：

```bash
make ios-ipa
```

生产 Deploy 会在 macOS runner 上为同一 `main` exact commit 生成无签名 IPA、`sidestore-source.json` 和不可变 Release assets，并在 Cloudflare 端点执行发布后 smoke。GitHub Actions 不持有 Apple 证书；最终签名仍由设备端 SideStore 与用户 Apple ID 完成。

## 发布

推送 `main` 后，生产 workflow 以公共 build 为起点，并行发布 GitHub Pages、Cloudflare Pages 和 SideStore；三端完成后执行 post-deploy Fast/PWA/SideStore gates。验证失败时保持既有 GitHub Pages、Cloudflare 与 SideStore latest 条件回退语义。详细合同见 `docs/HANDOFF.md` 与 `docs/TESTING.md`。
