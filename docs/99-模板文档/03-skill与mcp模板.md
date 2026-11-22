---
title: "03-skill与mcp模板"
---

# skill 与 mcp 模板

装在哪、怎么装见 `docs/99-模板文档/README.md`。本文只回答一件事：**每个角色用哪个 skill、连哪个 MCP。**

**表里写死的是常用技能。要做的事跟表里对不上时，用 `find-skills` 现找，不硬扛。**

**产品角色用的 `grill-me` 要从 `mattpocock/skills` 装：**

```bash
npx skills@latest add mattpocock/skills --skill=grill-me --skill=grilling -a opencode
```

**只装 `grill-me` 与它依赖的 `grilling`，不装 `grill-with-docs`。** 后者的 `GLOSSARY.md` 落仓库根、ADR 落 `docs/adr/`，与我们的 `docs/01-产品/04-产品术语表.md` / `docs/03-架构/07-ADR重要决策/` 是两套；两套术语表同时存在是最糟的结果——我们要自己的。**

**`grill-me` 的 `disable-model-invocation: true` 是个已知约束**：这个 skill 只能由人在会话里手动 `/grill-me` 触发，产品角色自己调不动。所以：

| 场景 | 怎么办 |
|---|---|
| 人在场、想深度问 | 人手动 `/grill-me` |
| 产品角色自己要走提问流程 | 按 `02-subagent模版.md` 产品 §4.3 **内联的协议**做，不依赖 skill 触发 |

**§4.3 已经把 grilling 的协议（设计树、frontier、每问带推荐答案、frontier 空才收工）写进文档了**，所以即使 skill 触发不了，产品也知道该怎么做。skill 只是加速器，不是必需品。

## 一、产品（product-manager）

| 类型 | 名称 | 干什么 | 流程 |
|---|---|---|---|
| skill | **`mattpocock:grill-me`** | **提问的主力**：把模糊需求 grill 成设计树，直到 frontier 为空 | 建设计树 → 每轮只问 frontier → 每问带推荐答案 → 等人答 → 树的下一层冒出来 → 循环到 frontier 空 |
| skill | `superpowers:brainstorming` | 起草候选方案 | 只在需要「列 2–3 个方案让人选」时用；提问顺序由 grill-me 管 |
| skill | `superpowers:writing-plans` | 把结论落成带验收标准的文档 | 按任务拆条 → 每条写清改哪些文件、怎么验、卡点在哪 → 落成计划文档 |
| MCP | 飞书项目 | 读需求单、评论、附件 | — |
| MCP | Context7 | 查产品/技术文档的当前版本 | — |
| skill | `find-skills` | 表里没有合适的，就现找 | 判断现有技能匹配不上 → 调用 → 按它说的做 |

## 二、设计（designer）

| 类型 | 名称 | 干什么 | 流程 |
|---|---|---|---|
| MCP | **`open-design`** | **出原型的主力**：建项目、下 brief、等生成、读产物 | create_project → start_run → get_run 轮询 → list_files/get_file |
| 工具 | `od` CLI（**装法见 README 的 OpenDesign 一节**） | MCP 不可用时兜底，能力等价 | `od plugin run` / `od project list` / `od export` |
| MCP | Playwright | 打开产物、截图、走查交互、量参数 | — |
| skill | `find-skills` | 表里没有合适的，就现找 | 判断现有技能匹配不上 → 调用 → 按它说的做 |

## 三、架构（architect）

| 类型 | 名称 | 干什么 | 流程 |
|---|---|---|---|
| skill | `superpowers:writing-plans` | 把决策写成结构化文档 | 列 2–3 个方案 → 各写代价 → 定一个 → 按 Context/Decision/Consequences/Alternatives 落文 |
| MCP | GitLab | 读现有代码结构、看历史变更 | — |
| MCP | Context7 | 查框架与库的当前 API | — |
| MCP | Postgres | 看现有表结构与索引 | — |
| skill + CLI | **`archify`** | 出架构图示、状态机、ER 图 | 每个写一份 candidate.json → 各跑一次 finalize（四校验）→ 看交叉建议 → 调坐标重跑。**finalize 必带 `--out-dir docs/99-tmp/架构-<任务>/receipts/`**，否则 4 个 json 收据会落在业务目录里 |
| skill | `find-skills` | 表里没有合适的，就现找 | 判断现有技能匹配不上 → 调用 → 按它说的做 |

## 四、全栈开发（fullstack-dev）

| 类型 | 名称 | 干什么 | 流程 |
|---|---|---|---|
| skill | `superpowers:test-driven-development` | 先写失败的测试再实现 | 写用例 → **跑一次确认它失败** → 写最小实现 → 跑通 → 再重构 |
| skill | `superpowers:systematic-debugging` | 定位根因，不打补丁 | 复现 → 缩小范围 → 提假设 → 验证假设 → 找到根因 → 再修 |
| skill | `superpowers:executing-plans` | 按计划的清单逐条推进 | 取一条 → 做完即验证 → 记结果 → 下一条；不跳步、不并步 |
| MCP | GitLab | 建分支、开 MR、看 CI | — |
| MCP | Context7 | 查框架 API，防幻觉 | — |
| MCP | Postgres | 验证迁移结果、查数据结构 | — |
| MCP | Chrome DevTools | 看 console、网络请求、性能 | — |
| skill | `find-skills` | 表里没有合适的，就现找 | 判断现有技能匹配不上 → 调用 → 按它说的做 |

## 五、测试（test-runner）

| 类型 | 名称 | 干什么 | 流程 |
|---|---|---|---|
| skill | `anthropics:webapp-testing` | 驱动浏览器验证真实交互 | 判断是静态还是动态页面 → 静态直接读 HTML 找选择器；动态先起服务 → 导航等 `networkidle` → 截图/查 DOM 侦察 → 用真实选择器执行动作 |
| skill | `superpowers:verification-before-completion` | 声称完成前先找证据 | 逐条列出「我要证明什么」→ 跑命令拿新鲜输出 → 没有证据的项标「未验证」 |
| MCP | GitLab | 读流水线日志与测试 artifact | — |
| MCP | Postgres | 核对测试后的数据状态 | — |
| skill | `find-skills` | 表里没有合适的，就现找 | 判断现有技能匹配不上 → 调用 → 按它说的做 |

## 六、审查（code-reviewer）

| 类型 | 名称 | 干什么 | 流程 |
|---|---|---|---|
| skill | `code-review`（内置） | 读 diff 找正确性问题 | 在全新子代理里读改动 → 按严重度列发现 → 只出结论不改码 |
| skill | `superpowers:verification-before-completion` | 查作者的「已验证」是不是真的 | 要他给命令与输出 → 对不上就标未验证 → 写进审查报告 |
| MCP | GitLab | 读 MR diff、讨论、CI 结果 | — |
| MCP | Serena | 跨文件查定义与调用方 | — |
| MCP | Semgrep | 静态分析，找注入、越权、硬编码密钥 | — |
| skill | `find-skills` | 表里没有合适的，就现找 | 判断现有技能匹配不上 → 调用 → 按它说的做 |

## 七、运维（ops-engineer）

| 类型 | 名称 | 干什么 | 流程 |
|---|---|---|---|
| skill | `anthropics:webapp-testing` | 发布后按关键路径走一遍 | 按冒烟清单逐条开页面点 → 每步截图 → 与预期逐条对照 |
| skill | `superpowers:verification-before-completion` | 查冒烟是不是真跑了 | 要有截图与返回码 → 只有「部署成功」不算 → 写进发布记录 |
| MCP | GitLab | 读部署日志、建标签 | — |
| MCP | Sentry | 读错误率、异常聚合 | — |
| MCP | 阿里云 | 读实例状态、监控指标 | — |
| skill + CLI | **`archify`** | 出部署拓扑图（归属 + 边界，测试生产同图） | 用 `engineering_profile: deployment-ownership` → finalize → 核归属。**同样带 `--out-dir`，收据进 `99-tmp/`** |
| skill | `find-skills` | 表里没有合适的，就现找 | 判断现有技能匹配不上 → 调用 → 按它说的做 |

