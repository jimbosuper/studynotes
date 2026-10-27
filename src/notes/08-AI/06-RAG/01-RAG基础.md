# RAG 基础

## 一、工程案例：给 300 页产品手册做可引用的问答

**场景**：一份 300 页的工业设备手册（PDF，约 15 万字，含目录、参数表、接线图、故障码表）。售后工程师每天在群里问「E-042 是什么故障」「传感器接哪两个端子」。目标是做一个内部问答服务：输入问题，输出**结论 + 出处（章节 + 页码）**，手册里没有的问题明确拒答。

**为什么选这个案例**：它同时踩中 RAG 的四个真实约束——① 文档长到塞不进上下文；② 手册里有大量表格和型号，纯语义检索会失手；③ 答案必须能翻到原页核对，售后要担责；④ 手册每季度改版，旧版必须下架。

**交付物**：`parse.py`（解析 → 清洗 → 分块）、`ingest.py`（入库）、`ask.py`（检索 → 拼上下文 → 生成 → 引用）、`common.py`（客户端与连接）、一份 10 题自测记录、一张验收表。

### 1.1 环境与目录

```bash
docker run -d --name pgvector --restart=always \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ragdb -p 5432:5432 \
  pgvector/pgvector:pg16

python3.12 -m venv .venv && source .venv/bin/activate
pip install "openai>=1.40" "psycopg[binary]>=3.2" "pgvector>=0.3" \
            "pypdf>=5.0" "numpy>=1.26"

export OPENAI_API_KEY="sk-..."
export OPENAI_BASE_URL="https://api.openai.com/v1"
export EMBED_MODEL="text-embedding-3-small"
export EMBED_DIM="1536"
export CHAT_MODEL="gpt-4o-mini"
export PGVECTOR_DSN="postgresql://postgres:postgres@localhost:5432/ragdb"
```

```text
manual/
├── docs/manual_v3.2.pdf
├── common.py           # 客户端、连接、embedding
├── parse.py            # 解析、清洗、分块
├── ingest.py           # 入库
├── ask.py              # 检索、拼上下文、生成、引用
└── eval/questions.jsonl
```

```python
# common.py
import os
import psycopg
from openai import OpenAI
from pgvector.psycopg import register_vector

client = OpenAI()                       # 读 OPENAI_API_KEY / OPENAI_BASE_URL
EMBED_MODEL = os.environ["EMBED_MODEL"]
EMBED_DIM = int(os.environ["EMBED_DIM"])
CHAT_MODEL = os.environ["CHAT_MODEL"]


def connect() -> psycopg.Connection:
    """先执行 1.5 的 DDL 再调用：vector 类型不存在时 register_vector 会报错。"""
    conn = psycopg.connect(os.environ["PGVECTOR_DSN"])
    register_vector(conn)               # 不注册时，传 list 会报类型错误
    return conn
```

> 国内环境两个高频坑：chat 与 embedding 往往不是同一个端点，先确认服务商真的提供 embedding 接口；换 embedding 模型必须同步改表维度，见 2.2 与 2.8。

### 1.2 解析：先确认文字真的读出来了

```python
# parse.py
import re
from pathlib import Path

def parse_pdf(path: Path) -> list[str]:
    """按页解析，保留 [[pN]] 标记，后面用来生成页码引用。"""
    from pypdf import PdfReader
    pages = []
    for i, page in enumerate(PdfReader(str(path)).pages, start=1):
        text = page.extract_text() or ""
        pages.append(f"[[p{i}]]\n{text}")
    return pages


def report(pages: list[str]) -> None:
    lens = [len(re.sub(r"\[\[p\d+\]\]", "", p).strip()) for p in pages]
    empty = sum(1 for n in lens if n < 20)
    mid = sorted(lens)[len(lens) // 2]
    print(f"页数={len(pages)} 总字数={sum(lens)} 空页={empty} 每页中位数={mid}")
```

```text
页数=<实测> 总字数=<实测> 空页=<实测> 每页中位数=<实测>
```

**判断标准**：中位数只有几十字、空页占比超过 5%，基本是扫描件——PDF 里存的是图片，`extract_text()` 取不到文字层，必须先 OCR（`pymupdf` 渲染成图 + OCR）。这一步不做，后面每个环节都在处理空气。

### 1.3 清洗：删掉每页都出现的那几行

页眉页脚（「XX 公司 版权所有」「第 3 页 / 共 300 页」）会在每个块里重复，既污染向量又浪费 token。它们有个共同特征：**在多页重复出现**。

```python
from collections import Counter

def strip_running_heads(pages: list[str], ratio: float = 0.3) -> list[str]:
    """删掉出现在超过 ratio 比例页面上的短行（页眉、页脚、水印）。"""
    cnt = Counter()
    for p in pages:
        for line in {l.strip() for l in p.splitlines() if l.strip()}:
            cnt[line] += 1
    threshold = max(3, int(len(pages) * ratio))
    noise = {l for l, c in cnt.items() if c >= threshold and len(l) < 40}
    # 只删命中的噪声行，空行原样保留：段落边界是后续按 \n\n 切块的前提
    return ["\n".join(l for l in p.splitlines() if l.strip() not in noise) for p in pages]
```

再补两步：合并 PDF 断行（行尾不是句末标点、下一行也不是新段落时接上）、把连续空行压成两个换行。

> 清洗规则宁可少写。删多了会把正文里的短句（「注意：断电后操作」）当成页眉删掉；删少了只是多几个噪声块。每加一条规则，抽 3 页看结果。

### 1.4 分块：标题优先，长度兜底

手册有清晰的章节结构，**按标题切**是最优解：每块自带「第 4 章 安装 > 4.2 接线」的路径，检索命中后模型立刻知道语境。

```python
import re

def split_recursive(text: str, size: int, seps=("\n\n", "\n", "。", "；", "")) -> list[str]:
    """按分隔符优先级从粗到细切，切不动才硬切。"""
    if len(text) <= size:
        return [text] if text.strip() else []
    if not seps:                                  # 分隔符用尽：按长度硬切
        return [text[i:i + size] for i in range(0, len(text), size)]
    sep, rest = seps[0], seps[1:]
    parts = [text] if sep == "" else text.split(sep)
    out, buf = [], ""
    for part in parts:
        if not part:
            continue
        piece = part + sep if sep else part
        if len(piece) > size:                     # 单段装不下：降一级再切
            if buf:
                out.append(buf); buf = ""
            out.extend(split_recursive(piece.strip(), size, rest))
        elif len(buf) + len(piece) <= size:
            buf += piece
        else:
            out.append(buf); buf = piece
    return out + ([buf] if buf else [])


def chunk_by_heading(md: str, max_chars: int = 700) -> list[dict]:
    """按标题层级切块，标题路径与页码写进每块。"""
    chunks, stack, buf = [], [], []
    cur_page = None

    def flush():
        body = "\n".join(buf).strip()
        if not body:
            return
        path = " > ".join(t for _, t in stack) or "正文"
        # 页标记当硬边界：块不跨页，page 才是正文真正所在的页
        for seg in re.split(r"(?=\[\[p\d+\]\])", body):
            m = re.search(r"\[\[p(\d+)\]\]", seg)
            page = int(m.group(1)) if m else cur_page
            text = re.sub(r"\[\[p\d+\]\]\n?", "", seg).strip()
            if not text:
                continue
            subs = [text] if len(text) <= max_chars else split_recursive(text, max_chars)
            chunks.extend({"section": path, "page": page, "content": s} for s in subs)

    for line in md.split("\n"):
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            flush()
            level, title = len(m.group(1)), m.group(2).strip()
            stack = [(lv, t) for lv, t in stack if lv < level]
            stack.append((level, title))
            buf = [f"[[p{cur_page}]]"] if cur_page else []   # 标题后的正文仍属于当前页
        else:
            pm = re.match(r"^\[\[p(\d+)\]\]\s*$", line)
            if pm:
                cur_page = int(pm.group(1))
            buf.append(line)
    flush()
    return chunks
```

以页为界会让块数变多（300 页大约 300–800 块），但这是「引用能翻到原页」的代价。跨页块省了块数，却让 `page` 只是起始页，第 8 项验收经常翻错页。

PDF 里没有 `#` 标记，先把「第 X 章」「4.2 xxx」这类行改写成 Markdown 标题：

```python
HEAD_PATTERNS = [
    (r"^第\s*[一二三四五六七八九十\d]+\s*章\s*.+$", 1),
    (r"^\d+\.\d+\s+\S.+$", 2),
    (r"^\d+\.\d+\.\d+\s+\S.+$", 3),
]

def pdf_to_markdown(pages: list[str]) -> str:
    out = []
    for p in pages:
        for line in p.splitlines():
            s = line.strip()
            for pat, level in HEAD_PATTERNS:
                if re.match(pat, s) and len(s) < 40:
                    out.append("#" * level + " " + s)
                    break
            else:
                out.append(line)
    return "\n".join(out)
```

目录页的条目也长得像标题（「第 4 章 安装 …… 37」），会被误判成章节，后面正文就挂到错误路径下。按行尾的引导符 `……`／`....` 或连续页码先把目录页剔掉，再改写标题。

参数取值：

| 内容 | 块大小 | overlap | 说明 |
|---|---|---|---|
| 参数表、故障码表 | 整表一块 | 0 | 行与行互相依赖，不能切 |
| 接线步骤、操作流程 | 300–500 字 | 0 | 步骤必须连续 |
| 概念说明、原理 | 500–700 字 | 50–80 | 论证链条长 |
| 目录、索引页 | 不入库 | — | 没有答案，只会抢名额 |

分块完必须看块长分布，不看就是盲调：

```sql
SELECT count(*) AS chunks, round(avg(length(content))) AS avg_len,
       min(length(content)) AS min_len, max(length(content)) AS max_len
FROM chunks WHERE doc_id = 'manual' AND version = 'v3.2';
```

```text
chunks=<实测> avg_len=<实测> min_len=<实测> max_len=<实测>
```

### 1.5 入库：元数据比向量更重要

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE chunks (
    id          bigserial PRIMARY KEY,
    doc_id      text NOT NULL,
    version     text NOT NULL,
    chunk_index int  NOT NULL,
    section     text NOT NULL,
    page        int,
    content     text NOT NULL,
    embedding   vector(1536) NOT NULL,
    is_public   boolean NOT NULL DEFAULT true,
    dept        text,
    is_active   boolean NOT NULL DEFAULT true,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (doc_id, version, chunk_index)
);

CREATE INDEX chunks_emb_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_doc_idx ON chunks (doc_id, version, is_active);
CREATE INDEX chunks_dept_idx ON chunks (dept) WHERE is_active;
```

| 字段 | 用途 | 缺了会怎样 |
|---|---|---|
| `doc_id` + `version` | 引用、整版下架 | 改版后新旧答案并存 |
| `section` | 引用显示到节 | 只能给文件名，用户无法核对 |
| `page` | PDF 翻页定位 | 300 页手册里找不到原文 |
| `is_active` | 旧版下架 | 检索到已废止的参数 |
| `dept` / `is_public` | 权限过滤 | 越权检索（见 3.9） |

```python
def embed(texts: list[str], batch: int = 64) -> list[list[float]]:
    out = []
    for i in range(0, len(texts), batch):
        resp = client.embeddings.create(
            model=EMBED_MODEL, input=[t[:6000] for t in texts[i:i + batch]],
            dimensions=EMBED_DIM)        # 仅 OpenAI v3 / 声明支持 MRL 的模型
        out.extend(d.embedding for d in resp.data)
    return out


def ingest(conn, doc_id: str, version: str, chunks: list[dict]) -> int:
    vecs = embed([c["content"] for c in chunks])
    with conn.transaction():            # 同一事务：要么全换，要么不动
        with conn.cursor() as cur:
            cur.execute("DELETE FROM chunks WHERE doc_id=%s AND version=%s", (doc_id, version))
            cur.executemany(
                """INSERT INTO chunks (doc_id, version, chunk_index, section, page, content, embedding)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                [(doc_id, version, i, c["section"], c["page"], c["content"], v)
                 for i, (c, v) in enumerate(zip(chunks, vecs))])
    return len(chunks)
```

> `DELETE` 与 `INSERT` 必须在同一个事务里。`with conn.cursor()` 只是游标，不是事务；psycopg 默认不自动提交，漏掉 `conn.transaction()`（或 `conn.commit()`）时数据根本不会落库。分开提交时，中间失败会留下一个空库，线上直接全量拒答。

> `t[:6000]` 是保守截断，不是分块策略。先查所用模型的最大输入 token，块长上限必须低于它；真出现截断，说明 1.4 的参数错了，回去改分块。有些模型超长直接报错，有些静默截断，以模型文档为准。

### 1.6 检索：过滤条件必须进 SQL

```python
def retrieve(conn, question: str, k: int = 4, dept: str | None = None) -> list[dict]:
    qvec = embed([question])[0]
    with conn.cursor() as cur:
        cur.execute(
            """SELECT doc_id, version, chunk_index, section, page, content,
                      1 - (embedding <=> %s::vector) AS similarity
                 FROM chunks
                WHERE is_active
                  AND (is_public OR dept = %s)
                ORDER BY embedding <=> %s::vector
                LIMIT %s""", (qvec, dept, qvec, k))
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]
```

`<=>` 是余弦距离，`1 - 距离` 才是相似度；`ORDER BY` 必须用距离升序，才能走 HNSW 索引。

`dept=None` 时 `dept = %s` 恒为 NULL，只有 `is_public` 的块会命中——这正是匿名请求应有的结果；但调用方要明确传 `dept`，别指望默认值开权限。

> 带 `WHERE` 的近似检索可能拿不满 K 条（原因见 3.7）；`is_public OR dept = %s` 这种 OR 条件也让单列索引难用。数据量上来后先用 `EXPLAIN` 看计划，再决定拆成两次查询还是继续用 OR。

| K | 适用 | 风险 |
|---|---|---|
| 2–3 | 单点事实（「E-042 是什么」） | 检索错一次就没有兜底 |
| 4–6 | 通用问答 | 平衡 |
| 8–15 | 跨节综合 | 噪声稀释，必须接重排 |

**K 不是越大越好**：故障码章节有几十条结构相同的条目，K 一大会把相邻条目全捞进来，模型容易抄错行。

### 1.7 生成：编号、拒答、引用

```python
SYSTEM = """你是产品手册问答助手，只根据【资料】回答。
规则：
1. 只使用【资料】中的内容，不使用先验知识补充。
2. 每条结论后标注来源编号，如 [1]；同一结论多条资料写 [1][3]。
3. 资料不足时原样输出：手册中没有找到相关内容。
4. 型号、参数、页码、故障码必须与资料完全一致。"""

def fit_hits(hits: list[dict], max_chars: int = 6000) -> list[dict]:
    """按相关性顺序装入，超长截掉尾部；编号与内容始终一一对应。"""
    out, used, seen = [], 0, set()
    for h in hits:
        key = (h["doc_id"], h.get("chunk_index", h["content"]))
        if key in seen:                     # 同一块重复命中只留一条
            continue
        cost = len(h["content"]) + 80       # 80 是编号与出处行的粗略开销
        if out and used + cost > max_chars:
            break
        seen.add(key)
        out.append(h); used += cost
    return out


def build_context(hits: list[dict]) -> str:
    parts = []
    for i, h in enumerate(hits, start=1):
        page = f"（p.{h['page']}）" if h.get("page") else ""
        parts.append(f"[{i}] {h['doc_id']} {h['version']} · {h['section']}{page}\n{h['content']}")
    return "\n\n".join(parts)


def ask(conn, question: str, k: int = 4, min_sim: float = 0.45,
        dept: str | None = None) -> dict:
    hits = retrieve(conn, question, k=k, dept=dept)
    if not hits or hits[0]["similarity"] < min_sim:
        return {"answer": "手册中没有找到相关内容。", "citations": [], "blocked_by": "threshold"}

    hits = fit_hits(hits)                   # 先裁到预算内，再编号
    resp = client.chat.completions.create(
        model=CHAT_MODEL, temperature=0,
        messages=[{"role": "system", "content": SYSTEM},
                  {"role": "user", "content": f"【资料】\n{build_context(hits)}\n\n【问题】\n{question}"}])
    answer = resp.choices[0].message.content

    citations, seen = [], set()
    for m in re.finditer(r"\[(\d+)\]", answer):
        idx = int(m.group(1))
        if idx in seen or not (1 <= idx <= len(hits)):
            continue                      # 越界编号是模型编的，直接丢
        seen.add(idx)
        h = hits[idx - 1]
        citations.append({"mark": f"[{idx}]", "doc": h["doc_id"],
                          "section": h["section"], "page": h["page"]})

    if not citations and "没有找到" not in answer:
        return {"answer": "手册中没有找到相关内容。", "citations": [], "blocked_by": "no_citation"}
    return {"answer": answer, "citations": citations}
```

`fit_hits` 的裁剪顺序就是相关性顺序，所以「超长按相关性截断」不是一句原则，而是这段代码；编号在裁剪之后生成，`citations` 用同一个 `hits` 列表索引，这是引用能对上原文的唯一保证。

阈值 `0.45` 不是通用常数：拿库内问题的最高相似度、库外问题的最高相似度两组数据，取中间值。做法见 3.11。

### 1.8 十题自测

题目覆盖三类：单点事实（A）、跨节综合（B）、手册里没有（C）。

| # | 类型 | 问题 | 期望 |
|---|---|---|---|
| 1 | A | E-042 故障码代表什么 | 命中故障码表，给出含义与处理步骤 |
| 2 | A | 传感器接线端子几号 | 命中接线表，给出端子号 |
| 3 | A | 额定输入电压是多少 | 命中参数表，数字一致 |
| 4 | A | 更换滤芯的周期 | 命中维护章节 |
| 5 | B | 设备在 -10℃ 环境下启动要注意什么 | 环境参数 + 启动步骤两节 |
| 6 | B | 出现 E-042 且伴随异响，先做什么 | 故障码 + 检修顺序两节 |
| 7 | B | 接 380V 电源需要多粗的线 | 电气参数 + 安装规范两节 |
| 8 | C | 这台设备的市场价格 | 拒答 |
| 9 | C | 竞争对手 X 的同类产品参数 | 拒答 |
| 10 | C | 明年会不会出新一代 | 拒答 |

每次改动都重跑，数值以自有评测集实测为准：

| 指标 | 口径 | 本次 |
|---|---|---|
| 检索命中 | 标准答案所在块出现在 Top-4 | `<实测>` |
| 回答正确 | 结论与手册一致（人工判） | `<实测>` |
| 引用可核对 | 抽 10 条引用能翻到原页同句 | `<实测>` |
| 拒答正确 | C 类 3 题全部拒答 | `<实测>` |
| P50 延迟 | 检索 + 生成 | `<实测>` |

### 1.9 验收表

| # | 检查项 | 命令或检查 | 通过标准 |
|---|---|---|---|
| 1 | 解析覆盖 | 跑 `report(parse_pdf(...))` | 空页占比 < 5%，每页中位数 > 200 字 |
| 2 | 噪声清理 | 抽 3 页对比清洗前后 | 页眉页脚消失，正文完整 |
| 3 | 分块完整 | 打印前 5 块的 `section` 与 `content` 首尾 | `section` 是全路径，`content` 是完整句段（硬切处除外） |
| 4 | 块长分布 | 1.4 的 SQL | 无 < 80 字碎片，> 1200 字占比 < 5% |
| 5 | 维度一致 | `\d chunks` | `vector(N)` 与 `EMBED_DIM` 相同 |
| 6 | 幂等 | 同一文档连续 ingest 两次 | 块数不变，无唯一键冲突 |
| 7 | 库内命中 | 跑 1.8 的第 1–7 题 | 逐题记录，答案块在 Top-4 |
| 8 | 引用可核对 | 抽 10 条引用翻原文 | 10/10 能定位到同句同页 |
| 9 | 库外拒答 | 跑第 8–10 题看日志 | 全部拒答，`blocked_by` 有值 |
| 10 | 改版生效 | 改一条参数后重新 ingest | 旧值不再出现在 Top-4 |

> 第 8 项最容易糊弄。引用不是「有个 [1] 就算」，而是用户点开能落到那一页那一句。抽检时必须真的打开 PDF 对一遍。

### 1.10 改版：先下架旧版，再上架新版

```python
def activate(conn, doc_id: str, version: str) -> None:
    with conn.transaction():            # 两次 UPDATE 一起生效
        with conn.cursor() as cur:
            cur.execute("UPDATE chunks SET is_active=false WHERE doc_id=%s AND version<>%s",
                        (doc_id, version))
            cur.execute("UPDATE chunks SET is_active=true WHERE doc_id=%s AND version=%s",
                        (doc_id, version))
```

顺序不能反：先上新版会让新旧同时可检索，用户看到两个矛盾的参数；先下旧版再上新版，中间有几秒空窗，但不会给出错答案。**宁可短暂拒答，不可短暂答错。**

`ingest` 插入时 `is_active` 默认是 `true`，所以「单独补跑一次旧版」会把它重新插成可检索。重跑任何版本之后，都要再调一次 `activate(conn, doc_id, 当前版本)`，否则版本下架等于没做。

---

## 二、高频问答：会卡住你的地方，也是面试最常问的

按现场出现频率排序。每条讲三件事：现场怎么查、要点是什么、面试会顺着追问什么。

### 2.1 解析结果几乎是空的

**现场**

整页字数 < 20；再渲染第一页为 PNG，肉眼确认是不是图；`pypdf` 与 `pymupdf` 各读一遍。

**要点**

- 扫描件：PDF 里存的是图片，`extract_text()` 只能取文字层，取不到就返回空串。
- 换库解决不了图片，先确认「没有文字层」这件事，再走 OCR。
- OCR 结果要抽 3 页人工核对——OCR 常把 `0` 认成 `O`、`1` 认成 `l`，参数表里这是致命的。

**追问**

- 怎么确认是扫描件？→ 两个库都读空就是，别在解析库上继续试。
- 空页占比多少算异常？→ 超过 5%，或者每页中位数只有几十字。
- OCR 之后就算完吗？→ 不算，数字和型号必须抽页对原文。

### 2.2 插入报 `expected 1536 dimensions, not 1024`

**现场**

`\d chunks` 看列类型；`len(embed(["test"])[0])` 看实际维度。

**要点**

- 建表时写死 `vector(1536)`，换的模型输出 1024 维（BGE-M3、通义 text-embedding-v3 都是 1024）。
- 一条 SQL 加一行 Python 就能对上，只查写入端或只查表定义都找不到。
- 改法只有两个：改表维度并全量重建，或换回同维度模型。**只改一边必然继续报错。**

**追问**

- 改表维度就够了吗？→ 不够，旧向量必须全部重算。
- 怎么防止再犯？→ 模型配置只留一处，启动时比对维度。
- 这个报错是坏事吗？→ 是好事，它挡住了模型混用。

### 2.3 检索不到，但文档里明明有

**现场**

K 放大到 20，打印「问题 + Top-20 内容 + 相似度」，看答案块到底在不在。

**要点**

- 三种原因：块把答案切碎；用户用词与原文差异大；答案块排在第 5 名之后。
- 换模型要全量重建索引，成本最高、见效最不确定，应该排在最后。
- 分诊顺序：Top-20 里没有 → 分块或召回问题；有但排在后面 → 排序问题；排第一但答错 → 生成问题。

**追问**

- 为什么要先把 K 放大？→ 只有看到完整候选，才能区分召回和排序。
- 用户用词差异大怎么改？→ 查询改写或混合检索，别先换模型。
- 多轮问题算哪类？→ 检索查询本身不完整，先做指代补全。

### 2.4 表格被切成孤儿行

**现场**

打印命中块的原文，看是不是只有 `| 线 | 500 元 |` 这种残行；再搜「500 元」看它落在哪一块、那块里有没有表头。

**要点**

- 解析没问题，是**分块**按字数硬切，把一张表切成了几块。
- 修法是把整张表当原子单元：连续以 `|` 开头的行收进同一个 buf，遇到非表格行才输出。
- 换 `pdfplumber` 不解决切分环节的问题，别在解析库上打转。

**追问**

- 表长到一块装不下怎么办？→ 表头 + 分片，每个分片都重复表头。
- 代码块也这样处理吗？→ 是，读到围栏进入收集模式，直到闭合。
- 怎么验收？→ 抽块看首尾是不是完整句段或完整表。

### 2.5 引用编号指向了别的块

**现场**

打印 `build_context` 的编号与 `citations` 映射，逐条对照；随便挑一条引用，看 `[2]` 在上下文里到底是不是那句话。

**要点**

- 拼上下文和解析引用用了两套顺序：一边按相似度排，一边按 `chunk_index` 排。
- 这不是模型幻觉，是映射错误；把工程问题当成模型问题会一直修不好。
- 编号只在一处生成，解析时用同一个 `hits` 列表索引，中间不要排序、不要过滤、不要重新拼接。

**追问**

- 去重或重排后编号为什么会错？→ 位置变了，旧答案里的编号对不上。
- 模型会不会自己编编号？→ 会，越界编号必须直接丢掉。
- 怎么自动发现？→ 校验编号范围，再核对数字是否在原文。

### 2.6 库外问题答得很自信

**现场**

问 5 个库里肯定没有的问题，看是否仍返回带引用的答案；再看检索最高相似度是多少。

**要点**

- 没有拒答机制：检索总会返回 Top-K，哪怕全是无关块，模型也会拿它们拼一个答案。
- 更强的模型只会把假答案写得更像真的，这是工程问题不是模型能力问题。
- 修法是三道防线：相似度阈值、Prompt 拒答话术、无引用兜底，见 3.11。

**追问**

- 阈值怎么定？→ 20 个库内问题 + 20 个库外问题各取最高相似度，取中间值。
- 只加 Prompt 行不行？→ 不行，模型有时不执行，且钱已经花了。
- 三道防线先上哪个？→ 阈值最便宜，先挡住明显无关的。

### 2.7 文档更新后两个版本同时被检索到

**现场**

直接查库里的版本分布：`SELECT version, count(*) FROM chunks WHERE doc_id=... GROUP BY version`。

**要点**

- 重新入库时只做了插入，没删旧块；或者旧版本没有 `is_active=false`。
- 不是缓存问题，是数据层有两份。
- 修法是「先删后插」加版本下架，两者都要，缺一个都会留下旧数据。

**追问**

- 单独补跑一次旧版为什么会复活？→ `ingest` 插入时 `is_active` 默认是 `true`，跑完要再 `activate`。
- 先下架还是先上架？→ 先下旧版，宁可短暂拒答，不可短暂答错。
- 缓存要不要清？→ 要，按 source 清语义缓存。

### 2.8 换了 Embedding 模型，检索全乱

**现场**

固定库不动，用旧模型编码同一个问题再检索一次，看结果是否恢复正常。

**要点**

- 库里是旧模型的向量，查询用新模型编码，两个向量空间不可比。
- 两次实验的条件根本不一致，不能据此比较模型优劣。
- 换模型必须**全量重建**，没有增量迁移的办法。

**追问**

- 同维度换模型也要重建吗？→ 要，维度相同不代表空间相同。
- 怎么确认空间真的变了？→ 同一文本新旧向量相似度明显低于同模型内的正常水平。
- 能灰度吗？→ 新表双写、评测达标后切读流量。

### 2.9 页眉页脚成了高分块

**现场**

看 Top-K 里是否有块只有页眉、页码、版权声明；打印命中块全文，确认有没有实质内容。

**要点**

- 页眉在每个块里重复，短文本向量容易被这类高频短语主导。
- 不是用户问的正好是公司名，是分数被噪声抬起来了。
- 修法是在入库前按「跨页重复率」删噪声行（1.3 的做法），比在检索端加过滤更彻底。

**追问**

- 检索端过滤为什么不够？→ 噪声还占着索引和 token，只是没显示。
- 删多了怎么办？→ 每加一条规则抽 3 页看结果。
- 怎么识别噪声行？→ 多页重复出现、长度短。

### 2.10 相似度很高，但答非所问

**现场**

把问题里的实词逐个去检索结果里找，看覆盖率是不是 0；再抽掉问题里的关键词，看分数是否几乎不变。

**要点**

- 语义相近但实体不同：库里有「保养周期」，没有「保修期」，向量把两个词拉得很近，分数被抬起来。
- 不是「未登录词」（词不在词表），而是**关键词缺失但主题相似**。
- 调高全局阈值会误伤真正的库内问题；修法是加关键词覆盖率校验，或引入 BM25 做混合检索。

**追问**

- 为什么不能靠调阈值？→ 局部问题用全局阈值解决，必然一边漏一边误伤。
- 怎么判断是主题相似而不是实体匹配？→ 抽掉关键词分数几乎不变。
- 混合检索怎么融合？→ RRF 只用名次，不用原始分数。

### 2.11 多轮第二问跑偏

**现场**

把「那怎么复位」这一句单独打印出来，看它能不能独立成问；再用它单独检索一次，看 Top-K 是否全是无关块。

**要点**

- 检索只用最后一句「那怎么复位」，这句话里没有任何可检索的实体。
- 加历史没用，检索阶段根本没读历史；长历史还会让生成混用上一轮的条件。
- 修法是在检索前把问题改写成独立完整句（「E-042 报警后怎么复位」），历史只用于改写，不直接进向量。

**追问**

- 历史为什么不直接进向量？→ 噪声大，而且指代仍未解决。
- 改写喂几轮历史？→ 最近 2~3 轮就够，多了反而干扰。
- 改写把型号抹掉了怎么办？→ 原问题再走一次 BM25 兜底。

### 2.12 调大 K 后接口报上下文超长

**现场**

打印 `len(build_context(hits))`，按所用模型的 tokenizer 估 token，对照窗口上限。

**要点**

- 拼进 Prompt 的块总长超过模型上下文窗口；K 翻倍，注入的 token 近似翻倍。
- 修法顺序：先给上下文设总长度上限、按相关性截断（1.7 的 `fit_hits`），再不行才减 K、压缩块、换窗口更大的模型。
- 不要靠删几句 System Prompt 或调 temperature 绕过——资料没进上下文，模型只能编。

**追问**

- 为什么不能按原顺序截断？→ 最相关的可能在后面，会被一起截掉。
- 怎么省 token？→ 去重、按句压缩、父块换子块。
- 超长会报错吗？→ 有的模型报错，有的静默截断，以文档为准。

### 2.13 加了权限过滤，召回骤降

**现场**

对比「SQL 里带 WHERE」与「取回后再过滤」两种写法的结果条数；从 4 条掉到 0 条就是后过滤。

**要点**

- 先取 Top-K 再在应用层过滤，过滤后剩不下几条；正确做法是把条件下推到 SQL。
- 不是权限条件写错，是过滤位置不对。
- 后过滤还有越权风险：日志、缓存、调试输出里已经带出了无权内容。

**追问**

- 为什么必须和 `ORDER BY ... LIMIT` 同一条 SQL？→ 否则候选池先被无关块占满。
- `OR` 条件为什么慢？→ 单列索引难同时命中，要看计划再决定拆查询。
- 多租户怎么防漏？→ `tenant_id` 建索引，必要时上行级安全策略。

---

## 三、核心知识：从零开始要建立的东西

### 3.1 三个先天局限与 RAG 的定位

模型有三件事做不到：**知识有截止日期**（训练数据之后的事不知道）、**不知道私有数据**（公司制度、产品手册从没进过训练集）、**不知道自己不知道**（训练目标是生成流畅文本，不是保证事实正确，缺知识时会编）。

| 方案 | 知识存在哪 | 更新成本 | 可溯源 | 权限隔离 |
|---|---|---|---|---|
| RAG | 外部文档库 | 重新入库，分钟级 | 能，给到章节页码 | 能，检索时按身份过滤 |
| 微调 | 模型参数 | 重新训练，小时到天级 | 不能 | 难，知识进了参数人人可见 |
| 长上下文 | 本次请求的上下文 | 无需更新 | 能，但粒度粗 | 能，靠代码控制 |
| 关键词检索 | 文档本身 | 即时 | 能 | 能 |

**边界**：微调擅长风格、格式、领域语感，不擅长记事实；长上下文适合「一两篇文档、只问一次」；文档总量在 3 万字以内时，直接全文塞进 Prompt 往往比 RAG 更准（分档见 3.16）。RAG 在**文档量超过上下文承载能力、内容会变、需要引用**时才成为必要。

### 3.2 索引阶段与查询阶段

RAG 只有两个阶段：**索引**离线跑一次，**查询**每次提问跑一次。

```mermaid
flowchart TD
    classDef client fill:#DBEAFE,stroke:#2563EB,color:#1E3A8A
    classDef service fill:#DCFCE7,stroke:#16A34A,color:#14532D
    classDef data fill:#FEF3C7,stroke:#D97706,color:#78350F

    subgraph IDX["索引阶段"]
        A["原始文档"]:::data --> B["解析"]:::service --> C["清洗"]:::service --> D["分块"]:::service --> E["向量化"]:::service --> F["入库"]:::data
    end
    subgraph QRY["查询阶段"]
        G["用户问题"]:::client --> H["查询向量化"]:::service --> I["检索 Top-K"]:::service --> J["拼上下文"]:::service --> K["生成"]:::service --> L["带引用回答"]:::client
    end
    F --> I
    linkStyle default stroke:#94A3B8,stroke-width:1.5px
```

读图一句话：**索引阶段决定检索的上限，检索决定回答的上限。** 效果不好时，排查顺序永远是「先索引、再检索、最后 Prompt」。

> **面试**：常问「RAG 效果不好先查哪一段？」答：先索引、再检索、最后 Prompt，索引阶段决定检索上限。

### 3.3 文档解析与结构保留

解析的目标不是「拿到一串文字」，而是「拿到文字 + 结构」。标题层级、页码、表格边界一旦丢掉，分块就只能按字数硬切。

| 格式 | 常用库 | 关键点 |
|---|---|---|
| Markdown / TXT | 内置 `open()` | 零成本，`#` 结构天然保留 |
| PDF（文字版） | `pypdf` / `pdfplumber` | `pypdf` 快；`pdfplumber` 能取表格坐标 |
| PDF（扫描件） | `pymupdf` + OCR | 纯 PDF 库读出空串，必须先 OCR |
| Word | `python-docx` | 段落与表格分开遍历，样式名带标题层级 |
| HTML | `BeautifulSoup` | 先删 script/nav/footer 再取正文 |
| Excel / CSV | `pandas` | 整表转 Markdown，或每行一句 |

**解析是静默失败最多的环节**：程序不报错，但内容少了一半。入库前必须抽页看字数、看首 200 字。判断标准不是「有没有报错」，而是「读出来的字数和页数是否合理」。

### 3.4 分块粒度与重叠比例

分块是**检索单元**的定义。块太大，一个向量混了好几个主题，检索不精准；块太小，一句话离开上下文就读不懂。理想块满足两条：**语义自足**（单独拿出来能读懂）、**长度适中**。

| 内容类型 | 建议块长 | 理由 |
|---|---|---|
| FAQ、问答对 | 100–300 字 | 一问一答本身很短 |
| 制度条款、规则 | 300–500 字 | 一条规则一两百字，加上下文 |
| 技术文档、教程 | 500–800 字 | 一段完整说明含示例 |
| 长篇报告 | 800–1200 字 | 论证链条长，切短会断逻辑 |

**overlap 取块长的 10%–20%**（500 字配 50–100）。按标题分块可以设 0，因为标题路径已经提供了跨块语境。overlap 的代价是存储和 token 翻倍，不要无脑加大。

参数不靠拍脑袋：准备 10 条「问题 + 答案关键词」，对每组 `(size, overlap)` 重新分块并检索，统计关键词是否出现在 Top-K 里。这是 RAG 调参的基本方法。

### 3.5 结构化分块的三类原子单元

有三类内容**绝不能从内部切开**，切开就失去意义：

| 单元 | 切坏的后果 | 处理 |
|---|---|---|
| 表格 | 只剩残行，表头在另一块 | 连续 `\|` 行收进同一 buf，整体输出 |
| 代码块 | 围栏被切成两半，后半块无法运行 | 读到三反引号进入收集模式，直到闭合 |
| 有序步骤 | 步骤 3 和步骤 4 分家，模型给出跳步答案 | 按列表项聚合，整段不切 |

实现上都是同一个模式：**逐行扫描，遇到单元开始标记就进入「整块收集」，遇到结束标记才输出。** 这比任何按字数切分的算法都可靠。

> 边界：整块收集会让块长失控。一张 3000 字的参数表就是一块，检索时它可能挤掉别的结果。折中办法是「表头 + 分片」——每个分片都重复表头，保证任一分片可独立读懂。

### 3.6 向量空间与 Embedding 模型

Embedding 把一段文本映射成固定维度的浮点数组，语义相近的文本方向相近。**这是语义检索的全部基础，它不要求两句话有共同字词。**

| 模型 | 维度 | 中文 | 部署 |
|---|---|---|---|
| text-embedding-3-small | 1536 | 中上 | API |
| text-embedding-3-large | 3072 | 上 | API |
| BGE-M3 | 1024 | 强 | 本地 |
| 通义 text-embedding-v3 | 1024 | 强 | API |

三条铁律：**入库与检索必须同一个模型**；**维度必须与表定义一致**；**换模型必须全量重建**。不同模型的向量空间不可比，混用后相似度接近随机数。

**非对称检索的隐藏参数**：有些模型要求查询和文档用不同前缀。BGE 中文 v1.5 建议查询加「为这个句子生成表示以用于检索相关文章：」，文档不加；E5 系列要求 `query: ` 与 `passage: `；BGE-M3 与 OpenAI v3 不需要。漏加前缀不会报错，只会让召回悄悄变差。

### 3.7 距离度量与索引类型

pgvector 三个算子：`<=>` 余弦距离、`<->` L2 距离、`<#>` 负内积。文本检索默认用 `<=>`，因为余弦只看方向、不受文本长度影响。

| 索引 | 原理 | 适合 | 代价 |
|---|---|---|---|
| HNSW | 多层近邻图 | 在线查询，默认首选 | 建索引慢、占内存 |
| IVFFlat | 聚类分桶 | 数据量大、内存紧张 | 需要先有数据再建，召回受 `probes` 影响 |
| 无索引 | 全表扫描 | 几千条以内 | 数据一大就慢 |

HNSW 的关键参数：`m`（每个节点的连边数，默认 16）、`ef_construction`（建索引时的候选数，默认 64）、`ef_search`（查询时的候选数，默认 40）。调大 `ef_search` 提召回、增延迟，是运行时可调的旋钮。

> **带 WHERE 的近似检索会少返回**：过滤发生在索引扫描之后，条件苛刻时可能拿不满 K 条。pgvector 0.8 起支持 iterative scan；更稳的做法是给过滤列建索引，或对高频过滤维度做分区。

### 3.8 Top-K 的召回与精度权衡

K 是「喂给模型几条资料」。它同时影响召回和噪声：

| K | 召回 | 噪声 | 适用 |
|---|---|---|---|
| 1–2 | 低 | 最低 | 单点事实、有强置信 |
| 3–5 | 中 | 低 | 通用问答的默认区间 |
| 6–10 | 较高 | 中 | 需要跨段综合 |
| 10–30 | 高 | 高 | 只做粗排候选，必须接重排 |

**规律**：K 增大，召回单调上升，回答准确率通常先升后降。正确姿势是「大 K 召回 + 重排精选」，而不是直接把 20 条塞进 Prompt。模型对上下文中间部分的利用率低于开头结尾，这是已知现象，所以最相关的两条应该放在两端。

### 3.9 元数据与权限过滤

只存向量和原文是不够的。缺元数据，就无法引用、无法过滤、无法下架。

| 字段 | 例子 | 用途 |
|---|---|---|
| `doc_id` | `manual` | 引用展示、按文档删除 |
| `section` | `第 4 章 > 4.2 接线` | 引用精确到节 |
| `page` | `37` | PDF 翻页 |
| `updated_at` | `2026-09-01` | 时效过滤、新旧冲突 |
| `dept` | `service` | 权限过滤 |
| `version` | `v3.2` | 版本下架 |

**权限过滤必须在 SQL 的 `WHERE` 里**，不能先取 Top-K 再在应用层筛。后过滤有两个问题：过滤后可能一条不剩（召回崩），以及日志、缓存、调试输出里已经带出了无权内容（越权风险）。

> 多租户场景给 `tenant_id` 建索引，并考虑行级安全策略（RLS）。只靠应用层拼 `WHERE` 迟早会漏一处。

> **面试**：常问「权限过滤为什么不能取回结果再筛？」答：会占掉 Top-K 名额导致召回崩，还会在日志和缓存里带出无权内容。

### 3.10 上下文拼接与引用编号

拼接做三件事：编号、去重、控长。

```text
[1] manual v3.2 · 第 6 章 故障诊断 > 6.3 故障码（p.112）
E-042：编码器信号丢失。检查编码器线缆与接地。

[2] manual v3.2 · 第 4 章 安装 > 4.2 接线（p.37）
编码器接线端子为 X5 的 3、4 号。
```

规则：编号从 1 连续递增；编号只在拼接时生成一次；解析引用时用同一个列表索引；同一块重复命中要去重（按 `doc_id + chunk_index`）；总长度设上限，超了按相关性截断，而不是按原顺序截断（1.7 的 `fit_hits`）。

### 3.11 拒答的三道防线

```mermaid
flowchart TD
    classDef client fill:#DBEAFE,stroke:#2563EB,color:#1E3A8A
    classDef service fill:#DCFCE7,stroke:#16A34A,color:#14532D
    classDef data fill:#FEF3C7,stroke:#D97706,color:#78350F
    classDef danger fill:#FEE2E2,stroke:#DC2626,color:#7F1D1D

    Q["用户问题"]:::client --> T{"最高相似度达标"}:::service
    T -->|"否"| R1["直接拒答"]:::danger
    T -->|"是"| G["模型生成"]:::service
    G --> C{"有合法引用"}:::service
    C -->|"有"| OK["返回答案与出处"]:::data
    C -->|"无"| R2["替换为拒答话术"]:::danger
    linkStyle default stroke:#94A3B8,stroke-width:1.5px
```

**阈值怎么定**：造两组数据——20 个库里确实有的问题，20 个肯定没有的问题，各取最高相似度。库内组的最低值应明显高于库外组的最高值；如果两组重叠，说明这个 Embedding 对你的语料区分度不够，阈值救不了，得换模型或加混合检索。

| 防线 | 位置 | 拦住什么 | 代价 |
|---|---|---|---|
| 相似度阈值 | 调模型之前 | 明显无关 | 零成本，可能误伤 |
| Prompt 拒答话术 | 生成时 | 词面相近但内容不符 | 一次生成费用 |
| 无引用兜底 | 生成之后 | 模型不听话裸答 | 已经花了 token |

三道缺一不可：只看阈值，「保修」这类词会让无关问题虚高；只看 Prompt，模型有时不执行；只看兜底，钱已经花了。

> **面试**：常问「RAG 怎么做到该拒答就拒答？」答：相似度阈值、Prompt 话术、无引用兜底三道，缺一不可。

### 3.12 幻觉的来源分层

RAG 不能消除幻觉，只能把幻觉从「凭空编造」转移到「资料读错」。按来源拆开看，修法完全不同：

| 来源 | 表现 | 修法 |
|---|---|---|
| 检索缺失 | 该有的资料没进上下文，模型凭记忆答 | 改分块、混合检索、查询改写 |
| 上下文冲突 | 新旧两版都在，模型各引一半 | 版本下架、按时间过滤 |
| 长上下文稀释 | 关键句在中间被忽略 | 减小 K、重排、压缩上下文 |
| 生成漂移 | 资料对，但模型加了推断 | 强化 Prompt、要求逐条引用 |
| 引用漂移 | 答案对，编号指错 | 编号同源、生成后校验 |

**判断顺序**：先看标准答案在不在上下文里，再看它排第几，最后才看 Prompt。跳过前两步直接改 Prompt，是最常见的无效优化。

```mermaid
flowchart TD
    classDef client fill:#DBEAFE,stroke:#2563EB,color:#1E3A8A
    classDef service fill:#DCFCE7,stroke:#16A34A,color:#14532D
    classDef data fill:#FEF3C7,stroke:#D97706,color:#78350F
    classDef danger fill:#FEE2E2,stroke:#DC2626,color:#7F1D1D

    S["回答不对"]:::danger --> A{"标准答案在上下文里"}:::service
    A -->|"不在"| B["查解析与分块"]:::service
    A -->|"在"| C{"正确块排第几"}:::service
    C -->|"靠后"| D["加重排或混合检索"]:::service
    C -->|"第一"| E{"答案与资料矛盾"}:::service
    E -->|"是"| F["改 Prompt 与上下文顺序"]:::service
    E -->|"否"| G["校验引用编号映射"]:::data
    linkStyle default stroke:#94A3B8,stroke-width:1.5px
```

落到哪一格，就只改那一格。三格里最贵的是「不在」——它要求回索引阶段返工，这也是为什么效果差时先查解析和分块，而不是先换模型。

### 3.13 检索评测与生成评测

「RAG 好不好」是两个独立问题，必须拆开测。

| 层面 | 指标 | 定义 | 怎么测 |
|---|---|---|---|
| 检索 | Recall@K | 答案块出现在 Top-K 的比例 | 每题标注答案所在文档与块 |
| 检索 | MRR | 第一个正确结果排名倒数的均值 | 同上 |
| 检索 | nDCG@K | 按位置折损的相关性累积 | 有多级相关性标注时用 |
| 生成 | 答案正确率 | 与标准答案语义一致 | 人工判分或模型当裁判 |
| 生成 | 忠实度 | 每个事实点都能在资料里找到 | 逐句核对 |
| 生成 | 引用正确率 | 引用块确实包含该结论 | 抽查引用与原文 |
| 生成 | 拒答正确率 | 库外问题被正确拒答 | 专门造一批库外问题 |

**分开的意义**：检索差、生成好 → 优化索引与检索；检索好、生成差 → 优化 Prompt 与上下文组织。两组数字混在一起，永远不知道该改哪。

### 3.14 幂等入库与增量更新

同一份文档重复入库不能产生重复块。做法是 `(doc_id, version, chunk_index)` 唯一键 + 先删后插。

增量更新用文件指纹：

| 策略 | 做法 | 适用 |
|---|---|---|
| 全量重建 | 清表后全部重跑 | 块数少、追求简单 |
| 指纹增量 | 内容 hash 变了才重跑 | 推荐，成本与变更量成正比 |
| 实时同步 | 保存即触发 | 协作编辑场景 |

**删除同步最容易漏**：目录里删了文件，库里还留着，用户会检索到已废止的规定。定时任务要扫一遍「库里有、目录里没有」的来源并清掉。

### 3.15 成本结构与延迟构成

| 环节 | 成本驱动 | 延迟量级 | 优化方向 |
|---|---|---|---|
| 解析 | 页数、OCR | 离线 | 只跑一次，增量跳过 |
| Embedding | 总字数 × 单价 | 离线 | 批量、缓存、只重跑变化文档 |
| 存储 | 向量维度 × 块数 | — | 降维（仅 MRL 模型）、归档旧版 |
| 检索 | 索引大小、ef_search | 毫秒级 | HNSW 参数、减少过滤列 |
| 生成 | 上下文长度 + 输出长度 | 秒级 | 控制 K、压缩上下文、缓存 |

延迟的大头通常在生成，不在检索。所以「检索慢」的直觉经常是错的——先打点，再优化。

### 3.16 技术选型的四条边界

| 条件 | 选择 |
|---|---|
| 文档 < 3 万字，问题集中 | 全文塞进 Prompt，不上 RAG |
| 文档 3 万–30 万字，问题集中在少数文档 | 按标题/关键词挑章节再塞 |
| 文档 > 30 万字，问题分散 | RAG，先做纯向量基线 |
| 需要权限隔离、强溯源、频繁更新 | RAG + 元数据过滤 + 引用校验 |

**过早引入 RAG 的典型后果**：时间全花在调分块和阈值上，却没验证「用户到底会不会用」。先用最简方案跑一周真实问题，再决定要不要上向量库。

---

## 四、冷门知识汇总

只收「低频、代价小、遇到时能现查」的条目：真正的卡点已放在第二节，基础概念在第三节。下表给的是检索关键词，不是完整方案。

| 知识点 | 为什么冷门 | 用到时的关键词 |
|---|---|---|
| 印刷页码与物理页偏移 | 封面、前言用罗马数字，引用差几页才发现 | 用目录页反查偏移，存 `page_offset` |
| 全角字符与软连字符 | `１５００` 与 `1500` 不互通，词中 U+00AD 让查询对不上原文 | `unicodedata.normalize("NFKC", s)`、替换 `\u00ad` |
| CID 字体提取出乱码 | 只在个别嵌入字体上出现，看着像编码错误 | 搜 `(cid:`，换 `pymupdf` 的 `get_text` 对比 |
| 表格续页补表头 | 跨页表只有第一页有表头，续页全是残行 | 检测续页首行，缺表头就补 |
| 中文全文检索分词 | 做混合检索时才发现 PostgreSQL 默认不分中文 | `zhparser`、`pg_bigm`、`pg_trgm` |
| Matryoshka 截断 | 只有声明支持 MRL 的模型能截 | `dimensions` 参数、`MRL` |
| 余弦与内积的等价条件 | 归一化之后才等价，没归一化时排序会变 | 向量归一化、`<=>` 与 `<#>` |
| 数字一致性校验 | 只在金额、参数类问答里关键 | 正则抽数字，回查原文 |
| Embedding 缓存键 | 用块 id 做键，换分块参数后会命中旧向量 | 用 `sha256(content)` 做键 |
| 批量请求上限 | 64 条是经验值，超了可能报 400 或被限流 | 失败时把 batch 减半重试 |
