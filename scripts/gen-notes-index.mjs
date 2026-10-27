import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const notesRoot = fileURLToPath(new URL("../src/notes/", import.meta.url));
const output = path.join(notesRoot, "index.md");

const sorted = (names) =>
  names.sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));

const isNote = (name) =>
  name.endsWith(".md") && name !== "index.md" && name !== "README.md";

const countNotes = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    if (entry.name.startsWith(".") || entry.name === "assets") return total;
    if (entry.isDirectory()) return total + countNotes(path.join(dir, entry.name));
    return isNote(entry.name) ? total + 1 : total;
  }, 0);

const sections = sorted(
  fs
    .readdirSync(notesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name),
);

const total = sections.reduce(
  (sum, section) => sum + countNotes(path.join(notesRoot, section)),
  0,
);

const lines = [
  "---",
  "title: 全栈笔记",
  "---",
  "",
  "# 全栈笔记",
  "",
  `按 ${sections.length} 个方向整理的工程笔记，共 ${total} 篇。左侧目录与本地笔记目录一一对应。`,
  "",
];

for (const section of sections) {
  const sectionDir = path.join(notesRoot, section);
  const subdirs = sorted(
    fs
      .readdirSync(sectionDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name),
  );

  const files = sorted(
    fs
      .readdirSync(sectionDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && isNote(entry.name))
      .map((entry) => entry.name.replace(/\.md$/, "")),
  );

  lines.push(`## ${section}`, "", `共 ${countNotes(sectionDir)} 篇。`, "");

  for (const subdir of subdirs) {
    const count = countNotes(path.join(sectionDir, subdir));
    lines.push(`- [${subdir}](/notes/${section}/${subdir}/) · ${count} 篇`);
  }

  for (const file of files) {
    lines.push(`- [${file}](/notes/${section}/${file}.html)`);
  }

  lines.push("");
}

fs.writeFileSync(output, lines.join("\n"), "utf8");
console.log(`notes/index.md generated: ${sections.length} sections, ${total} notes`);
