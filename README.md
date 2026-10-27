# JimBo 的技术笔记

基于 `vuepress-theme-hope` 的个人博客（形态 A：文档项目主页）。
部署：GitHub 仓库 + Cloudflare Pages 自动构建。

## 本地开发

```bash
npm install
npm run dev      # 开 localhost:8080 预览
```

## 构建 & 部署

```bash
npm run build    # 产物在 src/.vuepress/dist
```

推 `main` 后：

- **方式一（CF 原生）**：Cloudflare Pages 后台连 GitHub 仓库，构建命令 `npm run build`，输出目录 `src/.vuepress/dist`。
- **方式二（GitHub Actions）**：见 `.github/workflows/deploy.yml`，需在仓库 Secrets 填 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`。

## 写新文章

在 `src/posts/2026/` 下新建 `.md`，开头写 frontmatter：

```yaml
---
title: 标题
date: 2026-01-01
category: 分类
tags:
  - 标签
---
```

改完 `git push` 即可，Cloudflare 1~3 分钟自动上线。

> 品牌名 / slogan / 导航 / logo 均为占位，随时改 `src/.vuepress/` 下配置与 `src/index.md`。
