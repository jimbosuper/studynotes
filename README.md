# JimBo的米奇妙妙屋

个人全栈知识库站点。五个栏目：

- **全栈笔记**：10 个方向、219 篇工程笔记，从计算机怎么执行指令写到一个大模型应用怎么上线
- **全栈项目**：完整交付链的实战项目。第一个项目「米奇妙妙屋」的七类产物镜像在站内，含可交互原型、架构图示与部署拓扑
- **Agent 工作流**：一套「AI + 人」的端到端交付规范，v1.1.0 定稿的 7 份文档，七个岗位角色与八道门
- **优质资源**：外部文档、工具、开源项目，按分类与收录规则收集
- **学习方法**：学习金字塔、布鲁姆层级等认知模型，决定「怎么读」

> **这两个内容库不在本仓库里。** 它们各自是独立仓库，站点只是发布端：
>
> | 内容 | 源仓库 | 同步到 |
> | --- | --- | --- |
> | 全栈笔记 | `../fullstack-notes` | `blog/src/notes/` |
> | Agent 工作流 | `../fullstack-workflow`（取 `backup-docs/`） | `blog/src/workflow/` + `docs/99-模板文档/` |
>
> **全栈项目栏目还有第三个来源：本仓库的 `docs/`。** 它镜像到 `blog/src/projects/01-米奇妙妙屋/`，同步命令是 `npm run sync:project`。
>
> **改内容去改源仓库，不要改 `blog/src/notes/`、`blog/src/workflow/` 与项目的七个角色目录——下一次同步会覆盖。**

- 线上地址：<https://studynotes-90w.pages.dev>
- 站点工程：[`blog/`](./blog)
- 项目文档：[`docs/`](./docs)

## 仓库结构

```text
studynotes/
├─ README.md          # 仓库总览（本文件）
├─ AGENTS.md          # 给 AI 协作者 / 新人的约定
├─ docs/              # 项目文档，8 个目录；同时是「全栈项目」栏目的内容源
│  ├─ 01-产品/ … 07-审查/
│  └─ 99-模板文档/     # Agent 工作流模板的副本（也由同步生成）
└─ blog/              # 站点工程（VuePress）
   ├─ package.json
   ├─ scripts/
   │  ├─ sync-content.mjs      # 从两个源仓库同步内容
   │  ├─ sync-project.mjs      # docs/ → src/projects/01-米奇妙妙屋
   │  └─ gen-notes-index.mjs   # 生成 /notes/ 目录页
   └─ src/
      ├─ .vuepress/   # 站点配置、导航、侧边栏、样式
      │  └─ public/project-assets/  # 原型 / 架构图 / 部署拓扑（iframe 内嵌用）
      ├─ index.md     # 首页
      ├─ notes/       # 全栈笔记（同步产物）
      ├─ workflow/    # Agent 工作流（同步产物）
      ├─ projects/    # 全栈项目（导读与项目介绍手写，七个角色目录由 sync:project 生成）
      ├─ methods/     # 学习方法（手写）
      └─ resources/   # 优质资源（手写）
```

## 本地开发

```bash
cd blog
npm install
npm run sync          # 首次必须先跑：笔记与工作流不在仓库里
npm run sync:project  # 首次也必须跑：项目栏目从仓库根的 docs/ 镜像
npm run dev           # http://localhost:8080
```

`dev` 与 `build` 都会先执行 `gen:notes`，但**不会**自动 `sync`——内容变了要手动跑 `npm run sync`；`docs/` 变了要手动跑 `npm run sync:project`。

源仓库不在默认位置时用环境变量指定：

```bash
NOTES_SRC=/path/to/fullstack-notes WORKFLOW_SRC=/path/to/fullstack-workflow npm run sync
```

## 常用命令

全部在 `blog/` 执行：

| 命令 | 作用 |
| --- | --- |
| `npm run sync` | 从两个源仓库拉内容，顺带修 Markdown、补 frontmatter、校验断链与缺图 |
| `npm run sync:project` | 把仓库根的 `docs/` 镜像成 `src/projects/01-米奇妙妙屋`，并拷 3 个 HTML 产物到 `public/project-assets/` |
| `npm run gen:notes` | 只重新生成 `/notes/` 目录页 |
| `npm run dev` | 开发服务器 |
| `npm run build` | 构建，产物在 `src/.vuepress/dist` |
| `npm run clean-dev` | 清缓存后启动 |

## 部署

推送到 `master` 后由 Cloudflare Pages 自动构建发布。

| 配置项 | 值 |
| --- | --- |
| Production branch | `master` |
| Root directory | `blog` |
| Build command | `npm run build` |
| Build output directory | `src/.vuepress/dist` |
| 环境变量 | `NODE_VERSION=22` |

> Cloudflare 构建环境里没有 `../fullstack-notes` 与 `../fullstack-workflow`，所以线上构建只用 `npm run build`——三个源（两个内容库 + `docs/`）的同步产物都已经提交进本仓库。完整步骤见 [docs/06-运维/03-运维手册.md](./docs/06-运维/03-运维手册.md)，写内容的约定见 [docs/04-开发/01-代码规范.md](./docs/04-开发/01-代码规范.md)。

## 技术栈

VuePress 2 · vuepress-theme-hope 2 · Vite · Cloudflare Pages

## License

文档内容采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 许可。

Copyright © 2026 JimBo
