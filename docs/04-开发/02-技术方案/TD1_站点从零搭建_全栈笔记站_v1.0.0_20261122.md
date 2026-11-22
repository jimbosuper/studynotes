> **TD1** · 技术方案 · v1.0.0（**链版本**）· 2026-11-22
> **审查**：已通过（CR2，第 1 轮）
> **放行**：已放行 · JimBo · 2026-11-22
> **上游**：PRD1 v1.0.0
> **下游**：实现记录 v1.0.0、TP1 v1.0.0

# 站点从零搭起来

## 一、业务怎么建模

### 1.1 状态

**没有带状态字段的实体。** 站点是无状态静态产物。

有状态的是「内容」，但它不落库，只在 Git 里：

| 层 | 形态 | 谁改 |
|---|---|---|
| 源库 | 两个独立仓库的 Markdown | 我 |
| 站点内容 | `blog/src/` 下的目录与文件 | 同步脚本，或手写 |
| 构建产物 | `blog/src/.vuepress/dist/` | `npm run build` |

### 1.2 数据

**数据是目录树，不是记录。** 这个选择决定后面所有实现：

| 问题 | 目录树回答 | 数据库回答 |
|---|---|---|
| 一篇笔记归哪 | 看它在哪个目录 | 存 `category_id` |
| 怎么排序 | 看文件名前缀 | 存 `sort` 字段 |
| 导航结构 | 目录树本身就是 | `parent_id` 建树 |
| 新增一篇 | 建一个文件 | 插记录 + 刷缓存 |

**选目录树的理由**：笔记本身就是文件。写的时候在编辑器按目录整理，读的时候也按目录找。加数据库等于同一结构维护两遍。

## 二、接口契约

### 2.1 站点对外

静态站没有 API，对外只有 HTTP GET。

| 路径 | 返回 | 说明 |
|---|---|---|
| `/` | 首页 | 介绍 + 五栏目入口 |
| `/notes/` | 笔记目录页 | 全部方向索引 |
| `/notes/<方向>/` | 方向首屏 | 章节列表（主题自动生成） |
| `/notes/<方向>/<章节>/` | 章节首屏 | 篇列表（主题自动生成） |
| `/notes/<方向>/<章节>/<篇>.html` | 正文 | — |
| `/projects/` `/workflow/` `/resources/` `/methods/` | 各栏目首屏 | — |
| `/atom.xml` `/sitemap.xml` `/robots.txt` | 派生文件 | 构建时生成 |
| 未知路径 | `404.html` | — |

**方向首屏与章节首屏不是我写的**，是主题发现目录下没有 `index.md` 时自动生成的。这条省掉大量手工维护。

### 2.2 构建入口

| 命令 | 做什么 |
|---|---|
| `npm run dev` | 开发服务器，热更新，8080 |
| `npm run build` | 静态产物到 `src/.vuepress/dist/` |
| `npm run sync` | 从源库拉内容（§3.4） |
| `npm run gen:notes` | 重生成 `/notes/` 目录页 |
| `npm run clean-dev` | 清缓存后起 dev |

`dev` 与 `build` 都先跑 `gen:notes`，因为目录页依赖磁盘扫描。

## 三、关键逻辑

### 3.1 骨架：起一个 theme-hope 站

参考官方文档的三件套，顺序不能乱：

```text
1. npm init + 装 vuepress@2 / vuepress-theme-hope@2 / @vuepress/bundler-vite
2. src/.vuepress/config.ts —— 站点级：语言、标题、描述、head 注入、打包参数
3. src/.vuepress/theme.ts  —— 主题级：导航、侧栏、插件、Markdown 增强
4. src/index.md            —— 首页（home: true + hero + features）
```

**为什么分两个文件**：`config.ts` 是构建层，`theme.ts` 是展示层。混在一起以后换主题要重写一半；分开后换主题只动 `theme.ts`。

### 3.2 导航手写，侧边栏读磁盘

**导航手写**（`navbar.ts`）：五个栏目固定，不随内容变。

```ts
export const navbar: NavbarOptions = [
  { text: "首页", link: "/", icon: "fa-solid fa-house" },
  { text: "全栈笔记", link: "/notes/", icon: "fa-solid fa-book" },
  // … 全栈项目 / Agent工作流 / 优质资源 / 学习方法
];
```

**侧边栏读磁盘**（`sidebar.ts`）：笔记目录一直在变。

```ts
const readDir = (dir) => {
  for (const entry of 排序后的目录项) {
    if (是目录) → 递归，prefix 设为 "目录名/"
    if (是 md) → 叶子节点，link 是去掉 .md 的文件名
  }
};
```

三条实现细节：

| 细节 | 为什么 |
|---|---|
| `localeCompare(name, "zh-CN", { numeric: true })` | 默认按标题排，中文变拼音序；加 `numeric` 才能让 `02-` 排在 `01-` 之后 |
| 跳过 `index.md` / `README.md` / `assets/` | 这三个不是笔记；资源目录不该进导航 |
| 任意层递归 | 后端是「语言 → 分类 → 篇」三层，写死两层会漏 |

**这是选 theme-hope 的主要理由**：它的侧栏直接吃嵌套数组，不用自己拼 HTML。

### 3.3 首页：三层视觉

首页是唯一需要「设计」的页面，其余都是文档布局。

| 层 | 实现 | 来源 |
|---|---|---|
| 结构 | `home: true` + `heroText` + `tagline` + `actions` + `features` | theme-hope 官方首页配置 |
| 极光背景 | 作用域 `.home-aurora`：2rem 网格 + 三团径向渐变（绿 / 蓝 / 紫），`background-attachment: fixed` | 自己写 |
| 渐变文字 | 标题与副标题共用 `linear-gradient(92deg, #0f9d6b → #2f7df6 → #8b5cf6)`，`background-clip: text` | 自己写 |

**配色为什么是这三色**：绿色是主色（`--vp-c-accent: #2f845d`），蓝与紫是相邻色。绿 → 蓝 → 紫的过渡读起来是「技术 → 严谨 → 前沿」，三色在同一段色相区间，不显杂乱。

**极光背景用 `fixed` 不用 `scroll`**：首页比屏幕长，滚动时背景跟着动会晕。固定后滚的是内容，背景是一块静止的底。

### 3.4 内容接入：为什么不直接在站点里写

**这是本项目最关键的架构决定。**

最初想法是把笔记直接放 `blog/src/notes/` 里写。放弃的原因：

| 直接写在站点里 | 拉出来独立仓库 |
|---|---|
| 笔记与站点配置混在一个仓库，改样式会碰到内容历史 | 内容与展示彻底分开 |
| 笔记量上来后仓库被图片撑大，克隆变慢 | 两份仓库各自独立增长 |
| 想在 Obsidian 里读，要面对一堆 VuePress 配置 | 源库是纯 Markdown，任何编辑器能开 |
| 手机改一篇笔记要跑一遍构建 | 源库改了 push 就行 |

所以定成「源库 + 发布端」两个角色，脚本单向同步：

```text
../fullstack-notes/      ──npm run sync──▶  blog/src/notes/
../fullstack-workflow/   ──npm run sync──▶  blog/src/workflow/
                                          └▶  docs/99-模板文档/
```

**同步不是简单复制。** 源库有三种写法会让 Vue 编译失败，必须在这一步修掉：

| 源库写法 | 为什么会挂 | 同步时怎么处理 |
|---|---|---|
| 路径里有 `C++` | VuePress 把 `+` 转义成 `_`，产物目录变 `04-C__`，链接全 404 | 改名 `Cpp` |
| 行内代码里 `` `${{ github.sha }}` `` | Vue 把 `{{ }}` 当插值，抛 TypeError，整页只剩开头几句 | 包 `<span v-pre>` 让 Vue 跳过 |
| 标题写成 `# 01-软件工程图典` | 页面标题显示成「01-软件工程图典」 | 去掉两位数字前缀 |

**三种都是实测出来的，不是猜的。** 第一条在目录页链接上暴露；第二条最隐蔽（页面还在、内容没了）；第三条在页面标题上暴露。

### 3.5 目录页为什么生成而不是手写

`/notes/` 是站点的内容地图。两种做法：

| 做法 | 问题 |
|---|---|
| 手写目录表 | 加一篇改两处（文件 + 表格），一定会忘 |
| 构建前扫盘生成 | 内容变表就变，不用人管 |

选后者。脚本扫 `src/notes/` 目录树，输出「总览表 + 每方向明细表」，写进 `notes/index.md`，构建时当普通页面渲染。

**三层方向要特殊处理**：`05-后端` 是「语言 → 分类 → 篇」，比别的方向多一层。判断方式是「这个章节下面还有没有目录」。

### 3.6 深浅色为什么不跟随系统

theme-hope 默认跟随系统。改成 `darkmode: "toggle"` 之后有第二个坑：**首屏闪黑**。

原因：主题首屏脚本解析 HTML 时读系统设置，把 `data-theme` 设成 `dark`，等用户设置（默认浅色）生效时再切回，中间闪一下。

解法是在 `config.ts` 的 `head` 注入脚本，首屏绘制前就把 `data-theme` 钉成 `light`：

```js
try {
  var k = "vuepress-theme-hope-scheme", s = localStorage.getItem(k);
  if (s !== "dark") {
    if (s !== "light") localStorage.setItem(k, "light");
    document.documentElement.setAttribute("data-theme", "light");
  }
} catch (e) {}
```

**只在用户明确切过深色时才尊重设置**，其余一律浅色。既保留手动切换，又不闪。

### 3.7 部署：构建命令里不能带 sync

线上是 Cloudflare Pages，拉代码后跑 `npm run build`。

**不能写成 `npm run sync && npm run build`**——Cloudflare 构建环境里没有 `../fullstack-notes` 与 `../fullstack-workflow`，那是本地路径。

所以内容必须先本地同步、**提交进仓库**，线上只负责构建。这也决定了 `.gitignore` 不能忽略 `blog/src/notes/`。

## 四、数据改动

**没有数据库，所以没有迁移。**「数据改动」在这里指文件移动：

| 动作 | 影响 | 可逆 |
|---|---|---|
| 同步先清空 `blog/src/notes/` | 目录内手工文件会被删 | 是（重跑 sync） |
| 改名 `C++` → `Cpp` | 源库不动，只改站点侧副本 | 是 |
| 删除 `posts/`、`about.md` | 旧演示内容 | 是（在 git 历史里） |

**源库永远不被写。** 同步单向，脚本只读不写源目录。

## 五、实施顺序

从零到能跑，九步：

| # | 步骤 | 依赖 | 做完能看到什么 |
|---|---|---|---|
| 1 | 装依赖，起一个空白 theme-hope 站 | 无 | 默认主题首页，`npm run dev` 能打开 8080 |
| 2 | 写 `config.ts`：标题、描述、语言、浅色首屏脚本 | 1 | 页面标题与描述正确，系统深色下不闪黑 |
| 3 | 写 `theme.ts`：导航、侧栏、插件、Markdown 增强 | 2 | 六项导航出现，搜索可用，RSS 与 sitemap 生效 |
| 4 | 写 `sidebar.ts` 递归读盘 | 3 | 侧栏自动列出笔记目录，三层方向正确嵌套 |
| 5 | 放第一篇笔记进去 | 4 | 能点进正文，页面标题取自 H1 |
| 6 | 首页：hero + 方向卡片 + 极光背景 + 渐变文字 | 3 | 首页视觉定稿，卡片 4 列 |
| 7 | 写 `sync-content.mjs`：拉全部内容 + 三种修补 | 5 | 219 篇笔记与 7 份工作流文档一次到位 |
| 8 | 写 `gen-notes-index.mjs`：扫盘生成目录页 | 7 | `/notes/` 是一张完整目录表（总览 + 明细 15 张表） |
| 9 | 配 Cloudflare Pages 并推送首个版本 | 8 | 线上可访问，构建日志出现 `success` |

**顺序不能跳**：4 之前必须有 3，侧栏要读 `theme.ts` 注入的 `sidebar`；7 之前必须有 5，否则不知道单篇长什么样；9 在 8 之后，因为线上构建产物要含目录页。

**每一步都有可验收的产出物。** 跨会话推进时按下表核对，某一步的「做完能看到什么」没出现，就不要进下一步。

## 六、已知的坑

| 坑 | 表现 | 怎么绕 |
|---|---|---|
| `C++` 目录名 | 构建后变 `04-C__` | 同步时改名 |
| 行内代码里的 `{{ }}` | 整页内容残缺，日志有 TypeError | 包 `<span v-pre>` |
| 裸尖括号 `<provider>` | 构建直接失败，报 Element is missing end tag | 写进行内代码或转义 |
| `README.md` 与自动 `index.md` 撞路径 | 构建报 SlimSearch duplicate ID | 给 README 加 `permalink` |
| dev 缓存残留旧页面 | 改配置不生效 | `npm run clean-dev` |
| 线上没有源库 | 构建报目录不存在 | 线上只跑 build |
| 忘了提交同步产物 | 线上内容与本地不一致 | 三处一起提交 |

**最需注意的一条**：这三种写法是「已知会挂」的清单，不是全部。源库出现新写法时构建会直接失败，需要补进同步脚本的修补规则。

最后更新：2026-11-22
