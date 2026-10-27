import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SidebarArrayOptions, SidebarOptions } from "vuepress-theme-hope";

const notesDir = fileURLToPath(new URL("../notes/", import.meta.url));

/**
 * 按磁盘上的目录结构生成侧边栏：
 * - 目录和文件名原样显示（保留 01-、02- 前缀，方便对齐原笔记）
 * - 跳过 index.md / README.md，避免每个章节末尾多出一个「本章节」
 * - 跳过 assets 等资源目录
 */
const readDir = (dir: string): SidebarArrayOptions => {
  const items: SidebarArrayOptions = [];

  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }))) {
    if (entry.name.startsWith(".") || entry.name === "assets") continue;

    if (entry.isDirectory()) {
      items.push({
        text: entry.name,
        prefix: `${entry.name}/`,
        collapsible: true,
        children: readDir(path.join(dir, entry.name)),
      });
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      entry.name !== "index.md" &&
      entry.name !== "README.md"
    ) {
      const name = entry.name.replace(/\.md$/, "");
      items.push({ text: name, link: name });
    }
  }

  return items;
};

export const sidebar: SidebarOptions = {
  // 全栈笔记：完全按原目录的名称与顺序生成
  "/notes/": readDir(notesDir),
  "/projects/": "structure",
  "/workflow/": "structure",
  "/resources/": "structure",
};
