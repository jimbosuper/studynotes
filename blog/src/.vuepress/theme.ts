import { hopeTheme } from "vuepress-theme-hope";
import { navbar } from "./navbar.js";
import { sidebar } from "./sidebar.js";

export default hopeTheme({
  hostname: "https://studynotes-90w.pages.dev",
  author: {
    name: "JimBo",
    url: "https://studynotes-90w.pages.dev",
  },

  logo: "/avatar.png",
  favicon: "/avatar.png",

  // 站点默认浅色：只有用户手动点右上角图标时才切到深色，不跟随系统
  darkmode: "toggle",

  // 不公开显示仓库入口（导航栏右上角的 GitHub 图标），
  // 但保留 docsRepo 供每篇笔记底部的「编辑此页」使用
  repo: "",
  docsRepo: "https://github.com/jimbosuper/studynotes",
  // 站点在仓库根下的 blog/ 目录，编辑链接要带上前缀
  docsDir: "blog/src",
  docsBranch: "master",

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
      hostname: "https://studynotes-90w.pages.dev",
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
