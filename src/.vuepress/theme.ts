import { hopeTheme } from "vuepress-theme-hope";
import { navbar } from "./navbar.js";
import { sidebar } from "./sidebar.js";

export default hopeTheme({
  hostname: "https://blog.jimbo.xxx",
  author: {
    name: "JimBo",
    url: "https://blog.jimbo.xxx",
  },

  logo: "/avatar.png",
  favicon: "/avatar.png",

  // 填 GitHub 仓库地址，例如 "https://github.com/yourname/blog"
  repo: "",
  docsRepo: "",
  docsDir: "src",
  docsBranch: "main",

  navbar,
  sidebar,
  // 侧边栏按文件名里的序号排序（默认按标题排序，中文会变成拼音顺序）
  sidebarSorter: ["readme", "order", "filename"],

  displayFooter: true,
  footer: "CC BY-NC-SA 4.0 ｜Copyright © 2026 JimBo",
  // 关闭主题自动生成的版权行，避免重复
  copyright: false,

  // Markdown 增强：图表 / 数学 / 图片懒加载 / 提示块
  markdown: {
    mermaid: true,
    math: true,
    imgLazyload: true,
    imgSize: true,
    imgMark: true,
    alert: true,
    hint: true,
  },

  plugins: {
    icon: "fontawesome",
    slimsearch: true,
    readingTime: true,
    copyCode: {
      showInMobile: true,
    },
    seo: true,
    sitemap: {
      hostname: "https://blog.jimbo.xxx",
    },
    feed: {
      rss: true,
      atom: true,
      json: false,
    },
    comment: false,
    blog: false,
  },
});
