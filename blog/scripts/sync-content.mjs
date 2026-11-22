/**
 * 从两个源仓库同步站点内容：
 *   全栈笔记     fullstack-notes    -> src/notes/     （README.md 变成 /notes/ 首页）
 *   Agent 工作流  fullstack-workflow -> src/workflow/  （backup-docs 的 README + 01–06）
 *   模板副本     fullstack-workflow -> ../../docs/99-模板文档/
 *
 * 同步是单向的：两个源仓库是唯一事实源，src/notes 与 src/workflow 都是生成产物，
 * 在站点里手改会被下一次同步覆盖。改内容去改源仓库。
 *
 * 用法：
 *   npm run sync
 *   NOTES_SRC=/path/to/fullstack-notes WORKFLOW_SRC=/path/to/fullstack-workflow npm run sync
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const blogDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = path.resolve(blogDir, "..");

const NOTES_SRC =
  process.env.NOTES_SRC || path.join(repoDir, "..", "fullstack-notes");
const WORKFLOW_SRC =
  process.env.WORKFLOW_SRC || path.join(repoDir, "..", "fullstack-workflow");

const DEST_NOTES = path.join(blogDir, "src/notes");
const DEST_WORKFLOW = path.join(blogDir, "src/workflow");
const DEST_TEMPLATES = path.join(repoDir, "docs/99-模板文档");

/** 路径里的 + 会被 VuePress 转义成 _，导致目录页链接 404，统一改名 */
const RENAMES = [["C++", "Cpp"]];

const SKIP_DIRS = new Set([".git", ".openchamber", "node_modules"]);
const SKIP_FILES = new Set([".DS_Store"]);

const read = (file) => fs.readFileSync(file, "utf8");
const write = (file, text) => fs.writeFileSync(file, text, "utf8");
const renameName = (name) =>
  RENAMES.reduce((acc, [from, to]) => acc.split(from).join(to), name);

/* ---------------- 复制 ---------------- */

function copyTree(srcDir, destDir, { rename = true, skipFiles = SKIP_FILES } = {}) {
  fs.mkdirSync(destDir, { recursive: true });

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (skipFiles.has(entry.name)) continue;

    const src = path.join(srcDir, entry.name);
    const name = rename ? renameName(entry.name) : entry.name;

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      copyTree(src, path.join(destDir, name), { rename, skipFiles });
    } else {
      fs.copyFileSync(src, path.join(destDir, name));
    }
  }
}

/* ---------------- 正文修补 ---------------- */

/** 软件工程那 9 篇标题带 NN- 序号，页面标题会变成「01-软件工程图典」 */
const stripHeadingNumber = (text) =>
  text.replace(/^# ([0-9]{2})-(?!\d)(.+)$/m, "# $2");

/**
 * Vue 会把 {{ }} 当插值。源库有 10 行在行内代码里写 ${{ github.sha }}，
 * 渲染时抛 TypeError 并让整页内容残缺，包一层 <span v-pre> 跳过编译。
 */
function protectMustache(text) {
  const lines = text.split("\n");
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line.includes("{{")) continue;

    lines[i] = line.replace(/`[^`\n]*`/g, (span) =>
      span.includes("{{") ? `<span v-pre>${span}</span>` : span,
    );
  }
  return lines.join("\n");
}

/* ---------------- frontmatter ---------------- */

function withFrontmatter(text, extra) {
  const lines = Object.entries(extra).map(
    ([key, value]) => `${key}: ${JSON.stringify(value)}`,
  );

  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) {
      const head = text.slice(0, end);
      const rest = text.slice(end);
      const missing = lines.filter(
        (line) => !new RegExp(`^${line.split(":")[0]}:`, "m").test(head),
      );
      return missing.length ? `${head}\n${missing.join("\n")}${rest}` : text;
    }
  }
  return `---\n${lines.join("\n")}\n---\n\n${text}`;
}

const h1Of = (text) => {
  const line = text.split("\n").find((l) => l.startsWith("# "));
  return line ? line.slice(2).trim() : null;
};

/* ---------------- 目标一：全栈笔记 ---------------- */

function syncNotes() {
  fs.rmSync(DEST_NOTES, { recursive: true, force: true });
  // 源库 README 单独处理（写成 README.md 保持与源库一致），这里跳过原文件
  copyTree(NOTES_SRC, DEST_NOTES, {
    skipFiles: new Set([...SKIP_FILES, "README.md"]),
  });

  // README.md 用 permalink 落到 00-内容导读.html：
  // 不写 permalink 的话它会占住 /notes/，和自动生成的 index.md 撞路径，构建报 duplicate ID
  const readmeSrc = path.join(NOTES_SRC, "README.md");
  if (fs.existsSync(readmeSrc)) {
    const text = read(readmeSrc)
      .replace(/^# 全栈笔记$/m, "# 全栈笔记导读")
      .split("C++")
      .join("Cpp")
      // 源库里的相对目录链接改成站内路径
      .replace(
        /\*\*\[([0-9]{2}-[^\]]+)\]\(([0-9]{2}-[^\s)]+\/)\)\*\*/g,
        (m, label, dir) => `**[${label}](/notes/${dir})**`,
      );
    write(
      path.join(DEST_NOTES, "README.md"),
      withFrontmatter(text, {
        title: "00-内容导读",
        permalink: "/notes/00-内容导读.html",
        category: "导读",
      }),
    );
  }

  let touched = 0;
  const walk = (dir, section) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const rel = path.relative(DEST_NOTES, file);
      const top = rel.split(path.sep)[0];

      if (entry.isDirectory()) {
        walk(file, section || top);
        continue;
      }
      if (!entry.name.endsWith(".md") || entry.name === "index.md") continue;

      let text = read(file);
      const before = text;
      text = stripHeadingNumber(text);
      text = protectMustache(text);
      text = withFrontmatter(text, {
        title: h1Of(text) || entry.name.replace(/\.md$/, ""),
        category: section || top,
      });

      if (text !== before) {
        write(file, text);
        touched++;
      }
    }
  };
  walk(DEST_NOTES, "");

  console.log(
    `notes    ${path.relative(repoDir, NOTES_SRC)} -> blog/src/notes  ` +
      `（${countMd(DEST_NOTES)} 篇，改写 ${touched} 个）`,
  );
}

/* ---------------- 目标二：Agent 工作流 ---------------- */

/**
 * Agent 工作流按源仓库 backup-docs 的原始 7 份文件发布。
 * 侧边栏顺序 = 00-内容导读（README）+ 01…06，与 README 里的「装什么」表格一一对应。
 */
const WORKFLOW_DOCS = [
  {
    file: "README.md",
    title: "00-内容导读",
    permalink: "/workflow/00-内容导读.html",
    summary: "装什么、怎么让 AI 装、装完怎么用",
    target: "读完就懂",
  },
  {
    file: "01-全局AGENTS模板.md",
    title: "01-全局AGENTS模板",
    summary: "行为底线、任务分级、四道门",
    target: "`~/.config/opencode/AGENTS.md`",
  },
  {
    file: "02-subagent模版.md",
    title: "02-subagent模板",
    summary: "七个角色的系统提示词",
    target: "拆成 7 个文件进 `~/.config/opencode/agents/`",
  },
  {
    file: "03-skill与mcp模板.md",
    title: "03-skill与mcp模板",
    summary: "每角色用哪个 skill、连哪个 MCP",
    target: "按表装配",
  },
  {
    file: "04-项目AGENTS模板.md",
    title: "04-项目AGENTS模板",
    summary: "项目特有的事实与命令",
    target: "每个项目复制成 `AGENTS.md`",
  },
  {
    file: "05-docs文档模板.md",
    title: "05-docs文档模板",
    summary: "`docs/` 下每份文档写哪几节",
    target: "不装，查用",
  },
  {
    file: "06-项目目录模板.md",
    title: "06-项目目录模板",
    summary: "目录怎么建、怎么裁剪",
    target: "不装，查用",
  },
];

/** /workflow/ 首页：和 /notes/ 一样先给目录，不直接跳内容 */
const buildWorkflowHome = () =>
  [
    "---",
    "title: Agent 工作流目录",
    "---",
    "",
    "# Agent 工作流目录",
    "",
    "一套「AI + 人」的端到端交付规范：七个岗位角色、八道门，把人和 AI 的分工钉死。",
    "",
    "下表是全部 7 份文档，点标题进正文；左侧边栏是同一套顺序。",
    "",
    "| # | 文档 | 装到哪 | 讲什么 |",
    "| --: | --- | --- | --- |",
    ...WORKFLOW_DOCS.map((doc, i) => {
      const link = doc.permalink || `/workflow/${doc.file.replace(/\.md$/, "")}.html`;
      return `| ${i} | [${doc.title}](${link}) | ${doc.target} | ${doc.summary} |`;
    }),
    "",
    "**1–3 是全局的，装一次；4 每个项目装一次；5、6 查用。**",
    "",
  ].join("\n");

function syncWorkflow() {
  const docsSrc = path.join(WORKFLOW_SRC, "backup-docs");

  for (const dir of [DEST_WORKFLOW, DEST_TEMPLATES]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(DEST_WORKFLOW, { recursive: true });
  fs.mkdirSync(DEST_TEMPLATES, { recursive: true });

  let pages = 0;
  for (const doc of WORKFLOW_DOCS) {
    const src = path.join(docsSrc, doc.file);
    if (!fs.existsSync(src)) {
      console.log(`  ! 缺失 ${doc.file}，跳过`);
      continue;
    }

    const name = doc.name || doc.file;
    let text = read(src);
    if (doc.file === "README.md") {
      text = text
        // 站内页面标题用中文名，不用仓库名
        .replace(/^# fullstack-workflow$/m, "# Agent 工作流")
        // 站点上不需要「存档 / 活版本在哪」这类仓库内说明
        .replace(
          /^> \*\*这是 v1\.0\.0 定稿存档[\s\S]*?不是给新项目装的。\n/m,
          "> 这套规范是 v1.0.0 定稿版：7 份文档，装好 OpenChamber 之后整套丢给 AI 就能配好并开工。\n",
        )
        // 源仓库里的安装路径换成站点里能点的链接
        .replace(
          /[`]*\[\`?fullstack-workflow\/\`?\]\(\.\/fullstack-workflow\/\)[`]*/g,
          "本目录的 01–06",
        );
    }

    // README 用 permalink 落到 00-内容导读，避免和首页 index.md 抢 /workflow/
    const fm = { title: doc.title };
    if (doc.permalink) fm.permalink = doc.permalink;
    text = withFrontmatter(text, fm);

    write(path.join(DEST_WORKFLOW, name), text);
    // 项目内副本保持 v1.0 原始形态：README + 01–06 平铺
    write(path.join(DEST_TEMPLATES, doc.file), text);
    pages++;
  }

  write(path.join(DEST_WORKFLOW, "index.md"), buildWorkflowHome());

  console.log(
    `workflow ${path.relative(repoDir, WORKFLOW_SRC)}/backup-docs -> ` +
      `blog/src/workflow（${pages} 页 + 目录首页）+ docs/99-模板文档（${pages} 份）`,
  );
}

/* ---------------- 校验 ---------------- */

function countMd(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".md") && entry.name !== "index.md") n++;
    }
  };
  walk(dir);
  return n;
}

function check() {
  const problems = [];

  const scan = (root) => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) {
        scan(file);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;

      const rel = path.relative(repoDir, file);
      let inFence = false;

      for (const line of read(file).split("\n")) {
        if (/^\s*```/.test(line)) {
          inFence = !inFence;
          continue;
        }
        if (inFence) continue;

        // 去掉行内代码，代码里写的示例路径不算真引用
        const text = line.replace(/`[^`\n]*`/g, (span) =>
          span.replace(/[^\s]+\.[a-z]+/gi, ""),
        );

        for (const m of text.matchAll(/\]\(([^)\s]+\.md)(#[^)]*)?\)/g)) {
          if (/^https?:/.test(m[1])) continue;
          if (!fs.existsSync(path.resolve(path.dirname(file), m[1]))) {
            problems.push(`断链 ${rel} -> ${m[1]}`);
          }
        }
        for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
          if (/^https?:|^data:/.test(m[1])) continue;
          if (!fs.existsSync(path.resolve(path.dirname(file), m[1]))) {
            problems.push(`缺图 ${rel} -> ${m[1]}`);
          }
        }
      }
    }
  };
  scan(path.join(blogDir, "src"));

  if (problems.length) {
    console.log(`\n校验：${problems.length} 个问题`);
    console.log(problems.slice(0, 30).join("\n"));
  } else {
    console.log("\n校验：无断链、无缺图");
  }
  return problems.length;
}

syncNotes();
syncWorkflow();
process.exitCode = check() ? 1 : 0;
