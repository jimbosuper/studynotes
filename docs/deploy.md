# 部署说明

站点由 Cloudflare Pages 托管：推送到 `master` 后自动拉取、构建、发布，不需要 GitHub Actions。

## Cloudflare Pages 配置

| 配置项 | 值 |
| --- | --- |
| Production branch | `master` |
| Framework preset | None |
| Root directory | `blog` |
| Build command | `npm run build` |
| Build output directory | `src/.vuepress/dist` |
| 环境变量 | `NODE_VERSION=22` |

> Root directory 是仓库根（`studynotes/`）到站点工程（`blog/`）的相对路径。留空会找不到 `package.json`，构建直接失败。

## 发布流程

1. 本地改完，`npm run build` 确认通过
2. 提交并推送到 `master`
3. Cloudflare 自动构建，约 3–5 分钟
4. 构建日志末尾出现 `success VuePress build completed` 与 `Success! Your site was deployed` 即为成功

## 换域名

`.pages.dev` 子域跟随项目名，重名时 Cloudflare 会自动加随机后缀。要固定地址，绑定自定义域名：

1. Pages 项目 → Custom domains → Set up a custom domain
2. 域名在 Cloudflare：自动加 CNAME；不在：按提示去域名商加一条 CNAME 指向 `<项目>.pages.dev`
3. 同步修改 `blog/src/.vuepress/theme.ts` 里三处域名：
   - `hostname`
   - `author.url`
   - `plugins.sitemap.hostname`
4. 重新构建推送，否则 sitemap、RSS、SEO 里仍是旧域名

## 常见构建报错

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `Output directory "src/vuepress/dist" does not exist` | 路径少写了 `.vuepress` 的点 | 改成 `src/.vuepress/dist` |
| `Missing entry-point to Worker script` / `wrangler deploy` 相关 | Pages 建成了 Workers 项目 | 删掉 Worker，重新建 Pages 项目 |
| `Cannot find module` / `npm install` 失败 | Root directory 没设成 `blog` | 改为 `blog` |
| 构建超时 | 首次安装依赖较慢 | 重试一次；仍失败检查 Node 版本 |

## 体积限制

Cloudflare 单项目上限 20,000 个文件、单文件 25 MiB。当前产物约 1,700 个文件、最大图片 1.2 MB，远低于上限。

## 备用方案：Workers 静态资源

仓库里的 `blog/wrangler.jsonc` 是为 Workers 静态资源准备的：

```jsonc
{
  "name": "studynotes",
  "compatibility_date": "2026-01-01",
  "assets": {
    "directory": "./src/.vuepress/dist",
    "not_found_handling": "404-page"
  }
}
```

如果以后从 Pages 切到 Workers，Root directory 设为 `blog`，Deploy command 用 `npx wrangler deploy` 即可，其余不变。Pages 项目会忽略这个文件。
