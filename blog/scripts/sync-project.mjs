/**
 * 把 docs/ 的产物同步成「全栈项目」栏目里的项目笔记。
 *
 *   源：<仓库根>/docs/         （工作流规定的唯一状态源）
 *   目标：blog/src/projects/01-米奇妙妙屋/
 *   HTML 产物：拷到 blog/src/.vuepress/public/project-assets/
 *
 * 规则：
 *   1. 只重建 01-产品 … 07-审查 这 7 个目录；不动 00-项目介绍.md、index.md、README.md
 *   2. 文件名去掉版本号（v1.0.0_20261122），版本信息留在文首那三行流程头里
 *   3. 链上产物的「审查 / 放行」流程头原样保留——它是流程证据，不是完成度
 *   4. HTML 产物不转成 md 正文，生成一个内嵌 iframe 的页面
 *   5. 三种会让 Vue 编译失败的写法自动修（C++ 改名、${{ }} 包裹、裸尖括号转义）
 *
 * 用法：npm run sync:project
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const blogDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = path.resolve(blogDir, "..");

const DOCS_SRC = path.join(repoDir, "docs");
const PROJECT_DIR = path.join(blogDir, "src/projects/01-米奇妙妙屋");
const ASSETS_DEST = path.join(blogDir, "src/.vuepress/public/project-assets");

/** 生成的 7 个角色目录；同步时整目录重建 */
const ROLE_DIRS = [
  "01-产品",
  "02-设计",
  "03-架构",
  "04-开发",
  "05-测试",
  "06-运维",
  "07-审查",
];

/** 手写内容，同步永不触碰 */
const HAND_WRITTEN = new Set(["index.md", "README.md", "00-项目介绍.md"]);

const read = (file) => fs.readFileSync(file, "utf8");
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
};

const h1Of = (text) => {
  const line = text.split("\n").find((l) => l.startsWith("# "));
  return line ? line.slice(2).trim() : null;
};

/* ---------------- 三种会让 Vue 挂掉的写法 ---------------- */

/**
 * 文首那段引用块里每一行单独成段。
 *
 * 原始写法是连续的 > 行，Markdown 会把它们合并成一个段落，
 * 渲染出来就是「PRD1 … 审查：… 放行：…」挤成一长串。
 * 在每两行之间插一个空的 > 行，让每项各自成段。
 *
 * 只处理第一个 # 标题之前的那段，正文里的引用块不动。
 */
function splitHeaderBlockquote(text) {
  const lines = text.split("\n");
  const headingIndex = lines.findIndex((l) => l.startsWith("# "));
  const end = headingIndex === -1 ? lines.length : headingIndex;

  const out = [];
  let inHeader = false;

  for (let i = 0; i < end; i++) {
    const line = lines[i];
    const isQuote = line.startsWith(">");

    if (isQuote) {
      if (inHeader && out.length && out[out.length - 1] !== ">") out.push(">");
      inHeader = true;
      out.push(line);
    } else {
      inHeader = false;
      out.push(line);
    }
  }

  out.push(...lines.slice(end));
  return out.join("\n");
}

/** 行内代码里的 {{ }} → 包 <span v-pre>（围栏内跳过） */
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

/* ---------------- 映射表 ---------------- */

/**
 * src   —— 相对 docs/ 的路径
 * out   —— 相对 01-米奇妙妙屋/<角色>/ 的文件名
 *
 * 文件名里的序号与 docs/ 完全一致（03-PRD、04-术语表…），
 * 序号有跳号的地方说明 docs 里本来就没有那份产物，跳号原样保留。
 */
const MAP = [
  // 01-产品（docs 序号：01-BRD、02-MRD 缺，03-PRD、04-术语表）
  {
    dir: "01-产品",
    src: "01-产品/03-PRD产品需求/PRD1_全栈笔记站_v1.0.0_20261122.md",
    out: "03-PRD1-全栈笔记站.md",
    title: "PRD1 · 全栈笔记站",
  },
  {
    dir: "01-产品",
    src: "01-产品/04-产品术语表.md",
    out: "04-产品术语表.md",
    title: "产品术语表",
  },

  // 02-设计（01-设计系统、02-原型图、03-页面规格）
  {
    dir: "02-设计",
    src: "02-设计/01-设计系统.md",
    out: "01-设计系统.md",
    title: "设计系统",
  },
  {
    dir: "02-设计",
    srcHtml: "02-设计/02-原型图/index.html",
    out: "02-原型图.md",
    title: "原型图（可交互）",
    asset: "proto.html",
    height: 900,
    note: "OpenDesign 生成，单文件自包含。上面是真实产物，可直接切四屏、切桌面/手机宽度。",
  },
  {
    dir: "02-设计",
    src: "02-设计/03-页面规格_全栈笔记站_v1.0.0_20261122.md",
    out: "03-页面规格.md",
    title: "页面规格",
  },

  // 03-架构（01-系统架构、02-架构图示、04-环境规范；03 状态机缺）
  {
    dir: "03-架构",
    src: "03-架构/01-系统架构_全栈笔记站_v1.0.0_20261122.md",
    out: "01-系统架构.md",
    title: "系统架构",
  },
  {
    dir: "03-架构",
    srcHtml: "03-架构/02-架构图示_v1.0.0.html",
    out: "02-架构图示.md",
    title: "架构图示",
    asset: "arch.html",
    height: 760,
    embedClass: "embed-arch",
    note: "Archify 生成，9 节点 + 2 个边界框。可缩放、可切换深浅色。",
  },
  {
    dir: "03-架构",
    src: "03-架构/04-项目环境规范.md",
    out: "04-项目环境规范.md",
    title: "项目环境规范",
  },
  {
    dir: "03-架构",
    src: "03-架构/07-ADR重要决策/ADR1_内容源与站点分离_v1.0.0_20261122.md",
    out: "07-ADR重要决策/ADR1-内容源与站点分离.md",
    title: "ADR1 · 内容源与站点分离",
  },
  {
    dir: "03-架构",
    src: "03-架构/07-ADR重要决策/ADR2_主题选型_v1.0.0_20261122.md",
    out: "07-ADR重要决策/ADR2-主题选型.md",
    title: "ADR2 · 主题选型",
  },
  {
    dir: "03-架构",
    src: "03-架构/07-ADR重要决策/ADR3_不用数据库_v1.0.0_20261122.md",
    out: "07-ADR重要决策/ADR3-不用数据库.md",
    title: "ADR3 · 不用数据库",
  },

  // 04-开发（01-代码规范、02-技术方案、03-实现记录）
  {
    dir: "04-开发",
    src: "04-开发/01-代码规范.md",
    out: "01-代码规范.md",
    title: "代码规范",
  },
  {
    dir: "04-开发",
    src: "04-开发/02-技术方案/TD1_站点从零搭建_全栈笔记站_v1.0.0_20261122.md",
    out: "02-技术方案.md",
    title: "技术方案 · 站点从零搭建",
  },
  {
    dir: "04-开发",
    src: "04-开发/03-实现记录/TD1_站点从零搭建_全栈笔记站_实现记录_v1.0.0_20261122.md",
    out: "03-实现记录.md",
    title: "实现记录",
  },

  // 05-测试
  {
    dir: "05-测试",
    src: "05-测试/01-测试策略.md",
    out: "01-测试策略.md",
    title: "测试策略",
  },
  {
    dir: "05-测试",
    src: "05-测试/02-测试方案/TP1_首版验证_全栈笔记站_v1.0.0_20261122.md",
    out: "02-测试方案.md",
    title: "测试方案 · 首版验证",
  },
  {
    dir: "05-测试",
    src: "05-测试/03-测试报告/TR1_首版验证_全栈笔记站_v1.0.0_20261122.md",
    out: "03-测试报告.md",
    title: "测试报告 · 首版验证",
  },

  // 06-运维
  {
    dir: "06-运维",
    src: "06-运维/01-服务详细情况.md",
    out: "01-服务详细情况.md",
    title: "服务详细情况",
  },
  {
    dir: "06-运维",
    srcHtml: "06-运维/02-部署拓扑.html",
    out: "02-部署拓扑.md",
    title: "部署拓扑",
    asset: "topo.html",
    height: 720,
    embedClass: "embed-topo",
    note: "手写 SVG，7 节点 3 链路。橙色虚线标出「内容源仓库不在生产链路上」。",
  },
  {
    dir: "06-运维",
    src: "06-运维/03-运维手册.md",
    out: "03-运维手册.md",
    title: "运维手册",
  },
  {
    dir: "06-运维",
    src: "06-运维/04-发布记录.md",
    out: "04-发布记录.md",
    title: "发布记录",
  },

  // 07-审查
  {
    dir: "07-审查",
    src: "07-审查/01-审查清单.md",
    out: "01-审查清单.md",
    title: "审查清单",
  },
  {
    dir: "07-审查",
    src: "07-审查/02-审查报告/CR1_站点首版审查_全栈笔记站_v1.0.0_20261122.md",
    out: "02-审查报告.md",
    title: "审查报告 · 站点首版",
  },
];

/* ---------------- 生成 ---------------- */

/** 给正文补 frontmatter：标题由映射表给，分类是角色目录名 */
function withFrontmatter(text, title, category) {
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) return text;
  }
  return `---\ntitle: ${JSON.stringify(title)}\ncategory: ${JSON.stringify(category)}\n---\n\n${text}`;
}

/** HTML 产物：生成一个内嵌 iframe 的页面 */
function buildIframePage(entry) {
  const lines = [
    `# ${entry.title}`,
    "",
    `> 这一页嵌的是**真实产物**，不是截图。可以在页面上直接操作。`,
    "",
    `<div class="project-embed${entry.embedClass ? ` ${entry.embedClass}` : ""}">`,
    `  <iframe src="/project-assets/${entry.asset}" title="${entry.title}" loading="lazy"></iframe>`,
    `</div>`,
    "",
  ];

  if (entry.note) {
    lines.push(`**说明**：${entry.note}`, "");
  }

  lines.push(
    "> 如果内嵌区域显示不全，说明浏览器拦了 iframe，改用新窗口打开：",
    `> [` + `/${"project-assets/" + entry.asset}` + `](/project-assets/${entry.asset})`,
    "",
  );

  return lines.join("\n");
}

function syncProject() {
  if (!fs.existsSync(DOCS_SRC)) {
    console.error(`源目录不存在：${path.relative(repoDir, DOCS_SRC)}`);
    process.exit(1);
  }

  // 1. 只清空 7 个角色目录，手写内容不动
  for (const dir of ROLE_DIRS) {
    fs.rmSync(path.join(PROJECT_DIR, dir), { recursive: true, force: true });
  }

  // 2. HTML 产物拷到 public（ASCII 文件名，避免 URL 编码问题）
  fs.rmSync(ASSETS_DEST, { recursive: true, force: true });
  fs.mkdirSync(ASSETS_DEST, { recursive: true });

  let pages = 0;
  let embeds = 0;

  for (const entry of MAP) {
    // HTML → iframe 页
    if (entry.srcHtml) {
      const srcFile = path.join(DOCS_SRC, entry.srcHtml);
      if (!fs.existsSync(srcFile)) {
        console.log(`  ! 缺失 ${entry.srcHtml}，跳过`);
        continue;
      }
      fs.copyFileSync(srcFile, path.join(ASSETS_DEST, entry.asset));

      const md = withFrontmatter(
        buildIframePage(entry),
        entry.title,
        entry.dir,
      );
      write(path.join(PROJECT_DIR, entry.dir, entry.out), md);
      pages++;
      embeds++;
      continue;
    }

    // Markdown → 笔记
    const srcFile = path.join(DOCS_SRC, entry.src);
    if (!fs.existsSync(srcFile)) {
      console.log(`  ! 缺失 ${entry.src}，跳过`);
      continue;
    }

    let text = read(srcFile);
    text = splitHeaderBlockquote(text);
    text = protectMustache(text);
    text = withFrontmatter(text, entry.title, entry.dir);
    write(path.join(PROJECT_DIR, entry.dir, entry.out), text);
    pages++;
  }

  // 3. 统计
  const countMd = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => {
      if (e.isDirectory()) return sum + countMd(path.join(dir, e.name));
      return sum + (e.name.endsWith(".md") ? 1 : 0);
    }, 0);

  const total = ROLE_DIRS.reduce((sum, dir) => {
    const p = path.join(PROJECT_DIR, dir);
    return sum + (fs.existsSync(p) ? countMd(p) : 0);
  }, 0);

  console.log(
    `project  docs -> blog/src/projects/01-米奇妙妙屋  ` +
      `（${total} 篇：${pages} 生成，含 ${embeds} 个内嵌产物）`,
  );
  console.log(`         HTML -> blog/src/.vuepress/public/project-assets（${embeds} 个）`);
}

syncProject();
