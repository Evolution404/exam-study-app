# 工程结构

## 模块边界

- `app/study-app.tsx`：应用路由状态与跨页面编排，不承载同步实现和浏览器环境细节。
- `app/*-view.tsx`：独立业务页面；GitHub 同步位于 `app/sync-view.tsx`。
- `app/hooks/`：跨页面浏览器能力。主题解析和移动端可视区域统一由 `use-app-environment.ts` 管理。
- `app/styles/theme-tokens.css`：日间/夜间唯一的语义颜色来源。
- `app/styles/components.css`：现有组件样式。硬编码颜色与页面级夜间选择器已设预算，只能逐步减少。
- `lib/`：数据库、同步协议与领域计算，不依赖 React 页面。

## 当前格式

客户端只支持 IndexedDB v6 和 GitHub 同步协议 v2。所有正式客户端和远程资料库已升级，因此不保留旧数据库升级链、v1 事件仓库回退、旧配置键或一次性迁移脚本。

## 主题规则

新组件必须使用 `--color-*` 语义令牌，不得在新样式文件中硬编码颜色，也不得新增 `html[data-theme="dark"]` 页面补丁。`npm test` 会先执行架构检查，防止主题覆盖再次退化。
