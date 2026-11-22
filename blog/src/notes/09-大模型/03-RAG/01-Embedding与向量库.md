---
title: "Embedding与向量库"
category: "09-大模型"
---

# Embedding与向量库

> 这篇从 Embedding 的语义表示讲起，经过模型与维度选择、距离度量、HNSW/IVF 索引原理，最后落到 pgvector、Milvus、Qdrant 的建表建索引、写入查询、选型容量与线上排障。
>
> 学完能为一个知识库选定 Embedding 模型与维度，建出可用的向量索引，并在 PostgreSQL 或独立向量库里完成写入、过滤检索和召回率验证。

## 一、Embedding 的边界与向量检索链路

Embedding（嵌入）把一段文本映射为定长稠密向量，语义相近的文本在向量空间里距离更近；向量库负责在百万级候选里快速找出最近的 k 条。它解决的是“意思相近”的召回，不解决精确匹配、权限和事实校验。

先看它在整条 RAG 链路里的位置：

```mermaid
graph LR
  A[原始文档] --> B[解析与切分]
  B --> C[Embedding 模型]
  C --> D[(向量库/索引)]
  E[用户问题] --> F[查询向量]
  F --> D
  D --> G[top-k 候选]
  G --> H[重排与生成]
  classDef blue fill:#eff6ff,stroke:#93c5fd,color:#1e3a8a;
  classDef green fill:#ecfdf5,stroke:#86efac,color:#166534;
  classDef gray fill:#f8fafc,stroke:#cbd5e1,color:#334155;
  class A,B,C,F blue;
  class D gray;
  class G,H green;
```

### 1.1 它替代不了什么

向量检索是召回手段之一，不是数据库替代品。下面的判断直接决定要不要引入向量库：

| 任务 | 该用的手段 | 说明 |
|---|---|---|
| 按订单号、身份证号精确查 | B-tree / 唯一索引 | 向量对长数字串不敏感 |
| 按状态、时间、部门过滤 | 普通列 + 索引 | 过滤条件必须走标量索引 |
| 关键词必须命中 | BM25 / 全文索引 | 专有名词、型号靠词频更稳 |
| 语义近似、跨表述召回 | 向量检索 | “报销多久到账”匹配“费用支付周期” |

> 边界：向量检索返回的是“相似”，不是“正确”。相似度 0.82 只说明两段文本在模型看来接近，是否回答了问题要靠重排、引用和评测判断，这部分在《RAG基础》展开。

### 1.2 一次检索要付的三笔账

向量检索的成本由三处决定，任何一处估算错都会在上线后暴露：

- 写入成本：每段文本调用一次 Embedding，按 token 计费，还要算重试与重建；
- 存储成本：向量维度 × 条数 × 元素字节数，索引还要额外 1.1–1.5 倍；
- 查询成本：HNSW 靠内存随机访问，IVF 靠倒排扫描，过滤条件会放大扫描量。

一条 1024 维 float32 向量占 4 KB，100 万条就是 4 GB 裸数据。这个数字决定了后面所有选型。

## 二、环境准备与最小闭环

这一章把依赖装好，跑通“文本 → 向量 → 相似度”的最小闭环，先确认模型和接口可用，再谈索引。

### 2.1 版本基线

| 组件 | 基线版本 | 用途 |
|---|---|---|
| Python | 3.12+ | 客户端与脚本 |
| PostgreSQL | 17.x | pgvector 宿主 |
| pgvector | 0.8.x | 向量类型与 HNSW |
| Milvus | 2.6.x | 分布式向量库 |
| Qdrant | 1.15.x | 轻量向量库 |
| psycopg | 3.2+ | PostgreSQL 驱动 |

> Embedding 模型不锁版本：模型名以供应商当前可用列表为准，同一索引内不允许换模型，换模型等于全量重建。

### 2.2 安装

Python 依赖三端一致：

```bash
python -m pip install --upgrade pip
python -m pip install requests numpy psycopg[binary] pgvector
```

本机装 PostgreSQL 与 pgvector：

```bash
# Ubuntu 24.04
sudo apt install -y postgresql-17 postgresql-17-pgvector

# Rocky Linux 9 / CentOS Stream 9
sudo dnf install -y postgresql17-server postgresql17-contrib
sudo dnf install -y pgvector_17

# macOS（Homebrew）
brew install postgresql@17 pgvector

# Windows（winget 装服务端，扩展随安装包）
winget install PostgreSQL.PostgreSQL.17
```

不想装本机服务时用容器，镜像已带扩展：

```bash
docker run -d --name pgvector \
  -e POSTGRES_PASSWORD=ragpass \
  -e POSTGRES_DB=rag \
  -p 5432:5432 \
  pgvector/pgvector:pg17
```

验证扩展可用：

```bash
psql "postgresql://postgres:ragpass@localhost:5432/rag" -c "CREATE EXTENSION IF NOT EXISTS vector; SELECT extversion FROM pg_extension WHERE extname='vector';"
```

预期输出（版本号以实际安装为准）：

```text
 extversion
------------
 0.8.0
(1 row)
```

### 2.3 最小闭环：一次 Embedding 与余弦相似度

先用兼容接口拿到向量，确认维度、归一化和相似度排序符合预期。

```python
import os
import numpy as np
import requests

BASE_URL = os.environ.get("EMBED_BASE_URL", "https://api.openai.com/v1")
API_KEY = os.environ["EMBED_API_KEY"]
MODEL = os.environ.get("EMBED_MODEL", "your-embedding-model")  # 以供应商当前模型名为准

def embed(texts: list[str]) -> np.ndarray:
    resp = requests.post(
        f"{BASE_URL}/embeddings",
        headers={"Authorization": f"Bearer {API_KEY}"},
        json={"model": MODEL, "input": texts},
        timeout=30,  # 不设超时会在网络抖动时挂死整个批处理
    )
    resp.raise_for_status()
    items = sorted(resp.json()["data"], key=lambda d: d["index"])  # 返回可能乱序，必须按 index 还原
    return np.asarray([d["embedding"] for d in items], dtype=np.float32)

def normalize(m: np.ndarray) -> np.ndarray:
    # 归一化后余弦相似度等于内积，索引才能统一用 IP 计算
    return m / np.linalg.norm(m, axis=1, keepdims=True)

docs = ["费用报销在审批通过后 7 个工作日内到账。",
        "差旅住宿标准按城市等级分为三档。",
        "发票抬头错误需要联系开票方重开。"]

vecs = normalize(embed(docs))
query = normalize(embed(["报销的钱多久能到账"]))
scores = query @ vecs.T
for text, score in sorted(zip(docs, scores[0]), key=lambda x: -x[1]):
    print(f"{score:.4f}  {text}")
```

预期输出（示例，分数随模型变化）：

```text
0.8412  费用报销在审批通过后 7 个工作日内到账。
0.4127  发票抬头错误需要联系开票方重开。
0.2870  差旅住宿标准按城市等级分为三档。
```

> 边界：`/embeddings` 的路径和 `dimensions` 参数各厂商支持程度不同。OpenAI 兼容实现里 `input` 可以是字符串或字符串数组，批量上限常见 64–2048 条，按供应商文档取小值更安全。

## 三、Embedding 模型选择与维度

Embedding 模型决定了召回上限，选型看四件事：语言覆盖、最大输入长度、维度、能否私有化部署。

### 3.1 选型维度

| 关注点 | 判断标准 | 代价 |
|---|---|---|
| 语言 | 中文为主需中文或多语模型 | 单语模型跨语召回差 |
| 输入长度 | 覆盖切分后的块长 | 长输入模型更贵更慢 |
| 维度 | 768–1536 是常见平衡点 | 维度线性放大存储 |
| 部署 | 数据不能出域必须私有化 | 要自己维护推理服务 |
| 成本 | 按 token 计费，重建也要付 | 换模型等于重跑全库 |

常见可选族（具体版本与价格以供应商为准）：OpenAI `text-embedding-3-large` / `text-embedding-3-small`、BAAI `bge-m3`、`bge-large-zh-v1.5`、Jina `jina-embeddings-v3`、Cohere `embed` 系列。

### 3.2 维度不是越大越好

维度增加带来的是存储、内存和构建时间的线性增长，召回收益在 1024 维之后迅速变缓。落地时优先用支持维度裁剪的模型，把 1536 维截断到 1024 或 768，再测召回。

```python
def truncate_and_normalize(vecs: np.ndarray, dim: int) -> np.ndarray:
    # Matryoshka 训练过的模型允许截断前缀维度，截断后必须重新归一化
    cut = vecs[:, :dim]
    return cut / np.linalg.norm(cut, axis=1, keepdims=True)

full = embed(docs)              # 假设 1536 维
small = truncate_and_normalize(full, 1024)
print(full.shape, small.shape, np.linalg.norm(small[0]))
```

预期输出：

```text
(3, 1536) (3, 1024) 0.99999994
```

> 边界：只有明确用 Matryoshka 或“支持自定义 dimensions”训练的模型能截断。普通模型截断会破坏语义空间，召回明显下降。

### 3.3 对称与非对称检索

问题是短查询、文档是长段落时，两者分布不同，部分模型要求加前缀区分。

```python
def embed_query(text: str) -> np.ndarray:
    # e5 系列要求 query 前缀，bge 中文模型可用检索指令，不加前缀会掉点
    return embed([f"query: {text}"])[0]

def embed_passage(text: str) -> np.ndarray:
    return embed([f"passage: {text}"])[0]
```

判断方法：同一模型分别测“加前缀 / 不加前缀”在自有 200 条评测集上的 recall@10，差 3 个点以上才值得引入前缀约定。前缀一旦确定，写入和查询必须成对使用，混用等于两个语义空间。

### 3.4 批处理与失败重试

全库重建动辄几十万条，批量接口必须带重试、限速和断点。

```python
import time

def embed_batched(texts: list[str], batch_size: int = 64) -> np.ndarray:
    out = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        for attempt in range(5):
            try:
                out.append(embed(batch))
                break
            except requests.HTTPError as e:
                # 429 和 5xx 可以重试，400 多为输入超长或参数错，重试无意义
                if e.response is not None and e.response.status_code not in (429, 500, 502, 503, 504):
                    raise
                if attempt == 4:
                    raise
                time.sleep(min(2 ** attempt, 16))
        time.sleep(0.05)  # 主动限速，避免触发供应商 RPM 限制
    return np.vstack(out)
```

> 边界：批量大小受单请求 token 上限约束，一条 8000 token 的长块可能单独就超限。写入前先按模型最大输入长度截断，并记录被截断的块，否则会静默丢内容。

## 四、距离度量与归一化

距离度量必须与索引的算子类一致，否则要么查得慢，要么结果错。

### 4.1 三种度量

设查询向量 q、文档向量 d：

| 度量 | 公式 | 取值范围 | 适用 |
|---|---|---|---|
| 余弦（cosine） | 1 − q·d / (‖q‖‖d‖) | 0–2，越小越近 | 文本检索默认 |
| 内积（IP） | −q·d | 负值越小越近 | 向量已归一化 |
| 欧氏（L2） | ‖q − d‖₂ | 0–∞ | 图像、坐标类 |

向量归一化后，余弦相似度与内积等价，L2 距离也与余弦单调对应（‖q−d‖² = 2 − 2q·d）。所以“归一化 + 内积”是最省算力的组合。

### 4.2 pgvector 的算子与算子类

| SQL 算子 | 含义 | 索引算子类 |
|---|---|---|
| `<=>` | 余弦距离 | `vector_cosine_ops` |
| `<#>` | 负内积 | `vector_ip_ops` |
| `<->` | 欧氏距离 | `vector_l2_ops` |

三个算子类不能混用。用 `<=>` 排序却建了 `vector_l2_ops` 索引，查询会退化成顺序扫描；用 `<#>` 却建了 cosine 索引，结果排序与索引访问路径不一致。

```sql
-- 建错算子类的典型现象：EXPLAIN 里看不到 Index Scan
CREATE INDEX idx_wrong ON kb_chunk USING hnsw (embedding vector_l2_ops);
EXPLAIN ANALYZE
SELECT id FROM kb_chunk
ORDER BY embedding <=> (SELECT embedding FROM kb_chunk WHERE id = 1)
LIMIT 10;
```

预期输出关键行（示例）：

```text
Seq Scan on kb_chunk  (cost=0.00..2150.00 rows=100000 width=8)
```

### 4.3 精度：float32、halfvec 与二值化

| 类型 | 每维字节 | 召回影响 | 适用 |
|---|---|---|---|
| `vector` | 4 | 基准 | 默认 |
| `halfvec` | 2 | 通常 <1 个点 | 内存紧张 |
| `bit` | 1/8 | 明显下降，需重排补偿 | 超大规模粗筛 |

halfvec 把存储减半，代价是极小精度损失；二值量化把 1024 维压到 128 字节，适合上亿条粗筛，但必须用原始向量重排前 100 条，否则召回掉得厉害。

> 边界：量化只改存储和距离计算，不改模型。写入 halfvec 前仍按 float32 归一化，转换在数据库侧完成，避免两套归一化逻辑。

## 五、向量索引：HNSW、IVF 与量化

向量库的查询速度来自近似最近邻（Approximate Nearest Neighbor，ANN）索引，核心是拿少量召回损失换数量级的速度提升。

### 5.1 HNSW

HNSW（Hierarchical Navigable Small World）建多层可导航图：上层稀疏用于快速跳转，底层稠密用于精确收敛。查询从顶层入口逐层下降，在每层用 `ef` 个候选扩展。

| 参数 | 含义 | 常用值 | 影响 |
|---|---|---|---|
| `m` | 每个节点向上连边数 | 16 | 越大召回越高、内存越大 |
| `ef_construction` | 建图时候选队列长度 | 64–200 | 越大图质量越好、建得越慢 |
| `ef_search` | 查询时候选队列长度 | 40–200 | 越大召回越高、延迟越高 |

HNSW 的优点是不需要训练、支持增量插入、召回高；缺点是吃内存、删除只做标记、构建时间长。它是当前文本 RAG 的默认选择。

### 5.2 IVF

IVF（Inverted File）先用 k-means 把向量聚成 `lists` 个簇，查询时只扫最近的 `probes` 个簇。

- `lists` 经验值：行数 / 1000（百万行约 1000）；
- `probes`：查询时扫的簇数，1–10% 的 lists，越大召回越高越慢；
- 必须先有代表性数据才能训练，空表建索引会失败或质量很差。

IVF 适合批量导入、写少读多的场景，内存占用比 HNSW 低，但召回对数据分布敏感，新数据偏离训练分布时掉点明显。

### 5.3 索引对比

| 索引 | 是否训练 | 增量写入 | 内存 | 典型场景 |
|---|---|---|---|---|
| HNSW | 否 | 友好 | 高 | 在线问答、频繁更新 |
| IVF_FLAT | 是 | 一般 | 中 | 批量知识库 |
| IVF_PQ | 是 | 一般 | 低 | 千万级以上 |
| 暴力扫描 | 否 | 无所谓 | 低 | 评测基线、小于 10 万 |

### 5.4 用暴力扫描量召回

任何索引上线前都要和暴力扫描对比，否则不知道丢了多少召回。

```python
import numpy as np

rng = np.random.default_rng(42)
corpus = rng.normal(size=(20000, 256)).astype(np.float32)
corpus /= np.linalg.norm(corpus, axis=1, keepdims=True)
queries = rng.normal(size=(100, 256)).astype(np.float32)
queries /= np.linalg.norm(queries, axis=1, keepdims=True)

exact = np.argsort(-(queries @ corpus.T), axis=1)[:, :10]  # 暴力 top-10 作为真值

def recall_at_10(approx: np.ndarray) -> float:
    # 命中数 / 真值数，衡量 ANN 相对精确检索丢了多少
    hit = [len(set(a) & set(e)) for a, e in zip(approx, exact)]
    return float(np.mean(hit) / 10)

print("baseline recall@10 =", recall_at_10(exact))
```

预期输出：

```text
baseline recall@10 = 1.0
```

把 `approx` 换成索引返回的 id 列表即可得到真实召回。工程上要求 recall@10 ≥ 0.9，低于 0.85 先调 `ef_search`，再考虑换索引。

> 边界：随机向量上的召回不代表真实文本分布。评测集必须来自真实文档和真实提问，至少 100 条，覆盖专有名词、缩写和口语表述。

### 5.5 过滤与索引的冲突

带 `WHERE dept = 'hr'` 的向量查询是最容易出问题的地方：

- 后过滤：先取 top-k 再筛条件，条件稀疏时结果不足 k 条；
- 前过滤：先筛出子集再算距离，子集大时退化为暴力扫描；
- 分区/分片：按租户或部门物理隔离，查询只扫一个分区。

pgvector 0.8 提供迭代扫描缓解后过滤漏结果：

```sql
SET hnsw.ef_search = 100;
SET hnsw.iterative_scan = strict_order;  -- 结果不足时继续扫，保证顺序正确
SET hnsw.max_scan_tuples = 20000;        -- 上限，防止一次查询扫穿全表
```

> 边界：`SET LOCAL` 只在事务内生效，psql 自动提交模式下会静默失效；要跨语句生效用 `SET`，要事务结束自动还原就包在 `BEGIN`/`COMMIT` 里。

Milvus 用 partition key 或标量索引，Qdrant 用 payload index，思路相同：让过滤先缩小候选集，再在子集内做图搜索。

## 六、pgvector 落地

已有 PostgreSQL 且数据量在千万级以内时，pgvector 是维护成本最低的选择：向量和业务数据同库、同事务、同备份。

### 6.1 建表与索引

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE kb_chunk (
    id          bigserial PRIMARY KEY,
    doc_id      text        NOT NULL,
    dept        text        NOT NULL,
    chunk_no    int         NOT NULL,
    content     text        NOT NULL,
    embedding   vector(1024) NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (doc_id, chunk_no)  -- 幂等写入的前提，重跑不会产生重复块
);

-- 过滤列必须有普通索引，否则向量查询会先全表再过滤
CREATE INDEX idx_chunk_dept ON kb_chunk (dept);

-- HNSW 建索引吃内存，先调大会话参数再建
SET maintenance_work_mem = '2GB';
SET max_parallel_maintenance_workers = 4;
CREATE INDEX idx_chunk_hnsw ON kb_chunk
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 200);
```

建索引耗时随行数增长，百万级 1024 维通常几分钟到十几分钟，期间会占大量内存和 WAL。

### 6.2 写入

```python
import numpy as np
import psycopg
from pgvector.psycopg import register_vector

DSN = "postgresql://postgres:ragpass@localhost:5432/rag"

def upsert_chunks(rows: list[dict], vecs: np.ndarray) -> None:
    with psycopg.connect(DSN) as conn:
        register_vector(conn)  # 让 numpy 数组直接映射为 vector 类型
        with conn.cursor() as cur:
            cur.executemany(
                """
                INSERT INTO kb_chunk (doc_id, dept, chunk_no, content, embedding)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (doc_id, chunk_no)
                DO UPDATE SET content = EXCLUDED.content,
                              embedding = EXCLUDED.embedding,
                              dept = EXCLUDED.dept,
                              updated_at = now()
                """,
                [(r["doc_id"], r["dept"], r["chunk_no"], r["content"], v)
                 for r, v in zip(rows, vecs)],
            )
        conn.commit()  # 一批一个事务，几十万条不要一条一提交
```

预期输出（`psql` 核对）：

```text
 id | doc_id  | dept | chunk_no |         content
----+---------+------+----------+--------------------------
  1 | HR-0001 | hr   |        0 | 费用报销在审批通过后 7 个…
(1 row)
```

### 6.3 查询

```sql
-- 查询向量以参数传入，避免拼接字符串
PREPARE search_chunk(vector, text[], int) AS
SELECT id, doc_id, chunk_no, content,
       1 - (embedding <=> $1) AS score
FROM kb_chunk
WHERE dept = ANY($2)
ORDER BY embedding <=> $1
LIMIT $3;

SET hnsw.ef_search = 100;
-- 直接拿库里已有的一条向量当查询参数，避免手写 1024 维字面量
EXECUTE search_chunk((SELECT embedding FROM kb_chunk WHERE id = 17), ARRAY['hr','finance'], 10);
```

预期输出（示例）：

```text
 id | doc_id  | chunk_no |          content           | score
----+---------+----------+----------------------------+--------
 17 | HR-0001 |        3 | 费用报销在审批通过后 7 个… | 0.8412
 42 | HR-0009 |        1 | 差旅住宿标准按城市等级…   | 0.7905
(2 rows)
```

### 6.4 维护

```sql
-- 删除是逻辑标记，HNSW 不会立刻回收；大量删除后重建
REINDEX INDEX CONCURRENTLY idx_chunk_hnsw;

-- 更新统计信息后，规划器才会正确选择索引
ANALYZE kb_chunk;

-- 查看索引体积
SELECT pg_size_pretty(pg_relation_size('idx_chunk_hnsw')) AS hnsw_size,
       pg_size_pretty(pg_total_relation_size('kb_chunk')) AS table_size;
```

> 边界：pgvector 是单机扩展，扩的是 PostgreSQL 的读副本，不解决写入分片。超过约 5000 万条或需要多租户强隔离时，迁到 Milvus/Qdrant；迁移前先确认 `VACUUM`、备份窗口和索引重建时间能接受。

## 七、Milvus 与 Qdrant 落地

数据量上亿、写入吞吐高、需要独立扩缩容时，用专用向量库。Milvus 走分布式组件，Qdrant 走单进程加副本，两者 API 思路一致：定义 schema、建索引、写入、带过滤检索。

### 7.1 Milvus

Milvus 依赖 etcd 存元数据、对象存储（MinIO/S3）存日志与索引，生产按官方 Helm Chart 或 Docker Compose 部署。下面 `vec`、`query_vec` 是第 2 章 `embed()` 返回的 1024 维 float32 数组，维度必须与 schema 一致。

```python
from pymilvus import MilvusClient, DataType

client = MilvusClient(uri="http://localhost:19530", token="root:Milvus")

schema = client.create_schema(auto_id=False, enable_dynamic_field=False)
schema.add_field("id", DataType.VARCHAR, max_length=64, is_primary=True)
schema.add_field("doc_id", DataType.VARCHAR, max_length=64)
schema.add_field("dept", DataType.VARCHAR, max_length=32)
schema.add_field("content", DataType.VARCHAR, max_length=8192)
schema.add_field("embedding", DataType.FLOAT_VECTOR, dim=1024)

index_params = client.prepare_index_params()
# HNSW 的 M/efConstruction 在 Milvus 里是驼峰参数名
index_params.add_index(
    field_name="embedding",
    index_type="HNSW",
    metric_type="COSINE",
    params={"M": 16, "efConstruction": 200},
)

if not client.has_collection("kb_chunk"):
    client.create_collection("kb_chunk", schema=schema, index_params=index_params)

client.insert("kb_chunk", [
    {"id": "HR-0001-0", "doc_id": "HR-0001", "dept": "hr",
     "content": "费用报销在审批通过后 7 个工作日内到账。", "embedding": vec.tolist()},
])

res = client.search(
    collection_name="kb_chunk",
    data=[query_vec.tolist()],
    filter='dept in ["hr", "finance"]',  # 标量过滤在服务端完成，不走客户端
    limit=10,
    output_fields=["doc_id", "content"],
    search_params={"metric_type": "COSINE", "params": {"ef": 100}},
)
for hit in res[0]:
    print(hit["distance"], hit["entity"]["content"])
```

预期输出（示例）：

```text
0.8412 费用报销在审批通过后 7 个工作日内到账。
0.7905 差旅住宿标准按城市等级分为三档。
```

### 7.2 Qdrant

Qdrant 单二进制即可运行，支持标量量化、payload 过滤和快照备份。

```python
from qdrant_client import QdrantClient, models

client = QdrantClient(url="http://localhost:6333")

client.create_collection(
    collection_name="kb_chunk",
    vectors_config=models.VectorParams(
        size=1024,
        distance=models.Distance.COSINE,
        hnsw_config=models.HnswConfigDiff(m=16, ef_construct=200),
    ),
    # int8 量化把向量压到 1/4，always_ram 保留原始向量用于重排
    quantization_config=models.ScalarQuantization(
        scalar=models.ScalarQuantizationConfig(
            type=models.ScalarType.INT8, quantile=0.99, always_ram=True
        )
    ),
)

client.create_payload_index(
    collection_name="kb_chunk", field_name="dept",
    field_schema=models.PayloadSchemaType.KEYWORD,  # 过滤字段必须建 payload 索引
)

client.upsert(
    collection_name="kb_chunk",
    points=[models.PointStruct(
        id=1, vector=vec.tolist(),
        payload={"doc_id": "HR-0001", "dept": "hr",
                 "content": "费用报销在审批通过后 7 个工作日内到账。"},
    )],
)

res = client.query_points(
    collection_name="kb_chunk",
    query=query_vec.tolist(),
    query_filter=models.Filter(must=[
        models.FieldCondition(key="dept", match=models.MatchAny(any=["hr", "finance"]))
    ]),
    limit=10,
    with_payload=True,
)
for p in res.points:
    print(p.score, p.payload["content"])
```

预期输出（示例）：

```text
0.8412 费用报销在审批通过后 7 个工作日内到账。
0.7905 差旅住宿标准按城市等级分为三档。
```

### 7.3 运维差异

| 维度 | pgvector | Milvus | Qdrant |
|---|---|---|---|
| 部署 | PostgreSQL 扩展 | 多组件分布式 | 单进程/集群 |
| 事务 | 与业务同事务 | 无跨表事务 | 无跨表事务 |
| 扩缩容 | 读副本 | 分片+副本 | 分片+副本 |
| 过滤 | SQL 条件 | 标量过滤/分区键 | payload 索引 |
| 备份 | pg_dump/PITR | 对象存储快照 | snapshot API |

> 边界：Milvus 的 consistency level 默认 `Bounded`，写入后立即查询可能看不到最新数据；对实时性敏感的集合显式设 `Strong`，代价是延迟上升。

## 八、选型、容量与成本

选型先算三个数：向量条数、单条字节数、过滤维度。数字算完，候选通常只剩一个。

### 8.1 按规模选

| 条数 | 推荐 | 原因 |
|---|---|---|
| < 10 万 | pgvector 或暴力扫描 | 索引收益不明显 |
| 10 万–1000 万 | pgvector + HNSW | 运维复用现有 PG |
| 1000 万–1 亿 | Qdrant / Milvus | 需要分片与量化 |
| > 1 亿 | Milvus 集群 | 分布式写入与索引 |

### 8.2 容量估算

裸向量 = 条数 × 维度 × 每维字节。以 500 万条、1024 维为例：

```text
float32: 5,000,000 × 1024 × 4 B = 20.5 GB
halfvec: 5,000,000 × 1024 × 2 B = 10.2 GB
int8   : 5,000,000 × 1024 × 1 B = 5.1 GB
```

HNSW 索引再按裸向量的 1.1–1.5 倍估内存，500 万条 float32 需要约 25–30 GB 常驻内存。这个数决定机器规格，而不是 QPS。

### 8.3 多租户隔离

| 方案 | 隔离强度 | 成本 |
|---|---|---|
| 共享表 + 过滤列 | 弱，靠代码保证 | 最低 |
| 共享表 + 行级安全 | 中 | 低 |
| 分区表/分区键 | 中高 | 中 |
| 独立 collection/schema | 强 | 高 |

> 边界：向量相似度会跨租户泄漏内容——即使过滤做对，也要防止“先取 top-k 再过滤”的实现。过滤必须下推到索引层，最好在 SQL/API 参数里完成，不在应用层截断。

## 九、检索质量与运维排障

上线后每天要看两类指标：检索质量（召回、命中）和系统健康（延迟、内存、写入滞后）。

### 9.1 质量指标

| 指标 | 定义 | 目标（示例） |
|---|---|---|
| recall@10 | 真值前 10 被召回比例 | ≥ 0.90 |
| MRR@10 | 首个正确结果排名倒数和 | ≥ 0.75 |
| 空结果率 | 无任何候选的查询占比 | < 2% |
| 过滤后不足率 | 结果数 < k 的查询占比 | < 5% |

计算 recall 需要真值，最省事的做法是对抽样查询跑一次暴力扫描。

```sql
-- 在只读副本或离线快照上做，不要对生产主库跑全表暴力扫描
BEGIN;
SET LOCAL enable_indexscan = off;   -- 关掉索引扫描，得到暴力扫描基线
SET LOCAL enable_bitmapscan = off;
SELECT id FROM kb_chunk
WHERE dept = 'hr'
ORDER BY embedding <=> (SELECT embedding FROM kb_chunk WHERE id = 17)
LIMIT 10;
ROLLBACK;
```

### 9.2 现象、原因与第一条命令

| 现象 | 最可能原因 | 第一条检查 |
|---|---|---|
| 查询很慢且走 Seq Scan | 算子类不匹配/未建索引 | `EXPLAIN ANALYZE` 看访问路径 |
| 召回突然下降 | 换模型/改前缀/维度截断 | 核对写入与查询的模型名与维度 |
| 过滤后结果不足 k | 后过滤+ef 太小 | 开 iterative_scan 或加分区 |
| 内存持续上涨 | HNSW 全量驻留+副本过多 | `pg_relation_size` 与容器内存 |
| 写入越来越慢 | 逐条提交/索引维护 | 看批量大小与 WAL 生成速率 |
| 维度报错 | 模型维度与列定义不一致 | `SELECT vector_dims(embedding) FROM kb_chunk LIMIT 1` |

### 9.3 变更管理

换 Embedding 模型是全量重建，不是改配置：

1. 新模型写入新表或新列，保留旧索引可回滚；
2. 用同一批 200 条评测查询对比 recall@10 与 P95；
3. 双写一段时间，灰度切读；
4. 确认稳定后删旧列，回收空间。

> 边界：不要对同一列混写两个模型的向量。维度相同也不代表语义空间相同，混写后相似度没有意义，而且很难通过指标发现。

## 十、最佳实践案例

### 10.1 案例背景

一家人力资源外包公司有内部制度问答系统，文档来自 12 个部门，共 82 万个切分块。原方案把向量放在独立部署的 Milvus 单机上，由一名不熟悉 Milvus 的后端维护；故障时无人会扩容，且向量与制度原文分两套库，改一条制度要人工双写。

目标：在现有 PostgreSQL 17 集群上承载 82 万块、1024 维向量，支持按部门过滤，P95 查询延迟低于 100 ms，recall@10 不低于 0.90，并且在制度更新时与原文同事务写入。约束：不能新增中间件，内存单机 64 GB，团队只熟悉 SQL。

### 10.2 案例实操

第一步，按新表结构建表并评估存储。1024 维 float32 约 3.4 GB 裸数据，索引按 1.3 倍估算 4.4 GB，单机可放；为留余量改用 `halfvec`，裸数据降到 1.7 GB。

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE kb_chunk_v2 (
    id         bigserial PRIMARY KEY,
    doc_id     text         NOT NULL,
    dept       text         NOT NULL,
    chunk_no   int          NOT NULL,
    content    text         NOT NULL,
    embedding  halfvec(1024) NOT NULL,
    updated_at timestamptz  NOT NULL DEFAULT now(),
    UNIQUE (doc_id, chunk_no)
);

CREATE INDEX idx_chunk_v2_dept ON kb_chunk_v2 (dept);
SET maintenance_work_mem = '8GB';
SET max_parallel_maintenance_workers = 4;
CREATE INDEX idx_chunk_v2_hnsw ON kb_chunk_v2
    USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 200);
```

第二步，用批量脚本回填 82 万块，每 2000 条一个事务，失败可断点续跑。

```python
import json
import numpy as np
import psycopg
from pgvector.psycopg import register_vector

DSN = "postgresql://rag:pass@pg-prod:5432/rag"

def load_rows(path: str):
    with open(path, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            yield r

def backfill(path: str, batch: int = 2000):
    buf, vecs = [], []
    with psycopg.connect(DSN) as conn:
        register_vector(conn)
        with conn.cursor() as cur:
            for r in load_rows(path):
                buf.append(r)
                vecs.append(np.asarray(r["embedding"], dtype=np.float32))
                if len(buf) == batch:
                    flush(cur, buf, vecs)
                    conn.commit()  # 每批一个事务：断点可续，WAL 增长可控
                    buf, vecs = [], []
            if buf:
                flush(cur, buf, vecs)
                conn.commit()

def flush(cur, buf, vecs):
    cur.executemany(
        """INSERT INTO kb_chunk_v2 (doc_id, dept, chunk_no, content, embedding)
           VALUES (%s, %s, %s, %s, %s)
           ON CONFLICT (doc_id, chunk_no) DO NOTHING""",  # 断点续跑时跳过已写入的块
        [(r["doc_id"], r["dept"], r["chunk_no"], r["content"], v)
         for r, v in zip(buf, vecs)],
    )
```

第三步，用 300 条真实提问做召回对比：同一批查询分别走新索引和关闭索引的暴力扫描，统计 recall@10 与 P95。

```python
import time

def search(cur, qvec, dept_list, ef=100):
    # SET 不支持绑定参数，用 set_config 达到同样的会话级效果
    cur.execute("SELECT set_config('hnsw.ef_search', %s, true)", (str(ef),))
    cur.execute("SELECT set_config('hnsw.iterative_scan', 'strict_order', true)")
    t0 = time.perf_counter()
    cur.execute(
        """SELECT id FROM kb_chunk_v2
           WHERE dept = ANY(%s)
           ORDER BY embedding <=> %s::halfvec LIMIT 10""",
        (dept_list, qvec),  # 列是 halfvec，查询参数必须显式转成同类型才能走索引
    )
    ids = [r[0] for r in cur.fetchall()]
    return ids, (time.perf_counter() - t0) * 1000

def exact(cur, qvec, dept_list):
    cur.execute("SET LOCAL enable_indexscan = off")
    cur.execute("SET LOCAL enable_bitmapscan = off")
    cur.execute(
        """SELECT id FROM kb_chunk_v2
           WHERE dept = ANY(%s)
           ORDER BY embedding <=> %s LIMIT 10""",
        (dept_list, qvec),
    )
    return [r[0] for r in cur.fetchall()]
```

第四步，调 `ef_search`。从 40 到 200 扫一遍，记录召回和延迟，选拐点而不是最大值。

| ef_search | recall@10 | P95 延迟 | 走索引比例 |
|---|---|---|---|
| 40 | 0.871 | 12 ms | 100% |
| 100 | 0.936 | 28 ms | 100% |
| 200 | 0.951 | 51 ms | 100% |

第五步，处理过滤稀疏的部门。12 个部门里有 3 个部门文档占比不足 2%，后过滤经常凑不满 10 条，改为按部门建部分索引，其余部门走迭代扫描。

```sql
CREATE INDEX idx_chunk_v2_hnsw_legal ON kb_chunk_v2
    USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 200)
    WHERE dept = 'legal';  -- 部分索引只覆盖高频稀疏部门，体积可控
```

### 10.3 案例结果

迁移后实测（示例环境，300 条查询，单机 64 GB）：

- recall@10 从 Milvus 方案的 0.904 变为 0.936，`ef_search=100`；
- P95 延迟 28 ms，满足 100 ms 目标，QPS 峰值 45 时 CPU 占用 38%；
- 裸向量 1.7 GB，HNSW 索引 2.3 GB，总占用 4.0 GB，比 float32 方案省一半；
- 制度更新与向量写入在同一事务内完成，双写不一致的工单从每周约 6 起降到 0。

失败模式与复盘：

- 第一次回填按每 200 条提交，82 万块跑了 5 小时且 WAL 暴涨；改为 2000 条后降到 48 分钟。
- 最初用 `vector_cosine_ops` 建索引却存 `halfvec` 列，建索引直接报类型不匹配；`halfvec` 必须配 `halfvec_cosine_ops`。
- 法务部门查询长期只返回 3–4 条，原因是 `ef_search=40` 加后过滤；部分索引加上迭代扫描后恢复到稳定 10 条。
- 换模型测试时曾把新旧向量混写进同一列，指标看起来正常但答案开始串部门；此后固定为“新列 + 新索引 + 灰度切读”的迁移流程。

> 边界：本案例的延迟和召回是单机实测示例，换机器、换模型、换数据分布都会变。上线前用自己的 200–300 条真实查询重跑一遍，别直接抄表里的数字。
