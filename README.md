# 拾卷（Exam Study App）

公开访问的本地优先背题软件。网页本身只包含程序代码，不包含任何用户题库、解析或练习记录。每位用户通过自己的 GitHub 令牌连接自己的私有资料库，数据彼此隔离。

线上地址：<https://evolution404.github.io/exam-study-app/>

## 数据边界

- 公开仓库：界面、练习逻辑和 GitHub 同步代码。
- 浏览器 IndexedDB：当前设备的题库、作答、错题和解析。
- 用户自己的私有 GitHub 仓库：跨设备同步事件。
- GitHub 令牌：会持久保存在当前设备的浏览器本地存储中，直到你主动清除；不会写入题库或同步到远端资料库。
- GitHub API 中继：Cloudflare Pages 默认使用同源 `/api-github`；GitHub Pages 因不能运行 Function，默认使用配套的 `https://sync.980923.xyz` Worker。中继只允许同步所需的 GitHub API 路径与方法；如果改成自定义地址，请只使用自己信任的部署，因为中转服务会处理带令牌的请求。

本仓库不允许提交真实题库文件。项目所有者的送电线路工题库位于私有 `exam-study-vault` 中。

## 使用

1. 打开线上地址，进入“同步”。
2. 填写自己的私有资料库名称，默认 `exam-study-vault`。
3. 输入只授权该私有仓库、具有 Contents 读写权限的细粒度 GitHub 令牌。令牌会保存在这台设备的浏览器中，方便下次同步；共享设备上请在“同步”页清除本机数据，或在令牌管理页面撤销它。
4. 点击“立即同步”。软件会通过令牌识别 GitHub 用户，并只读取该用户有权访问的资料库。

也可以不连接 GitHub，直接导入本地 JSON 题库；此时数据只保存在当前浏览器。

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

推送 `main` 后，GitHub Actions 自动构建并发布 GitHub Pages。
