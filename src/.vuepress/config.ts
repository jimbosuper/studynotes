import { defineUserConfig } from "vuepress";
import { viteBundler } from "@vuepress/bundler-vite";
import theme from "./theme.js";

export default defineUserConfig({
  // 自定义域名时改这一行，例如 "/blog/"
  base: "/",

  lang: "zh-CN",
  title: "JimBo的米奇妙妙屋",
  description: "简洁·核心·不烧心的全栈知识库",

  bundler: viteBundler({
    viteOptions: {
      ssr: {
        // @vuepress/search-helper 的客户端模块带 CSS 副作用导入，
        // 若被 SSR 外部化，Node 会以 .css 模块加载而报错，故交给 Vite 打包处理
        noExternal: ["@vuepress/search-helper", "@vuepress/plugin-slimsearch"],
      },
      // mermaid v12 依赖 dayjs(UMD)，预打包以提供正确的 default 导出
      optimizeDeps: {
        include: ["mermaid", "dayjs"],
      },
    },
  }),

  theme,
});
