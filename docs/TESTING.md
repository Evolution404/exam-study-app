# 测试体系与功能覆盖矩阵

本文件梳理系统所有功能对应的测试，作为「每个界面操作都有测试可循」的可审计清单。测试不使用框架，全部为 `node/tsx + assert`（浏览器 e2e 用 `playwright-core` 驱动 Chrome，默认 headless；`BROWSER_HEADLESS=0` 或 `make test-browser-visible` 可开可见 Chrome）。

## 1. 测试层级总览

| 层级 | 命令 | 包含内容 | 耗时量级 | 是否含构建 |
|---|---|---|---|---|
| 逻辑 `unit` | `npm run test:unit` / `make test-unit` | 纯计算：快捷键、Excel 导入、错题口径、题型展示、同步 payload、v7 领域 | 秒级 | 否 |
| 源码断言 `source` | `npm run test:source` / `make test-source` | 源码/静态断言：架构门、PWA 缓存、GitHub 代理一致性、弹窗层级、作答反馈 UI、内容块 UI、v7 数据流 | 秒级 | 否 |
| 集成 `integration` | `npm run test:integration` / `make test-integration` | fake-indexeddb + mock 后端：db-v7、同步 mock、同步集成（事件/试题管理/合并） | 秒级 | 否 |
| 快测 `fast` | `npm run test:fast` / `make test-fast` | 并行执行 unit + source + integration，再执行 typecheck + lint | 数秒–数十秒 | 否 |
| 完整 CI `test` | `npm test` / `make test` | production build → `test:fast`（architecture、typecheck、lint、全部逻辑/源码/集成脚本） | 数十秒 | 是 |
| 全量 `full` | `npm run test:full` / `make test-full` | 完整 CI + 浏览器全部场景（默认 headless，可用 `make test-browser-visible` 看可见浏览器） | 数分钟 | 是（+真实浏览器） |
| 浏览器 smoke `e2e` | `npm run test:browser-smoke` | Ubuntu Chromium 桌面冒烟场景；端口严格固定，不能悄悄改连其他服务 | 数十秒 | 否 |
| PWA smoke `e2e` | `npm run test:pwa-smoke` | production build → Vite preview → 真实 Service Worker 安装、接管、版本化缓存与 app shell | 分钟级 | 是 |

## 2. 浏览器分组速查

`scripts/tests/test-browser-visible.mjs` 由 `BROWSER_GROUPS` 环境变量选择场景分组（逗号分隔，缺省=全部）。每组独立浏览器上下文 + 独立 IndexedDB；共享一个进程内 mock GitHub 服务器，因此可做真实跨设备同步。

浏览器 runner 会按操作系统从 PATH 查找 `google-chrome-stable`、`google-chrome`、`chromium` 或 `chromium-browser`；本机有多个浏览器时可用 `CHROME_PATH=/path/to/chrome` 指定。未提供 `BASE_URL` 时，runner 以 `BROWSER_PORT`（默认 `5173`）启动 Vite，并传入 `--strictPort`：端口已被占用会直接失败，不会接受其他服务的页面。需要并行运行时为每个 runner 传不同的 `BROWSER_PORT`；测试结束会回收它自己启动的进程。

| 分组 | 命令 | 覆盖 | 依赖 |
|---|---|---|---|
| `desktop` | `make test-browser-desktop` | 首页/题库管理/配置/练习/同步（401 失败、自动同步、真实同步、热窗口、幂等） | — |
| `mobile` | `make test-browser-mobile` | 移动端导航、模板下载兜底、练习暂停/继续、跨设备拉取 | **先跑 desktop**（跨设备验证依赖桌面端先推送） |
| `management` | `make test-browser-management` | 题库/试题/文件夹/未归档/批量移除、标签/题组、事件管理、真实同步 | — |
| `review` | `make test-browser-review` | 复习轮次：新建/编辑/绑定练习/提前结束/归档 | — |
| `search` | `make test-browser-search` | 关键词/正则搜索、题型标签、题目详情导航与收藏、批量操作、加入题组 | — |
| `history` | `make test-browser-history` | 练习记录/结果：正确率、筛选、重练错题、继续/放弃/删除 | — |
| `inflight` | `make test-browser-inflight` | 练习进行中删除当前题（自动跳过）/删光全部题（优雅结束）/删题库（置空会话，不丢答案） | — |

CI 的 Chromium smoke 使用 `BROWSER_GROUPS=desktop`，只验证可在 Ubuntu 上稳定复现的核心启动、导入、练习与同步路径；完整场景仍由 `test:full` 在发布前运行。

## 3. 功能覆盖矩阵

状态图例：**自动**=自动化断言；**替代**=用等价交互覆盖（见第 4 节）；**限制**=已知限制，不做自动 e2e（列原因）。

### 3.1 首页
| 功能操作 | 覆盖位置 | 状态 |
|---|---|---|
| 导入题库（JSON fixture） | browser-desktop/mobile/management | 自动 |
| 今日统计与进度口径标签 | browser-desktop | 自动 |
| 继续上次练习 / 放弃 | browser-mobile, browser-history | 自动 |
| 题库范围 toggle、更多模式入口 | browser-desktop（练习入口） | 自动 |

### 3.2 题库管理
| 功能操作 | 覆盖位置 | 状态 |
|---|---|---|
| 新建空白题库 / 删除（保留题目 / 级联） | browser-desktop, browser-management | 自动 |
| 文件夹新建 / 题库移入 | browser-management | 自动 |
| 编辑题库（改名/文件夹/说明） | browser-management | 自动 |
| JSON / Excel 导入 | browser-desktop | 自动 |
| 模板下载（Web Share 不可用回退下载） | browser-mobile | 自动 |
| 批量移除 → 未归档 / 隐藏未归档 | browser-management | 自动 |
| 活动范围（近 90 天 / 自定义日期） | browser-desktop | 自动 |
| 题数 / 优先级 / 最近练习等 KPI | 未覆盖 | 限制（数据依赖多，易脆，后续补充） |

### 3.3 试题管理
| 功能操作 | 覆盖位置 | 状态 |
|---|---|---|
| 新增题目 / 编辑题干 | browser-management, browser-desktop | 自动 |
| 内容块编辑器 + 图片插入 | browser-desktop（attachFixtureImage） | 自动 |
| 题目搜索/过滤、批量操作 | browser-management | 自动 |
| 题目详情（进度指示 + 上一题/下一题切换） | browser-management | 自动 |
| 图片缓存（缓存全部/清空） | 未覆盖 | 限制 |

### 3.4 知识整理（标签 / 题组）
| 功能操作 | 覆盖位置 | 状态 |
|---|---|---|
| 标签新建/合并/删除、标签练习 | browser-management | 自动 |
| 题组新建（名称/说明/搜索添加/组内提示）、编辑、删除 | browser-management, browser-search | 自动 |
| 题组题目排序（上移/下移） | browser-search | 替代 |
| 拖拽排序 | — | 限制（浏览器原生 DnD 不稳定；上移/下移已覆盖等价语义） |

### 3.5 搜索
| 功能操作 | 覆盖位置 | 状态 |
|---|---|---|
| 关键词搜索、正则模式 | browser-desktop（筛选交互）、browser-search | 自动 |
| 筛选抽屉（状态/标签/题库/统计口径）、active count | browser-desktop（assertSearchFilterInteractions） | 自动 |
| 题型标签（全部/单选/多选/判断/计算） | browser-search | 自动 |
| 题目详情（上一题/下一题/收藏/编辑/只练这一题） | browser-search | 自动 |
| 批量：收藏所选 / 添加标签 / 练习已选 / 练习全部 / 加入题组 | browser-search | 自动 |
| 搜索练习配置（数量/顺序/选项随机） | browser-search | 自动 |

### 3.6 练习中心
| 功能操作 | 覆盖位置 | 状态 |
|---|---|---|
| 随机指定题数（不修改全局配置） | browser-desktop, browser-history | 自动 |
| 全量顺序练习 | browser-desktop, browser-history, browser-review | 自动 |
| 绑定复习轮次（自动选中轮次题库） | browser-review | 自动 |
| 高级筛选（题型/状态/标签/统计/关键词/日期） | browser-review（轮次进度口径） | 部分自动 |
| 其余模式（全量随机/错题重练/收藏/复习优先/标签） | 单元测试（含个人难度、有效计时、复习优先排序） | 部分 |

### 3.7 作答
| 功能操作 | 覆盖位置 | 状态 |
|---|---|---|
| 单选/多选/判断/计算作答反馈 | browser-desktop, browser-history | 自动 |
| 个人解析 note 自动保存 | browser-desktop, browser-management | 自动 |
| 题目总览（聚焦、进度、跳题） | browser-desktop, browser-mobile | 自动 |
| 计算题精度判定 | browser-desktop | 自动 |
| 收藏题目 / 复制题目 | browser-desktop（收藏在 search 详情）、browser-search | 自动（复制→替代） |
| 左右滑动切题 | 未覆盖 | 限制（触摸手势；键盘/按钮导航已覆盖） |

### 3.8 练习记录与结果
| 功能操作 | 覆盖位置 | 状态 |
|---|---|---|
| 记录状态筛选（进行中/已完成/已放弃） | browser-history | 自动 |
| 继续练习 / 放弃练习 | browser-history | 自动 |
| 删除练习记录 | browser-history | 替代（滑动删除按钮平时被覆盖，用 dispatchEvent 直接触发删除处理器） |
| 结果页正确率 / 只看错题 / 只看未答 | browser-history | 自动 |
| 重练本次题目 / 只练本次错题 / 继续本次练习 | browser-history | 自动 |
| 结果题目详情弹窗 | browser-desktop | 自动 |

### 3.9 复习轮次
| 功能操作 | 覆盖位置 | 状态 |
|---|---|---|
| 新建轮次（命名 + 选择题库范围） | browser-review | 自动 |
| 编辑轮次（改名 / 调整范围） | browser-review | 自动 |
| 绑定轮次发起练习 | browser-review | 自动 |
| 提前结束（两次确认）→ 最终快照 | browser-review | 自动 |
| 归档 | browser-review | 自动 |
| 到期复习提醒 | 未覆盖 | 限制（依赖时间推进；轮次 CRUD 已全流程覆盖） |

### 3.10 配置
| 功能操作 | 覆盖位置 | 状态 |
|---|---|---|
| 主题（浅/深/系统）、主题勾选对齐 | browser-desktop | 自动 |
| 答题交互（自动下一题/提交判定/错题反馈等） | browser-desktop | 自动 |
| 每组题目数量 / 每日目标 / 范围口径 | browser-desktop | 自动 |
| 电脑快捷键录制 | browser-desktop | 自动 |
| 自动同步阈值触发 | browser-desktop | 自动 |
| 颜色选择器（背景色等） | 未覆盖 | 限制（原生 color picker 无法可靠自动化） |

### 3.11 同步
| 功能操作 | 覆盖位置 | 状态 |
|---|---|---|
| 401 失败提示（错误语调） | browser-desktop, browser-mobile | 自动 |
| 手动同步 → 热窗口（检查点/分段/热字节） | browser-desktop | 自动 |
| 幂等二次同步 | browser-desktop | 自动 |
| 跨设备双向合并（第二设备拉取） | browser-mobile（依赖 desktop） | 自动 |
| 事件管理（展开/编辑/删除/批量抽屉） | browser-management | 自动 |
| 本地/远端恢复、清除数据 | 未覆盖 | 限制（危险路径，需用户确认；UI 入口已断言存在） |
| 同步协议/合并/去重 | 集成测试（test-sync-integration 等） | 自动 |
| 设备同步时间起点：过滤历史、题库完整、远端保留、扩大范围补回 | test-sync-history-range / test-sync-v8-history | 自动 |

#### 删除竞争状态（跨设备 + 练习中）

| 竞争场景 | 覆盖位置 | 状态 |
|---|---|---|
| 练习中删当前题 → 自动跳过；删光全部 → 优雅结束 | browser-inflight | 自动 |
| 练习中删题库 → 置空会话、不静默丢答案（E3） | browser-inflight | 自动 |
| `savePracticeProgress` 与删题读后写竞争 → 不复活已删题（R4） | test-db-v7（S1.2） | 自动 |
| 删题级联清空跨全部历史 run 的 attempts（E5） | test-db-v7（S1.4） | 自动 |
| 删活动复习轮次中的题 → 该题作答被拒（E4） | test-db-v7（S2.5） | 自动 |
| 跨设备删题裁剪对方活动 run（行保留） | test-sync-question-management（S14） | 自动 |
| 删题把题组裁空 → 写墓碑，阻止陈旧组编辑跨设备复活（E6） | test-sync-question-management（S13） | 自动 |
| 离线编辑遇远端墓碑 → blocked（local-pending 安全路径） | test-sync-question-management（S12） | 自动 |
| 远端毒记录（与压实墓碑冲突）→ 跳过而非杀同步（Hazard） | test-sync-v7-multidevice | 自动 |
| 删独占题库级联：独占题删/共享题存活/靶向 run 墓碑（S3.1） | test-sync-question-management（S15） | 自动 |
| `deleteBankV7` 总墓碑靶向 run vs `deletePracticeRunV7` 条件墓碑（E7） | test-sync-question-management（S16） | 自动 |

#### 同步故障面与完整性（CAS + 故障注入）

使用 CAS-capable + 故障注入的 mock（`startMockGitHubServer({ cas, faults })`）与 `syncWithGitHub` 的 fetch 注入缝，覆盖传输层的并发/中断/损坏/网络失败路径。

| 故障场景 | 覆盖位置 | 状态 |
|---|---|---|
| CAS 并发推送：head PUT 409 一次 → rebase → 重新生成分段 → 提交成功（G1） | test-sync-fault-tolerance（S1） | 自动 |
| CAS 重试耗尽：持续 409 → 抛「并发更新」且 claim 释放、记录回 pending（G1） | test-sync-fault-tolerance（S2） | 自动 |
| 部分上传：segment PUT 500 → claim 释放 → 重试成功（G3） | test-sync-fault-tolerance（S3） | 自动 |
| 网络抖动：flakyFetch 500 → 重试成功、本地无半安装（G4） | test-sync-fault-tolerance（S4） | 自动 |
| 损坏 blob：checkpoint 字节翻转 → 完整性错误、本地不变（G5） | test-sync-fault-tolerance（S5） | 自动 |
| 下载失败：blob GET 500 → 干净报错、本地不变（G12） | test-sync-fault-tolerance（S6） | 自动 |
| ETag/304 not-modified 快路径（G16） | test-sync-fault-tolerance（S7） | 自动 |
| restore 丢弃未同步 pending 守卫（B1） | test-sync-fault-tolerance（S8） | 自动 |
| 中断 claim digest 不匹配降级 blocked、不崩全 sync（B2） | test-sync-fault-tolerance（S9） | 自动 |
| 乱序 pending 重放抛错时 sync 不崩（B3） | test-sync-fault-tolerance（S10） | 自动 |
| 并发 bootstrap 采纳胜者、无 split-brain（B4） | test-sync-fault-tolerance（S11） | 自动 |
| 同 realm 并发 sync 串行互斥、无 claimed 残留（B5） | test-sync-fault-tolerance（S12） | 自动 |

#### 同步完整性特征化

| 特征 | 覆盖位置 | 状态 |
|---|---|---|
| 检查点 encode→parse 往返保真：15 表 deep-equal + imageAssets 描述符子集（无 blob）+ 墓碑保留（G6） | test-sync-integrity | 自动 |
| 4MiB 检查点压缩后新设备全量恢复 | test-sync-coalescing（scenario 4） | 自动 |
| coalesce 重放等价：合并后新设备数据完整（含卸载对象 stub） | test-sync-coalescing（scenario 5/6） | 自动 |
| committed 裁剪（>500 条）后数据完整可重建 | test-sync-question-management（scenario 7） | 自动 |

### 3.12 移动端
| 功能操作 | 覆盖位置 | 状态 |
|---|---|---|
| 导航抽屉、移动端菜单 | browser-mobile | 自动 |
| 模板 Web Share → 下载兜底 | browser-mobile | 自动（下载兜底路径） |
| 暂停返回首页 / 继续上次练习 | browser-mobile | 自动 |
| 移动端同步设置卡片 | browser-mobile | 自动 |

## 4. 已知限制与替代方式

| 交互 | 处理 | 原因 |
|---|---|---|
| HTML5 拖拽排序 | **替代**：题组「上/下移」按钮（browser-search 已断言交换） | 原生 DnD 在可见 Chrome 下不稳定 |
| 触摸滑动删除 | **替代**：删除按钮平时被 swipe-content 覆盖，测试用 `dispatchEvent("click")` 直接触发删除处理器 | 真实滑动需 setPointerCapture，合成事件不可靠 |
| 触摸左右滑切题 | **限制**：不自动测 | 上一题/下一题按钮与键盘导航已覆盖等价行为 |
| 剪贴板复制 | **替代**：仅断言复制状态切换 | 剪贴板权限在多进程环境不稳定 |
| 长按恢复（同步页） | **限制**：不自动测 | 长按计时不稳定 |
| 颜色选择器 | **限制**：不自动测 | 原生 color picker 无法被 Playwright 稳定驱动 |
| Web Share 分享 | **替代**：断言不可用时回退下载 | 真实分享面板不可自动化 |
| 到期复习提醒 / 本地远端恢复 / 清除数据执行 | **限制**：不自动执行 | 依赖时间推进或危险路径，入口已断言存在 |
| 图片缓存执行 | **限制**：不自动执行 | 依赖大量真实图片资源 |
| 跨标签页并发同步 | **限制**：仅同 realm 串行（模块级互斥），跨标签页需 Web Locks | `syncWithGitHub` 的 B5 互斥只覆盖单 realm；浏览器多标签页另议 |
| 检查点 >32MiB 缩放悬崖 | **限制**：特征化记录 | `putImmutable` 对超限检查点抛错，分块/归档裁剪不在范围 |

## 5. 常用命令

```bash
make help                    # 全部命令
make dev                     # 启动开发服务器
make mock                    # 启动 mock GitHub 服务器
make test-fast               # 日常快测（不含构建）
make test                    # 完整 CI
make test-browser-search     # 只跑搜索场景
make test-browser-mobile     # 移动端（自动先跑 desktop）
make test-browser            # 全部浏览器场景
CHROME_PATH=/usr/bin/chromium BROWSER_PORT=5174 npm run test:browser-smoke  # 指定浏览器和严格端口的 Ubuntu 冒烟
PWA_PREVIEW_PORT=4174 npm run test:pwa-smoke  # production build + Vite preview + 真实 SW
```

## 6. PWA 构建、预览与部署缓存

`npm run test:pwa` 是快速源码边界检查；`npm run test:pwa-smoke` 才会构建 Cloudflare Pages 根路径产物（`CF_PAGES=1`），启动带 `--strictPort` 的 `vite preview`，用真实 Chromium 打开页面并在 reload 后确认：页面由 `sw.js` 接管、`shijuan-v10` 缓存已安装、app shell 已进入 Cache Storage、服务 worker 源码来自预览产物。默认使用 `PWA_PREVIEW_PORT=4173`，需要并行运行时显式换端口。

Cloudflare Pages 读取 `public/_headers`：入口 HTML、`sw.js`、manifest、固定名称图标和路由配置均 `no-cache, must-revalidate`；Vite 生成的内容哈希 `/assets/*` 才使用一年 `immutable`。GitHub Pages 不执行 `_headers`，因此 Service Worker 的 `updateViaCache: "none"`、HTML `no-cache` 请求和版本化缓存清理是客户端兜底；部署后应使用不带浏览器缓存的 `curl` 检查首页、`sw.js` 和 manifest 是否为本次构建内容。

测试清单唯一来源是 `scripts/tools/test-groups.mjs`。`test:architecture` 会运行 `check-test-registration.mjs`，扫描 `scripts/tests/test-*` 与 `package.json` 的脚本引用；任何新增但未登记的测试文件、组里不存在的 npm script 都会阻止 CI。
