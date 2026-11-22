/**
 * 扫描 src/notes 生成 /notes/ 目录页（notes/index.md），输出为表格。
 *
 * 结构：
 *   总览  方向 / 篇数 / 章节数 一张表
 *   明细  每个方向一张表：章节 | 篇数 | 篇目（篇名都是链接）
 *         05-后端 是三层（语言 → 语法/常用库/…），按语言分小节，每节一张表
 *
 * 注意：内容导读不能叫 README.md，它会和自动生成的 index.md 抢 /notes/ 路径，
 * VuePress 构建时报 SlimSearch duplicate ID，所以站在用 00-内容导读.md。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const notesRoot = fileURLToPath(new URL("../src/notes/", import.meta.url));
const output = path.join(notesRoot, "index.md");

const sorted = (names) =>
  [...names].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));

const SKIP = new Set(["index.md", "README.md", "assets"]);
const isNote = (name) => name.endsWith(".md") && !SKIP.has(name);

const entries = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith(".") && !SKIP.has(e.name));

const childDirs = (dir) =>
  sorted(entries(dir).filter((e) => e.isDirectory()).map((e) => e.name));

const noteFiles = (dir) =>
  sorted(
    entries(dir)
      .filter((e) => e.isFile() && isNote(e.name))
      .map((e) => e.name.replace(/\.md$/, "")),
  );

const countNotes = (dir) =>
  entries(dir).reduce(
    (total, entry) =>
      entry.isDirectory()
        ? total + countNotes(path.join(dir, entry.name))
        : isNote(entry.name)
          ? total + 1
          : total,
    0,
  );

const dirLink = (segments) => `/notes/${segments.join("/")}/`;
const fileLink = (segments, file) =>
  `/notes/${[...segments, file].join("/")}.html`;

/** 篇目列：篇名全做成链接，用 · 分隔 */
const noteCell = (segments, dir) => {
  const files = noteFiles(dir);
  return files.length
    ? files.map((f) => `[${f}](${fileLink(segments, f)})`).join(" · ")
    : "—";
};

const lines = [];

const sections = sorted(
  entries(notesRoot)
    .filter((e) => e.isDirectory())
    .map((e) => e.name),
);

const total = sections.reduce(
  (sum, s) => sum + countNotes(path.join(notesRoot, s)),
  0,
);

const totalChapters = sections.reduce(
  (sum, s) => sum + childDirs(path.join(notesRoot, s)).length,
  0,
);

lines.push(
  "---",
  "title: 全栈笔记目录",
  "---",
  "",
  "# 全栈笔记目录",
  "",
  `${sections.length} 个方向、${totalChapters} 个章节、${total} 篇。下表是完整目录，点篇名直接进正文；左侧边栏是同一套目录树。`,
  "",
  "## 总览",
  "",
  "| 方向 | 篇数 | 章节 | 覆盖 |",
  "| --- | --: | --: | --- |",
);

for (const section of sections) {
  const sectionDir = path.join(notesRoot, section);
  const chapters = childDirs(sectionDir);
  const first = chapters[0] ? `\`${chapters[0]}\`` : "";
  const last =
    chapters.length > 1 ? ` → \`${chapters[chapters.length - 1]}\`` : "";
  lines.push(
    `| [${section}](${dirLink([section])}) | ${countNotes(sectionDir)} | ${chapters.length} | ${first}${last} |`,
  );
}

lines.push(
  `| **合计** | **${total}** | **${totalChapters}** | — |`,
  "",
  "## 明细",
  "",
);

for (const section of sections) {
  const sectionDir = path.join(notesRoot, section);
  const chapters = childDirs(sectionDir);
  const rootFiles = noteFiles(sectionDir);

  lines.push(`### [${section}](${dirLink([section])})`, "");
  lines.push(
    `共 ${countNotes(sectionDir)} 篇，${chapters.length} 个章节。`,
    "",
  );

  // 方向下的直属篇（当前结构没有，留作兼容）
  if (rootFiles.length) {
    lines.push("| 篇目 |", "| --- |");
    for (const file of rootFiles) {
      lines.push(`| [${file}](${fileLink([section], file)}) |`);
    }
    lines.push("");
  }

  // 三层的方向（05-后端）：按语言分小节
  const isThreeLevel = chapters.some((c) =>
    childDirs(path.join(sectionDir, c)).length > 0,
  );

  if (isThreeLevel) {
    for (const chapter of chapters) {
      const chapterDir = path.join(sectionDir, chapter);
      const groups = childDirs(chapterDir);

      if (!groups.length) continue;

      lines.push(
        `#### [${chapter}](${dirLink([section, chapter])}) · ${countNotes(chapterDir)} 篇`,
        "",
        "| 分类 | 篇数 | 篇目 |",
        "| --- | --: | --- |",
      );
      for (const group of groups) {
        const groupDir = path.join(chapterDir, group);
        lines.push(
          `| [${group}](${dirLink([section, chapter, group])}) | ${countNotes(groupDir)} | ${noteCell([section, chapter, group], groupDir)} |`,
        );
      }
      lines.push("");
    }
    continue;
  }

  // 两层的方向：章节一张表
  lines.push("| 章节 | 篇数 | 篇目 |", "| --- | --: | --- |");
  for (const chapter of chapters) {
    const chapterDir = path.join(sectionDir, chapter);
    lines.push(
      `| [${chapter}](${dirLink([section, chapter])}) | ${countNotes(chapterDir)} | ${noteCell([section, chapter], chapterDir)} |`,
    );
  }
  lines.push("");
}

lines.push(
  "---",
  "",
  "**本页由 `blog/scripts/gen-notes-index.mjs` 生成，不要手改。** 内容源在 `fullstack-notes`，本站是发布端。",
  "",
);

fs.writeFileSync(output, lines.join("\n"), "utf8");
console.log(
  `notes/index.md generated: ${sections.length} sections, ${total} notes`,
);
