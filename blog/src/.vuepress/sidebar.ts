import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SidebarArrayOptions, SidebarOptions } from "vuepress-theme-hope";

const notesDir = fileURLToPath(new URL("../notes/", import.meta.url));
const projectsDir = fileURLToPath(new URL("../projects/", import.meta.url));

/**
 * 按磁盘上的目录结构生成侧边栏：
 * - 目录和文件名原样显示（保留 01-、02- 前缀，方便对齐源库）
 * - 最深支持三层（05-后端 是 语言 → 语法/常用库/工程化 → 篇）
 * - 跳过 index.md / assets
 * - README.md 是「00-内容导读」（permalink 落到 00-内容导读.html），要单独列出来
 * - 文件排在目录前面：00-内容导读 要在 00-计算机基础 之上
 */
const readDir = (dir: string): SidebarArrayOptions => {
  const items: SidebarArrayOptions = [];

  const sorted = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) => !entry.name.startsWith(".") && entry.name !== "assets",
    )
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1;
      return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
    });

  for (const entry of sorted) {
    if (entry.isDirectory()) {
      items.push({
        text: entry.name,
        prefix: `${entry.name}/`,
        collapsible: true,
        children: readDir(path.join(dir, entry.name)),
      });
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      if (entry.name === "index.md") continue;
      // README.md 带 permalink: /notes/00-内容导读.html
      const name = entry.name === "README.md" ? "00-内容导读" : entry.name.replace(/\.md$/, "");
      items.push({ text: name, link: name });
    }
  }

  return items;
};

/**
 * Agent 工作流：00-内容导读（README）+ 01–06，按 v1.0 原始顺序固定排列。
 */
const WORKFLOW_ORDER = [
  ["00-内容导读", "00-内容导读"],
  ["01-全局AGENTS模板", "01-全局AGENTS模板"],
  ["02-subagent模版", "02-subagent模板"],
  ["03-skill与mcp模板", "03-skill与mcp模板"],
  ["04-项目AGENTS模板", "04-项目AGENTS模板"],
  ["05-docs文档模板", "05-docs文档模板"],
  ["06-项目目录模板", "06-项目目录模板"],
];

/**
 * 全栈项目：手写数组，逐层给 prefix。
 *
 * theme-hope 的 prefix 是逐层拼接的：父项 prefix + 本项 prefix + 叶子 link。
 * 所以每项只写自己这一层（`01-产品/`），叶子只写文件名，不加 `../` 也不带父级。
 * 之前把父级拼进来，链接会变成 `/projects/01-米奇妙妙屋/01-米奇妙妙屋/01-产品/…`。
 */
const readProjectDir = (dir: string): SidebarArrayOptions => {
  const items: SidebarArrayOptions = [];

  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "assets")
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1;
      return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
    })) {
    if (entry.isDirectory()) {
      items.push({
        text: entry.name,
        prefix: `${entry.name}/`,
        collapsible: true,
        children: readProjectDir(path.join(dir, entry.name)),
      });
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      if (entry.name === "index.md") continue;
      // projects 侧 README.md 带 permalink，是 00-内容导读
      if (entry.name === "README.md") {
        items.push({ text: "00-内容导读", link: "/projects/00-内容导读.html" });
        continue;
      }
      const name = entry.name.replace(/\.md$/, "");
      items.push({ text: name, link: name });
    }
  }

  return items;
};

export const sidebar: SidebarOptions = {
  "/notes/": readDir(notesDir),
  "/workflow/": [
    {
      text: "Agent 工作流",
      collapsible: false,
      children: WORKFLOW_ORDER.map(([file, text]) => ({ text, link: file })),
    },
  ],
  "/projects/": readProjectDir(projectsDir),
  "/resources/": "structure",
  "/methods/": "structure",
};
