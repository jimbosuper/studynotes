# AGENTS.md

本文件面向前来协作的 AI Agent 与人类贡献者，说明这个仓库怎么组织、怎么跑、哪些东西不能乱改。

## 仓库定位

这是一个**发布端仓库**，不是内容仓库。

```text
内容源（独立仓库）              本仓库（发布端）
../fullstack-notes    ──sync──▶  blog/src/notes/
../fullstack-workflow ──sync──▶  blog/src/workflow/ + docs/99-模板文档/
```

**改内容去改源仓库。** `blog/src/notes/` 与 `blog/src/workflow/` 是同步产物，手改会被下一次 `npm run sync` 覆盖。

## 仓库布局

```text
studynotes/          # Git 仓库根
├─ README.md
├─ AGENTS.md         # 本文件
├─ docs/             # 项目文档，8 个目录，结构固定
│  ├─ README.md                     # 在途需求表 + 状态定义 + 不适用产物清单
│  ├─ 01-产品/                      # PRD + 术语表（无 BRD/MRD）
│  ├─ 02-设计/                      # 原型图 + 页面规格（无设计系统登记）
│  ├─ 03-架构/                      # 系统架构 + 架构图示 + 环境规范（无 DB/ER/状态机）
│  ├─ 04-开发/                      # 代码规范 + 技术方案 + 实现记录
│  ├─ 05-测试/                      # 测试策略 + 测试方案 + 测试报告（无 test/ 目录）
│  ├─ 06-运维/                      # 服务详情 + 部署拓扑 + 运维手册 + 发布记录
│  ├─ 07-审查/                      # 审查清单 + 审查报告
│  ├─ 99-tmp/                       # 临时区，不入库
│  ├─ 99-外部文档/                  # 对外联调资料（当前为空）
│  └─ 99-模板文档/                  # 同步产物：7 份 v1.0 模板（01–06 + README）
└─ blog/             # 站点工程
   ├─ package.json
   ├─ scripts/
   │  ├─ sync-content.mjs      # 单向同步 + 修补 + 校验
   │  ├─ sync-project.mjs      # docs/ → src/projects/01-米奇妙妙屋（含 iframe 产物页）
   │  └─ gen-notes-index.mjs   # 递归生成 /notes/ 目录页
   ├─ wrangler.jsonc           # 备用：Workers 静态资源部署
   └─ src/
      ├─ .vuepress/   # config.ts / theme.ts / navbar.ts / sidebar.ts / styles
      │  └─ public/project-assets/  # proto.html / arch.html / topo.html（sync:project 拷入）
      ├─ index.md     # 首页（10 个方向的 feature 卡片）
      ├─ notes/       # 全栈笔记（同步产物，10 方向 219 篇）
      ├─ workflow/    # Agent 工作流（同步产物，00-导读 + 01–06 + 首页）
      ├─ projects/    # 全栈项目：00-内容导读 + 01-米奇妙妙屋（七个角色目录由 sync:project 生成）
      ├─ methods/     # 学习方法（手写，目录 + 8 个模型入口）
      └─ resources/   # 优质资源（手写，分类表 + 收录规则）
```

## 常用命令

全部在 `blog/` 目录执行：

```bash
npm install
npm run sync          # 从两个源仓库拉内容（首次必须）
npm run sync:project  # 把 <仓库根>/docs/ 镜像成 src/projects/01-米奇妙妙屋
npm run dev           # 开发服务器 http://localhost:8080
npm run build         # 产物 blog/src/.vuepress/dist
npm run gen:notes     # 只重新生成 /notes/ 目录页
npm run clean-dev     # 清缓存后启动
```

`dev` 与 `build` 会先执行 `gen:notes`，**但不会自动 sync 或 sync:project**。内容仓库有更新时先手动 `npm run sync`；`docs/` 有更新时先手动 `npm run sync:project`。

源仓库不在默认位置时：

```bash
NOTES_SRC=/path/to/fullstack-notes WORKFLOW_SRC=/path/to/fullstack-workflow npm run sync
```

## 同步做了什么

`scripts/sync-content.mjs` 是唯一入口，它做四件事：

1. **复制**：两个源仓库 → `src/notes/`、`src/workflow/`、`docs/99-模板文档/`
2. **改名**：路径里的 `C++` 改成 `Cpp`。VuePress 会把 `+` 转义成 `_`，不改 `/notes/` 目录页那条链接会 404
3. **修补**：三种源库写法会让 Vue 编译失败或渲染残缺，同步时自动处理
   - 标题带 `01-` 序号 → 去掉序号（页面标题不该带编号）
   - 行内代码里的 `${{ github.sha }}` → 包 `<span v-pre>`，否则 Vue 当插值，抛 TypeError 让整页内容残缺
   - 源库 README → `notes/00-导读.md`；无 H1 的页面补 `title`
4. **校验**：扫全站 Markdown 的跨篇链接与图片引用，断链或缺图直接报出来，退出码非 0

验证：

```bash
npm run sync
# 结尾应是「校验：无断链、无缺图」
```

## 内容约定（写源仓库时遵守）

- 目录与文件名保留数字前缀：`00-计算机基础`、`01-数据结构`、`01-绪论`。排序依赖这些前缀
- `05-后端` 比其他方向多一层：`语言 / 语法 | 常用库 | 工程化 | 数据库 | 常用框架 | 微服务 / 篇`。侧边栏与目录页都支持三层
- 图片放在章节同级的 `assets/`，用 `./assets/xxx.png` 引用。**不要放在笔记同目录**，源库统一在章节层
- 路径含中文，链接一律用相对路径，不手写 URL 编码
- 每个文件第一行是一个 `# 标题`，不带数字序号
- 正文里的 `${{ … }}`（GitHub Actions 表达式）必须写进行内代码，同步脚本会加保护；写成裸文本会破坏构建
- 结构性关系用 Mermaid 内联（` ```mermaid `），不额外生成图片

## 不提交的东西

```text
blog/node_modules/
blog/src/.vuepress/dist/
blog/src/.vuepress/.cache/
blog/src/.vuepress/.temp/
blog/.wrangler/
*.log
.DS_Store
.openchamber/
```

## 视觉与配置约定

- 站点默认浅色（`theme.ts` 中 `darkmode: "toggle"`），不要改回跟随系统
- 内容宽度、正文居中、右侧目录宽度在 `styles/index.scss` 与 `styles/palette.scss`，改动后同时检查 1512px 与 1920px
- 域名出现在 `theme.ts` 的 `hostname`、`author.url`、`sitemap.hostname` 三处，换域名要一起改
- 首页内容在 `src/index.md`，样式限定在 `.home-aurora` 作用域内，不要写成全局选择器
- `notes/index.md` 由 `scripts/gen-notes-index.mjs` 生成，**禁止手改**；要改样式就改脚本
- `notes/`、`workflow/` 与 `projects/01-米奇妙妙屋/0N-*` 七个角色目录是同步产物，**禁止手改**
- `projects/00-内容导读`（即 `projects/README.md`，带 `permalink`）、`projects/01-米奇妙妙屋/{index,00-项目介绍}.md` 是手写

## 部署约定

- 仓库分支：`master`
- Cloudflare Pages：Root directory `blog`，构建命令 `npm run build`（线上没有源仓库，只构建已提交内容），输出 `src/.vuepress/dist`
- 推送 `master` 即自动部署，不需要 GitHub Actions
- 构建产物体积：当前 365 页、1,841 个文件、235 MB，Cloudflare 上限是 20,000 文件 / 单文件 25 MiB，还有余量
- 新增内容后**必须把同步产物一起提交**，否则线上还是旧内容

## 改动纪律

- 改内容：去源仓库改，回来跑 `npm run sync`，再提交同步产物
- 改项目文档：改 `<仓库根>/docs/`，回来跑 `npm run sync:project`，再提交 `src/projects/01-米奇妙妙屋` 的七个角色目录与 `public/project-assets/`；**`00-项目介绍`、`index.md`、`projects/README.md` 是手写，脚本不碰**
- 改站点：直接改 `blog/src/.vuepress/` 或 `blog/scripts/`
- 修改配置或布局后至少跑一次 `npm run build`，确认 365 页全部渲染、无 Vue 编译报错
- 提交信息用「类型: 说明」格式，例如 `feat: 接入全栈笔记 v3`、`docs: 更新部署说明`

## 文档口径

`docs/` 是「全栈项目」栏目的内容源，会被读者直接看到，所以按**已交付**的口径写：

- 状态只写实际值：`已放行 · JimBo · <日期>`、`已通过（CR1，第 1 轮）`。不写「待确认」「待验收」「未验证」这类过程态
- 产物写完就是完整产物，不写「事后补」「事后归纳」「当时没留下」这类自述
- 缺的产物要在 `docs/README.md` 第五节与项目 `00-项目介绍` 里逐条说明理由，**不留下没解释的空位**
- 数字一律是构建产物实测值（页数、文件数、体积、链接数、用例数）。改完 `npm run build` 后同步更新 `AGENTS.md` 与相关文档里的数字
