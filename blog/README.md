# 站点工程

VuePress 2 + vuepress-theme-hope 2，发布在 Cloudflare Pages：<https://studynotes-90w.pages.dev>

**内容不在这里。** 三个来源，三条同步：

| 内容 | 来源 | 同步到 | 命令 |
| --- | --- | --- | --- |
| 全栈笔记 | `../../fullstack-notes` | `src/notes/` | `npm run sync` |
| Agent 工作流 | `../../fullstack-workflow`（`backup-docs/`） | `src/workflow/` + `../docs/99-模板文档/` | `npm run sync` |
| 全栈项目文档 | `../docs/` | `src/projects/01-米奇妙妙屋/` + `public/project-assets/` | `npm run sync:project` |

## 命令

```bash
npm install
npm run sync          # 从两个内容源仓库拉笔记与工作流（首次必须）
npm run sync:project  # 从 ../docs/ 生成项目栏目（首次也必须）
npm run dev           # http://localhost:8080
npm run build         # 产物在 src/.vuepress/dist
npm run gen:notes     # 只重新生成 /notes/ 目录页
npm run clean-dev     # 清缓存后启动
```

`dev` 与 `build` 都会先跑 `gen:notes`，但**不会**自动 `sync` 或 `sync:project`。

## 目录

```text
blog/
├─ scripts/
│  ├─ sync-content.mjs      # 单向同步 + 修补 + 校验断链/缺图
│  ├─ sync-project.mjs      # docs/ → src/projects/01-米奇妙妙屋，含 iframe 产物页
│  └─ gen-notes-index.mjs   # 递归生成 /notes/ 目录页
├─ src/
│  ├─ .vuepress/
│  │  ├─ config.ts          # 站点基础配置
│  │  ├─ theme.ts           # 主题、插件、域名
│  │  ├─ navbar.ts          # 顶部导航（首页 / 全栈笔记 / 全栈项目 / Agent工作流 / 优质资源 / 学习方法）
│  │  ├─ sidebar.ts         # 按磁盘目录生成，支持三层
│  │  ├─ public/            # avatar.png、favicon.svg、project-assets/（原型 / 架构图 / 部署拓扑）
│  │  └─ styles/            # palette.scss、index.scss
│  ├─ index.md              # 首页
│  ├─ notes/                # 同步产物：10 方向 219 篇
│  ├─ workflow/             # 同步产物：00-导读 + 01–06（v1.1.0 7 份）+ 首页
│  ├─ projects/             # 00-内容导读 + 01-米奇妙妙屋（七个角色目录由 sync:project 生成）
│  ├─ methods/              # 手写：学习方法目录
│  └─ resources/            # 手写：优质资源分类与规则
├─ wrangler.jsonc           # 备用：Workers 静态资源
└─ package.json
```

## 同步修什么

源库有三种写法会让 Vue 编译失败或渲染残缺，`sync-content.mjs` 自动处理：

| 源库写法 | 问题 | 处理后 |
| --- | --- | --- |
| `# 01-软件工程图典` | 页面标题带编号 | 去掉 `01-` |
| `` `${{ github.sha }}` `` | Vue 当插值，整页内容残缺 | 包 `<span v-pre>` |
| 路径含 `C++` | 构建后变 `04-C__`，目录页 404 | 改名 `Cpp` |

同步结束会校验跨篇链接与图片引用，应为「校验：无断链、无缺图」。

## 部署

Cloudflare Pages，Root directory `blog`，构建命令 `npm run build`，输出 `src/.vuepress/dist`。详见 [`../docs/06-运维/03-运维手册.md`](../docs/06-运维/03-运维手册.md)。
