---
title: "RAG优化与评估"
category: "09-大模型"
---

# RAG优化与评估

> 这篇从 RAG 的失败分层讲起，经过可重复的评估基线、检索侧优化（切分与元数据、查询改写、混合检索、重排）、生成侧优化（上下文压缩、引用与拒答）、GraphRAG 的适用边界，最后落到 RAGAS 指标判读、线上回归与一个完整的优化案例。
>
> 学完能独立搭一套 RAG 评估集，用命中率、召回率、忠实度把问题归到检索层或生成层，并按对应路径完成优化和回归验证。

## 一、先定位失败层，再谈优化

RAG 的效果问题必须先归到「检索没找到」还是「生成没用对」，否则任何优化都是盲改。

检索增强生成（Retrieval-Augmented Generation，RAG）由两段组成：一段把问题变成查询、从知识库取回片段；另一段把片段和问题拼成上下文、让模型作答。两段的失败表现完全不同，修复手段也完全不重叠。先换向量库、先换更大的模型，是成本最高、命中率最低的做法。

### 1.1 两类失败的判定

判断依据是「正确答案所需的证据，有没有进入最终上下文」。

| 现象 | 证据在库里 | 证据进上下文 | 失败层 |
|---|---|---|---|
| 答非所问、答成相邻主题 | 是 | 否 | 检索层 |
| 答「没有相关信息」 | 是 | 否 | 检索层 |
| 上下文里有答案，仍答错 | 是 | 是 | 生成层 |
| 上下文里有答案，答出一半 | 是 | 是 | 生成层 |
| 多跳问题只答对第一跳 | 是 | 部分 | 检索层 + 生成层 |

判定动作只有一步：把线上失败的问题拿出来，人工看最终送给模型的上下文里有没有那段正确证据。有，问题在生成；没有，问题在检索。

```python
# 最小判定脚本：把失败样本的上下文落盘，人工只需看有没有关键证据
import json

def dump_failure(question: str, contexts: list[str], answer: str, path: str) -> None:
    # 只留上下文和答案，不留完整 trace，避免把敏感原文写进日志系统
    record = {"question": question, "contexts": contexts, "answer": answer}
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
```

> 边界：不要用「模型答得像不像」来判断失败层。语气流畅的错误答案最容易被误判成生成问题，实际是检索层根本没给证据。

### 1.2 最小指标集

四个指标覆盖两层，全部可自动化计算。

| 指标 | 计算对象 | 回答什么问题 |
|---|---|---|
| 命中率 Hit@k | 检索结果 | 前 k 条里有没有相关文档 |
| 召回率 Recall@k | 检索结果 | 相关文档被找回了多少 |
| 忠实度 Faithfulness | 生成答案 | 答案是否由上下文支持 |
| 答案相关性 Answer Relevancy | 生成答案 | 答案是否切题 |

命中率（Hit Rate@k）是「至少命中一条」的查询占比，衡量「有没有救」；召回率（Recall@k）是「命中的相关文档数除以全部相关文档数」，衡量「救全了没有」。多跳问题必须看召回率，只看命中率会漏掉「找到一半」的情况。

```text
Hit@k    = 命中至少一条相关文档的查询数 / 查询总数
Recall@k = 前 k 条中相关文档数 / 该查询全部相关文档数
```

忠实度（Faithfulness）和答案相关性（Answer Relevancy）由 RAGAS 用大模型评判，算法在第六章展开。前者要求答案的每句陈述都能在上下文里找到依据，后者要求答案正面回应问题而不是堆砌上下文。

> 边界：命中率和召回率需要标注「哪些文档算相关」。没有标注就没有这两个指标，只能做人工抽检。标注成本是评估体系的第一笔投入，绕不开。

### 1.3 优化的优先级

按「改动成本 ÷ 收益」排序，先做便宜且高收益的。

| 顺序 | 动作 | 典型收益 | 风险 |
|---|---|---|---|
| 1 | 修切分与元数据 | 高 | 低 |
| 2 | 加查询改写 | 中高 | 中 |
| 3 | 混合检索 + RRF | 中高 | 低 |
| 4 | 加重排 | 高 | 延迟上升 |
| 5 | 生成约束与拒答 | 中 | 低 |

前两步几乎不增加线上架构复杂度，先做。重排收益高但会把 P95 延迟推高 100–300 ms，必须在有延迟预算时再上。换模型、换向量库放最后，因为它们的收益最不确定，且会让已有评估基线失效。

## 二、搭一套可重复的评估闭环

评估集、检索脚本、指标计算三件套固定下来，每次改动跑同一套数据，才能判断优化是否真的有效。

### 2.1 依赖与版本

基线为 2026-11-13：Python 3.12，`ragas` 0.2 及以上，`langchain-openai` 0.3 及以上。RAGAS 的小版本 API 有变动，安装后先看 `ragas.__version__`，以官方文档为准。

```bash
# Ubuntu / macOS 通用；Windows 用 py -3.12 -m venv .venv 后激活
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -U "ragas>=0.2" "langchain-openai>=0.3" "datasets>=3" "numpy"
```

```bash
python -c "import ragas, langchain_openai; print(ragas.__version__)"
```

预期输出（版本号以实际安装为准）：

```text
0.2.14
```

Rocky/CentOS 上用 `dnf install python3.12` 装解释器，pip 部分与上面一致。Windows 上激活脚本是 `.venv\Scripts\activate`。

### 2.2 评估集的结构

评估集是一份 JSONL，每行一个样本，字段固定。

```jsonl
{"id": "q001", "question": "试用期员工可以申请年假吗", "reference": "试用期员工不享受年假，转正后按入职月份折算。", "relevant_doc_ids": ["hr-leave-003"], "difficulty": "single_hop"}
{"id": "q002", "question": "北京和上海的年假天数为什么不同", "reference": "两地年假天数按当地法定标准执行，北京按国家基准，上海另有补充规定。", "relevant_doc_ids": ["hr-leave-003", "hr-leave-011"], "difficulty": "multi_hop"}
```

字段作用必须写清，否则后面没法定位：

- `question`：原样保存用户问法，含口语和错别字，不要清洗成规范问句；
- `reference`：参考答案，用于计算上下文召回率和答案正确性；
- `relevant_doc_ids`：证据所在的文档 ID，用于命中率和召回率；
- `difficulty`：分层看指标，避免多跳问题拉低整体均值后误判。

规模上，200–500 条足够做回归。分层规则：单跳 60%，多跳 20%，无答案 20%。无答案样本用于测拒答，不测召回。

> 边界：评估集不能只由写代码的人构造。业务方提供的真实问法才是分布，技术团队自己编的问句往往过于规范，指标会虚高。

### 2.3 离线检索指标

命中率、召回率、平均倒数排名（Mean Reciprocal Rank，MRR）都不需要模型，纯 Python 计算。下面这段存为 `eval/metrics.py`，后面的评估脚本直接复用。

```python
import json
from pathlib import Path


def retrieval_metrics(retrieved: list[str], relevant: list[str], k: int) -> dict:
    topk = retrieved[:k]
    hits = [doc for doc in topk if doc in set(relevant)]
    # 命中率看「有没有救」，召回率看「救全了没有」，两者不能互相替代
    hit = 1.0 if hits else 0.0
    recall = len(hits) / len(relevant) if relevant else 0.0
    # MRR 只奖励第一个相关文档的位置，衡量排序质量
    rr = 0.0
    for rank, doc in enumerate(topk, start=1):
        if doc in set(relevant):
            rr = 1.0 / rank
            break
    return {"hit": hit, "recall": recall, "rr": rr}


def evaluate_retrieval(samples: list[dict], retrieve, k: int = 5) -> dict:
    rows = []
    for s in samples:
        retrieved = retrieve(s["question"], k)
        m = retrieval_metrics(retrieved, s["relevant_doc_ids"], k)
        rows.append(m)
    n = len(rows)
    return {
        f"hit@{k}": round(sum(r["hit"] for r in rows) / n, 4),
        f"recall@{k}": round(sum(r["recall"] for r in rows) / n, 4),
        "mrr": round(sum(r["rr"] for r in rows) / n, 4),
        "n": n,
    }


if __name__ == "__main__":
    # 用固定数据验证公式，避免一开始就依赖线上检索
    demo = [
        {"question": "q1", "relevant_doc_ids": ["d1"]},
        {"question": "q2", "relevant_doc_ids": ["d2", "d3"]},
    ]
    fake = {"q1": ["d9", "d1"], "q2": ["d3", "d8", "d7"]}
    print(json.dumps(evaluate_retrieval(demo, lambda q, k: fake[q], k=5), ensure_ascii=False))
```

预期输出：

```json
{"hit@5": 1.0, "recall@5": 0.75, "mrr": 0.75, "n": 2}
```

q1 在第 2 位命中，q2 只找回 d3 漏了 d2，所以召回率是 1.5/2 = 0.75，MRR 是 (0.5 + 1.0)/2 = 0.75。

> 边界：`k` 必须和线上实际注入的片段数一致。评估用 k=10、线上只塞 3 条，指标好看但没有意义。

### 2.4 RAGAS 接入

RAGAS 用大模型做评判，输入是问题、检索上下文、模型答案、参考答案四元组。

```python
import os
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from ragas import evaluate
from ragas.dataset_schema import EvaluationDataset, SingleTurnSample
from ragas.embeddings import LangchainEmbeddingsWrapper
from ragas.llms import LangchainLLMWrapper
from ragas.metrics import (
    answer_relevancy,
    context_precision,
    context_recall,
    faithfulness,
)

# 评判模型建议用比被评估模型更强的型号，否则打分本身不可靠
judge = LangchainLLMWrapper(
    ChatOpenAI(
        model=os.environ["JUDGE_MODEL"],
        base_url=os.environ["OPENAI_BASE_URL"],
        api_key=os.environ["OPENAI_API_KEY"],
        temperature=0,
    )
)
emb = LangchainEmbeddingsWrapper(
    OpenAIEmbeddings(
        model=os.environ.get("EMBED_MODEL", "text-embedding-3-small"),
        base_url=os.environ["OPENAI_BASE_URL"],
        api_key=os.environ["OPENAI_API_KEY"],
    )
)

samples = [
    SingleTurnSample(
        user_input=s["question"],
        retrieved_contexts=s["contexts"],
        response=s["answer"],
        reference=s["reference"],
    )
    for s in run_pipeline()  # run_pipeline 返回检索 + 生成后的结果
]

result = evaluate(
    dataset=EvaluationDataset(samples=samples),
    metrics=[faithfulness, answer_relevancy, context_precision, context_recall],
    llm=judge,
    embeddings=emb,
)
print(result)
print(result.to_pandas().mean(numeric_only=True))
```

预期输出（示例，分数 0–1）：

```text
{'faithfulness': 0.82, 'answer_relevancy': 0.88,
 'context_precision': 0.71, 'context_recall': 0.65}
```

> 边界：RAGAS 的评判模型本身会漂移。同一批数据换判断模型，分数可能差 0.05–0.1。因此回归时固定判断模型和版本，只比同一基线上的差值，不比绝对值。

## 三、检索侧优化

检索侧的目标只有一个：让正确证据稳定进入前 k 条，并且不被无关片段挤掉。

### 3.1 切分与元数据

切分错误是 RAG 最常见、也最便宜可修的问题。

| 问题 | 表现 | 修法 |
|---|---|---|
| 块太大 | 召回噪声高、忠实度低 | 按语义切 300–600 token |
| 块太小 | 缺主语、答不完整 | 加标题与父级摘要 |
| 跨段答案 | 只召回一半 | 小切分 + 父块回填 |
| 表格被切碎 | 数字对不上 | 表格整块保留并转文本 |

父块回填（parent document retriever）的做法：用小块建索引保证命中精度，命中后返回它所属的大块给模型，兼顾召回和上下文完整。

```python
# 元数据是过滤和排序的依据，切分时就要写进 payload
chunk = {
    "id": "hr-leave-003#2",
    "text": "试用期员工不享受年假……",
    "metadata": {
        "doc_id": "hr-leave-003",
        "section": "年假",
        "effective_date": "2026-01-01",  # 制度类必须带生效日期，避免旧版被召回
        "deprecated": False,
        "parent_id": "hr-leave-003",
    },
}
```

检索时先按 `deprecated=false` 和生效日期过滤，再做向量检索。制度、价格、合同这类会过期的内容，不带时间过滤就一定会召回旧版本。

> 边界：元数据过滤会显著缩小候选集。过滤条件写得太细（部门 + 职级 + 地区 + 版本）时，可能把正确文档也过滤掉，最后返回空。过滤条件要用评估集逐条验证。

### 3.2 查询改写

用户问句和文档表述经常对不上。查询改写（Query Rewriting）把一句口语问法变成一条或多条更接近文档语言的查询。

| 方法 | 做法 | 适合 |
|---|---|---|
| 多查询 Multi-Query | 生成 3–5 条同义查询，结果合并 | 口语化、同义词多 |
| HyDE | 先让模型写一段假答案，用假答案检索 | 问题短、文档长 |
| 回退 Step-back | 先问更抽象的上位问题 | 细节问题缺背景 |
| 分解 Decomposition | 拆成子问题分别检索 | 多跳、对比类 |

```python
def rewrite_multi_query(question: str, llm, n: int = 3) -> list[str]:
    prompt = (
        "把用户问题改写成 {n} 条检索查询，覆盖同义词和不同表述，"
        "每条一行，不要编号，不要解释。\n问题：{q}"
    ).format(n=n, q=question)
    out = llm(prompt)
    queries = [line.strip() for line in out.splitlines() if line.strip()]
    # 原问题必须保留：改写会丢信息，原句是兜底
    return [question, *queries[:n]]
```

多查询的结果用倒数排名融合（Reciprocal Rank Fusion，RRF）合并，而不是简单拼接后截断。

```python
def rrf(rank_lists: list[list[str]], k: int = 60) -> list[str]:
    scores: dict[str, float] = {}
    for ranks in rank_lists:
        for pos, doc_id in enumerate(ranks, start=1):
            # 1/(k+pos) 让多个列表都靠前的文档胜出，k 抑制单列表的极端排名
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + pos)
    return sorted(scores, key=scores.get, reverse=True)
```

> 边界：查询改写会增加一次模型调用，延迟 +300–800 ms。对话式产品可以接受，低延迟接口要评估。改写还会引入语义漂移，原问题必须始终作为其中一路查询。

### 3.3 混合检索

向量检索擅长语义相近，关键词检索（BM25）擅长专有名词、编号、错误码。两者互补。

```python
from rank_bm25 import BM25Okapi

# 中文需要先分词；英文按空格切即可
def build_bm25(corpus: list[dict], tokenize) -> BM25Okapi:
    return BM25Okapi([tokenize(c["text"]) for c in corpus])


def hybrid_search(query: str, vector_store, bm25, corpus, tokenize, k: int = 20) -> list[str]:
    vec_ids = [d.id for d in vector_store.search(query, k=k)]
    scores = bm25.get_scores(tokenize(query))
    # 取 BM25 前 k，再与向量结果做 RRF，避免两路分数量纲不同
    kw_ids = [
        corpus[i]["id"]
        for i in sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:k]
    ]
    return rrf([vec_ids, kw_ids])[:k]
```

预期效果：在含产品型号、法规条款编号的知识库上，命中率通常比纯向量高 5–15 个百分点（示例，需按自己的评估集实测）。

> 边界：BM25 依赖分词质量。中文不装分词器直接按字切，编号类查询仍有效，但语义类查询会退化。混合检索的收益集中在「精确匹配」类问题，纯语义问题收益有限。

### 3.4 重排

重排（Rerank）用交叉编码器（Cross-Encoder）对「问题 + 片段」逐对打分，精度明显高于向量相似度，代价是延迟。

```python
from sentence_transformers import CrossEncoder

# 交叉编码器把问题和文档拼在一起编码，能捕捉词序和否定，比双塔向量准
reranker = CrossEncoder("BAAI/bge-reranker-v2-m3", max_length=512)


def rerank(query: str, candidates: list[dict], top_n: int = 5) -> list[dict]:
    pairs = [(query, c["text"]) for c in candidates]
    scores = reranker.predict(pairs)
    # 按分数重排后只保留 top_n，减少送进模型的无关上下文
    ordered = sorted(zip(candidates, scores), key=lambda x: x[1], reverse=True)
    return [c for c, _ in ordered[:top_n]]
```

| 方案 | 延迟增量 | 精度 | 适用 |
|---|---|---|---|
| 不重排 | 0 | 基线 | 低延迟、简单问题 |
| 本地 Cross-Encoder | 80–200 ms | 高 | 有 GPU 或 CPU 富余 |
| 托管重排 API | 150–400 ms | 高 | 无运维、可接受外呼 |
| 大模型重排 | 1–3 s | 最高 | 离线、低 QPS |

> 边界：重排只能重排已经召回的候选。召回阶段没进来的文档，重排也救不回来。所以顺序永远是先修召回，再加重排。

### 3.5 多路召回与过滤

复杂知识库通常要同时走多条路：向量、BM25、按标题/标签的精确匹配、按时间的最近版本。合并后再重排。

```text
候选 = RRF( 向量 top20, BM25 top20, 标题精确匹配 top5, 最新版本 top5 )
最终上下文 = rerank(候选, top_n=5)
```

> 边界：路数不是越多越好。每增加一路都带来噪声和延迟，且需要单独的评估数据证明它有效。没有指标支撑的召回路径应当删掉。

## 四、生成侧优化

生成侧的目标是：只使用上下文里的事实、按问题作答、没有依据时明确拒答。

### 4.1 上下文组织

同样的片段，不同的顺序和数量，忠实度差别很大。

| 做法 | 效果 | 代价 |
|---|---|---|
| 按相关度降序 | 关键证据靠前 | 无 |
| 去重压缩 | 减少重复干扰 | 一次模型调用 |
| 保留来源标记 | 便于引用和核查 | 少量 token |
| 限制总长 | 控制成本和注意力稀释 | 可能截断证据 |

「中间丢失」（lost in the middle）是稳定复现的现象：长上下文中间段的信息最容易被忽略。证据放在开头或结尾，命中率更高。

```python
def build_context(docs: list[dict], max_chars: int = 6000) -> str:
    parts, used = [], 0
    for i, d in enumerate(docs, start=1):
        # 编号和来源让模型能引用，也让日志能回溯到具体文档
        block = f"[{i}] 来源: {d['metadata']['doc_id']}\n{d['text']}"
        if used + len(block) > max_chars:
            break
        parts.append(block)
        used += len(block)
    return "\n\n".join(parts)
```

> 边界：压缩不能改变原意。用模型压缩上下文时，必须保留数字、日期、否定词，这三类信息一旦被改写，忠实度会直接崩。

### 4.2 提示词约束与引用

```text
你是企业制度问答助手。规则：
1. 只依据下方资料回答，不使用资料外的知识。
2. 每条结论后用 [编号] 标注来源。
3. 资料不足以回答时，回答「根据现有资料无法确定」，并说明缺什么。
4. 不猜测数字、日期和适用范围。

资料：
{context}

问题：{question}
```

引用标记的价值不只是好看：它能让人工抽检时一眼看出答案有没有捏造，也让忠实度低的样本更容易归因。

> 边界：提示词约束不能替代检索质量。上下文里没有答案时，再强的约束也只能让模型拒答，不能让它答对。

### 4.3 拒答与置信度

拒答要做成两档，而不是一刀切。

| 情况 | 处理 |
|---|---|
| 上下文中无相关证据 | 直接拒答，提示转人工 |
| 证据部分覆盖 | 回答已知部分，标明缺口 |
| 证据冲突（新旧版本） | 列出冲突，按生效日期给结论 |
| 证据充分 | 正常作答并给引用 |

```python
def answer_with_guard(question: str, docs: list[dict], llm) -> dict:
    if not docs:
        # 召回为空时不让模型自由发挥，直接走人工，避免编造
        return {"answer": "根据现有资料无法确定，已转人工。", "refused": True, "citations": []}
    ctx = build_context(docs)
    text = llm(PROMPT.format(context=ctx, question=question))
    refused = "无法确定" in text
    return {"answer": text, "refused": refused, "citations": extract_citations(text)}
```

> 边界：拒答率要和命中率一起看。召回差导致的高拒答率不是「安全」，是检索故障。

## 五、GraphRAG 的适用边界

GraphRAG 用实体和关系建图，解决向量检索答不了的多跳与全局问题，但建设和查询成本都显著高于向量 RAG。

### 5.1 向量检索答不了的两类问题

| 问题类型 | 例子 | 向量 RAG 表现 |
|---|---|---|
| 多跳关系 | A 的负责人所在部门的预算上限 | 只能召回单段，拼不出链路 |
| 全局汇总 | 这批合同的主要风险主题有哪些 | 召回若干片段，覆盖不全 |

第一类需要沿关系走多条边；第二类需要在全库层面做归纳。向量检索按相似度取 top-k，天然做不到这两件事。

### 5.2 建图流程

微软的 GraphRAG 路线可以拆成五步，每步都能单独替换实现。

```mermaid
graph LR
  A[文档切块] --> B[LLM 抽实体与关系]
  B --> C[实体消歧与建图]
  C --> D[社区检测]
  D --> E[社区摘要]
  E --> F[局部/全局检索]
  classDef blue fill:#eff6ff,stroke:#93c5fd,color:#1e3a8a;
  classDef green fill:#ecfdf5,stroke:#86efac,color:#166534;
  classDef amber fill:#fffbeb,stroke:#fcd34d,color:#92400e;
  classDef gray fill:#f8fafc,stroke:#cbd5e1,color:#334155;
  class A,B,C blue;
  class D,E amber;
  class F green;
```

最小可运行版本只做三元组抽取与邻域扩展，社区摘要可以后补。

```python
import json
import networkx as nx

EXTRACT_PROMPT = """从文本中抽取实体和关系，只输出 JSON：
{"entities":[{"name":"","type":""}],
 "relations":[{"source":"","target":"","relation":""}]}
文本：{text}"""


def _strip_fence(raw: str) -> str:
    # 围栏可能带语言标记，按行判断首尾，避免在正文里写三个反引号把代码块截断
    lines = raw.strip().splitlines()
    if lines and lines[0].startswith("`" * 3):
        lines = lines[1:]
    if lines and lines[-1].startswith("`" * 3):
        lines = lines[:-1]
    return "\n".join(lines)


def extract_graph(chunks: list[str], llm) -> nx.MultiGraph:
    # 用 MultiGraph：同一对实体之间可以有多条不同类型的关系，普通 Graph 会覆盖
    g = nx.MultiGraph()
    for text in chunks:
        # 提示词里本身有 JSON 大括号，用 replace 而不是 format，否则 format 会把它当占位符
        prompt = EXTRACT_PROMPT.replace("{text}", text)
        data = json.loads(_strip_fence(llm(prompt)))
        for e in data["entities"]:
            g.add_node(e["name"].strip(), type=e["type"])
        for r in data["relations"]:
            g.add_edge(r["source"].strip(), r["target"].strip(), label=r["relation"])
    return g


def local_search(g: nx.MultiGraph, seed: str, hops: int = 2) -> list[str]:
    # 从命中的实体出发扩展邻域，把多跳链路拼成一段可读文本
    if seed not in g:
        return []
    nodes = nx.single_source_shortest_path_length(g, seed, cutoff=hops).keys()
    lines = []
    for u, v, d in g.subgraph(nodes).edges(data=True):
        lines.append(f"{u} -[{d.get('label','')}]-> {v}")
    return lines
```

### 5.3 三种检索方式的取舍

| 方式 | 回答什么 | 成本 | 延迟 |
|---|---|---|---|
| 向量 top-k | 单点事实 | 低 | 低 |
| GraphRAG 局部 | 多跳关系 | 中 | 中 |
| GraphRAG 全局 | 全库主题归纳 | 高 | 高 |

全局检索要先读全部社区摘要再归纳，单次查询的 token 消耗可能是向量 RAG 的几十倍。

> 边界：实体抽取靠大模型，一次建图的成本通常是全量文本的 3–10 倍 token。知识库更新频繁时，图会持续腐化，必须有增量更新和实体消歧策略。只做单跳事实问答的系统不要上 GraphRAG。

## 六、RAGAS 指标怎么看

RAGAS 的四个核心指标各自回答一个独立问题，单看任何一个都会误判。

### 6.1 指标定义与算法

| 指标 | 输入 | 算法要点 |
|---|---|---|
| 忠实度 | 答案 + 上下文 | 拆陈述，逐条验证是否有上下文支撑 |
| 答案相关性 | 问题 + 答案 | 由答案反推问题，与原问题算相似度 |
| 上下文精确率 | 问题 + 上下文 | 相关片段是否排在前面 |
| 上下文召回率 | 参考答案 + 上下文 | 参考答案的陈述有多少能被上下文覆盖 |

忠实度（Faithfulness）= 被上下文支持的陈述数 / 答案陈述总数。它只判断「有没有依据」，不判断「对不对」：上下文本身错了，忠实度仍可能是 1。

上下文召回率（Context Recall）= 可归因于上下文的参考答案陈述数 / 参考答案陈述总数。它衡量检索是否取全了证据，是多跳问题最敏感的指标。

```text
faithfulness     = supported_statements / total_statements
context_recall   = attributed_reference_statements / total_reference_statements
```

> 边界：RAGAS 的评判依赖大模型，中文长句的陈述拆分质量参差。医疗、法律等专业语料要先人工抽检 30–50 条，确认拆分和判定可接受，再用于回归门禁。

### 6.2 指标组合判读

四个指标的组合比单个绝对值有用。

| 忠实度 | 上下文召回 | 判断 | 动作 |
|---|---|---|---|
| 低 | 高 | 有证据但没用对 | 改提示词、压缩上下文 |
| 高 | 低 | 只用了部分证据 | 修召回、加查询改写 |
| 低 | 低 | 检索和生成都坏 | 先修检索 |
| 高 | 高 | 链路正常 | 看相关性与拒答率 |

答案相关性低而忠实度高，是典型的「答得准但不切题」：答案句句有依据，但回应的是相邻问题。这时要查查询改写是否漂移，而不是改生成约束。

### 6.3 阈值与门禁

阈值不能照抄。做法是先用当前线上版本跑出一个基线，再把「不低于基线 - 2 个百分点」设为门禁。

```python
THRESHOLDS = {
    "faithfulness": 0.80,
    "answer_relevancy": 0.80,
    "context_recall": 0.70,
    "hit@5": 0.85,
}


def gate(report: dict) -> tuple[bool, list[str]]:
    # 任何一项跌破阈值就阻断发布，避免用平均值掩盖单指标退化
    failed = [k for k, v in THRESHOLDS.items() if report.get(k, 0) < v]
    return (not failed, failed)
```

> 边界：小样本的指标波动很大，200 条评估集上 2 个百分点的差异可能是噪声。做显著性判断时至少要用 500 条，或跑多次取均值。

## 七、线上监控、回归与排障

离线评估通过不等于线上可用，线上还要盯分布漂移、延迟和成本。

### 7.1 线上指标

| 指标 | 采集方式 | 告警线（示例） |
|---|---|---|
| 检索空结果率 | 服务端打点 | > 8% |
| 拒答率 | 服务端打点 | 突增 50% |
| P95 延迟 | 网关 | > 3 s |
| 单次 token 成本 | usage 累加 | > 预算 120% |
| 点踩率 | 用户反馈 | > 10% |

检索空结果率是最灵敏的先行指标。它一涨，多半是元数据过滤写错、索引没更新或 embedding 版本不一致。

### 7.2 回归流程

```text
改代码 → 跑离线评估集 → 与基线比 → 过门禁 → 灰度 5% → 看线上指标 24h → 全量
```

灰度期间要对比的是「同一批问题的两版答案」，不是总体均值。用请求 ID 把两版结果对齐，才能排除流量结构变化。

### 7.3 排障表

| 现象 | 最可能原因 | 第一条检查 |
|---|---|---|
| 突然大量拒答 | 索引为空或过滤条件错 | 查检索返回条数 |
| 答旧制度 | 未按生效日期过滤 | 看召回文档的版本字段 |
| 编号类问题答错 | 只有向量检索 | 加 BM25 并看命中率 |
| 多跳问题答一半 | 召回不足 | 看 Recall@k 与召回片段数 |
| 答案捏造 | 上下文为空仍在生成 | 检查拒答分支是否生效 |
| 延迟翻倍 | 重排或多查询叠加 | 看各阶段耗时埋点 |

> 边界：排障时先看检索返回，再看生成。跳过检索直接调提示词，会把检索故障误当成模型问题，越改越乱。

## 八、最佳实践案例

### 8.1 案例背景

一家 800 人的公司有内部制度问答助手，知识库约 1.2 万份文档，覆盖人事、财务、IT。上线三个月后，点踩率 14%，人工抽检发现两类问题各占一半：一类是「答旧版本制度」，另一类是「多跳问题只答一半」。目标是在四周内把点踩率降到 6% 以下，且 P95 延迟不超过 3 秒。

约束有三条：不能换向量库，索引结构已和权限系统绑定；不能引入 GPU，重排只能用 CPU 或托管 API；预算只允许每次查询最多增加一次模型调用。

现状基线：单路向量检索，top-5 直接拼上下文，提示词没有拒答分支，没有评估集。

### 8.2 案例实操

第一步，先花三天建评估集，不写任何优化代码。

```python
# build_eval.py：从线上日志采样真实问法，业务方补参考答案和证据 ID
import json
import random

random.seed(42)

rows = []
with open("logs/questions.jsonl", encoding="utf-8") as f:
    pool = [json.loads(line) for line in f if line.strip()]

# 按难度分层抽样，避免长尾问题被高频问题淹没
for difficulty, quota in (("single_hop", 120), ("multi_hop", 40), ("no_answer", 40)):
    picked = random.sample([p for p in pool if p["difficulty"] == difficulty], quota)
    rows.extend(picked)

with open("eval/rag_eval.jsonl", "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
print(f"written {len(rows)} samples")
```

预期输出：

```text
written 200 samples
```

第二步，跑基线。检索指标用 2.3 的脚本包装成命令行，生成指标用 RAGAS。

```python
# eval/retrieval_eval.py：对 2.3 的 evaluate_retrieval 加配置开关的薄封装
import argparse
import json

from metrics import evaluate_retrieval  # 2.3 的 eval/metrics.py
from pipeline import Config, run  # 第三章的检索管线，Config 决定开关


def load_eval_set(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--k", type=int, default=5)
    args = ap.parse_args()

    cfg = json.load(open(args.config, encoding="utf-8"))  # 配置即版本，可复现
    samples = load_eval_set("eval/rag_eval.jsonl")
    # 只取候选 ID 做检索评估，不调用生成，省钱且指标不受模型波动影响
    retrieve = lambda q, k: [c["id"] for c in run(q, Config(**cfg))["candidates"]]
    print(json.dumps(evaluate_retrieval(samples, retrieve, args.k), ensure_ascii=False))
```

```bash
python eval/retrieval_eval.py --config configs/baseline.yaml --k 5
```

预期输出（示例）：

```json
{"hit@5": 0.79, "recall@5": 0.61, "mrr": 0.62, "n": 200}
```

基线 RAGAS（示例）：

```text
{'faithfulness': 0.71, 'answer_relevancy': 0.84,
 'context_precision': 0.63, 'context_recall': 0.58}
```

判读：召回率 0.61、上下文召回 0.58，问题主要在检索层；忠实度 0.71 也偏低，但先修检索再看。

第三步，按优先级做四项改动，每项单独跑评估。`store`、`bm25`、`by_id` 来自第三章的实现，这里只展示编排与开关。

```python
# pipeline.py：四项改动都用开关控制，便于单独归因
from dataclasses import dataclass


@dataclass
class Config:
    use_version_filter: bool = False   # 按生效日期过滤旧文档
    use_multi_query: bool = False      # 多查询改写
    use_hybrid: bool = False           # 向量 + BM25 + RRF
    use_rerank: bool = False           # CPU 重排
    top_k: int = 20
    final_n: int = 5


def run(question: str, cfg: Config) -> dict:
    queries = rewrite_multi_query(question, llm) if cfg.use_multi_query else [question]
    rank_lists = []
    for q in queries:
        if cfg.use_hybrid:
            rank_lists.append(hybrid_search(q, store, bm25, corpus, tokenize, cfg.top_k))
        else:
            rank_lists.append([d.id for d in store.search(q, cfg.top_k)])
    candidates = [by_id[i] for i in rrf(rank_lists)[: cfg.top_k]]

    if cfg.use_version_filter:
        # 制度类文档只保留当前生效版本，这是「答旧制度」的直接修复
        candidates = [c for c in candidates if not c["metadata"]["deprecated"]]

    docs = rerank(question, candidates, cfg.final_n) if cfg.use_rerank else candidates[: cfg.final_n]
    # candidates 留给检索评估用：检索指标不该受生成模型波动影响
    return {
        "candidates": candidates,
        "answer": answer_with_guard(question, docs, llm),
        "contexts": [d["text"] for d in docs],
    }
```

逐项开启后的评估（示例，同一批 200 条）：

| 配置 | hit@5 | recall@5 | 忠实度 | 上下文召回 |
|---|---|---|---|---|
| 基线 | 0.79 | 0.61 | 0.71 | 0.58 |
| + 版本过滤 | 0.80 | 0.64 | 0.74 | 0.61 |
| + 多查询 | 0.85 | 0.70 | 0.76 | 0.67 |
| + 混合检索 | 0.90 | 0.76 | 0.78 | 0.72 |
| + 重排 | 0.90 | 0.76 | 0.84 | 0.75 |

重排不改变召回，只改变进入最终上下文的内容，所以 hit@5 不变而忠实度和上下文精确率上升。这个现象本身就是「重排生效」的证据。

延迟实测（示例，单机 8 核 CPU）：

```text
baseline      p50 0.62s  p95 1.10s
+multi_query  p50 1.05s  p95 1.78s
+hybrid       p50 1.12s  p95 1.86s
+rerank       p50 1.48s  p95 2.55s
```

第四步，加拒答和引用，再跑一次全量评估。

```text
{'faithfulness': 0.86, 'answer_relevancy': 0.89,
 'context_precision': 0.82, 'context_recall': 0.75}
```

第五步，灰度 5%，对齐同一批请求的两版答案，观察 24 小时。`ab_compare.py` 按请求 ID 把两版结果配对，只统计同一批问题的点踩率差，避免流量结构变化干扰判断。

```bash
python eval/ab_compare.py --baseline v1 --candidate v2 --since 24h --metric thumbs_down
```

预期输出（示例）：

```json
{"v1_thumbs_down": 0.141, "v2_thumbs_down": 0.058, "requests": 1832}
```

### 8.3 案例结果

四周后，点踩率从 14.1% 降到 5.8%，P95 延迟 2.55 s，仍在 3 s 预算内；忠实度从 0.71 升到 0.86，上下文召回从 0.58 升到 0.75（示例数据，来自该系统的内部评估集）。

失败模式有三个，都值得记下来。

第一，版本过滤上线首日检索空结果率从 3% 涨到 11%。原因是部分文档的 `effective_date` 字段为空，过滤时被当成过期。修复是空值默认放行，并补数据。

第二，多查询在对比类问题上反而变差。改写成三条同义查询后，两边的证据各被召回一半，模型只答了一边。修复是对含「区别、对比、分别」的问题走分解而不是同义改写。

第三，重排上线后短问题延迟超标。原因是 `max_length=512` 对长片段截断，重排模型仍要处理全部 20 个候选。修复是把候选从 20 降到 10，召回率不变，P95 降了 0.4 s。

复盘：这次收益最大的两项是版本过滤和混合检索，都是不需要模型的改动；成本最高的是重排，收益集中在忠实度。评估集是整件事的前提，没有它，四项改动无法单独归因，也很可能把「多查询变差」当成整体噪声忽略掉。

> 边界：这套数字只对应一个 1.2 万文档、中文、制度类知识库。换语料、换语言、换问题分布，收益排序会变。方法可以复用，数字不能复用。
