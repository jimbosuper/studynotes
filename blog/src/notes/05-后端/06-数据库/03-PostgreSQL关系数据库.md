---
title: "PostgreSQL关系数据库"
category: "05-后端"
---

# PostgreSQL关系数据库

> 这篇从 PostgreSQL 的"一连接一进程"模型和堆表存储讲起，经过安装与最小验证、类型系统与 JSONB、CTE 与窗口函数、索引体系、MVCC 与 VACUUM、扩展生态、备份复制与现场排障，最后落到一个把两千一百万行事件表从 MySQL 迁到 PostgreSQL 17 并完成查询提速的完整案例。
>
> 学完能独立部署并调优一个 PostgreSQL 17/18 实例，用 JSONB 与分区表承载半结构化数据，读懂 EXPLAIN 判断索引是否生效，处理膨胀、长事务和序列化冲突，配置流复制与时间点恢复，并完成一次带校验的跨库迁移。

## 一、PostgreSQL 的进程模型与存储结构

PostgreSQL（下称 PG）采用"一连接一进程"的模型，每张表是一张无序堆表，所有索引都独立于数据存放；这两条决定了它的连接成本、更新代价和调优方向。

与 MySQL 的对比不是优劣之争，而是排障入口不同：

| 维度 | PostgreSQL | MySQL/InnoDB |
|---|---|---|
| 进程模型 | 每连接一个 backend 进程 | 单进程多线程 |
| 表组织 | 堆表，索引全部独立 | 主键即聚集索引 |
| 旧版本 | 留在堆内，靠 VACUUM 回收 | undo 日志 + 回滚段 |
| 事务内 DDL | 可回滚 | 隐式提交 |
| 扩展 | 内核可挂扩展（`CREATE EXTENSION`） | 插件有限 |

```mermaid
graph TD
  A[应用 / PgBouncer 连接池] --> B[postmaster 监听 5432]
  B --> C[backend 进程 每连接一个]
  C --> D["解析 → 重写 → 计划器 → 执行器"]
  D --> E[shared_buffers 共享缓冲]
  D --> F[WAL 缓冲区]
  E --> G[(堆文件 heap)]
  E --> H[(TOAST 大字段)]
  F --> I[(pg_wal 日志)]
  D --> J[辅助进程 autovacuum / checkpointer / walwriter]
  I -.流复制.-> K[备库 standby]
  classDef blue fill:#eff6ff,stroke:#93c5fd,color:#1e3a8a;
  classDef green fill:#ecfdf5,stroke:#86efac,color:#166534;
  classDef amber fill:#fffbeb,stroke:#fcd34d,color:#92400e;
  classDef gray fill:#f8fafc,stroke:#cbd5e1,color:#334155;
  class A,B,C,D blue;
  class E,G,H,I green;
  class F,J amber;
  class K gray;
```

一条 UPDATE 的实际路径体现了"无 undo"的代价：

```mermaid
sequenceDiagram
    participant C as 客户端
    participant B as backend
    participant S as shared_buffers
    participant W as WAL
    participant D as 堆文件
    C->>B: BEGIN
    C->>B: UPDATE accounts SET balance=900 WHERE id=1
    B->>S: 定位页，未命中则从堆文件读入
    B->>S: 写入新元组版本，旧元组保留在原位
    B->>W: 先写 WAL 记录（先日志后数据）
    B-->>C: COMMIT（WAL 落盘即可返回）
    Note over S,D: 脏页由 checkpointer 异步写回
    Note over S: 旧元组变成死元组，等 VACUUM 回收
```

由此得到三条直接影响运维的推论：

- 连接贵：backend 是进程，每个占数 MB 内存，几百以上连接必须前置 PgBouncer（transaction 模式）；
- 更新不原地覆盖：高频 UPDATE 的表会积累死元组，autovacuum 跟不上就膨胀，这是 PG 最常见的性能事故；
- 索引与数据分离：一次主键查询至少两次访问（索引 + 堆），覆盖索引（index-only scan）的收益比 MySQL 更明显。

2026-11 的版本基线：

| 版本 | 发布 | 社区支持到 | 使用建议 |
|---|---|---|---|
| 18 | 2025-09 | 2030-11 | 新项目首选 |
| 17 | 2024-09 | 2029-11 | 存量系统主力 |
| 16 | 2023-09 | 2028-11 | 可维护，计划升级 |
| 15 | 2022-10 | 2027-11 | 尽快排期升级 |

PG 18 相对 17 有三处与业务代码相关的变化：`uuidv7()` 内建（时间有序主键不必再靠扩展）、异步 I/O（`io_method`，顺序扫描与 vacuum 受益）、虚拟生成列（`GENERATED ALWAYS AS ... VIRTUAL`，不占存储）。17 带来的增量备份（`pg_basebackup --incremental`）和逻辑复制槽故障转移，是大库备份与升级方案的关键能力。

> 边界：PG 适合需要复杂查询、强约束、JSONB、地理或向量检索的系统。单表纯 KV 高并发写入、超大规模简单计数这类场景，PG 的进程模型与 MVCC 写放大不占优势，应交给 Redis 或专用存储；已有 MySQL 团队与工具链时，迁移收益要按查询复杂度算，不是按"新版本"算。

## 二、安装与最小验证

安装走官方仓库拿最新小版本，发行版自带的包往往落后一到两个大版本；所有平台都遵循"装包 → 初始化 → 改监听与认证 → 启动 → 建角色验证"五步。

| 环境 | 安装方式（2026-11） | 服务管理 |
|---|---|---|
| Ubuntu 24.04 | PGDG 源 + `apt install postgresql-18` | `systemctl` / `pg_ctlcluster` |
| Rocky/CentOS 9 | PGDG 源 + `dnf install postgresql18-server` | `systemctl` |
| macOS 14+ | `brew install postgresql@18` | `brew services` |
| Windows 10/11 | EDB 安装包（含 pgAdmin、Stack Builder） | 服务面板 `postgresql-x64-18` |

Ubuntu 用官方脚本一次性配好源与签名：

```bash
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh   # 加 PGDG 源，避免发行版旧包
sudo apt install -y postgresql-18
pg_lsclusters                       # 确认 18 main 已创建、端口 5432
sudo pg_ctlcluster 18 main start
```

Rocky 9 先禁用系统自带的 PG 模块，否则会装到旧版本：

```bash
sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm
sudo dnf -qy module disable postgresql
sudo dnf install -y postgresql18-server
sudo /usr/pgsql-18/bin/postgresql-18-setup initdb
sudo systemctl enable --now postgresql-18
```

macOS 与 Windows 走包管理器或图形安装器，初始化由安装程序完成：

```bash
brew install postgresql@18
brew services start postgresql@18
psql postgres -c "SELECT version();"     # Homebrew 默认当前系统用户即超级用户
```

生产配置只改必要项，每一行都有明确理由（Debian 路径 `/etc/postgresql/18/main/postgresql.conf`，RHEL 为 `/var/lib/pgsql/18/data/postgresql.conf`）：

```ini
listen_addresses = '*'              # 只在内网网卡上开放，公网由防火墙挡掉
port = 5432
max_connections = 300               # 应用连接池总和，超出部分交给 PgBouncer
shared_buffers = 8GB                # 专用服务器物理内存的 25%
effective_cache_size = 24GB         # 告诉计划器 OS 页缓存大概有多少，不实际分配
work_mem = 16MB                     # 每个排序/哈希节点上限，复杂查询多时会成倍占用
maintenance_work_mem = 1GB          # VACUUM、建索引用
random_page_cost = 1.1              # SSD 随机读接近顺序读，默认 4.0 会误判走全表扫描
effective_io_concurrency = 200      # SSD/NVMe 并发 IO 能力
wal_compression = zstd              # 15+ 支持，压缩 WAL 省带宽与归档空间
max_wal_size = 8GB
checkpoint_timeout = 15min
log_min_duration_statement = 500ms  # 慢查询入日志，单位毫秒
log_lock_waits = on                 # 锁等待超过 deadlock_timeout 记日志
log_checkpoints = on
track_io_timing = on                # 让 pg_stat_statements 能报 IO 时间
password_encryption = scram-sha-256
```

认证在 `pg_hba.conf` 里按"连接来源 + 库 + 用户"逐条放行，顺序从上到下匹配：

```ini
# TYPE  DATABASE  USER      ADDRESS         METHOD
local   all       postgres                  peer        # 本机 postgres 系统用户免密
host    all       all       10.0.0.0/24     scram-sha-256
host    replication repl     10.0.0.0/24    scram-sha-256
```

改完配置重载并验证四项：版本、数据目录、监听、编码。

```bash
sudo systemctl reload postgresql
sudo -u postgres psql -c "SELECT version();"
sudo -u postgres psql -c "SHOW data_directory; SHOW listen_addresses; SHOW server_encoding;"
```

预期输出（节选，示例）：

```text
PostgreSQL 18.1 (Ubuntu 18.1-1.pgdg24.04+1) on x86_64-pc-linux-gnu, compiled by gcc ...
        data_directory
---------------------------------
 /var/lib/postgresql/18/main
 listen_addresses
------------------
 *
 server_encoding
-----------------
 UTF8
```

建应用角色与库，注意 PG 15 起 `public` schema 不再默认给所有人 `CREATE` 权限：

```sql
CREATE ROLE shop_app LOGIN PASSWORD 'App@123456';
CREATE DATABASE shop OWNER shop_app ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0;
\c shop
-- 库归 shop_app 所有，public schema 的属主随之变为 shop_app，无需额外授权
REVOKE ALL ON SCHEMA public FROM PUBLIC;   -- 收掉默认的 USAGE，只留属主与应用角色
GRANT USAGE ON SCHEMA public TO shop_app;
```

最小闭环：建表、写入、读回、看执行计划。

```bash
psql "postgresql://shop_app:App%40123456@10.0.0.11:5432/shop" -c "\conninfo"
```

```sql
CREATE TABLE smoke_test (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note text NOT NULL);
INSERT INTO smoke_test (note) VALUES ('hello pg') RETURNING id, note;
SELECT count(*) FROM smoke_test;
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM smoke_test WHERE id = 1;
```

```text
 id |   note
----+----------
  1 | hello pg
 count
-------
     1
 Index Scan using smoke_test_pkey on smoke_test  (cost=0.15..8.17 rows=1 width=13) (actual time=0.012..0.013 rows=1 loops=1)
   Index Cond: (id = 1)
   Buffers: shared hit=2
 Planning Time: 0.058 ms
 Execution Time: 0.021 ms
```

> 边界：应用禁止用 `postgres` 超级用户连接，超级用户会绕过行级安全与部分权限检查。`listen_addresses='*'` 只在有安全组或防火墙的前提下成立。`LC_COLLATE` 建库后不可改，需要变更排序规则只能新建库再迁移。

## 三、类型系统与 JSONB

PG 的类型比 MySQL 严格：没有隐式字符串到数字的转换，长度与精度按语义选，不按习惯填；类型选对能省掉大量应用层校验。

| 类别 | 推荐类型 | 理由与边界 |
|---|---|---|
| 主键 | `bigint GENERATED ALWAYS AS IDENTITY` | 标准 SQL，避免 `serial` 的序列归属混乱 |
| 金额 | `numeric(12,2)` | 精确十进制，不用 `float8` |
| 字符串 | `text` | 与 `varchar(n)` 性能相同，长度约束用 `CHECK` |
| 时间 | `timestamptz` | 存 UTC 时刻，显示按会话时区 |
| 布尔 | `boolean` | 不接受 0/1 隐式转换 |
| 唯一标识 | `uuid` + `gen_random_uuid()` | 18 可用时间有序的 `uuidv7()` |
| 枚举 | `text` + `CHECK` 或独立字典表 | 原生 `enum` 加值要改类型，跨表复用差 |
| 数组 | `text[]`、`bigint[]` | 适合小集合，检索用 GIN |
| 半结构化 | `jsonb` | 可索引、可更新字段，写入即解析 |

金额与时间两个坑先钉死：

```sql
SELECT 0.1::float8 + 0.2::float8 = 0.3::float8;   -- f，二进制浮点误差
SELECT 0.1::numeric + 0.2::numeric = 0.3::numeric; -- t
SELECT '2026-11-13 10:00:00'::timestamp AT TIME ZONE 'Asia/Shanghai';  -- 转成带时区时刻
```

`json` 与 `jsonb` 只差一个字母，行为完全不同：

| 对比项 | `json` | `jsonb` |
|---|---|---|
| 存储 | 原始文本 | 解析后的二进制 |
| 写入成本 | 低（不校验结构） | 高（解析、去重键） |
| 查询与索引 | 每次解析，不能建 GIN | 支持 GIN 与路径查询 |
| 键顺序 | 保留 | 不保留，重复键保留最后一个 |

业务字段一律用 `jsonb`。这一节的例子统一用下面的表：

```sql
CREATE TABLE events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   bigint      NOT NULL,
  event_type  text        NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- 生成列：把 JSONB 里的渠道固化成独立列，可建普通 B-tree 与约束
  channel     text        GENERATED ALWAYS AS (payload->>'channel') STORED,
  CONSTRAINT payload_is_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX idx_events_payload ON events USING gin (payload jsonb_path_ops);
CREATE INDEX idx_events_channel_time ON events (channel, occurred_at DESC);
```

核心操作符只有几个，记住就够用：

```sql
SELECT payload->'channel'        AS ch_json,     -- 取子元素，返回 jsonb
       payload->>'channel'      AS ch_text,      -- 取文本，返回 text
       payload#>'{user,id}'      AS uid_json,
       payload#>>'{user,id}'     AS uid_text
FROM events LIMIT 1;

SELECT count(*) FROM events WHERE payload @> '{"campaign":"双11"}';        -- 包含，可走 GIN
SELECT count(*) FROM events WHERE payload ? 'coupon';                      -- 顶层键是否存在
SELECT count(*) FROM events WHERE payload @? '$.items[*] ? (@.qty > 3)';   -- SQL/JSON 路径
```

`jsonb_path_ops` 比默认的 `jsonb_ops` 索引小一半左右、只支持 `@>`，代价是不能用于 `?`、`?|` 这类键存在判断。两种索引按查询形态二选一，不要都建。

> 边界：`jsonb` 更新任何键都会重写整个文档（超过 2 KB 还会进 TOAST），把高频变更的计数字段塞进 JSONB 会造成写放大。JSONB 不承担外键与多表一致性，需要事务约束的字段仍然建普通列。单文档不要超过几十 KB，超出的部分拆表。

## 四、查询：CTE、窗口、LATERAL 与 UPSERT

PG 的查询能力优势集中在"一条 SQL 表达复杂业务"，写报表与批处理时能少一次应用层循环，就少一次网络往返与一致性问题。

样例表沿用订单域：

```sql
CREATE TABLE customers (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  city text NOT NULL
);

CREATE TABLE orders (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers(id),
  status      text   NOT NULL CHECK (status IN ('paid','shipped','refunded')),
  amount      numeric(12,2) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_customer_time ON orders (customer_id, created_at DESC);
```

### 4.1 窗口函数与 FILTER

窗口函数在聚合的同时保留明细行，`FILTER` 让一条语句算多个口径，避免多次扫描同一张表。

```sql
SELECT customer_id,
       date_trunc('month', created_at)                     AS month,
       sum(amount)                                         AS total,
       count(*) FILTER (WHERE status = 'refunded')         AS refund_cnt,
       sum(amount) OVER (PARTITION BY customer_id)         AS customer_total,
       rank() OVER (PARTITION BY date_trunc('month', created_at)
                    ORDER BY sum(amount) DESC)             AS month_rank
FROM orders
WHERE created_at >= '2026-01-01'
GROUP BY customer_id, date_trunc('month', created_at);
```

窗口函数在 `GROUP BY` 之后执行，所以 `sum(amount) OVER (...)` 里可以直接写聚合结果。执行顺序是 `WHERE → GROUP BY → 聚合 → 窗口 → ORDER BY → LIMIT`，把过滤条件写进 `WHERE` 才能减少参与聚合的行。

### 4.2 CTE 与递归查询

`WITH` 让复杂查询分段可读；PG 12 起非递归 CTE 默认可以内联，不会被强制物化，性能与子查询相当。

```sql
WITH monthly AS (
  SELECT customer_id, date_trunc('month', created_at) AS month, sum(amount) AS total
  FROM orders
  WHERE created_at >= '2026-01-01'
  GROUP BY 1, 2
)
SELECT c.city, m.month, sum(m.total) AS gmv
FROM monthly m JOIN customers c ON c.id = m.customer_id
GROUP BY c.city, m.month
ORDER BY gmv DESC
LIMIT 10;
```

递归 CTE 处理树形结构（组织架构、类目、BOM），`UNION ALL` 加深度字段可防止环导致死循环：

```sql
WITH RECURSIVE tree AS (
  SELECT id, parent_id, name, 1 AS depth, ARRAY[id] AS path
  FROM categories WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id, c.parent_id, c.name, t.depth + 1, t.path || c.id
  FROM categories c JOIN tree t ON c.parent_id = t.id
  WHERE t.depth < 10 AND NOT c.id = ANY(t.path)   -- 环检测，防止脏数据无限递归
)
SELECT depth, repeat('  ', depth - 1) || name AS label FROM tree ORDER BY path;
```

### 4.3 LATERAL 与 DISTINCT ON

`LATERAL` 让右侧子查询引用左侧当前行，等价于"每行执行一次"的相关子查询，但计划器能选索引；`DISTINCT ON` 是 PG 特有的"每组取第一行"写法。

```sql
-- 每个客户最近 3 笔订单：一次查询完成，避免 N+1
SELECT c.id, c.name, o.id AS order_id, o.amount, o.created_at
FROM customers c
CROSS JOIN LATERAL (
  SELECT id, amount, created_at
  FROM orders
  WHERE customer_id = c.id
  ORDER BY created_at DESC
  LIMIT 3
) o
ORDER BY c.id, o.created_at DESC;
```

```sql
-- 每个客户最近一笔订单；DISTINCT ON 的括号与 ORDER BY 前缀必须一致
SELECT DISTINCT ON (customer_id) customer_id, id, amount, created_at
FROM orders
ORDER BY customer_id, created_at DESC;
```

`DISTINCT ON` 比 `row_number() = 1` 更短，代价是排序键必须与 `DISTINCT ON` 表达式前缀一致，否则报错。

### 4.4 UPSERT、RETURNING 与 MERGE

`INSERT ... ON CONFLICT` 是并发安全的幂等写入，不要用"先查再插"（两次往返之间存在竞态窗口）。

```sql
CREATE TABLE inventory (
  sku      text PRIMARY KEY,
  qty      integer NOT NULL CHECK (qty >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO inventory (sku, qty) VALUES ('SKU-1', 10)
ON CONFLICT (sku) DO UPDATE
  SET qty = inventory.qty + EXCLUDED.qty,   -- EXCLUDED 是本次想插入的行
      updated_at = now()
RETURNING sku, qty;
```

```text
 sku   | qty
-------+-----
 SKU-1 |  10
```

批量写入用 `unnest` 展开数组，一次往返写多行：

```sql
INSERT INTO inventory (sku, qty)
SELECT * FROM unnest(ARRAY['SKU-1','SKU-2'], ARRAY[5, 7])
ON CONFLICT (sku) DO UPDATE SET qty = inventory.qty + EXCLUDED.qty;
```

PG 15 起支持标准 `MERGE`，适合"来源表与目标表比对后插入/更新/删除"的同步场景：

```sql
MERGE INTO inventory AS t
USING (SELECT sku, qty FROM staging_inventory) AS s
ON t.sku = s.sku
WHEN MATCHED AND s.qty = 0 THEN DELETE
WHEN MATCHED THEN UPDATE SET qty = s.qty, updated_at = now()
WHEN NOT MATCHED THEN INSERT (sku, qty) VALUES (s.sku, s.qty);
```

`RETURNING` 让写入直接带回结果，省掉一次查询；它也能用在 `UPDATE`、`DELETE` 上：

```sql
UPDATE orders SET status = 'shipped'
WHERE id = 42 AND status = 'paid'
RETURNING id, status;
```

> 边界：`ON CONFLICT` 必须有唯一索引或排他约束作为冲突目标，靠应用层判重不算。`MERGE` 在并发下仍可能冲突，高并发计数用 `ON CONFLICT DO UPDATE` 的原子加法。`RETURNING` 返回的是语句影响的行，批量操作大时不要在应用里一次性收集百万行。

### 4.5 物化视图

报表类查询重复执行代价高时，物化视图把结果落盘，`REFRESH MATERIALIZED VIEW CONCURRENTLY` 可在不阻塞读的情况下刷新（需要唯一索引）。

```sql
CREATE MATERIALIZED VIEW mv_daily_gmv AS
SELECT date_trunc('day', created_at) AS day, sum(amount) AS gmv, count(*) AS order_cnt
FROM orders GROUP BY 1;

CREATE UNIQUE INDEX ON mv_daily_gmv (day);   -- CONCURRENTLY 刷新的前提
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_gmv;
```

> 边界：物化视图不自动刷新，需要调度器或触发器；`CONCURRENTLY` 刷新会全量重算再比对，大结果集耗时与普通刷新接近，只是不锁读。数据要"准实时"就用普通表加定时 `INSERT ... ON CONFLICT` 汇总，而不是物化视图。

## 五、索引体系

PG 的索引类型按数据结构分工，选错类型比不建索引更糟：写放大照付，查询用不上。

| 类型 | 结构 | 适用 | 注意 |
|---|---|---|---|
| B-tree | 平衡树 | 等值、范围、排序 | 默认类型，90% 场景 |
| Hash | 哈希表 | 仅等值 | 不支持范围与排序 |
| GIN | 倒排 | 数组、JSONB、全文 | 写入慢，更新代价高 |
| GiST | 通用搜索树 | 几何、范围、近邻 | 需操作符类支持 |
| BRIN | 块级摘要 | 物理有序的大表 | 只适合时间/自增列 |
| SP-GiST | 空间分区树 | 非平衡数据、前缀 | 场景窄 |

复合索引的列顺序按"等值列 → 排序列 → 范围列"排。B-tree 默认从最左列开始连续使用；PG 18 起的 skip scan 能跳过前导列，但只对"前导列选择率低"的查询生效，设计列序时仍按最左前缀规划：

```sql
-- 查询：WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC
CREATE INDEX idx_orders_tenant_status_time ON orders (tenant_id, status, created_at DESC);
```

部分索引把"只查一小部分行"的条件写进索引，体积和写入成本都降下来：

```sql
-- 只索引待发货订单，通常不到全表 1%
CREATE INDEX idx_orders_pending ON orders (created_at) WHERE status = 'paid';
```

表达式索引解决"函数包住列导致索引失效"：

```sql
CREATE INDEX idx_customers_lower_name ON customers (lower(name));
SELECT * FROM customers WHERE lower(name) = 'acme';   -- 能命中上面的索引
```

`INCLUDE` 把非过滤列放进叶子节点，做成覆盖索引（index-only scan），省掉回表：

```sql
CREATE INDEX idx_orders_cover ON orders (customer_id, created_at DESC) INCLUDE (amount, status);
```

建索引的锁级别决定上线方式：普通 `CREATE INDEX` 拿 `SHARE` 锁，阻塞所有写入；生产必须并发建：

```sql
CREATE INDEX CONCURRENTLY idx_orders_status ON orders (status);
-- 失败会留下 INVALID 索引，必须删掉重建，不能直接复用
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
```

读执行计划先看三件事：访问方法（Seq Scan / Index Scan / Bitmap）、估算行数与实际行数的偏差、Buffers 命中情况。

```sql
EXPLAIN (ANALYZE, BUFFERS, SETTINGS)
SELECT id, amount FROM orders
WHERE customer_id = 42 AND created_at >= '2026-11-01'
ORDER BY created_at DESC LIMIT 20;
```

```text
Limit  (cost=0.43..48.21 rows=20 width=24) (actual time=0.031..0.402 rows=20 loops=1)
  Buffers: shared hit=27
  ->  Index Scan using idx_orders_customer_time on orders
        (cost=0.43..9821.55 rows=4200 width=24) (actual time=0.029..0.381 rows=20 loops=1)
        Index Cond: ((customer_id = 42) AND (created_at >= '2026-11-01 00:00:00+08'::timestamp with time zone))
        Buffers: shared hit=27
Planning Time: 0.286 ms
Execution Time: 0.438 ms
```

六个高频失效场景，按出现频率排：

- 列上套函数或运算：`WHERE date(created_at) = '2026-11-13'`，改成范围比较；
- 列被转换或参数类型不对：`WHERE tenant_id::text = '42'` 直接让索引失效，驱动传参的类型要与列一致；
- `LIKE '%关键词'` 前缀通配，B-tree 用不上，改用 `pg_trgm` 的 GIN；
- 复合索引跳过最左列：`WHERE status = 'paid'` 用不上 `(tenant_id, status, ...)`；
- 统计信息过期：大批量导入后没 `ANALYZE`，计划器按旧分布选错路径；
- 表太小或选择率太高：返回 30% 以上行时全表扫描本就更快，索引不是越多越好。

> 边界：索引要跟着查询建，不跟着列建；单表索引超过 5 个要审视写入路径。Index-only scan 依赖 visibility map，表长期不 VACUUM 时会退化成普通索引扫描并回表。`CREATE INDEX CONCURRENTLY` 不能在事务块里执行，也不能与其他 DDL 并行跑。

## 六、MVCC、VACUUM 与锁

PG 的 MVCC 靠"保留旧元组"实现，读写互不阻塞；代价是死元组必须由 VACUUM 回收，长事务与长快照会把膨胀放大。

### 6.1 元组版本与可见性

每行有 `xmin`（创建事务）与 `xmax`（删除事务），查询按快照判断版本是否可见。默认隔离级别是 `READ COMMITTED`，每条语句取新快照；`REPEATABLE READ` 整个事务一个快照（快照隔离，标准里会出现的幻读在 PG 里不会出现）。

```sql
SHOW default_transaction_isolation;   -- read committed
```

两个会话验证快照差异，先准备账户表：

```sql
CREATE TABLE accounts (id bigint PRIMARY KEY, balance numeric(12,2) NOT NULL);
INSERT INTO accounts VALUES (1, 1000.00);
```

```sql
-- 会话 A
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT balance FROM accounts WHERE id = 1;    -- 1000.00
```

```sql
-- 会话 B
UPDATE accounts SET balance = 900 WHERE id = 1;
COMMIT;
```

```sql
-- 会话 A 再读：仍是 1000.00（快照隔离）
SELECT balance FROM accounts WHERE id = 1;
-- 写自己没见过的版本会失败，而不是静默覆盖
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
```

```text
ERROR:  could not serialize access due to concurrent update
```

同一段在 `READ COMMITTED` 下第二条 `SELECT` 会读到 900.00，`UPDATE` 会基于最新版本重算而不报错。选择依据：读多写少、要求事务内报表一致用 RR；高并发写入用 RC 并接受"语句间数据可变"。

`SERIALIZABLE` 在 RR 之上加 SSI（可串行化快照隔离）检测读写依赖环，冲突时报同样错误码 `40001`，应用必须整体重试事务。

### 6.2 VACUUM 与表膨胀

死元组占用的空间只被标记可复用，不还给操作系统；更新密集型表必须让 autovacuum 跑得比写入快。

```sql
-- 死元组最多的表，n_dead_tup 持续上涨就是膨胀信号
SELECT relname, n_live_tup, n_dead_tup,
       last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 5;
```

```text
      relname      | n_live_tup | n_dead_tup |        last_autovacuum
-------------------+------------+------------+-------------------------------
 orders            |    8421330 |    1820394 | 2026-11-13 03:12:44.512+08
 events            |   21044312 |     204118 | 2026-11-13 03:14:02.107+08
```

`orders` 的 `n_dead_tup` 是活元组的 21%，远超默认阈值，说明默认的 20% 触发比例对这个表太粗。按表覆盖参数，比全局调小更安全：

```sql
ALTER TABLE orders SET (
  autovacuum_vacuum_scale_factor = 0.02,   -- 2% 死元组就触发，适合高频更新表
  autovacuum_vacuum_threshold    = 1000,
  autovacuum_analyze_scale_factor = 0.01
);
```

判断真实膨胀要看文件大小与有效行数的差距，而不是只看 `n_dead_tup`：

```sql
SELECT relname,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
       pg_size_pretty(pg_indexes_size(relid))        AS index_size,
       pg_size_pretty(pg_relation_size(relid))       AS heap_size
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC LIMIT 5;
```

回收方式分三档，按影响面选：

```sql
VACUUM (VERBOSE, ANALYZE) orders;        -- 在线，不锁读写，空间留给本表复用
VACUUM FULL orders;                      -- 重写整表并还给 OS，持 ACCESS EXCLUSIVE 锁，禁止在线做
-- 生产大表用扩展做在线整理（需安装 pg_repack）
-- pg_repack --table=orders --no-superuser-check
```

事务 ID 回卷是 PG 唯一的"整库停写"风险：`age(datfrozenxid)` 逼近 20 亿时强制进入只读。监控这一条比监控膨胀更优先：

```sql
SELECT datname, age(datfrozenxid) AS xid_age
FROM pg_database ORDER BY xid_age DESC;
```

```text
 datname |  xid_age
---------+-----------
 shop    | 148320911
 postgres|  48321002
```

超过 15 亿要立即安排 `VACUUM FREEZE` 与排查 autovacuum 是否被长事务挡住。长事务（`idle in transaction`）是最常见原因：

```sql
SELECT pid, state, now() - state_change AS idle_for, left(query, 60) AS last_query
FROM pg_stat_activity
WHERE state LIKE 'idle in transaction%'
ORDER BY idle_for DESC;
```

### 6.3 锁与队列

PG 的行锁不阻塞普通读，只有写同一行才互斥；表级锁有 8 种模式，DDL 与 `VACUUM FULL` 会拿最重的 `ACCESS EXCLUSIVE`。

| 语句 | 表锁 | 阻塞对象 |
|---|---|---|
| `SELECT` | ACCESS SHARE | 仅 ACCESS EXCLUSIVE |
| `INSERT/UPDATE/DELETE` | ROW EXCLUSIVE | DDL、VACUUM FULL |
| `CREATE INDEX` | SHARE | 所有写 |
| `CREATE INDEX CONCURRENTLY` | SHARE UPDATE EXCLUSIVE | 仅 DDL |
| `ALTER TABLE` | ACCESS EXCLUSIVE | 读写全部 |

任务队列用 `FOR UPDATE SKIP LOCKED` 实现无阻塞抢占，这是 PG 上最标准的做法：

```sql
CREATE TABLE jobs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status      text NOT NULL DEFAULT 'pending',
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz
);

WITH claimed AS (
  SELECT id FROM jobs
  WHERE status = 'pending'
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED       -- 跳过别人已锁住的行，消费者之间不排队
  LIMIT 10
)
UPDATE jobs j
SET status = 'running', started_at = now()
FROM claimed c
WHERE j.id = c.id
RETURNING j.id, j.payload;
```

锁等待现场第一条查询是 `pg_blocking_pids`，能直接指出谁挡住了谁：

```sql
SELECT pid, usename, state, wait_event_type, wait_event,
       now() - xact_start AS xact_age,
       pg_blocking_pids(pid) AS blockers,
       left(query, 80) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND pid <> pg_backend_pid()
ORDER BY xact_start NULLS LAST;
```

```text
  pid  | usename  |        state        | wait_event_type | wait_event | xact_age  | blockers
-------+----------+---------------------+-----------------+------------+-----------+----------
 18342 | shop_app | active              | Lock            | relation   | 00:02:31  | {18290}
 18290 | shop_app | idle in transaction | Client          | ClientRead | 00:04:12  | {}
```

`blockers` 为空但状态是 `idle in transaction` 的那一行就是源头：一个没提交的事务持着表锁，后续 DDL 全部排队。处理是 `SELECT pg_terminate_backend(18290);`，而不是重启实例。

> 边界：`pg_terminate_backend` 会回滚该连接的事务，大事务回滚可能比等它跑完更慢，先看 `xact_age` 与影响的表。咨询锁（`pg_advisory_lock`）用于跨会话互斥，键必须是业务能稳定生成的整数对；它不随事务自动释放，必须在 `finally` 里显式解锁。

## 七、扩展生态

扩展是 PG 与"通用关系库"最大的差别：向量检索、地理、模糊匹配、时序分区都能在库内完成，少一套外部系统就少一条一致性边界。

| 扩展 | 能力 | 典型用途 |
|---|---|---|
| `pg_stat_statements` | 语句级耗时统计 | 慢查询治理，必装 |
| `pg_trgm` | 三元组相似度 | 模糊搜索、`LIKE '%x%'` |
| `pgvector` | 向量类型与 ANN 索引 | 语义检索、RAG |
| `PostGIS` | 几何与地理类型 | 位置、围栏、路径 |
| `pg_partman` | 分区自动创建与清理 | 时间分区表运维 |
| `postgres_fdw` | 跨库外部表 | 分库查询、迁移比对 |

安装分两步：装软件包，再在库内 `CREATE EXTENSION`。`pg_stat_statements` 还要进预加载列表并重启：

```ini
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.max = 10000
pg_stat_statements.track = all
```

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
```

```sql
-- 总耗时最高的 5 条语句，按平均耗时排序看单次代价
SELECT round(total_exec_time::numeric, 1) AS total_ms,
       calls,
       round(mean_exec_time::numeric, 2) AS mean_ms,
       rows,
       left(query, 60) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC LIMIT 5;
```

`pg_trgm` 把 `LIKE '%关键词%'` 变成可索引查询，中文短词建议配合二元分词：

```sql
CREATE INDEX idx_customers_name_trgm ON customers USING gin (name gin_trgm_ops);
SELECT name, similarity(name, 'acme') AS sim
FROM customers WHERE name ILIKE '%acme%' ORDER BY sim DESC LIMIT 10;
```

`pgvector` 的用法是"向量列 + 距离操作符 + ANN 索引"，索引必须在数据灌入后建，否则构建期会反复更新：

```sql
CREATE TABLE docs (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  content   text NOT NULL,
  embedding vector(768) NOT NULL        -- 维度与嵌入模型一致，改维度要重建列与索引
);

CREATE INDEX idx_docs_embedding ON docs
  USING hnsw (embedding vector_cosine_ops)   -- HNSW 查询快、构建慢，适合在线检索
  WITH (m = 16, ef_construction = 64);

SELECT id, content, 1 - (embedding <=> '[...]') AS score
FROM docs ORDER BY embedding <=> '[...]' LIMIT 10;
```

> 边界：扩展的二进制与大版本绑定，`pg_upgrade` 前要确认每个扩展都有对应新版本；托管云只允许白名单内的扩展，选型前先查目标平台的支持列表。扩展不是越多越好，每装一个都进入升级与备份的检查项。`pgvector` 的 HNSW 索引常驻内存，容量规划要单独算。

## 八、备份、复制与现场排障

备份解决误删与介质故障，复制解决可用性，两者不能互相替代：从库会同步误删，备份不能自动接管流量。

### 8.1 逻辑备份与物理备份

逻辑备份按对象导出 SQL 或自定义格式，跨版本、跨平台可恢复；物理备份复制数据目录，恢复快但要求版本一致。

```bash
# 自定义格式：支持并行恢复与选择性恢复，比纯 SQL 小且快
pg_dump -Fc -d shop -f /backup/shop_20261113.dump

# 查看备份里有哪些对象，恢复前先确认
pg_restore -l /backup/shop_20261113.dump | head -20

# 恢复到新库，4 个并行任务；--no-owner 避免目标库角色不存在时报错
createdb -O shop_app shop_restore
pg_restore -d shop_restore -j 4 --no-owner /backup/shop_20261113.dump

# 全库逻辑备份（含角色与表空间定义），只有它会带 CREATE ROLE
pg_dumpall -f /backup/all_20261113.sql
```

物理备份用 `pg_basebackup`，`-X stream` 把所需 WAL 一起打包，`-R` 自动写出备库配置：

```bash
sudo -u postgres pg_basebackup -h 10.0.0.11 -U repl \
  -D /backup/base_20261113 -Ft -z -X stream -P
```

```text
waiting for checkpoint
 85015/85015 kB (100%), 1/1 tablespace
```

### 8.2 WAL 归档与时间点恢复

PITR 的前提是"基础备份 + 从备份起点到目标时刻的完整 WAL 链"。先开归档：

```ini
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /archive/%f && cp %p /archive/%f'   # 目标已存在则跳过，避免重放冲突
archive_timeout = 60                                              # 低写入时也保证 WAL 定期切段
```

`archive_command` 的退出码非 0 会让 WAL 在 `pg_wal` 里堆积，直到磁盘满；监控归档延迟是必做项：

```sql
SELECT archived_count, failed_count, last_archived_wal, last_failed_wal
FROM pg_stat_archiver;
```

恢复在空数据目录上做，`recovery.signal` 是 12 之后的开关（旧的 `recovery.conf` 已废弃）：

```ini
restore_command = 'cp /archive/%f %p'
recovery_target_time = '2026-11-13 10:20:00+08'
recovery_target_action = 'promote'    -- 到达目标点后自动转为主库
```

```bash
sudo -u postgres touch /var/lib/postgresql/18/main/recovery.signal
sudo pg_ctlcluster 18 main start
sudo -u postgres psql -c "SELECT pg_is_in_recovery();"   -- 短暂为 t，随后变 f
```

日志里出现 `recovery stopping before commit of transaction ...` 表示按时间点停住了，此时数据就是误操作之前的状态。

### 8.3 流复制

流复制由 walsender 推 WAL、walreceiver 落盘重放，备库可读不可写。主库配置与复制角色：

```ini
wal_level = replica
max_wal_senders = 10
max_replication_slots = 10
wal_keep_size = 1GB
synchronous_standby_names = 'ANY 1 (*)'   # 至少一个备库确认才提交
synchronous_commit = on
```

```sql
CREATE ROLE repl WITH REPLICATION LOGIN PASSWORD 'Repl@123456';
SELECT pg_create_physical_replication_slot('standby_1');   -- 槽保证主库不清理备库还没收到的 WAL
```

备库用 `pg_basebackup -R` 一次成型，启动后自动进入恢复模式。`pg_basebackup` 要求目标目录为空，因此先把旧目录挪开留作回退：

```bash
sudo systemctl stop postgresql
sudo mv /var/lib/postgresql/18/main /var/lib/postgresql/18/main.bak   # 保留原目录，回退时可直接换回
sudo -u postgres mkdir -p /var/lib/postgresql/18/main
sudo -u postgres pg_basebackup -h 10.0.0.11 -U repl \
  -D /var/lib/postgresql/18/main -Fp -Xs -P -R -S standby_1
sudo systemctl start postgresql
```

```sql
-- 主库视角
SELECT client_addr, state, sent_lsn, replay_lsn,
       pg_wal_lsn_diff(sent_lsn, replay_lsn) AS lag_bytes,
       sync_state
FROM pg_stat_replication;
```

```text
 client_addr |   state   |  sent_lsn  | replay_lsn | lag_bytes | sync_state
-------------+-----------+------------+------------+-----------+------------
 10.0.0.12   | streaming | 0/9A21C540 | 0/9A21C400 |       320 | sync
```

`sync_state = sync` 表示半同步生效；`lag_bytes` 持续增长通常是备库重放慢（大事务、`max_worker_processes` 不足）或网络带宽不够。

### 8.4 逻辑复制与版本升级

逻辑复制按表发布变更，主备可以不同大版本、不同 schema，是"停机窗口只有秒级"的升级手段：

```sql
-- 源库
CREATE PUBLICATION shop_pub FOR TABLE customers, orders;
-- 目标库（先建好同名表结构）
CREATE SUBSCRIPTION shop_sub
  CONNECTION 'host=10.0.0.11 port=5432 dbname=shop user=repl password=Repl@123456'
  PUBLICATION shop_pub WITH (copy_data = true);
```

切换顺序固定：确认订阅追平（`pg_stat_subscription` 无延迟）→ 停写源库 → 校验行数 → 应用改连接串 → 删除订阅。序列值不会自动同步，切换前必须手工 `setval`。

```sql
SELECT subname, received_lsn, latest_end_lsn, last_msg_send_time FROM pg_stat_subscription;
```

### 8.5 现场排障

排障顺序永远是"先看谁在等、再看谁在扫"，参数调整放最后。

| 现象 | 第一条命令 | 定位方向 |
|---|---|---|
| 连接被拒 | `SELECT count(*), state FROM pg_stat_activity GROUP BY 2;` | 连接泄漏或池上限 |
| CPU 打满 | `SELECT * FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 5;` | 高频小查询或全表扫描 |
| 查询突然变慢 | `EXPLAIN (ANALYZE, BUFFERS) <SQL>;` | 统计信息过期、计划翻转 |
| 写入卡住 | `SELECT pid, pg_blocking_pids(pid) FROM pg_stat_activity;` | 锁等待、长事务 |
| 磁盘只涨不降 | `SELECT relname, n_dead_tup FROM pg_stat_user_tables ORDER BY 2 DESC;` | 膨胀、WAL 堆积 |
| 备库延迟 | `SELECT * FROM pg_stat_replication;` | 大事务、网络、重放瓶颈 |
| 归档失败 | `SELECT * FROM pg_stat_archiver;` | 归档目录权限、空间 |

连接数打满时先看是谁占着不还，而不是直接调大 `max_connections`：

```sql
SELECT usename, application_name, state, count(*)
FROM pg_stat_activity
GROUP BY 1, 2, 3 ORDER BY 4 DESC;
```

> 边界：`pg_terminate_backend` 与 `pg_cancel_backend` 的区别是前者断连接回滚事务、后者只取消当前语句。`max_connections` 每加一个都占共享内存与进程槽，超过 500 必须上连接池。排障时不要用 `SELECT *` 看 `pg_stat_activity`，宽字段会让查询本身变慢。

## 九、最佳实践案例

### 9.1 案例背景

一个营销事件平台，2023 年上线时用 MySQL 8.0 单实例存事件流：一张 `events` 表 2100 万行、磁盘 480 GB，半结构化属性塞在 `TEXT` 列里存 JSON 字符串。三个问题在 2026 年同时爆发：运营要按活动、渠道、商品组合筛选，只能 `LIKE '%...%'` 全表扫，P95 从 1.2 秒涨到 26 秒；月度报表要跨事件表与订单表做多维聚合，MySQL 上要跑 40 分钟且拖慢主库；多租户查询靠应用层拼 `tenant_id` 条件，一次漏拼就串数据。

目标：查询 P95 降到 1 秒内，报表从 40 分钟降到 5 分钟内，租户隔离由数据库兜底，迁移停机窗口不超过 30 分钟。约束：不改应用侧的领域模型（事件仍是"固定列 + 动态属性"），源库继续可回滚，全程社区版。

选型结论是 PostgreSQL 17：JSONB 加 GIN 解决动态属性检索，声明式分区解决大表清理，窗口函数与 `FILTER` 一条 SQL 出报表，行级安全（RLS）兜住租户隔离。MySQL 侧没有等价能力组合，改造量反而更大。

### 9.2 案例实操

第一步，目标库按新模型建表。分区表的主键必须包含分区键，这是最容易卡住的一步：

```sql
CREATE TABLE events (
  tenant_id   bigint      NOT NULL,
  id          bigint      GENERATED BY DEFAULT AS IDENTITY,  -- BY DEFAULT 才允许迁移时写入源库 id
  event_type  text        NOT NULL,
  occurred_at timestamptz NOT NULL,
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (occurred_at, id)                          -- 分区键 occurred_at 必须在主键里
) PARTITION BY RANGE (occurred_at);

CREATE TABLE events_2026_10 PARTITION OF events
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE events_2026_11 PARTITION OF events
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE events_default  PARTITION OF events DEFAULT;  -- 兜底，避免插入落空报错
```

第二步，建两类索引。分区表在父表上建索引会自动下发到每个分区：

```sql
-- 租户 + 时间：覆盖 90% 的列表查询，等值列在前、范围列在后
CREATE INDEX idx_events_tenant_time ON events (tenant_id, occurred_at DESC);
-- JSONB 包含查询：jsonb_path_ops 体积约为默认 ops 的一半
CREATE INDEX idx_events_payload ON events USING gin (payload jsonb_path_ops);
```

第三步，用 pgloader 迁移 MySQL 数据。目标表已经按新模型建好，所以加载只灌数据、不建表（`data only`），否则 pgloader 会按源库类型重建出一张普通表，把分区和 JSONB 全部覆盖掉：

```bash
createdb -h 10.0.0.31 -U shop_app marketing   # pgloader 不负责建库
```

```lisp
LOAD DATABASE FROM mysql://etl:Etl%40123@10.0.0.21:3306/marketing
             INTO postgresql://shop_app:App%40123456@10.0.0.31:5432/marketing
WITH data only, truncate,
     workers = 8, concurrency = 4,
     batch rows = 25000
CAST type datetime to timestamptz drop default drop not null using zero-dates-to-null,
     type tinyint when (= 1 precision) to boolean drop typemod using tinyint-to-boolean,
     column events.payload to jsonb
```

三条转换缺一不可：`zero-dates-to-null` 处理 MySQL 的零日期（`0000-00-00` 在 PG 里非法）；`tinyint(1)` 默认被映射成 smallint，显式转 boolean；`payload` 在源库是 TEXT 存 JSON 字符串，显式 `to jsonb` 让 pgloader 在装载时解析，否则写进 jsonb 列会直接类型报错。

```bash
pgloader /tmp/marketing.load
```

预期输出（节选，示例）：

```text
             table name     errors       rows      bytes      total time
-----------------------  ---------  ---------  ---------  --------------
                  fetch          0          0                     0.000s
        fetch meta data          0         38                     0.402s
                 Create Schemas        0         0                     0.061s
                  create tables          0         2                     0.184s
                  copy events          0  21044312     38.2 GB      21m04.771s
--------------------  ---------  ---------  ---------  --------------
              Total       0      21044312                  21m11.208s
```

加载只灌数据，索引边写边维护，比"先卸索引再重建"慢，但省掉一次全表重建，整体仍然更短。显式写入的 `id` 不会推进序列，必须手工校准，否则下一条新写入直接主键冲突：

```sql
SELECT setval(pg_get_serial_sequence('events', 'id'), (SELECT max(id) FROM events));
```

第四步，迁移后必须校验，不看 pgloader 的报错数就上线是事故来源。行数与金额汇总两边对比：

```sql
-- 目标库
SELECT count(*) AS rows, sum((payload->>'amount')::numeric) AS amount_sum,
       min(occurred_at) AS min_ts, max(occurred_at) AS max_ts
FROM events WHERE occurred_at >= '2026-10-01';
```

```text
   rows   | amount_sum  |       min_ts        |       max_ts
----------+-------------+---------------------+---------------------
 18420933 | 94821300.55 | 2026-10-01 00:00:12 | 2026-11-13 09:58:31
```

源库用同口径 `SELECT COUNT(*), SUM(JSON_EXTRACT(payload,'$.amount'))` 对比，四个值全部一致才进入下一步。接着执行 `ANALYZE`，否则计划器按默认选择率估算，GIN 索引可能不被选中：

```sql
ANALYZE events;
```

第五步，开启行级安全，把租户隔离从"应用记得拼条件"变成"数据库强制"：

```sql
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON events
  USING (tenant_id = current_setting('app.tenant_id')::bigint);
-- 表属主默认绕过 RLS，必须强制，否则应用用属主连接等于没开
ALTER TABLE events FORCE ROW LEVEL SECURITY;

-- 应用在事务内设置租户，事务结束即失效，避免连接复用串租户
BEGIN;
SET LOCAL app.tenant_id = '42';
SELECT count(*) FROM events WHERE occurred_at >= '2026-11-01';
COMMIT;
```

验证隔离：用租户 42 连接查不到租户 43 的数据，`EXPLAIN` 里会看到策略条件被下推进扫描：

```sql
EXPLAIN (ANALYZE, COSTS OFF)
SELECT count(*) FROM events WHERE occurred_at >= '2026-11-01';
```

```text
 Aggregate (actual time=18.402..18.403 rows=1 loops=1)
   ->  Index Only Scan using events_2026_11_tenant_time_idx on events_2026_11 events
         Index Cond: (occurred_at >= '2026-11-01 00:00:00+08'::timestamp with time zone)
         Filter: (tenant_id = (current_setting('app.tenant_id'::text))::bigint)
         Heap Fetches: 0
```

第六步，改写三条核心查询。列表页走"租户 + 时间"复合索引，属性筛选走 GIN，两者组合时计划器自动选 BitmapAnd：

```sql
SELECT id, event_type, occurred_at, payload->>'channel' AS channel
FROM events
WHERE tenant_id = 42
  AND occurred_at >= '2026-11-01'
  AND payload @> '{"campaign":"双11","channel":"app"}'
ORDER BY occurred_at DESC
LIMIT 50;
```

日报用窗口函数与 `FILTER` 一次算完，替代原来应用层三次查询：

```sql
SELECT date_trunc('day', occurred_at) AS day,
       count(*)                                        AS events,
       count(DISTINCT payload->>'user_id')             AS uv,
       count(*) FILTER (WHERE event_type = 'pay')      AS pay_cnt,
       sum((payload->>'amount')::numeric)
         FILTER (WHERE event_type = 'pay')             AS gmv,
       round(100.0 * count(*) FILTER (WHERE event_type = 'pay')
             / nullif(count(*) FILTER (WHERE event_type = 'view'), 0), 2) AS cvr
FROM events
WHERE tenant_id = 42 AND occurred_at >= '2026-11-01' AND occurred_at < '2026-11-14'
GROUP BY 1 ORDER BY 1;
```

```text
          day           | events |  uv   | pay_cnt |    gmv    |  cvr
------------------------+--------+-------+---------+-----------+-------
 2026-11-11 00:00:00+08 | 842133 | 92104 |   18422 | 1284930.50 |  3.12
 2026-11-12 00:00:00+08 | 611204 | 71033 |   11208 |  784211.00 |  2.84
```

月度分区清理替代 `DELETE`：`DROP TABLE` 一个分区子表只是元数据操作，秒级完成且不产生死元组，这是迁移收益最大的一项：

```sql
DROP TABLE events_2025_11;   -- 保留 12 个月，过期分区直接摘掉
-- 生产用 pg_partman 自动建分区与清理：
-- SELECT partman.create_parent('public.events', 'occurred_at', 'native', 'monthly');
```

第七步，做切换演练。增量同步不走 PG 逻辑订阅（它只能订阅 PG），用 Debezium 把 MySQL binlog 解出来写进 PG 的同构表，停写窗口内的顺序固定：

```bash
# 1. 源库记录 binlog 起点（8.4 语法），Debezium 配置从该位点开始
mysql -h 10.0.0.21 -uroot -p -e "SHOW BINARY LOG STATUS;"
```

```text
File: binlog.004217  Position: 48219033  Binlog_Do_DB:  Binlog_Ignore_DB:
```

Debezium 以该位点启动，把变更按 `(occurred_at, id)` 写进 `events`，幂等靠 `ON CONFLICT (occurred_at, id) DO UPDATE`。追平后进入演练窗口：

```text
04:00:00  停 MySQL 写入（应用切只读）
04:00:12  Debezium 位点追平，回放延迟 0
04:00:31  两侧行数与金额汇总比对一致
04:02:10  应用切换连接串到 PG，恢复写入
04:04:40  抽样 1000 个租户各查 10 条事件，无差异
```

回滚路径同样演练：应用连接串切回 MySQL，Debezium 反向通道保留 24 小时，期间两边双写比对无差异后才下线。

### 9.3 案例结果

| 指标 | 迁移前（MySQL 8.0） | 迁移后（PG 17，示例） |
|---|---|---|
| 属性筛选 P95 | 26 s | 0.42 s |
| 日报生成 | 40 min | 3 min 20 s |
| 单表清理 | `DELETE` 6 小时 | `DROP TABLE` 子表 0.8 s |
| 租户隔离 | 应用拼条件 | RLS 强制 |
| 主库磁盘 | 480 GB | 210 GB（分区 + 压缩） |

失败模式与复盘，四条都真实发生过：

- pgloader 首轮用了默认的 `create tables, create indexes`，它按源库类型重建出普通表：`payload` 是 `text`、分区也没了，GIN 索引根本建不上。改成"目标库先建分区表与索引 + pgloader 只做 `data only`"后解决；代价是加载期间要维护索引，耗时从预估的 14 分钟变成 21 分钟。此后把"验证 `jsonb_typeof(payload)='object'`、`relkind='p'`、GIN 索引 `indisvalid`"写进检查单。
- 迁完前两小时 P95 反而升到 3 秒，`pg_stat_statements` 显示同一查询计划在 Seq Scan 与 Bitmap 之间摇摆。根因是没有 `ANALYZE`，`pg_class.reltuples` 仍是初始值。迁移脚本把 `ANALYZE` 加为最后一步，并在切换后强制再跑一次。
- 开启 RLS 后应用报"查不到数据"，因为连接用的是表属主，属主默认绕过策略。补 `FORCE ROW LEVEL SECURITY` 后恢复；这条现在属于上线前必查项。
- 分区表最初把主键建成 `(id)`，建表直接失败（分区键不在唯一约束里）。改成 `(occurred_at, id)` 后，应用侧按 `id` 单查仍然走各分区的本地索引，代价只是唯一性检查多一列。

复盘结论：PG 的收益来自"一个库内同时解决检索、分区、隔离、报表"，但每一项都要求迁移时显式落地；把 MySQL 的表结构原样搬过来，只会得到更慢的 MySQL。
