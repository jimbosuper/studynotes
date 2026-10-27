# JimBo的米奇妙妙屋

> 简洁·核心·不烧心的全栈知识库

个人全栈知识库站点：把散落在本地的技术笔记整理成一个可持续维护、可检索的在线文档库，覆盖计算机基础、产品、UI、架构、前端、后端、测试、运维、AI 九个方向。

- 线上地址：<https://studynotes-90w.pages.dev>
- 站点源码：[`blog/`](./blog)
- 项目文档：[`docs/`](./docs)

## 仓库结构

```text
studynotes/
├─ README.md          # 仓库总览（本文件）
├─ AGENTS.md          # 给 AI 协作者 / 新人的约定
├─ docs/              # 项目文档：部署、维护、写笔记规范
└─ blog/              # 站点工程（VuePress 项目）
   ├─ package.json
   ├─ scripts/        # 生成 /notes/ 目录页的脚本
   └─ src/
      ├─ .vuepress/   # 站点配置、导航、侧边栏、样式
      ├─ index.md     # 首页
      └─ notes/       # 全部笔记（00-08 九个方向）
```

笔记内容与站点配置放在一起，是因为 VuePress 要求 `.vuepress` 与 Markdown 内容位于同一个源目录；`docs/` 只放项目级文档，不参与构建。

## 本地开发

```bash
cd blog
npm install
npm run dev      # http://localhost:8080
```

构建：

```bash
cd blog
npm run build    # 产物在 blog/src/.vuepress/dist
```

## 写笔记

在 `blog/src/notes/<方向>/<章节>/` 下按 `01-`、`02-` 前缀新建 Markdown 文件即可，侧边栏与 `/notes/` 目录页会自动更新。详细规范见 [docs/writing.md](./docs/writing.md)。

## 部署

GitHub 推送到 `master` 后由 Cloudflare Pages 自动构建发布。关键配置：

| 配置项 | 值 |
| --- | --- |
| Root directory | `blog` |
| Build command | `npm run build` |
| Build output directory | `src/.vuepress/dist` |
| 环境变量 | `NODE_VERSION=22` |

完整步骤与排错见 [docs/deploy.md](./docs/deploy.md)。

## 技术栈

VuePress 2 · vuepress-theme-hope 2 · Vite · Cloudflare Pages

## License

文档内容采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 许可。

Copyright © 2026 JimBo
