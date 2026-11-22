---
home: true
containerClass: home-aurora
heroImage: /avatar.png
heroImageAlt: JimBo米奇妙妙屋
heroText: JimBo的米奇妙妙屋
tagline: 从指令到上线，从笔记到交付，你所知的一切
actions:
  - text: 开始读笔记
    link: /notes/
    type: primary
  - text: 全栈项目
    link: /projects/
    type: secondary
  - text: Agent 工作流
    link: /workflow/
    type: secondary
features:
  - title: 计算机基础
    details: 数据结构、组成原理、操作系统、网络、软件工程。
    icon: "fa-solid fa-microchip"
    link: /notes/00-计算机基础/
  - title: 产品
    details: 需求与验收、规划与增长、商业化与 B 端、AI 产品。
    icon: "fa-solid fa-lightbulb"
    link: /notes/01-产品/
  - title: 设计
    details: 视觉与规范、交互与设计系统、多端可用性、Figma 交付。
    icon: "fa-solid fa-palette"
    link: /notes/02-设计/
  - title: 架构
    details: 架构决策与 ADR、领域边界、分布式一致性、容量与容灾。
    icon: "fa-solid fa-sitemap"
    link: /notes/03-架构/
  - title: 前端
    details: HTML/CSS/TS、Vue3、React19、工程化、测试、性能与安全。
    icon: "fa-solid fa-code"
    link: /notes/04-前端/
  - title: 后端
    details: Java、Python、Go、C++、Rust，加数据库、中间件与 API。
    icon: "fa-solid fa-server"
    link: /notes/05-后端/
  - title: 测试
    details: 策略与用例、单元与集成、接口与 E2E、性能与安全、CI 治理。
    icon: "fa-solid fa-vial"
    link: /notes/06-测试/
  - title: 运维
    details: Linux、Docker 与 K8s、Nginx、CI/CD、可观测性、故障复盘。
    icon: "fa-solid fa-cloud"
    link: /notes/07-运维/
  - title: 移动端
    details: Android、iOS、鸿蒙、Flutter、RN、uni-app、H5 与集成。
    icon: "fa-solid fa-mobile-screen"
    link: /notes/08-移动端/
  - title: 大模型
    details: 模型接入、Prompt 与结构化、RAG、Agent、Spring AI、AI 安全。
    icon: "fa-solid fa-brain"
    link: /notes/09-大模型/
  - title: 优质资源
    details: 开源项目、代码规范、学习文档、实用网站。
    icon: "fa-solid fa-star"
    link: /resources/
  - title: 学习方法
    details: 学习金字塔、布鲁姆层级、费曼学习、刻意练习。
    icon: "fa-solid fa-route"
    link: /methods/
---

## 米奇妙妙屋想解决什么？

网上讲一个技术的文章很多，但大多停在「它能做什么」，很少回答真正卡住人的三件事：**装好了怎么确认真的能用、出了事第一条命令敲什么、放到真实项目里边界在哪**。

所以这里不写名词百科，按一条完整的交付链铺开：**计算机基础 → 产品 → 设计 → 架构 → 前端/后端 → 测试 → 运维 → 移动端 → 大模型**，219 篇，每个环节都能看到上游要什么、下游怎么接。

每一篇都按同一套结构写：先划边界，再给最小可运行验证，最后落到一个完整案例。看完能从「听说过」变成「敢在项目里用，坏了知道先看哪」。

开发编码只占正规项目的 20%，AI 至今没能高质量完成工程，本质仍是黑盒祈祷编程。与其追 Harness、Skills 这类几个月迭代一次的中间产物，不如把精力放在企业级规范开发流程上——[Agent 工作流](/workflow/) 把产品、设计、架构、开发、测试、审查、运维七个角色和八道门写成了可执行的规则，让 AI 的输出有人复核、有门把关，而不是自己写自己签字。
