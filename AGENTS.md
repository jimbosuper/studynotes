# AGENTS.md

本文件面向前来协作的 AI Agent 与人类贡献者，说明这个仓库怎么组织、怎么跑、哪些东西不能乱改。

## 仓库布局

```text
studynotes/          # Git 仓库根
├─ README.md         # 项目总览
├─ AGENTS.md         # 本文件
├─ docs/             # 项目文档（部署、维护、写作规范）
└─ blog/             # 站点工程，所有 npm 命令都在这里执行
   ├─ package.json
   ├─ scripts/gen-notes-index.mjs
   ├─ wrangler.jsonc   # 备用：Cloudflare Workers 部署配置
   └─ src/
      ├─ .vuepress/    # config.ts / theme.ts / navbar.ts / sidebar.ts / styles
      ├─ index.md      # 首页
      ├─ notes/        # 笔记内容
      ├─ projects/     # 全栈项目（占位）
      ├─ workflow/     # Agent 工作流（占位）
      └─ resources/    # 优质资源（占位）
```

## 常用命令

全部在 `blog/` 目录执行：

```bash
npm install
npm run dev        # 开发服务器 http://localhost:8080
npm run build      # 产物 blog/src/.vuepress/dist
npm run gen:notes  # 只重新生成 /notes/ 目录页
npm run clean-dev  # 清缓存后启动
```

`dev` 与 `build` 都会先执行 `gen:notes`。

## 内容约定

- 笔记放在 `blog/src/notes/<方向>/<章节>/`，目录与文件名保留数字前缀：`00-计算机基础`、`01-数据结构`、`01-绪论`…，排序依赖这些前缀，不要去掉
- 路径含中文，链接一律用相对路径，不要手写 URL 编码
- 图片放在笔记同级的 `assets/` 目录，用 `./assets/xxx.png` 引用
- 侧边栏由 `blog/src/.vuepress/sidebar.ts` 扫描磁盘生成，新增笔记不需要改任何配置
- `blog/src/notes/index.md` 由 `scripts/gen-notes-index.mjs` 生成，**禁止手改**；要改样式就改脚本
- 新方向、新章节直接建目录，重启 dev 或重新构建即可生效

## 视觉与配置约定

- 站点默认浅色（`theme.ts` 中 `darkmode: "toggle"`），不要改回跟随系统
- 内容宽度、正文居中、右侧目录宽度在 `styles/index.scss` 与 `styles/palette.scss`，改动后需同时检查 1512px 与 1920px 两个宽度
- 域名出现在 `theme.ts` 的 `hostname`、`author.url`、`sitemap.hostname` 三处，换域名要一起改
- 首页内容在 `src/index.md`，其样式限定在 `.home-aurora` 作用域内，不要写成全局选择器

## 部署约定

- 仓库分支：`master`
- Cloudflare Pages：Root directory 必须为 `blog`，构建命令 `npm run build`，输出目录 `src/.vuepress/dist`
- 推送 `master` 即自动部署，不需要 GitHub Actions
- 构建产物体积受 Cloudflare 限制：单项目 20,000 个文件、单文件 25 MiB

## 改动纪律

- 不要提交 `node_modules`、`blog/src/.vuepress/dist`、`.cache`、`.temp`、`.wrangler`
- 不要提交 `.openchamber/`（本地工具产物）
- 修改配置或布局后至少跑一次 `npm run build`，确认构建通过再提交
- 提交信息用「类型: 说明」的格式，例如 `style: 默认浅色外观`、`docs: 补充部署说明`
