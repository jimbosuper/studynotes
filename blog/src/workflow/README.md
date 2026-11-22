---
title: "00-内容导读"
permalink: "/workflow/00-内容导读.html"
---

# Agent 工作流

> 这套规范是 v1.0.0 定稿版：7 份文档，装好 OpenChamber 之后整套丢给 AI 就能配好并开工。

给 OpenChamber 用的全栈交付规范。**装好 OpenChamber 之后，把这整个目录丢给 AI，它读完就能配好、也能开始干活。**

## 一、装什么

| # | 文件 | 装到哪 | 内容 |
|---|---|---|---|
| 1 | `01-全局AGENTS模板.md` | `~/.config/opencode/AGENTS.md` | 行为底线、任务分级、八道门 |
| 2 | `02-subagent模版.md` | 拆成 7 个文件进 `~/.config/opencode/agents/` | 七个角色的系统提示词 |
| 3 | `03-skill与mcp模板.md` | 按表装配 | 每个角色用哪个 skill、连哪个 MCP |
| 4 | `04-项目AGENTS模板.md` | 每个项目复制成 `AGENTS.md` | 项目特有的事实与命令 |
| 5 | `05-docs文档模板.md` | 不装 | `docs/` 下每份文档写哪几节 |
| 6 | `06-项目目录模板.md` | 不装 | 目录怎么建、怎么裁剪 |

**1–3 是全局的，装一次。4 每个项目装一次。5、6 是查用。**

**但这 7 个文件都要拷进项目的 `docs/99-模板文档/`。** 装完以后，项目里所有交叉引用都走 `docs/99-模板文档/<文件名>`，不依赖你机器上这份源目录。

## 二、让 AI 帮你做

装好 OpenChamber 之后，把整个目录给 AI，说这句：

```text
读这个目录的 README.md，按它把我这台机器上的 OpenChamber 配好，
再把这 7 个文件拷进我项目的 docs/99-模板文档/。
装完把每一步验证命令的输出贴给我。
```

AI 会做这六件事：

```text
1. 读 README.md（本文）与 01、02、03
2. 把 01 装成 ~/.config/opencode/AGENTS.md
3. 把 02 拆成 7 个角色文件，装进 ~/.config/opencode/agents/
4. 按 03 列出的清单装 skill、配 MCP
5. 跑验证命令，确认 7 个角色都能被调起来
6. 把这 7 个文件拷进目标项目的 docs/99-模板文档/
```

## 三、装之前确认四件事

| 项 | 怎么确认 | 没有会怎样 |
|---|---|---|
| OpenChamber 已安装 | `opencode --version` | 后面全部做不了 |
| 至少配好一个 provider | 会话里输入 `/models`，能看到模型 | 角色装上了但跑不起来 |
| Git 配了真人身份 | `git config --global user.name` 有值 | 提交记录追不到人 |
| 目标项目已 `git init` | 项目目录里有 `.git/` | 分支、提交、审查全失效 |

## 四、手工装（不想让 AI 装）

### 4.1 全局指令

```bash
mkdir -p ~/.config/opencode
cp 01-全局AGENTS模板.md ~/.config/opencode/AGENTS.md
```

验证：新开会话，问「你的任务分级规则是什么」，能答出小 / 中 / 大三级。

### 4.2 七个角色

`02-subagent模版.md` 里有 7 个 ````markdown 块，每块是一个角色，**自带 frontmatter**，整块复制成文件即可：

```text
~/.config/opencode/agents/
├─ product-manager.md
├─ designer.md
├─ architect.md
├─ fullstack-dev.md
├─ test-runner.md
├─ ops-engineer.md
└─ code-reviewer.md
```

只需改每块里的 `model` 一行为你本机有的模型。**`mode: subagent` 不能删**——不写会被当成主 agent，还抢走本该派给子代理的活。

验证：`ls ~/.config/opencode/agents/` 有 7 个文件；新会话里说「用产品角色写个 PRD」，能被派出去。

### 4.3 技能与 MCP

**先装通用的（skills 市场 + 常用 MCP），再单独接两个工具：OpenDesign 与 Archify。**

按 `03-skill与mcp模板.md` 的表格装：

```bash
# 技能来源
/plugin marketplace add anthropics/skills
/plugin marketplace add obra/superpowers

# 产品角色的提问技能（只装这两个，不装 grill-with-docs）
npx skills@latest add mattpocock/skills --skill=grill-me --skill=grilling -a opencode

# MCP 按需添加
opencode mcp add context7 --global --url https://mcp.context7.com/mcp
opencode mcp add gitlab --global --url https://gitlab.example.com/api/v4/mcp
```

验证：`opencode mcp list` 里已配的 server 显示 `connected`；`ls ~/.agents/skills/` 能看到 `grill-me` 与 `grilling`。

**`grill-with-docs` 不装。** 它会往仓库根写 `GLOSSARY.md`、往 `docs/adr/` 写 ADR，和我们的 `docs/01-产品/04-产品术语表.md` / `docs/03-架构/07-ADR重要决策/` 是两套。两套术语表同时存在比没有更糟。

**`grill-me` 的已知限制**：它的 frontmatter 带 `disable-model-invocation: true`，只能由人在会话里 `/grill-me` 手动触发，**子代理自己调不动**。所以 `02-subagent模版.md` 产品 §4.3 把 grilling 的协议内联进了文档——skill 触发不了也能按文档做。

**下面两个工具不走上面这套**：OpenDesign 是 MCP + CLI，Archify 是 skill + CLI，各有各的装法。

#### OpenDesign（设计角色出原型）

官方 `od mcp install opencode` 生成的配置**不能直接用**，两个坑：`od` 在 macOS 上被 `/usr/bin/od`（八进制 dump）占住；daemon 端口随机，不一定是 7456。

**三步装好：**

```bash
# 1. 打开桌面版（daemon 必须开着）
open -a "Open Design"

# 2. 查实际端口
lsof -nP -iTCP -sTCP:LISTEN | grep -i design
```

```jsonc
// 3. 写进 ~/.config/opencode/opencode.json 的 mcp 段
"open-design": {
  "type": "local",
  "command": [
    "/Users/<你>/.local/bin/node",
    "/Applications/Open Design.app/Contents/Resources/app/prebundled/daemon/daemon-cli.mjs",
    "mcp",
    "--daemon-url", "http://127.0.0.1:<上一步查到的端口>"
  ],
  "enabled": true
}
```

**三个必须**：`node` 用绝对路径；`daemon-cli.mjs` 用绝对路径；`--daemon-url` 写真实端口。少一样就连不上。

**CLI 兜底**（MCP 不通时等价可用）：

```bash
export OD_DAEMON_URL=http://127.0.0.1:<端口>
node "/Applications/Open Design.app/Contents/Resources/app/prebundled/daemon/daemon-cli.mjs" project list --json
```

验证：重启 OpenChamber，让它调 `list_projects`，能返回项目列表（空列表也算通）。

**端口会变。** 每次重开桌面版端口都可能不同，连不上时先重新查端口改配置。

#### Archify（架构角色与运维角色出图）

**它是 skill + Node CLI，不是 MCP。** skill 让 agent 知道怎么画，CLI 负责校验和渲染。

**走代理，否则克隆会 300 秒超时。** 下面按 Clash 默认端口 7897 写，你自己的端口用 `nc -z 127.0.0.1 7897` 之类确认：

```bash
export https_proxy=http://127.0.0.1:7897
export http_proxy=http://127.0.0.1:7897

# 全局装（推荐）
npx -y skills@latest add https://archify.si --skill archify --agent opencode --global --copy --yes
```

**源必须是 `https://archify.si`，不是 `archify.si`。** 前者走 well-known 端点只拉 skill 本体（203 个文件），后者会被当成 git 仓库去克隆，直接报 `repository 'archify.si' does not exist`。也不要写 `tt-a1i/archify`——仓库 141 MB，大概率超时。

装到 `~/.agents/skills/archify`。

**验证：**

```bash
node ~/.agents/skills/archify/bin/archify.mjs doctor
```

20 多项全 `[ok]` 才算装好（Node 版本、11 个 renderer、schema、viewer 运行时）。

**怎么用：** 填一份 JSON 描述结构，跑 `finalize`，它做四个校验（schema / 交付 / 产物 / 真实浏览器渲染）。

```bash
node ~/.agents/skills/archify/bin/archify.mjs finalize architecture \
  candidate.json 02-架构图示.html --quality showcase --json
```

**四个校验全过才算交付。** 过了还要看返回里的 `visualReviewRecommendation`——有交叉连线就按它给的 hints 调坐标重跑，最多两轮。**校验过了不等于图好看。**

| 项 | 说明 |
|---|---|
| 产物 | **单个自包含 HTML**（约 850 KB），零依赖，`file://` 直接打开 |
| 附带 | `.finalize.json` + `.browser-check.json` 交付凭据 |
| 导出 | PNG / JPEG / WebP / SVG（双主题）/ WebM（带运动） |
| 运行依赖 | Node.js ≥ 18，无其他依赖 |
| 输出位置 | 架构角色 → `docs/03-架构/02-架构图示.html`（或 `02-架构图示/`）、`03-状态机/`、`06-ER图/`（后两个恒为目录，文件名带序号，不建 `index.html`）；运维角色 → `docs/06-运维/02-部署拓扑.html`（或 `02-部署拓扑/`） |

**10 种图型**：架构、工作流、时序、数据流、生命周期、ERD、类图、树、时间线、瀑布。

**两条硬约束：**

| 约束 | 值 |
|---|---|
| 节点数 | **8–12 个**，超过就拆图 |
| 画布宽 | ≤ 1240px（宽高比 ≥ 1.55 时可到 1790px）；再宽文字会小到读不了 |

**它不是绘图编辑器，也不是 Mermaid 换皮。** 官方定位是「把技术意图变成可沟通的产物」——不做拖拽精修，不做托管分享，不是无限画布。复杂到 40 个节点以上，该拆成多张图。

**我们只用它画三种东西：**

| 图 | Archify 类型 | 产物 | 谁产出 |
|---|---|---|---|
| 架构图示（逻辑架构 + 系统上下文） | `architecture` | `02-架构图示.html` | 架构角色 |
| 状态机 | `lifecycle` | `03-状态机/1-<实体>.html`（每个实体一张，恒为目录） | 架构角色 |
| ER 图（全字段表结构） | `erd` | `06-ER图/<N>-<域>.html`（一张 8–12 表） | 架构角色 |
| 部署拓扑（测试 + 生产，各一个区域 + 私网） | `architecture` + `engineering_profile: deployment-ownership` | `02-部署拓扑.html` | 运维角色 |

**一次 `finalize` 只能出一种图。** Archify 的 `meta.views` 是同一张图的聚焦切换（比如只高亮某几个节点），不是把架构图和状态机拼在一起——两者 schema 完全不同。所以架构、状态机、ER 是三个独立文件。

**流程时序图仍然用 Mermaid 写在 `01-系统架构.md` 里。** 它数量多、改得勤、要对着读，做成 HTML 不划算。

### 4.4 项目级配置

**第一步，把这套文档拷进项目。**

```bash
cd <项目根>
mkdir -p docs/99-模板文档
cp <本目录>/*.md docs/99-模板文档/
```

**第二步，生成项目自己的 `AGENTS.md`。**

```bash
cp docs/99-模板文档/04-项目AGENTS模板.md AGENTS.md
```

把「待补充」换成实际值：技术栈、命令、受保护分支。**保持 100 行以内**——规则堆多了遵守率反而下降。

**模块级规矩不要写在根目录，写进那个目录自己的 `AGENTS.md`。** OpenChamber 从当前目录向上找到项目根，沿途的 `AGENTS.md` 全部加载。

**第三步，按目录模板建另外三个目录。**

```text
docs/     ← 照抄，一个字不改（99-模板文档 也在这里）
src/      ← 按技术栈裁剪
test/     ← 按工具裁剪
deploy/   ← 按平台裁剪
```

验证：`ls docs/99-模板文档/` 有 7 个文件；`ls docs/0*` 能看到 7 个产物目录。

## 五、装完怎么用

### 5.1 第一次开工

```text
1. 在项目里开一个 OpenChamber 会话
2. 说「按 PRD1 做」，主 agent 自己判断该派哪个角色
3. 每交完一份产物就停下等人放行：产品 → 设计 → 架构 → 技术方案 → 测试方案 → 运维 → 验收 → 上线（8 道门）
4. 你说过「可以」，它才继续
```

### 5.2 主 agent 会怎么走

| 任务级别 | 怎么判断 | 派谁 | 过几道门 |
|---|---|---|---|
| 小 | 单文件、不改数据结构、可一次回滚 | 自己做，不派 | **0 道** |
| 中 | 多文件、跨模块、新增功能 | 产品 → 全栈开发 → 测试 → 审查 | **3 道**：门 1 / 门 4 / 门 7 |
| 大 | 改数据结构、需迁移、上生产 | 七个角色，架构按需介入 | **8 道**，每道一个角色 |

**每派完一个角色，就停下等人放行。** 人只回答一个问题（「这是不是真的」），不判断质量——质量归审查。

**有些产物要先审过人过：** 大任务的 PRD（CR1）、架构 + TD（CR2）、代码（CR3）。审查没过，人不看这一版。其余四道（设计 / TP / 运维 / 上线）只过人，不审。

### 5.3 产物落在哪

```text
docs/01-产品/      PRD（链上，带版本）、BRD / MRD / 术语表（项目级，不带版本）
docs/02-设计/      页面规格（链上）、设计系统登记 / 原型图（项目级）
docs/03-架构/      系统架构 / 架构图示 / 状态机 / 数据库设计 / ER 图 / ADR（链上）
                  项目环境规范（项目级）
docs/04-开发/      技术方案 / 实现记录（链上）、代码规范（项目级）
docs/05-测试/      测试方案 / 测试报告（链上）、测试策略（项目级）
docs/06-运维/      服务详细情况 / 部署拓扑 / 运维手册 / 发布记录（全项目级）
docs/07-审查/      审查报告（链上）、审查清单（项目级）
docs/99-tmp/       技能原料，任务结束清空，不入库
docs/99-归档/      版本 / 废弃 / 发布快照，只读；**只在 dev 分支上**
```

**链上的产物带版本号且全链同版本；项目级的不带版本，靠 git log 追历史。** 见 `06-项目目录模板.md` 的 5.1。

## 六、三条铁律

| 规则 | 说明 |
|---|---|
| `docs/` 是唯一状态源 | 飞书、看板只做镜像，不得反向写状态 |
| 合并与上线权在人 | `test` / `prod` 只有人能合；AI 最高推到 `dev` |
| 审查是生效判定 | 写完不算，测试通过也不算，审查通过才算 |

## 七、常见问题

| 现象 | 原因 | 怎么修 |
|---|---|---|
| 角色装上了但调不出来 | 缺 `mode: subagent` | 补上，重启 OpenChamber |
| 主 agent 自己把活干完了 | `description` 太笼统 | 写清「什么时候用」，例如「需求模糊、验收标准不清楚时使用」 |
| 技能不触发 | `description` 与实际任务不匹配 | 改 `description`，写清触发场景 |
| 该用的技能没在表里 | 表只覆盖常用 | 让它用 `find-skills` 现找 |
| MCP 显示 needs authentication | 远程 server 要 OAuth | 会话里跑 `/mcps`，选中它登录 |
| 子代理读不到文件 | 路径写成了相对当前目录 | 文档里一律用项目根开始的相对路径 |
| 它一次派了多个角色 | 没读到「一次只派一个环节」 | 确认 `01` 已装成全局 `AGENTS.md` |
| 越权改了不该改的目录 | 子代理权限没配 | 检查该角色 frontmatter 里的 `permissions` |
| OpenDesign 连不上 | daemon 端口变了，或没开桌面版 | 重查端口改 `--daemon-url`；桌面版必须开着 |
| Archify 装不上，报 clone timeout | 没走代理，或源写成了 `archify.si` | 导出 `https_proxy`；源写 `https://archify.si` |
| Archify 说图不好看但门都过了 | 有交叉连线没修 | 看 `visualReviewRecommendation` 的 hints，调 `pos` 重跑 |
| 部署拓扑报 `deployment-private-state` | 数据库没放进 security-group | 每个环境建一个私网安全组，包住应用 + 数据库 |
| 部署拓扑报 `deployment-crossing-mechanism` | 连线 label 太笼统 | 写成「协议 + 端口 + 路径」，如 `HTTP 8080 轮询` |
| ER 图报 `references unknown entity` | `references` 写成了表名 | 用 entity 的 `id`：`"user.id"` 而不是 `"users.id"` |
