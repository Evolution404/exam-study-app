# 拾卷（Exam Study App）

公开访问的本地优先背题软件。网页本身只包含程序代码，不包含任何用户题库、解析或练习记录。每位用户通过自己的 GitHub 令牌连接自己的私有资料库，数据彼此隔离。

线上地址：<https://evolution404.github.io/exam-study-app/>

## 数据边界

- 公开仓库：界面、练习逻辑和 GitHub 同步代码。
- 浏览器 IndexedDB：当前设备的题库、作答、错题和解析。
- 用户自己的私有 GitHub 仓库：跨设备同步事件。
- GitHub 令牌：只保存在当前浏览器会话，不写入代码或题库。

本仓库不允许提交真实题库文件。项目所有者的送电线路工题库位于私有 `exam-study-vault` 中。

## 使用

1. 打开线上地址，进入“同步”。
2. 填写自己的私有资料库名称，默认 `exam-study-vault`。
3. 输入只授权该私有仓库、具有 Contents 读写权限的细粒度 GitHub 令牌。
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
