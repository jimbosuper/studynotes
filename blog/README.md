# JimBo的米奇妙妙屋

个人全栈知识库，把散落在本地的技术笔记整理成一个可持续维护的站点：计算机基础、产品、UI、架构、前端、后端、测试、运维、AI 九个方向。

- 线上地址：<https://studynotes-90w.pages.dev>
- 源码仓库：<https://github.com/jimbosuper/studynotes>
- 技术栈：VuePress 2 + vuepress-theme-hope 2 + Vite
- 部署：Cloudflare Pages（推 `master` 自动构建发布）

## 特性

- **文档型首页**：hero + 九大方向入口 + 常见问题，极光背景固定于视口
- **笔记即目录**：侧边栏由 `src/notes/` 的真实目录树生成，保留 `00-`、`01-` 序号，新增笔记无需改配置
- **`/notes/` 自动目录页**：构建前扫描全部笔记，按方向分组并统计篇数
- **阅读体验**：正文在侧边栏与右侧「此页内容」之间居中，右侧目录在大屏固定加宽
- **默认浅色**：右上角可手动切换深色，不跟随系统设置
- **全文搜索**：slimsearch，纯前端索引
- **Markdown 增强**：Mermaid 图表、数学公式、提示块、图片懒加载与尺寸标记
- **SEO**：sitemap、RSS / Atom、Open Graph

## 目录结构

```text
blog/
├─ scripts/
│  └─ gen-notes-index.mjs      # 扫描笔记目录，生成 /notes/ 目录页
├─ src/
│  ├─ .vuepress/
│  │  ├─ config.ts             # 站点基础配置（标题、描述、打包）
│  │  ├─ theme.ts              # 主题配置（导航、插件、域名）
│  │  ├─ navbar.ts             # 顶部导航
│  │  ├─ sidebar.ts            # 按磁盘目录生成侧边栏
│  │  ├─ public/               # 头像、favicon 等静态资源
│  │  └─ styles/               # 调色板与页面样式
│  ├─ index.md                 # 首页
│  ├─ notes/                   # 全部笔记（00-08 九个方向）
│  ├─ projects/                # 全栈项目（待补充）
│  ├─ workflow/                # Agent 工作流（待补充）
│  └─ resources/               # 优质资源（待补充）
├─ wrangler.jsonc              # 备用：Workers 静态资源部署配置
├─ package.json
└─ README.md
```

## 本地开发

需要 Node.js 20+（推荐 22）。

```bash
npm install
npm run dev        # http://localhost:8080
```

其他命令：

```bash
npm run build      # 产物输出到 src/.vuepress/dist
npm run gen:notes  # 只重新生成 /notes/ 目录页
npm run clean-dev  # 清理缓存后启动
```

> `dev` 与 `build` 都会先执行 `gen:notes`，所以目录页永远和实际笔记一致。

## 写一篇新笔记

在对应方向下按序号建目录和文件，例如：

```text
src/notes/09-新方向/01-新章节/01-新笔记.md
```

文件开头写 frontmatter：

```yaml
---
title: 笔记标题
date: 2026-10-27
category: 新方向
tags:
  - 标签
---
```

正文里的图片放在同目录的 `assets/` 下，用相对路径引用：

```md
![示意图](./assets/示意图.png)
```

保存后：

- 侧边栏自动出现 `09-新方向 / 01-新章节 / 01-新笔记`
- `/notes/` 目录页的篇数自动更新
- 本地开发时热更新，线上则等一次 `git push`

排序规则是文件名前的数字，所以新增章节记得保持 `01-`、`02-` 的前缀习惯。

## 部署

仓库根目录是 `blog/`，Cloudflare Pages 配置如下：

| 配置项 | 值 |
| --- | --- |
| Production branch | `master` |
| Build command | `npm run build` |
| Build output directory | `src/.vuepress/dist` |
| Root directory | 留空 |
| 环境变量 | `NODE_VERSION=22` |

推送代码到 `master` 后，Cloudflare 自动拉取、构建、发布，通常 3–5 分钟。

改用自定义域名时，除了在 Cloudflare 绑定域名，还需要同步修改 `src/.vuepress/theme.ts` 中的 `hostname`、`author.url`、`sitemap.hostname`，否则 sitemap 和 RSS 里的链接仍指向旧地址。

## 说明

- `src/notes/index.md` 由脚本生成，请勿手改
- 笔记路径含中文，构建产物中对应目录名会做 URL 编码，属正常现象
- Cloudflare 单项目限制 20,000 个文件、单文件 25 MiB，当前产物远低于上限

## License

文档内容采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 许可，署名非商业性使用、相同方式共享。

Copyright © 2026 JimBo
