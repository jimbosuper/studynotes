# RAG 优化

## 一、工程案例：把「答非所问的 badcase」从 30% 降下来：查询改写、混合检索、重排、上下文压缩

**场景**：一个已上线的企业制度问答助手，接手时基线如下——固定 500 字分块、纯向量检索、Top-4 直接喂模型、无 Rerank、无查询改写、Prompt 仅「根据资料回答」。用户投诉四类问题：检索不到专有名词、答偏相似条文、引用指向错误、多轮指代丢失。

**怎么算 30%**：40 条可答题里 21 条答对（52%），19 条答错；这 19 条里有 12 条是「答非所问」——答了，但答的是相邻条款或另一个概念，占可答题的 30%。其余错在引用对不上、该拒答却硬答。

**为什么必须做**：「能用不好用」的 RAG，用户体验和维护成本都在线性上升。优化不能靠拍脑袋加功能，必须先建立评测集、测基线、逐项优化、每步复测。

**动手前确认**：评测集冻结（50 条真实问答），PostgreSQL + pgvector 可连，Embedding 与 Chat 模型都能调通，`eval/questions.jsonl` 与库里的文档版本一致。

```bash
docker run -d --name pgvector --restart=always \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=ragdb -p 5432:5432 \
  pgvector/pgvector:pg16

python3.12 -m venv .venv && source .venv/bin/activate
pip install "openai>=1.40" "psycopg[binary]>=3.2" "pgvector>=0.3" \
            "numpy>=1.26" "jieba>=0.42" "rank-bm25>=0.2" \
            "FlagEmbedding>=1.3" "torch>=2.3"

export OPENAI_API_KEY="sk-..."
export OPENAI_BASE_URL="https://api.openai.com/v1"
export EMBED_MODEL="text-embedding-3-small"
export CHAT_MODEL="gpt-4o-mini"
export PGVECTOR_DSN="postgresql://postgres:postgres@localhost:5432/ragdb"
```

```text
rag/
├── common.py        # 连接、embed()、retrieve()、load_chunks()
├── pipeline.py      # ask() 编排：一个开关一项优化
├── ingest.py        # 分块、建 BM25、入库（1.3 与 1.6 的建表在这里）
├── optimize.py      # bm25 / rrf / rerank / rewrite / parent / compact / dedup / cache
├── answer.py        # Prompt、生成、引用校验
└── run_eval.py      # 评测入口：--stage 一次只开一项优化
```

```python
# common.py
import os
import psycopg
from openai import OpenAI
from pgvector.psycopg import register_vector

client = OpenAI()
EMBED_MODEL = os.environ["EMBED_MODEL"]
CHAT_MODEL = os.environ["CHAT_MODEL"]
REFUSAL = "抱歉，现有制度中没有找到相关规定"


def connect():
    conn = psycopg.connect(os.environ["PGVECTOR_DSN"])
    register_vector(conn)          # 不注册时传 list 会报类型错误
    return conn


def embed(texts):
    resp = client.embeddings.create(model=EMBED_MODEL, input=texts)
    return [d.embedding for d in resp.data]


def load_chunks(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT source, chunk_index, content FROM chunks"
                    " ORDER BY source, chunk_index")
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def retrieve(conn, question, k=20):
    """向量粗排；带出 chunk_index，RRF 靠它和 BM25 结果对齐。"""
    qvec = embed([question])[0]
    with conn.cursor() as cur:
        cur.execute(
            """SELECT source, chunk_index, content,
                      1 - (embedding <=> %s::vector) AS similarity
                 FROM chunks ORDER BY embedding <=> %s::vector LIMIT %s""",
            (qvec, qvec, k))
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]
```

```python
# pipeline.py
from common import retrieve
from optimize import (compact, expand_to_parent, hybrid_retrieve,
                      rerank, rewrite_query)
from answer import generate


def ask(conn, bm25, question, *, rewrite=False, hybrid=False, rerank_top=0,
        parent=False, compact_budget=0, strict_prompt=True,
        cache=None, scope="public"):
    """一个开关一步优化：评测时只加一项，其余保持上一轮的状态。"""
    if cache is not None:
        hit = cache.lookup(question, scope)
        if hit:
            return hit
    q = rewrite_query(question) if rewrite else question
    if hybrid:
        hits = hybrid_retrieve(conn, bm25, q)
    else:
        hits = retrieve(conn, q, k=4)
    hits = rerank(q, hits, top_n=rerank_top) if rerank_top else hits[:4]
    if parent:
        hits = expand_to_parent(conn, hits)     # 子块精排后再换成父块
    if compact_budget:
        hits = compact(hits, q, budget=compact_budget)
    out = generate(question, hits, strict=strict_prompt)
    if cache is not None:
        cache.store(question, out, scope)
    return {**out, "hits": hits}
```

`pipeline.py` 只做编排：`rewrite_query`、`expand_to_parent`、`hybrid_retrieve`、`rerank`、`compact`、`SemanticCache` 在 `optimize.py`；`generate` 与 `check_citation` 在 `answer.py`，下文逐节给出。

> **以下数据以自有评测集实测为准**：50 题（库内 40 / 库外 10），每次改动都跑完整评测集。

### 1.1 评测集与基线

评测集三类题目：库内可答 40 条、库外需拒答 10 条。每题标注 `must_contain` 关键词，用于自动判断召回与回答正确。

```text
// eval/questions.jsonl
{"question": "出差住宿一晚最多报多少", "answerable": true, "must_contain": "500"}
{"question": "年会抽奖什么时候", "answerable": false, "must_contain": ""}
```

```python
# run_eval.py
import argparse, json, time
from common import connect, load_chunks, REFUSAL
from pipeline import ask
from optimize import BM25Index

test_set = [json.loads(line) for line in
            open("eval/questions.jsonl", encoding="utf-8") if line.strip()]

STAGES = {                    # 每个 stage 只比上一轮多开一项
    "baseline": {"strict_prompt": False},
    "hybrid":   {"strict_prompt": False, "hybrid": True},
    "rerank":   {"strict_prompt": False, "hybrid": True, "rerank_top": 4},
    "rewrite":  {"strict_prompt": False, "hybrid": True, "rerank_top": 4,
                 "rewrite": True},
    "parent":   {"strict_prompt": False, "hybrid": True, "rerank_top": 4,
                 "rewrite": True, "parent": True},
    "compact":  {"strict_prompt": False, "hybrid": True, "rerank_top": 4,
                 "rewrite": True, "parent": True, "compact_budget": 1200},
    "prompt":   {"hybrid": True, "rerank_top": 4, "rewrite": True,
                 "parent": True, "compact_budget": 1200},
}


def run(label, conn, bm25, **flags):
    """库内看召回与回答，库外只看拒答。"""
    n_ans = n_rej = hit = ans_ok = rej_ok = 0
    lat = 0.0
    for case in test_set:
        t0 = time.time()
        r = ask(conn, bm25, case["question"], **flags)
        lat += time.time() - t0
        ctx = " ".join(h["content"] for h in r.get("hits", []))
        if case["answerable"]:
            n_ans += 1
            hit += case["must_contain"] in ctx
            ans_ok += case["must_contain"] in r["answer"]
        else:
            n_rej += 1
            rej_ok += REFUSAL in r["answer"]
    return {"label": label,
            "检索召回率": f"{hit}/{n_ans} = {hit/n_ans:.0%}",
            "回答准确率": f"{ans_ok}/{n_ans} = {ans_ok/n_ans:.0%}",
            "拒答正确率": f"{rej_ok}/{n_rej} = {rej_ok/n_rej:.0%}",
            "平均延迟": f"{lat/len(test_set):.2f}s"}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=[*STAGES, "all"], default="baseline")
    args = ap.parse_args()
    conn = connect()
    bm25 = BM25Index(load_chunks(conn))
    if args.stage == "all":
        from optimize import SemanticCache
        flags = {**STAGES["prompt"], "cache": SemanticCache()}
    else:
        flags = STAGES[args.stage]
    print(run(args.stage, conn, bm25, **flags))
```

```text
$ python run_eval.py --stage baseline
# 基线：纯向量 + Top-4 + 弱 Prompt
{'检索召回率': '25/40 = 62%', '回答准确率': '21/40 = 52%',
 '拒答正确率': '9/10 = 90%', '平均延迟': '1.42s'}
```

**基线以自有评测集实测为准**：召回 62%、准确 52%——这就是「能用不好用」的量化定义。

> **题量决定分辨率**：50 题规模下，1 题约合 2.5 个百分点。相邻两轮只差 1~2 题时先当噪声，别据此下结论；要判断小改动是否有效，扩题或换不同随机种子各跑一遍。

### 1.2 改分块策略

**改动**：从「固定 500 字」改为「按标题递归分块」，每块带章节路径前缀，单块不超过 800 字，超长章节按段落续切。

```python
import re

def chunk_by_heading(text, max_chars=800):
    """按标题切块，块首带「【路径】」前缀，一起向量化。"""
    chunks, stack, buf = [], [], []
    def flush():
        body = "\n".join(buf).strip()
        if not body:
            return
        path = " > ".join(t for _, t in stack if t) or "正文"
        header = f"【{path}】\n"
        if len(body) + len(header) <= max_chars:
            chunks.append({"section": path, "content": header + body})
        else:
            for para in re.split(r"\n\s*\n", body):
                if para.strip():
                    chunks.append({"section": path, "content": header + para.strip()})
    for line in text.split("\n"):
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            flush(); buf = []
            lv, title = len(m.group(1)), m.group(2).strip()
            stack = [(l, t) for l, t in stack if l < lv]
            stack.append((lv, title))
        else:
            buf.append(line)
    flush()
    for i, c in enumerate(chunks):
        c["chunk_index"] = i          # RRF 用 (source, chunk_index) 对齐两路结果
    return chunks
```

```text
$ python ingest.py --chunk heading && python run_eval.py --stage baseline
# 优化 1：按标题分块（其余配置不动）
{'检索召回率': '28/40 = 70%', '回答准确率': '25/40 = 62%',
 '拒答正确率': '9/10 = 90%', '平均延迟': '1.40s'}
```

**收益**：召回多 4 题（25→28，62%→70%），准确多 4 题（21→25，52%→62%），延迟不变。原因：每块自带章节路径，语义更完整；边界落在标题上，不再把一条规定切成两半。

### 1.3 加入混合检索

**改动**：向量检索 + BM25，RRF 融合。

```python
# optimize.py（retrieve / embed 从 common 导入）
import jieba
from rank_bm25 import BM25Okapi

class BM25Index:
    def __init__(self, docs):
        self.docs = docs
        self.corpus = [list(jieba.cut(d["content"])) for d in docs]
        self.bm25 = BM25Okapi(self.corpus)

    def search(self, query, k=20):
        scores = self.bm25.get_scores(list(jieba.cut(query)))
        ranked = sorted(range(len(scores)), key=lambda i: -scores[i])[:k]
        return [{**self.docs[i], "bm25_score": float(scores[i])} for i in ranked]

def rrf_fuse(rank_lists, k=60, top_n=20):
    """Reciprocal Rank Fusion：只用排名，不用分数。"""
    scores, store = {}, {}
    for ranks in rank_lists:
        for rank, doc in enumerate(ranks, start=1):
            key = (doc["source"], doc["chunk_index"])
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank)
            store.setdefault(key, doc)
    ordered = sorted(scores, key=lambda x: -scores[x])[:top_n]
    return [{**store[key], "rrf_score": round(scores[key], 4)} for key in ordered]

def hybrid_retrieve(conn, bm25_index, question, coarse_k=20, top_n=20):
    return rrf_fuse([retrieve(conn, question, k=coarse_k),
                     bm25_index.search(question, k=coarse_k)], k=60, top_n=top_n)
```

```text
# 优化 2：+ 混合检索
{'检索召回率': '33/40 = 82%', '回答准确率': '30/40 = 75%',
 '拒答正确率': '9/10 = 90%', '平均延迟': '1.58s'}
```

**收益**：召回多 5 题（28→33，70%→82%），准确多 5 题（25→30，62%→75%）。提升最明显的是含专有名词的题目（产品代号、版本号、错误码），这类查询 BM25 能精确命中，向量几乎随机。

### 1.4 加入重排序

**改动**：粗排 Top-20 → BGE-reranker 精排 Top-4。

```python
from FlagEmbedding import FlagReranker

reranker = FlagReranker("BAAI/bge-reranker-v2-m3", use_fp16=False)

def rerank(question, hits, top_n=4):
    if not hits:
        return []
    scores = reranker.compute_score(
        [[question, h["content"]] for h in hits], normalize=True)
    for h, s in zip(hits, scores):
        h["rerank_score"] = round(float(s), 4)
    return sorted(hits, key=lambda h: -h["rerank_score"])[:top_n]
```

```text
# 优化 3：+ Rerank
{'检索召回率': '33/40 = 82%', '回答准确率': '36/40 = 90%',
 '拒答正确率': '10/10 = 100%', '平均延迟': '2.10s'}
```

**收益**：准确多 6 题（30→36，75%→90%），拒答多 1 题（9→10，90%→100%）。延迟 +0.52s（本机 CPU 跑 v2-m3 约 950ms；GPU 另算）。延迟优化三选项：① 换 base 版模型（约 300ms，准确率略降）；② 粗排 20→10（约 480ms）；③ 上 GPU 或走 API。

### 1.5 加入查询改写

**改动**：口语化问题 → 检索友好查询，带对话历史补全指代。

```python
REWRITE_PROMPT = """你是检索查询优化器。把用户的口语化问题改写成适合检索的规范查询。
要求：① 补全指代；② 去掉寒暄和口头语；③ 保留关键实体和术语；④ 只输出改写后的查询。

对话历史：
{history}

用户问题：{question}
改写后的查询："""

def rewrite_query(question, history=None):
    resp = client.chat.completions.create(
        model=CHAT_MODEL, temperature=0,
        messages=[{"role": "user", "content": REWRITE_PROMPT.format(
            history="\n".join(history or []) or "（无）", question=question)}])
    return resp.choices[0].message.content.strip()
```

```text
# 优化 4：+ 查询改写
{'检索召回率': '35/40 = 88%', '回答准确率': '37/40 = 92%',
 '拒答正确率': '10/10 = 100%', '平均延迟': '2.42s'}
```

**收益**：召回多 2 题（33→35，82%→88%），准确多 1 题（36→37，90%→92%）。提升集中在口语化表达和多轮指代；代号类题目没有涨，因为改写偶尔会把 `PAAS-2024-007` 这类字符串抹平，见 3.5 的兜底做法。

### 1.6 父文档检索

**改动**：索引时建父块（章节级，约 1000 字）和子块（约 300 字）；用子块检索、精排，命中后把子块换成父块再喂模型。**顺序不能反**：先映射父块再精排，等于拿几个大块互相比较，Rerank 没有选择空间。

```sql
CREATE TABLE parent_chunks (
    id BIGSERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    parent_index INT NOT NULL,
    content TEXT NOT NULL,
    UNIQUE (source, parent_index)
);
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS parent_index INT;
CREATE INDEX IF NOT EXISTS idx_chunks_parent
    ON chunks (source, parent_index);
```

```python
def expand_to_parent(conn, hits):
    """Rerank 之后调用：按 (source, chunk_index) 找到父块，去重保序。"""
    if not hits:
        return []
    marks = ",".join(["(%s,%s)"] * len(hits))
    params = [v for h in hits for v in (h["source"], h["chunk_index"])]
    with conn.cursor() as cur:
        cur.execute(
            f"""SELECT c.source, c.chunk_index, c.parent_index, p.content
                  FROM chunks c JOIN parent_chunks p
                    ON p.source = c.source AND p.parent_index = c.parent_index
                 WHERE (c.source, c.chunk_index) IN ({marks})""", params)
        by_child = {(s, i): (pi, text) for s, i, pi, text in cur.fetchall()}
    out, seen = [], set()
    for h in hits:                                  # 保持 Rerank 的顺序
        key = (h["source"], h["chunk_index"])
        if key not in by_child:
            continue
        parent_index, content = by_child[key]
        if (h["source"], parent_index) in seen:
            continue
        seen.add((h["source"], parent_index))
        out.append({"source": h["source"], "parent_index": parent_index,
                    "content": content})
    return out
```

**注意**：同一父块被多个子块命中时会去重，4 条命中可能只剩 2~3 条父块，这是正常的——精排已经替你选过了。

```text
# 优化 5：+ 父文档检索
{'检索召回率': '37/40 = 92%', '回答准确率': '38/40 = 95%',
 '拒答正确率': '10/10 = 100%', '平均延迟': '2.55s'}
```

**收益**：召回多 2 题（35→37，88%→92%），准确多 1 题（37→38，92%→95%）。代价：上下文从约 900 token 涨到 2400 token 上下，生成成本约翻 2.5 倍（token 数以目标模型的 tokenizer 实测为准）。

### 1.7 上下文压缩

**改动**：父块把上下文撑到 2400 token，紧接着压一次——去重、按问题词裁剪句子，控制在 1200 字预算内。压缩放在 Rerank 之后、拼 Prompt 之前：先保证选对，再省 token。

```python
import re

def compact(hits, question, budget=1200):
    """去重 → 按句裁剪到字符预算；token 换算用目标模型实测。"""
    terms = set(re.findall(r"[\u4e00-\u9fa5]{2,}", question))
    kept, used = [], 0
    for h in dedup(hits):                    # dedup 实现见 3.10
        if used >= budget:
            break
        sents = [s for s in re.split(r"(?<=[。！？；])", h["content"]) if s.strip()]
        picked = [s for s in sents
                  if terms & set(re.findall(r"[\u4e00-\u9fa5]{2,}", s))]
        body = ""
        for s in (picked or sents[:1]):
            if used + len(body) + len(s) > budget:
                break
            body += s
        if body:
            kept.append({**h, "content": body})
            used += len(body)
    return kept
```

```text
# 优化 6：+ 上下文压缩到 1200 字
{'检索召回率': '37/40 = 92%', '回答准确率': '38/40 = 95%',
 '拒答正确率': '10/10 = 100%', '平均延迟': '2.38s'}
```

**收益**：召回与准确率不变，生成 token 约降一半，延迟略降。压缩不承诺涨点——**掉点就是裁得太狠，把 budget 调大或改回整块保留，以自有评测集为准**。首次上线只压明显超预算的块，别动短块；单句就超预算时该块会被整块丢掉，所以 budget 不能小于单块的最小长度。

### 1.8 Prompt 强化与引用校验

**改动**：Prompt 升级为 6 条规则 + few-shot，生成后加引用校验；基线用的是「根据资料回答」一句式。

```python
# answer.py
SYSTEM_PROMPT = """你是公司制度问答助手，服务对象是公司员工。

规则：
1. 只根据【参考资料】回答，不得使用你自己的知识补充、推广或推断。
2. 每个要点后标注来源编号，格式 [1]。
3. 参考资料不足以回答时，原样输出：抱歉，现有制度中没有找到相关规定。
4. 金额、天数、工作日等数字必须与资料完全一致，不得四舍五入。
5. 涉及分类判断时，必须引用定义该分类的条款。
6. 先给结论，再给依据，总长不超过 150 字。"""

WEAK_PROMPT = "根据以下资料回答问题。\n{context}"

FEW_SHOT = """示例：
【参考资料】
[1] 来源：差旅制度（住宿标准）  第三条 一线城市每人每晚不超过 500 元。
【问题】住宿能报多少？     【回答】一线城市每人每晚不超过 500 元 [1]。"""

def build_messages(question, hits, strict=True):
    context = "\n\n".join(
        f"[{i}] 来源：{h['source']}（{(h.get('metadata') or {}).get('section', '')}）\n"
        f"{h['content']}" for i, h in enumerate(hits, start=1))
    if not strict:
        return [{"role": "user",
                 "content": WEAK_PROMPT.format(context=context) + f"\n\n问题：{question}"}]
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": FEW_SHOT},
        {"role": "assistant", "content": "一线城市每人每晚不超过 500 元 [1]。"},
        {"role": "user", "content": f"【参考资料】\n{context}\n\n【员工问题】\n{question}"},
    ]

def generate(question, hits, strict=True):
    resp = client.chat.completions.create(
        model=CHAT_MODEL, messages=build_messages(question, hits, strict),
        temperature=0)
    answer = resp.choices[0].message.content or ""
    return {"answer": answer, **check_citation(answer, hits)}   # 校验见 3.13
```

```text
# 优化 7：+ Prompt 强化与引用校验
{'检索召回率': '37/40 = 92%', '回答准确率': '38/40 = 95%',
 '拒答正确率': '10/10 = 100%', '平均延迟': '2.58s'}
```

**收益**：准确率不变，但引用正确率从 71% 提到 96%（口径：答案里出现的数字都能在原文找到，且 `[n]` 编号都在 1~len(hits) 内；抽检 50 条，以自有评测集为准）。用户体感的改善来自「引用能对上原文」，而不是答案换了个说法。

### 1.9 语义缓存

**改动**：相似问题命中缓存，跳过改写、检索、重排和生成。缓存按 `scope` 隔离，scope 放租户或权限集合，不能只放用户 ID。

```python
import time
import numpy as np

class SemanticCache:
    """scope 隔离权限：不同 scope 的缓存互不可见。"""

    def __init__(self, threshold=0.94, ttl=86400, max_size=1000):
        self.threshold, self.ttl, self.max_size = threshold, ttl, max_size
        self.questions, self.vectors = [], []
        self.answers, self.timestamps, self.scopes = [], [], []

    def lookup(self, question, scope="public"):
        if not self.questions:
            return None
        qvec = np.array(embed([question])[0])
        mat = np.array(self.vectors)
        sims = (mat / np.linalg.norm(mat, axis=1, keepdims=True)) @ \
               (qvec / np.linalg.norm(qvec))
        now = time.time()
        candidates = [i for i, s in enumerate(self.scopes)
                      if s == scope and now - self.timestamps[i] < self.ttl]
        if not candidates:
            return None
        idx = max(candidates, key=lambda i: sims[i])
        if sims[idx] >= self.threshold:
            return {**self.answers[idx], "cache_hit": True,
                    "cached_question": self.questions[idx],
                    "cache_similarity": float(sims[idx])}
        return None

    def store(self, question, answer, scope="public"):
        self.questions.append(question)
        self.vectors.append(embed([question])[0])
        self.answers.append(answer)
        self.timestamps.append(time.time())
        self.scopes.append(scope)
        if len(self.questions) > self.max_size:
            for lst in (self.questions, self.vectors, self.answers,
                        self.timestamps, self.scopes):
                lst.pop(0)

    def invalidate(self, scope=None):
        """文档更新、权限变更、Prompt 改版时都要调用。"""
        if scope is None:
            for attr in ("questions", "vectors", "answers", "timestamps", "scopes"):
                setattr(self, attr, [])
            return
        keep = [i for i, s in enumerate(self.scopes) if s != scope]
        for attr in ("questions", "vectors", "answers", "timestamps", "scopes"):
            setattr(self, attr, [getattr(self, attr)[i] for i in keep])
```

```text
# 附加：+ 语义缓存（命中率 22%）
{'检索召回率': '37/40 = 92%', '回答准确率': '38/40 = 95%',
 '拒答正确率': '10/10 = 100%', '平均延迟': '2.06s'}
```

**收益**：命中时延迟从 2s 降到 0.3s，命中率 22%（以自有评测集为准）。

**三条硬约束**：

- 阈值 0.92~0.96 起步，太松会串答案（「住宿标准」与「餐饮标准」可能到 0.95），必须用评测集校准。
- 命中前先按 `scope` 和 TTL 过滤；只按相似度取 argmax 会把别的部门、过期文档的答案捞出来。
- 文档更新、权限变更、Prompt 改版都要 `invalidate()`；**拒答结果不要缓存**，否则新文档入库后用户永远看到「没有找到」。

### 1.10 验收（10 项全过才算生产可用）

| # | 检查 | 命令 | 通过标准 |
|---|---|---|---|
| 1 | 评测集冻结 | `wc -l eval/questions.jsonl` | 50 行，库内 40 / 库外 10 |
| 2 | 基线可复现 | `python run_eval.py --stage baseline` | 与 1.1 记录一致（召回 62%、准确 52%，允许 ±1 题） |
| 3 | 混合检索生效 | `python run_eval.py --stage hybrid` | 含代号 / 版本号的题目召回 ≥ 80% |
| 4 | Rerank 精排 | `python run_eval.py --stage rerank` | 准确率高于 hybrid，Top-1 `rerank_score` ≥ 0.5 |
| 5 | 查询改写 | `python run_eval.py --stage rewrite` | 多轮题改写后含被指代实体，逐条人工核对 |
| 6 | 父块 + 压缩 | `python run_eval.py --stage compact` | 每块带来源与章节，上下文 ≤ 1200 字 |
| 7 | 引用校验 | `python run_eval.py --stage prompt` | `citation_ok=True`，`bad_refs` 为空 |
| 8 | 库外拒答 | `python run_eval.py --stage all` | 10 题拒答 ≥ 9 题，答案里无凭空数字 |
| 9 | 缓存一致 | `python run_eval.py --stage all`，抽检 20 条命中 | 命中答案与直算一致，带 `cached_question` |
| 10 | 权限隔离 | 用无 B 部门权限的账号问 B 文档里的数字 | 检索 0 条、缓存不命中，回答走拒答 |

> **别只看好看的案例**：每次改动都要跑完整评测集，单题通过不算通过。
> **阈值校准**：Rerank 分数阈值、语义缓存阈值，都必须用真实数据定，别直接抄别人的 0.3。

---

## 二、高频问答：会卡住你的地方，也是面试最常问的

按现场出现频率排序。每条讲三件事：现场怎么查、要点是什么、面试会顺着追问什么——能一条 SQL、一次调用验证的，不写成长篇排查。

### 2.1 检索不到专有名词 / 产品代号

**现场**

先用 SQL 确认原文里真有：`SELECT count(*) FROM chunks WHERE content LIKE '%PAAS-2024-007%'`；再看向量 Top-20 里有没有它。

**要点**

- 专有名词是「稀有字符串」，Embedding 把它压成近乎随机的向量，BM25 按 term 精确命中。
- 第一选择是加 BM25 混合检索，不是换更大的模型。
- 查询改写最容易把代号抹平，原问题要单独留一条检索路径。

> ⚠️ 换模型成本最高、见效最不确定。**先加 BM25 混合检索**，专有名词立刻就能命中。注意查询改写会把代号改没，原问题要单独走一次 BM25（见 3.5）。

**追问**

- 为什么向量对代号几乎随机？→ 训练语料里出现次数太少，没学到稳定方向。
- 加了 BM25 还是查不到？→ 查 jieba 分词，代号要先 `add_word` 进自定义词典。
- 改写把代号抹平了怎么办？→ 原问题走 BM25、改写结果走向量，两路 RRF 合并。

### 2.2 检索召回太多噪声

**现场**

`rerank()` 后看分数分布，低分段（阈值以评测集定，一般 0.2~0.4）的块就是噪声。

**要点**

- 向量检索本身不带「相关性阈值」，它只给你 Top-K，无论相关性多低。
- 降 K 只是把噪声概率降低一点，排在 K 内的噪声照样进上下文。
- 把噪声挡在模型之外，靠的是 Rerank 和截断，不是少给几条。

> 降 K 解决不了本质：噪声可能排在 K 范围内。正确做法是「大 K 召回 + Rerank 精选 + 按阈值截断」。

**追问**

- 那阈值定多少？→ 用评测集校准，别抄别人的 0.3。
- 什么时候可以降 K？→ 单点事实题、候选本来就少的时候。
- 没有 Reranker 怎么办？→ 先用相似度阈值 + 去重兜一层。

### 2.3 引用指向错误

**现场**

同时看 `bad_refs`（编号越界）和 `suspect_numbers`（数字不在原文），见 3.13。

**要点**

- 编号是拼上下文时按顺序给的，模型多块混写时容易把 `[2]` 标到相邻条款；去重、重排后位置一变，旧答案的编号就对不上了。
- 引用错不等于答案错，但用户会当成错。
- 校验要同时覆盖数字和编号，任一不过就降级为「无引用」。

> 引用错不等于答案错。**加引用校验**：数字必须能在检索片段里按完整 token 找到，`[n]` 必须落在本次上下文编号范围内，否则标记可疑并降级为「无引用」。

**追问**

- 为什么重排会让编号错？→ 编号跟着位置走，位置变了映射没跟着变。
- 越界编号怎么处理？→ 直接丢弃，那是模型编的。
- 数字校验为什么要先归一化？→ 否则 `５００`、`1,200` 会误报。

### 2.4 多轮对话指代丢失

**现场**

`rewrite_query(question, history)` 看改写是否补全了指代；再单独用当前轮问题检索一次，看 Top-K 是否全是无关块。

**要点**

- 检索只用当前轮问题，历史指代（「那二线呢」）无法命中文档。
- 历史越长，生成越容易混用上一轮的金额、城市；检索端还完全看不到它。
- 检索只认改写后的查询，历史只作为改写的输入。

> 整段历史直接塞给模型，既拖慢生成，又让它混用上一轮的金额、城市；检索端更是完全看不到历史。**改写时只喂最近 2~3 轮并补全指代**，检索只用改写后的查询。

**追问**

- 为什么不把历史一起向量化？→ 噪声大，指代仍然没解开。
- 改写用什么参数？→ 与 Chat 同款模型，`temperature=0`。
- 改写失败怎么兜底？→ 原问题再检索一次，别只依赖改写结果。

### 2.5 答案里的数字幻觉

**现场**

用正则抽回答里所有数字，逐个确认出现在检索原文里：

```python
# 先统一全角数字、去掉千分位，再按完整 token 比对
norm = str.maketrans("０１２３４５６７８９", "0123456789")
ctx = "\n".join(h["content"] for h in hits).translate(norm).replace(",", "")
ans = answer.translate(norm).replace(",", "")
bad = [n for n in re.findall(r"\d+(?:\.\d+)?", ans)
       if not re.search(rf"(?<!\d){re.escape(n)}(?!\d)", ctx)]
```

**要点**

- 模型看到了相关内容但没提取到确切数字，凭训练数据里的模式编了一个。
- `bad` 非空就是数字幻觉，这是可以自动拦的一类错误。
- 归一化是校验前的固定动作，不是可选优化。

> `bad` 非空 → 数字幻觉。不先归一化的话，`５００` 和 `1,200` 会误报。

**追问**

- 换更强的模型能解决吗？→ 降低概率，不消除。
- 数字都对得上就说明答案对吗？→ 不，还要看语义和引用是否支持结论。
- 从源头怎么减少？→ Prompt 里写死「数字必须与资料完全一致」。

### 2.6 文档更新后检索不到

**现场**

比较目录文件列表和数据库 `source` 列表，看是否有僵尸记录。

**要点**

- 增量同步逻辑缺「删除」分支：库里残留已删文档，新文档没入库。
- 重建整个索引是过度反应，先看同步任务到底做了什么。
- 同步不是跑完就结束，缓存也要跟着失效。

> 定时任务建议每小时跑一次：`0 * * * * cd /opt/rag && python sync.py >> sync.log 2>&1`。同步结束后要按 source 清语义缓存（见 1.9），否则新文档进了库，用户拿到的仍是旧答案。

**追问**

- 为什么新文档没进来？→ 同步只处理了新增/修改分支，或任务根本没跑。
- 指纹用什么？→ 内容 hash，`mtime + size` 会漏「改了但大小不变」。
- 缓存必须清吗？→ 必须，否则新文档进了库，用户拿到的仍是旧答案。

### 2.7 相似度阈值设置不当

**现场**

按查询画相似度直方图，看相关块与无关块是否真的分得开；分不开就别用阈值，交给 Rerank。

**要点**

- 不同查询的相似度分布不同；同一模型在不同语料上分数段也不同，固定阈值必然一边噪声一边漏召。
- 调到一个「不高不低」的固定值（比如 0.75）只是心理安慰，没有数据依据。
- 自适应阈值也不是免费的午餐，相关块很少的查询会被切掉唯一的好结果。

> 自适应阈值只是启发式：`score >= mean + 0.5 * std` 可以当起点，但在相关块很少的查询上会把唯一的好结果切掉。上线前用评测集比「固定阈值 / 自适应 / 不设阈值 + Rerank」三种，按拒答率与召回一起看。

**追问**

- 0.75 这种经验值能用吗？→ 不能跨语料，只能在自己的数据上量。
- 什么时候必须用阈值？→ 需要拒答的时候，它是最便宜的第一道防线。
- 阈值和 Rerank 谁先？→ 先粗排、再 Rerank，阈值放在最后截断。

### 2.8 分块太大或太小

**现场**

检查分块后检索命中率，看是否有「关键信息被切到两块」，再抽块看首尾是否完整。

**要点**

- 文档结构不同，固定一个「最优」大小（比如 500 字）会切断语义边界或稀释关键信息。
- 结构优先：先按标题切，长度只做兜底。
- 重叠只为跨块的边界句服务，按句对齐，别按字数硬切。

> 按标题递归分块：块首带章节路径，超长章节按段落续切。相邻块留 10%~15% 重叠（按句对齐），否则「第三条开头一句」被切走时，单独检索两个块都答不全。

**追问**

- 为什么不能固定 500 字？→ 制度条文和 FAQ 的合适长度差一倍。
- 重叠越多越好吗？→ 不是，存储和编码成本跟着翻倍。
- 怎么定参数？→ 用评测集比两种切法，看命中率而不是感觉。

### 2.9 Rerank 延迟过高

**现场**

`time` 一下 Rerank 20 对耗时，看是否在可接受范围。

**要点**

- Rerank 是交叉编码器，对每对 (query, doc) 都要跑一次模型，所以延迟随候选数线性涨。
- 去掉 Rerank 是拿准确率换延迟，不是优化。
- 降延迟的三条路都在模型、候选数和硬件上，不在取消这一步。

> 优化三选项：① 用 base 版模型（约 300ms）；② 粗排 20→10（约 480ms）；③ 上 GPU 或走 API。

**追问**

- 为什么交叉编码器比双塔慢？→ 每对都要前向，文档向量不能离线预计算。
- 粗排减到 10 会掉点吗？→ 可能，要用评测集确认。
- 批量调用要注意什么？→ batch size，显存会先炸。

### 2.10 语义缓存串答案

**现场**

审查缓存命中的 `cached_question` 与 `scope`，看是否真的同义、同权限。

**要点**

- 不同问题的 Embedding 余弦相似度可能很高（0.95+）；只看相似度不看权限，还会跨部门命中。
- 相似度只说明主题接近，不说明问的是同一件事。
- 命中前先按 scope 和 TTL 过滤，再比相似度。

> 举例：「一线城市住宿标准」和「一线城市餐饮标准」可能达到 0.95。**阈值 0.92~0.96，且必须按 scope 过滤，用评测集校准**；拒答结果不入缓存。

**追问**

- 命中率很高说明缓存做得好吗？→ 不一定，可能是阈值太松在串答案。
- 文档更新后缓存怎么办？→ 按 scope `invalidate()`。
- 为什么拒答不能缓存？→ 新文档入库后用户会永远看到「没有找到」。

### 2.11 库外问题没拒答

**现场**

检查拒答题目的检索结果，看是否命中了库外内容。

**要点**

- 检索召回了无关内容，模型被「噪声」当成答案。
- Prompt 里加「如果不知道就说不知道」不够，模型仍会照着噪声答。
- 低分块全部丢弃时直接走拒答，不要硬生成。

> Rerank + 阈值过滤：把 `rerank_score` 低于校准阈值的块丢弃（归一化后一般 0.2~0.4 起步，按模型实测），模型看不到噪声就不会乱答。全部被丢弃时直接走拒答，不要硬生成。

**追问**

- 全部块都被丢弃怎么办？→ 直接拒答，不硬生成。
- 阈值怎么校准？→ 归一化后 0.2~0.4 起步，按模型实测。
- 只靠 Prompt 行不行？→ 不稳定，模型有时不执行。

### 2.12 Lost in the Middle

**现场**

把最相关的块放在开头和结尾，看回答是否更准；同时对比 4 块与 10 块。

**要点**

- 模型对上下文**开头和结尾**记得最牢，中间容易被忽略；块数越多，中间部分占比越大。
- 喂更多上下文不等于「看到全面」，反而稀释关键信息、抬高成本。
- 排序和块数是两个旋钮，先排序，再考虑要不要加块。

> 排序实现见 3.11：最相关的一条放开头、次相关放结尾，其余放中间。块数超过 5 先压缩，别靠加块数「补全面」。

**追问**

- 为什么加块数反而变差？→ 中间被稀释，噪声和成本一起涨。
- 这是模型缺陷吗？→ 是已知的位置偏置，换模型只能缓解。
- 怎么验证？→ 同一批题只改块排列，看准确率变化。

### 2.13 检索越权：A 部门问出 B 部门的答案

**现场**

用 A 部门账号问只有 B 部门文档里才有的数字，看回答或引用里是否出现。

**要点**

- 过滤发生在召回之后：无权限内容已经占掉 Top-K 名额，模型也可能在生成时用到它；语义缓存还会跨账号命中。
- 权限不是检索后的清理动作，而是查询条件的一部分。
- 缓存也要按权限隔离，否则绕过了 SQL 过滤。

> 权限条件必须进同一条 SQL（`chunks` 上要有 `acl` 列，存可访问的角色数组，查询时 `WHERE acl @> %s`），与向量排序一起执行；缓存 key 带上权限范围。这类问题低频但致命，宁可牺牲一点召回，也不要把别人的制度喂给模型。

**追问**

- 取回结果再删掉为什么不够？→ 已经进了上下文、日志和缓存。
- 多租户还该做什么？→ `tenant_id` 索引，必要时上行级安全策略。
- 宁可牺牲召回吗？→ 是，越权的代价远大于少答一条。

---

## 三、核心知识：从零开始要建立的东西

### 3.1 检索归因模型

拿到一个「答错了」的案例，永远按这个顺序定位——**先看检索，再看上下文组织，最后看生成**。

```mermaid
flowchart TD
    classDef danger fill:#FEE2E2,stroke:#DC2626,color:#7F1D1D
    classDef service fill:#DCFCE7,stroke:#16A34A,color:#14532D
    classDef data fill:#FEF3C7,stroke:#D97706,color:#78350F
    classDef normal fill:#F1F5F9,stroke:#64748B,color:#334155

    BAD["回答不对"]:::danger --> R1["第一段 检索：答案那段在 Top-K 里吗"]:::service
    R1 -->|"不在"| P1["改检索：分块 / 混合 / 加大 K"]:::danger
    R1 -->|"在，但排得靠后"| R2["第二段 组织：排位、去重、长度是否合适"]:::service
    R2 -->|"被淹没或超预算"| P3["改组织：重排 / 去重 / 压缩"]:::data
    R2 -->|"排位正常"| P2["改生成：Prompt 约束 / 引用校验 / 拒答"]:::normal
    linkStyle default stroke:#94A3B8,stroke-width:1.5px
```

**为什么顺序不能颠倒**：三段优化成本递增，且后段修不好前段的问题。**检索没召回** → Prompt 再完美，模型看不到资料只能拒答或幻觉。

### 3.2 混合检索原理

纯向量检索天生弱的三类查询，BM25 恰好能补上：

| 查询类型 | 例子 | 向量的问题 | BM25 的优势 |
|---|---|---|---|
| 专有名词 / 代号 | 「PAAS-2024-007 这个漏洞怎么处理？」 | 稀有字符串，Embedding 几乎随机 | term 精确命中 |
| 精确数字 / 版本号 | 「v2.3.1 的接口变更了什么？」 | 语义空间几乎一样，检索错版本 | term 精确匹配 |
| 用文档原词提问 | 「什么是离岗待岗？」 | 能命中，但可能把相近概念排前面 | 文档有原文直接置顶 |

> BM25 弱在「语义词不同」：用户问「住宿能报多少」，文档写「住宿费按城市级别限额」。

中文 BM25 还有一步不能省：**分词**。代号、型号要先 `jieba.add_word("PAAS-2024-007")` 加进自定义词典，否则会被切成碎片，精确命中就打了折扣；分词规则要和建索引时完全一致，查询与文档用同一个分词器。

### 3.3 RRF 融合算法

把向量检索和 BM25 的结果合并。**RRF（Reciprocal Rank Fusion）**只用排名不用分数——正好解决「向量 0~1 和 BM25 0~30 无法直接比较」的问题。

```text
RRF 公式：score(d) = Σ 1 / (k + rank_r(d))     r∈R
  R         ：所有检索器
  rank_r(d) ：文档 d 在第 r 个检索器的排名（从 1）
  k         ：平滑常数，常用经验值 60（不是最优解，换语料要复测）
```

RRF 的代价也在这里：只看排名，会抹平「BM25 里 30 分」和「BM25 里 3 分」的差距，只保证「都排在前面」。所以融合后的 Top-N 仍要 Rerank。

```python
def rrf_fuse(rank_lists, k=60, top_n=20):
    scores, store = {}, {}
    for ranks in rank_lists:
        for rank, doc in enumerate(ranks, start=1):
            key = (doc["source"], doc["chunk_index"])
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank)
            store.setdefault(key, doc)
    ordered = sorted(scores, key=lambda x: -scores[x])[:top_n]
    return [{**store[key], "rrf_score": round(scores[key], 4)} for key in ordered]
```

**直觉**：任意一路排得靠前总分越高，两路都靠前的得分最高。「两路都认为相关」比「只有一路极度相关」更可信。

> **面试**：常问「向量分数和 BM25 分数怎么融合？」答：RRF 只用名次不用分数，避开量纲问题，`k` 常取 60。

### 3.4 重排序机制

向量检索是**粗排**，它的打分方式决定精度天花板。**交叉编码器**把 query 和 doc 拼在一起输入，注意力机制做词级交互，精度远高于双塔。

```mermaid
flowchart LR
    classDef client fill:#DBEAFE,stroke:#2563EB,color:#1E3A8A
    classDef service fill:#DCFCE7,stroke:#16A34A,color:#14532D
    classDef data fill:#FEF3C7,stroke:#D97706,color:#78350F

    Q["问题"]:::client --> V1["双塔：问题向量（在线算）"]:::service
    D["文档"]:::client --> V2["双塔：文档向量（离线算）"]:::service
    V1 --> S["向量或混合检索粗排 Top-20~30"]:::data
    V2 --> S
    S --> R["交叉编码器：问题与每块逐对打分"]:::service
    R --> T["精排 Top-3~5 拼上下文"]:::data
    linkStyle default stroke:#94A3B8,stroke-width:1.5px
```

双塔两边编码时互相看不到，语义被压进一个固定向量，好处是文档向量可以离线算、线上只算问题；交叉编码器把问题和文档拼在一起输入，注意力做词级交互，精度更高，但每对都要跑一次模型。

**结论**：双塔粗排（快、量大），交叉编码器精排（准、量小）。向量/混合检索 Top-20~30 → Rerank → Top-3~5 → 喂给模型。

| 模型 | 部署 | 特点 |
|---|---|---|
| BGE-reranker-v2-m3 | 本地 | 中文强、开源、免费 |
| BGE-reranker-base | 本地 | 更小更快，效果略弱 |
| Cohere rerank-3 | API | 效果好，按量付费 |

`FlagReranker(..., normalize=True)` 才会把分数压到 0~1；不同模型的分数分布不同，阈值不能照搬，换模型必须重新校准。cross-encoder 一次前向只出一对分数，批量调用时要控制 batch size，否则显存先炸。

> **面试**：常问「双塔和交叉编码器各用在哪一步？」答：双塔离线编码做粗排，交叉编码器逐对打分做精排。

### 3.5 查询改写技术

用户的问题和文档的语言经常对不上：用户问「我们那个差旅费能报多少啊？」，文档写「住宿费按城市级别限额」。

```python
REWRITE_PROMPT = """你是检索查询优化器。把用户的口语化问题改写成适合检索的规范查询。
要求：① 补全指代；② 去掉寒暄和口头语；③ 保留关键实体和术语；④ 只输出改写后的查询。

对话历史：
{history}

用户问题：{question}
改写后的查询："""

def rewrite_query(question, history=None):
    resp = client.chat.completions.create(
        model=CHAT_MODEL, temperature=0,
        messages=[{"role": "user", "content": REWRITE_PROMPT.format(
            history="\n".join(history or []) or "（无）", question=question)}])
    return resp.choices[0].message.content.strip()
```

**适用**：口语化问题、多轮指代。**不适用**：对延迟敏感（多一次 LLM 调用约 0.5~1.5s）。

**改写会丢词**：`PAAS-2024-007`、`v2.3.1` 这类字符串在改写时最容易消失。兜底做法是「原问题 + 改写结果」各检索一次：原问题走 BM25 保字符串命中，改写结果走向量保语义，两路用 RRF 合并。

**注意**：3.6~3.8 与 3.14 属于可选增强，先把 3.1~3.5、3.9~3.13 跑通再加，不要一上来就叠。

### 3.6 HyDE 技术

思路：用户的问题和文档语言风格差异大，但**假想答案的语气和文档很像**。让模型编一个假设答案，再用它去检索。

```mermaid
flowchart TD
    classDef client fill:#DBEAFE,stroke:#2563EB,color:#1E3A8A
    classDef service fill:#DCFCE7,stroke:#16A34A,color:#14532D
    classDef lowlevel fill:#CCFBF1,stroke:#0D9488,color:#134E4A
    classDef data fill:#FEF3C7,stroke:#D97706,color:#78350F

    Q["问题：住宿能报多少"]:::client --> N["直接检索：短问句与文档长句风格不匹配"]:::service
    Q --> H["HyDE：先让模型写一段假设答案"]:::lowlevel
    H --> A["假设答案：一线城市每人每晚不超过 500 元"]:::data
    A --> V["用假设答案做向量检索"]:::service
    N --> C["两条路都跑，按评测集选"]:::data
    V --> C
    linkStyle default stroke:#94A3B8,stroke-width:1.5px
```

**假设答案不要求正确**，只要求风格接近文档：编错事实没关系，编错方向（比如把「报销」写成「采购」）才会污染检索。代价是多一次 LLM 调用，且每次都要等它生成完才能检索。

**不适用**：模型对领域完全无知（编出来的答案会偏得更远）。

### 3.7 多查询检索

一个问题 → 多个变体，每个分别走一遍混合检索，再用 RRF 合并。

```python
MULTI_QUERY_PROMPT = """针对用户的问题，生成 3 个不同角度的检索查询。
用词不同但都指向同一个答案；每条一行，不要编号，不要解释。

问题：{question}"""

# 生成变体后，每个变体走 hybrid_retrieve，再用 rrf_fuse 合并：
#   variants = multi_query(question)
#   lists = [hybrid_retrieve(conn, bm25, q, coarse_k=10) for q in variants]
#   hits = rrf_fuse(lists, k=60, top_n=4)
```

**代价**：每个变体多一次 Embedding + 检索，3 个变体就是 3 倍粗排；变体彼此太像时收益接近零。变体数 3 条足够，合并后仍要 Rerank，否则低质变体会把噪声带进上下文。

### 3.8 查询分解技术

复合问题拆成子问题，分别检索，各自命中自己最相关的文档，再合并。

```python
DECOMPOSE_PROMPT = """把下面的复杂问题拆解成 2-4 个可以独立检索的子问题。
每个子问题必须能单独回答，不要出现指代。每行一个，不要编号，不要解释。

问题：{question}"""

def decompose(question):
    resp = client.chat.completions.create(
        model=CHAT_MODEL, temperature=0,
        messages=[{"role": "user", "content": DECOMPOSE_PROMPT.format(question=question)}])
    subs = [l.strip("-• ").strip() for l in resp.choices[0].message.content.splitlines()
            if l.strip()]
    return subs or [question]
```

**价值**：「外出报备」单查询进不了 Top-4，分解后被召回。

### 3.9 父文档与分块检索

**Small-to-Big**：用小块检索，命中后返回它所属的大块。`parent_chunks` 与 `chunks.parent_index` 的建表语句见 1.6，这里只写查询。

```python
def retrieve_parent(conn, question, k=4):
    """一步到位：向量排序后直接 JOIN 父块。"""
    qvec = embed([question])[0]
    with conn.cursor() as cur:
        cur.execute(
            """SELECT c.source, c.parent_index, p.content,
                      c.content AS child_content,
                      1 - (c.embedding <=> %s::vector) AS similarity
               FROM chunks c JOIN parent_chunks p
                 ON p.source = c.source AND p.parent_index = c.parent_index
              ORDER BY c.embedding <=> %s::vector LIMIT %s""",
            (qvec, qvec, k))
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]
```

生产里更常见的是**先精排子块再展开父块**（见 1.6）：Rerank 大块的耗时与 token 都更高，命中同一父块的子块还会重复计费。

**句子窗口检索**（轻量替代）：命中一句话后，返回前后各 N 句。

```python
def retrieve_window(conn, question, k=4, window=2):
    def words(t):
        return set(re.findall(r"[\u4e00-\u9fa5]{2,}", t))
    q_words, out = words(question), []
    for h in retrieve(conn, question, k=k):
        sents = [s for s in re.split(r"(?<=[。！？!?；])", h["content"]) if s.strip()]
        best = max(range(len(sents)), key=lambda i: len(q_words & words(sents[i])))
        lo, hi = max(0, best - window), min(len(sents), best + window + 1)
        out.append({**h, "content": "".join(sents[lo:hi])})
    return out
```

**块长与重叠**：块长按文档结构调整——制度条文 300~800 字、FAQ 一问一块、代码按函数切；相邻块留 10%~15% 重叠，按句对齐。没有跨文档通用的「最优块长」，同一份文档也要用评测集比两种切法。相似度阈值是另一件事，见 2.7。

**代价**：父块把上下文从约 900 token 撑到 2400 token 上下，生成成本约翻 2.5 倍；所以父块之后还要压缩（见 1.7）。

### 3.10 上下文去重

混合检索的常见副作用：**同一段话被不同路径召回多次**。

```python
def dedup(hits, threshold=0.85):
    def shingles(text, n=8):
        return {text[i:i + n] for i in range(max(1, len(text) - n + 1))}
    kept, kept_sets = [], []
    for h in hits:
        s = shingles(h["content"])
        if not any(len(s & ks) / max(1, len(s | ks)) > threshold for ks in kept_sets):
            kept.append(h); kept_sets.append(s)
    return kept
```

放在融合之后、Rerank 之前：先把重复块去掉，才不会让同一段话占满 Top-K；父块展开后如果又出现重复，压缩阶段再去一次（见 1.7）。字符 8-gram 的 Jaccard 对短文本（不足 8 字）会失效，短块改用完全相等判断。

### 3.11 Lost in the Middle

模型对上下文**开头和结尾**记得最牢，中间容易被忽略。所以排序时把**最相关的两条放在最前和最后**：

```python
def arrange_for_attention(picked):
    if len(picked) <= 2:
        return picked
    return [picked[0]] + picked[2:] + [picked[1]]
```

| 上下文块数 | 大致字符 | 常见问题 | 建议 |
|---|---|---|---|
| 1 | 500 | 复合问题缺条件，答案片面 | 只用于单点事实题 |
| 3~5 | 1500~2500 | 覆盖与噪声相对平衡 | 默认区间，先从这里调 |
| 8~10 | 4000~5000 | 中段块利用率下降，成本上升 | 先压缩或重排再喂 |
| 20+ | 10000+ | 中段基本被忽略，延迟与费用都高 | 不要直接全塞 |

曲线是「倒 U 型」：太少缺信息，太多被稀释。**拐点因模型和文档而异，必须用自有评测集测**；3~5 块、2000 字左右只是安全起点，不是标准答案。

> **面试**：常问「Lost in the Middle 是什么，工程上怎么应对？」答：模型对上下文中间利用率低，把最相关的放开头结尾，块数超 5 先压缩。

### 3.12 生成约束

目标：**让模型「只看资料、老实标注、不懂就拒」。**

```python
SYSTEM_PROMPT = """你是公司制度问答助手，服务对象是公司员工。

规则：
1. 只根据【参考资料】回答，不得使用你自己的知识补充、推广或推断。
2. 每个要点后标注来源编号，格式 [1]。
3. 参考资料不足以回答时，原样输出：抱歉，现有制度中没有找到相关规定。
4. 金额、天数、工作日等数字必须与资料完全一致，不得四舍五入。
5. 涉及分类判断时，必须引用定义该分类的条款。
6. 先给结论，再给依据，总长不超过 150 字。"""

FEW_SHOT = """示例：
【参考资料】
[1] 来源：差旅制度（住宿标准）  第三条 一线城市每人每晚不超过 500 元。
【问题】住宿能报多少？     【回答】一线城市每人每晚不超过 500 元 [1]。"""

def build_messages(question, hits):
    context = "\n\n".join(
        f"[{i}] 来源：{h['source']}（{(h.get('metadata') or {}).get('section', '')}）\n"
        f"{h['content']}" for i, h in enumerate(hits, start=1))
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": FEW_SHOT},
        {"role": "assistant", "content": "一线城市每人每晚不超过 500 元 [1]。"},
        {"role": "user", "content": f"【参考资料】\n{context}\n\n【员工问题】\n{question}"},
    ]
```

**few-shot 的作用**：用一个例子告诉模型「输出应该长什么样」。基线用的是单条 `根据以下资料回答问题` 的弱 Prompt，`strict` 开关与两套 messages 的拼接见 1.8。

### 3.13 引用校验

生成后必做的一步：抽出回答里的所有数字与 `[n]` 编号，逐个确认数字出现在检索原文里、编号落在本次上下文范围内；对不上就记录问题、降级为「无引用」。

```python
def check_citation(answer, hits):
    """数字按完整 token 比对，编号按上下文范围校验。"""
    norm = str.maketrans("０１２３４５６７８９", "0123456789")
    ctx = "\n".join(h["content"] for h in hits).translate(norm).replace(",", "")
    ans = answer.translate(norm).replace(",", "")
    bad_numbers = [n for n in re.findall(r"\d+(?:\.\d+)?", ans)
                   if not re.search(rf"(?<!\d){re.escape(n)}(?!\d)", ctx)]
    bad_refs = [n for n in re.findall(r"\[(\d+)\]", ans)
                if not 1 <= int(n) <= len(hits)]
    return {"citation_ok": not bad_numbers and not bad_refs,
            "suspect_numbers": bad_numbers, "bad_refs": bad_refs}
```

`generate` 里直接 `return {"answer": answer, **check_citation(answer, hits)}`，见 1.8。比对前先把全角数字和千分位归一化，否则 `５００`、`1,200` 会误报；`citation_ok=True` 只说明数字和编号对得上，不说明语义正确，仍要人工抽检。

### 3.14 语义缓存

**精确缓存**：用 `hashlib.sha256(question)` 做 key，零误判、命中率低，适合「怎么开发票」这类逐字重复的入口。

**语义缓存**：按问题向量相似度命中，跳过整条链路。实现见 1.9，这里只记三条要害：

- **阈值**：0.92~0.96 起步。「一线城市住宿标准」与「一线城市餐饮标准」可能到 0.95，太松就串答案，必须用评测集校准。
- **隔离**：命中前按租户 / 权限过滤，key 不能只有问题文本，否则 A 部门的答案会发给 B 部门。
- **失效**：文档更新、权限变更、Prompt 改版都要清；拒答结果不入缓存，否则新文档入库后永远答不出来。

缓存只省重复劳动，不改善答案质量；命中率高不等于效果好，要抽检命中样本里有多少是「只是相似、答案不同」。

---

## 四、冷门知识汇总

只收低频、看一眼就能查、但真遇到会卡住半天的点；主线概念在二、三节。

| 知识点 | 为什么冷门 | 用到时的关键词 |
|---|---|---|
| BM25 的 k1 与 b | k1 控词频饱和、b 控长文档惩罚；ES 默认 1.2 / 0.75，rank_bm25 默认 1.5 / 0.75 | BM25Okapi、k1、b、长文档惩罚 |
| 中文分词决定召回 | 代号被 jieba 切碎后 BM25 再也匹配不上，要加自定义词典 | jieba、add_word、自定义词典 |
| rank_bm25 与 ES 的差别 | 前者是内存实现、无增量索引；量大换 Elasticsearch 的 BM25 + ik 分词 | rank-bm25、Elasticsearch、ik_max_word |
| pgvector 索引选择 | HNSW 建得慢查得快；IVFFlat 建得快，lists / probes 要调 | HNSW、IVFFlat、ef_search、probes |
| 距离算子 | `<=>` 余弦距离、`<#>` 负内积、`<->` 欧氏；向量没归一化时结果不同 | <=>、<#>、<->、vector_norm |
| 换 Embedding 必须重建 | 维度不同直接报错；同维度语义空间也不同，混用会掉召回 | 维度、重建索引、embedding 版本 |
| MMR 去冗余 | 在相关与多样之间折中，多文档汇总题有用，单点事实题没用 | MMR、lambda、多样性 |
| Recall@k 与 MRR | 一个看「有没有进前 k」，一个看「第一条对不对」，别混用 | Recall@k、MRR、NDCG@10 |
| token 预算按 tokenizer 算 | 中文按字数估算会偏，压缩预算要用目标模型实测 | tokenizer、上下文预算、truncate |
| 抽取式压缩 | 只留与问题重合的句子，便宜；LLMLingua 类方法更狠，但要额外模型 | LLMLingua、抽取式、budget |
| 句子窗口的边界 | 命中句在第一句或最后一句时，窗口会被截断 | 句子窗口、window、边界 |
| 增量同步用内容 hash | mtime + size 会漏「改了但大小不变」的情况 | fingerprint、sha256、增量同步 |
| 负缓存 | 把拒答也缓存，新文档入库后用户永远看到「没有找到」 | 负缓存、TTL、拒答 |
| 缓存失效维度 | 文档版本、权限、Prompt 版本任一变化都要失效 | cache key、版本号、invalidate |
| Lost in the Middle 的结论 | 结论是「中间位置利用率低」，不是「上下文越长越好」 | Lost in the Middle、position bias |
| 代码块的 chunk 边界 | 按行切、加语言与文件路径前缀，比按字数切好检索 | code chunk、AST、路径前缀 |
