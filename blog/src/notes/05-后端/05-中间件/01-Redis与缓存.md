# Redis 与缓存

---

## 一、Redis 与缓存是什么

Redis 是一个以内存为存储介质、以键值对为唯一寻址方式的数据结构服务器。字符串、哈希、列表、集合、有序集合、流共用同一个键空间，每条命令原子执行，每个键可以单独设置过期时间。缓存是它最常见的角色，但不是唯一角色：计数、会话、排行榜、限流、分布式锁、轻量消息流都建立在同一套结构之上。

用 Redis 做缓存，必须先回答"失效之后回哪里"；用 Redis 做存储，必须先接受异步复制和持久化窗口带来的丢数可能。这两句话决定了后面所有配置与取舍。

### 1.1 核心概念

数据库能保证正确性，但扛不住每个请求都查一遍。典型压力有三类：商品详情被高频重复读取，数据库连接与 CPU 被打满；下单需要跨实例互斥，不能两个进程同时扣同一份库存；接口要按用户或 IP 限流，计数要快且能自动过期。Redis 用内存中的键空间承接这些访问，把随机读的延迟从毫秒级压到亚毫秒级。

它的执行模型是理解一切性能现象的前提：

- **命令串行执行**。Redis 用一个事件循环接收命令，逐条执行，因此单条命令天然原子，也不存在行锁与死锁。
- **单条慢命令阻塞全局**。`KEYS *`、大集合上的 `SINTER`、大 value 的 `DEL` 都会让后续所有请求排队。
- **I/O 多线程只分担读写**。Redis 6 起可以用多线程处理网络读写与协议解析，命令执行仍是单线程。
- **后台线程处理释放与落盘**。`UNLINK`、AOF fsync、RDB 子进程在后台完成，不占命令线程。

| 概念 | 本质 | 直接影响 |
|---|---|---|
| 键空间 | 一个全局哈希表，键为二进制安全字符串 | 所有读写都按 key 定位，不支持条件查询 |
| 数据结构 | 值可以是多种类型，各有专用命令 | 结构选错会导致大 key 或额外反序列化 |
| 过期时间 | 每个键独立的 TTL，挂在过期字典 | 到期不保证立刻释放内存 |
| 单线程执行 | 命令队列串行消费 | 吞吐高，但一条慢命令拖垮全部 |
| 持久化 | RDB 快照与 AOF 日志 | 决定重启后能恢复多少数据 |
| 复制 | 主节点异步推送写命令 | 决定故障切换会丢多少写入 |

### 1.2 与相邻技术的关系

Redis 经常被放进同一句话里与关系库、本地缓存、Memcached 比较，但它们的定位并不重叠。

关系库是事实来源，负责约束、事务和复杂查询；Redis 是旁路加速层，命中就返回，未命中就回源。把 Redis 当唯一存储，等于放弃外键、范围查询和回滚能力。本地缓存如 Caffeine 在进程内，省掉一次网络往返，但多实例之间无法共享，也无法统一失效。Memcached 只提供字符串类操作，没有持久化、没有复杂结构、没有原生集群，胜在协议简单。Kafka 这类日志系统负责可靠保留与重放，Redis 的 Stream 只能做轻量队列。Redis 8 内置了 JSON、Search、TimeSeries、Bloom 等模块，能力边界比早期版本宽，但它仍不是文档数据库或搜索引擎。

| 技术 | 定位 | 与 Redis 的边界 |
|---|---|---|
| MySQL / PostgreSQL | 事实来源，强约束与事务 | Redis 只做加速，数据要能回源重建 |
| Caffeine 等本地缓存 | 进程内一级缓存 | 无共享状态，适合秒级容忍的旧值 |
| Memcached | 纯内存字符串缓存 | 无持久化、无复杂结构、无自动故障转移 |
| Kafka | 高吞吐日志与重放 | Redis Stream 不承担大规模保留与分区 |
| Elasticsearch | 全文检索与分析 | Redis Search 规模与聚合能力有限 |

> **注意**：Redis 的事务 `MULTI/EXEC` 不具备回滚能力，某条命令运行时报错，其余命令照常生效。需要"要么全做要么全不做"的语义，应该留在关系库。

### 1.3 架构组成

```mermaid
flowchart TD
    APP["应用客户端<br/>连接池"] -->|"RESP 请求"| IO["连接与 I/O 线程<br/>读写与协议解析"]
    IO -->|"命令入队"| CMD["命令执行线程<br/>单线程串行"]
    CMD -->|"读写键值"| DICT["键空间字典<br/>dict 与 expires"]
    CMD -->|"追加写命令"| BUF["AOF 缓冲区"]
    DICT -->|"fork 子进程快照"| RDB["RDB 文件"]
    BUF -->|"fsync 落盘"| AOF["AOF 文件"]
    CMD -->|"异步传播"| REP["从节点副本"]
    classDef client fill:#e3f2fd,stroke:#1565c0;
    classDef engine fill:#e8f5e9,stroke:#2e7d32;
    classDef image fill:#fff3e0,stroke:#ef6c00;
    class APP client
    class IO,CMD,DICT engine
    class BUF,RDB,AOF,REP image
```

四个组成部分各自对应一组配置：

- **网络层**：监听端口、连接数上限、TCP keepalive、TLS。连接数打满时新请求直接失败，不会排队。
- **执行层**：命令表、键空间字典、过期字典、阻塞队列。`INFO commandstats` 能看到每类命令的调用次数与平均耗时。
- **持久化层**：RDB 子进程、AOF 缓冲区与重写子进程。三者同时工作时会争抢磁盘与内存。
- **复制层**：主从连接、复制积压缓冲区、偏移量。从节点全量同步时会触发主节点 fork。

---

## 二、安装与连接

> **版本现状（2026）**：Redis 8.x 是当前开源稳定线，采用 AGPLv3 许可，源码分发包内置 JSON、Search、TimeSeries、Bloom 等模块；命令执行模型仍是单线程。具体小版本以官方发布为准，容器镜像建议固定到 `8.x` 的具体标签，不要长期使用浮动标签。

### 2.1 容器方式部署

容器部署的关键不是启动命令，而是把配置文件和持久化目录挂出来。否则容器重建后配置回到默认、数据全部丢失。

```bash
# ========== 准备目录 ==========
# 配置、数据、日志分开存放，便于备份与权限控制
mkdir -p /srv/redis/conf /srv/redis/data /srv/redis/log

# ========== 写入最小可用配置 ==========
cat > /srv/redis/conf/redis.conf <<'EOF'
bind 0.0.0.0
protected-mode yes
port 6379
requirepass change-me-strong
appendonly yes
appendfsync everysec
maxmemory 4gb
maxmemory-policy allkeys-lru
dir /data
EOF

# ========== 启动容器 ==========
# 配置文件只读挂载，数据目录可写挂载；启动命令显式指定配置文件
docker run -d --name redis8 \
  -p 6379:6379 \
  -v /srv/redis/conf/redis.conf:/usr/local/etc/redis/redis.conf:ro \
  -v /srv/redis/data:/data \
  --restart unless-stopped \
  redis:8 redis-server /usr/local/etc/redis/redis.conf

# ========== 验证 ==========
# 带密码连接并发送 PING，预期返回 PONG
docker exec -it redis8 redis-cli -a 'change-me-strong' --no-auth-warning PING

# 确认 AOF 已开启、内存上限已生效
docker exec -it redis8 redis-cli -a 'change-me-strong' --no-auth-warning CONFIG GET appendonly maxmemory
```

> **安全警告**：`bind 0.0.0.0` 加弱密码，等于把内存数据库直接暴露在公网。生产环境应限制在私网网段或安全组内，密码用 32 位以上随机串，并优先启用 ACL 而不是共用 `requirepass`。

### 2.2 包管理器安装

Debian 与 Ubuntu 的仓库版本通常落后于官方，功能验证可以用发行版包，需要新特性时改用官方 APT 仓库。

```bash
# ========== 发行版仓库安装 ==========
sudo apt update
sudo apt install -y redis-server

# 查看实际版本，确认是否为预期大版本
redis-server --version

# 开机自启并立即启动
sudo systemctl enable --now redis-server

# ========== 服务管理 ==========
# 查看运行状态与监听端口
sudo systemctl status redis-server --no-pager
ss -lntp | grep 6379

# 修改配置后重载（部分参数支持热加载，其余需重启）
sudo systemctl restart redis-server

# ========== 本地验证 ==========
redis-cli PING
redis-cli INFO server | grep redis_version
```

配置文件位于 `/etc/redis/redis.conf`。`systemctl restart` 可能触发一次 RDB 保存，并在启动时重放 AOF，数据量大时启动时间明显变长，维护窗口要留足。

### 2.3 核心配置项

配置分三类：决定能否连上、决定内存怎么用、决定掉电后剩多少。改完用 `CONFIG REWRITE` 写回文件，否则重启即失效。

| 配置项 | 默认值 | 作用与建议 |
|---|---|---|
| `bind` | `127.0.0.1 -::1` | 监听地址；对外服务需显式放开私网地址 |
| `protected-mode` | `yes` | 未设密码且监听非回环时拒绝外部连接 |
| `requirepass` | 空 | 默认用户密码；生产必须设置 |
| `maxmemory` | `0` | 内存上限，`0` 表示不限制；容器内要低于容器限额 |
| `maxmemory-policy` | `noeviction` | 超限后的淘汰策略；纯缓存改 `allkeys-lru` |
| `appendonly` | `no` | 是否开启 AOF；缓存可只开 RDB，存储型必须开 |
| `appendfsync` | `everysec` | AOF 落盘频率，兼顾性能与丢失窗口 |
| `save` | `3600 1 300 100 60 10000` | RDB 触发条件，三个"时间-变更数"对 |
| `timeout` | `0` | 空闲连接超时秒数，`0` 表示不断开 |
| `databases` | `16` | 逻辑库数量；集群模式只有 0 号库 |

> **注意**：`maxmemory` 只统计数据集与部分开销，不含 fork 时的写时复制增量。容器内存限制为 4 GB 时，`maxmemory` 应留出 20%–30% 余量，否则 RDB fork 期间容易触发 OOM Kill。

### 2.4 连接与访问控制

Redis 6 起提供 ACL，可以按用户限制可访问的键模式与命令类别，比单一密码精细得多。

```bash
# ========== ACL 配置 ==========
# 创建只读用户，只能访问 app: 前缀的键
redis-cli ACL SETUSER app_ro on '>read-pass' '~app:*' +@read -@dangerous

# 创建读写用户，禁用 FLUSHALL、CONFIG 等管理命令
redis-cli ACL SETUSER app_rw on '>write-pass' '~app:*' +@read +@write -@dangerous

# 查看用户权限
redis-cli ACL LIST

# 确认当前连接身份
redis-cli --user app_rw --pass 'write-pass' ACL WHOAMI

# ========== 常用连接方式 ==========
# 交互式连接，-a 传密码，--no-auth-warning 抑制命令行密码告警
redis-cli -h 10.0.0.12 -p 6379 -a 'write-pass' --no-auth-warning

# URL 形式，适合写进环境变量
redis-cli -u redis://app_rw:write-pass@10.0.0.12:6379/0

# 只读副本需要先开启 READONLY，否则重定向到主节点
redis-cli -h 10.0.0.13 -p 6379 -a 'write-pass' --no-auth-warning READONLY
```

| 方式 | 适用场景 | 注意事项 |
|---|---|---|
| 直连单机 | 开发、单实例 | 无故障转移，主节点挂掉即不可用 |
| Sentinel 地址 | 主从高可用 | 客户端需支持哨兵协议，先问主节点地址 |
| Cluster 种子节点 | 分片集群 | 客户端需处理 `MOVED`、`ASK` 重定向 |
| TLS 连接 | 跨公网、合规环境 | 需配置证书，性能有少量损耗 |

---

## 三、数据结构与内存模型

### 3.1 基础数据结构

结构选择决定命令复杂度，也决定内存占用。同一个对象，用 String 存 JSON 与用 Hash 存字段，读取成本和更新成本完全不同。

| 结构 | 底层编码 | 典型用途 | 主要风险 |
|---|---|---|---|
| String | int / embstr / raw | 缓存对象、计数器、锁 | value 过大阻塞网络与删除 |
| Hash | listpack / hashtable | 对象字段、会话 | 字段过多时 `HGETALL` 很重 |
| List | quicklist | 简单队列、时间线 | 无确认机制，消费失败即丢 |
| Set | intset / listpack / hashtable | 去重、标签、交并差 | 大集合运算耗 CPU |
| ZSet | listpack / skiplist | 排行榜、延迟队列 | 分数设计不当导致范围查询失效 |
| Stream | rax + listpack | 带消费组的消息流 | 需处理 pending 与裁剪 |

String 最大 512 MB，但实际不应超过几十 KB。计数器用 `INCR`，它原子且不会读到中间值。Hash 在字段少时用 listpack 连续存储，字段名或值超过 `hash-max-listpack-value`（默认 64 字节）、或字段数超过 `hash-max-listpack-entries`（默认 128）后转成 hashtable，内存上升但单字段操作仍是 O(1)。List 由多个 listpack 节点串成 quicklist，两端操作 O(1)，中间 `LINDEX` 是 O(N)。Set 的整数集合在元素全为整数且数量不超过 `set-max-intset-entries` 时极省内存。ZSet 用跳表加字典，范围查询 O(log N)，这也是排行榜的默认选择。

> **注意**：`HGETALL`、`SMEMBERS`、`LRANGE 0 -1` 的返回量与集合大小成正比。集合可能增长到十万级时，改用 `HSCAN`、`SSCAN` 分批取，避免单次响应撑爆客户端缓冲区。

### 3.2 扩展结构与模块

| 结构 | 关键命令 | 能力边界 |
|---|---|---|
| Bitmap | `SETBIT`、`BITCOUNT`、`BITOP` | 按位存储，适合签到与布尔标记 |
| HyperLogLog | `PFADD`、`PFCOUNT`、`PFMERGE` | 基数估算，标准误差约 0.81%，取不回元素 |
| GEO | `GEOADD`、`GEOSEARCH` | 基于 ZSet 的地理范围查询 |
| Stream | `XADD`、`XREADGROUP`、`XACK` | 消费组与 pending，保留量受内存限制 |
| JSON（模块） | `JSON.SET`、`JSON.GET`、`JSON.ARRAPPEND` | 按路径读写文档，避免整体反序列化 |
| Search（模块） | `FT.CREATE`、`FT.SEARCH` | 倒排索引与聚合，规模远小于专用搜索引擎 |
| Bloom（模块） | `BF.RESERVE`、`BF.ADD`、`BF.EXISTS` | 只回答"可能存在/一定不存在" |

Bitmap 的偏移量就是用户 ID 时，一个千万用户的签到表只占约 1.2 MB。HyperLogLog 固定占 12 KB 左右，适合 UV 估算，但不适合需要精确去重或要列出成员的场景。Bloom 过滤器用于缓存穿透防护，误判率由 `BF.RESERVE` 的容量与错误率参数决定，删除元素需要改用计数型布隆过滤器。

### 3.3 键空间与过期模型

过期不是定时器，而是"惰性删除 + 定期抽样"两套机制的组合。读到一个已过期的键时立即删除并返回空；后台每秒若干次随机抽取带 TTL 的键，删除其中已过期的。因此内存释放滞后于逻辑过期是正常现象。

```bash
# ========== 过期相关命令 ==========
# 设置值并附带 300 秒过期时间
redis-cli SET product:42 '{"name":"keyboard"}' EX 300

# 查看剩余秒数：-1 表示无过期时间，-2 表示键不存在
redis-cli TTL product:42

# 毫秒级过期，适合短窗口限流
redis-cli SET rate:user:7 1 PX 60000

# 移除过期时间，键变为永久
redis-cli PERSIST product:42

# 查看键的绝对过期时间戳（毫秒）
redis-cli PEXPIRETIME product:42
```

| 返回值 | 含义 | 常见误判 |
|---|---|---|
| 正数 | 剩余秒数 | 正常 |
| `-1` | 键存在但没有过期时间 | 误当成"已过期" |
| `-2` | 键不存在 | 误当成"没有设置 TTL" |

> **注意**：从节点不会独立删除过期键，而是等待主节点传播 `DEL`。读副本时逻辑上过期的键会返回空，但内存要等主节点的删除命令到达才释放。因此副本的 `used_memory` 可能长期高于主节点。

### 3.4 内存编码与碎片

`used_memory` 是分配器统计的数据占用，`used_memory_rss` 是操作系统看到的常驻内存，两者比值就是碎片率。

```bash
# ========== 内存观测 ==========
# 查看总内存、峰值、碎片率、数据集占用
redis-cli INFO memory

# 查看单个键的实际占用（抽样估算，大键会慢）
redis-cli MEMORY USAGE product:42 SAMPLES 5

# 让 Redis 给出内存诊断建议
redis-cli MEMORY DOCTOR

# 主动整理碎片（会消耗 CPU，建议低峰执行）
redis-cli MEMORY PURGE
```

| 指标 | 含义 | 判断 |
|---|---|---|
| `used_memory` | 分配器统计的逻辑内存 | 与业务数据量对照 |
| `used_memory_rss` | 操作系统常驻内存 | 明显高于逻辑内存说明有碎片 |
| `mem_fragmentation_ratio` | RSS / 逻辑内存 | 1.0–1.5 正常，超过 1.5 需关注 |
| `mem_fragmentation_ratio` < 1 | 内存被换出或统计口径差异 | 检查是否发生 swap |

大量增删不同大小的键会造成碎片。开启 `activedefrag yes` 可以让 Redis 在后台整理，但会增加 CPU 与延迟；更稳妥的做法是低峰重启或做主从切换，让新节点从空内存开始加载。

---

## 四、常用命令与批量操作

### 4.1 键与字符串命令

```bash
# ========== 写入与读取 ==========
# 仅当键不存在时写入，常用于锁与去重
redis-cli SET lock:order:42 token-abc NX PX 30000

# 仅当键存在时更新，保留原有 TTL
redis-cli SET session:7 '{"uid":7}' XX KEEPTTL

# 读取并删除，原子地消费一次性令牌
redis-cli GETDEL token:once:7

# 批量读写，减少往返；MGET 不存在的键返回 nil 占位
redis-cli MSET cfg:a 1 cfg:b 2
redis-cli MGET cfg:a cfg:b cfg:c

# ========== 计数 ==========
# 原子自增，键不存在时按 0 处理
redis-cli INCR page:view:20261029

# 带步长与浮点计数
redis-cli INCRBY stock:42 -1
redis-cli INCRBYFLOAT price:42 0.5

# ========== 键管理 ==========
# 判断类型与底层编码，排查大 key 时先看编码
redis-cli TYPE product:42
redis-cli OBJECT ENCODING product:42

# 异步删除大键，避免 DEL 阻塞主线程
redis-cli UNLINK big:hash:2020

# 渐进式遍历，生产环境禁止使用 KEYS *
redis-cli SCAN 0 MATCH 'product:*' COUNT 200
```

`SCAN` 的游标从 0 开始，返回的新游标为 0 时遍历结束。它不保证同一元素只返回一次，但保证遍历期间一直存在的元素一定被返回。`COUNT` 是每次扫描的提示量，不是精确条数。

### 4.2 集合类命令

```bash
# ========== Hash ==========
# 一次写入多个字段
redis-cli HSET user:7 name alice login_count 1

# 只取指定字段，避免 HGETALL 拉全量
redis-cli HMGET user:7 name login_count

# 字段级自增
redis-cli HINCRBY user:7 login_count 1

# 分批遍历大 Hash
redis-cli HSCAN user:7 0 COUNT 100

# ========== List ==========
# 左进右出，模拟队列
redis-cli LPUSH queue:mail '{"to":"a@example.com"}'
redis-cli RPOP queue:mail

# 阻塞弹出，超时单位秒；0 表示永久阻塞
redis-cli BRPOP queue:mail 5

# 保留区间，用于固定长度时间线
redis-cli LTRIM feed:7 0 99

# ========== Set ==========
redis-cli SADD tag:42 keyboard wireless
redis-cli SINTER tag:42 tag:43
redis-cli SMISMEMBER tag:42 keyboard mouse

# ========== ZSet ==========
# 写入分数与成员，分数相同按成员字典序
redis-cli ZADD rank:20261029 980 user:7 870 user:8

# 按分数从高到低取前十，带分数返回
redis-cli ZREVRANGE rank:20261029 0 9 WITHSCORES

# 按分数区间统计，用于延迟队列取到期任务
redis-cli ZRANGEBYSCORE delay:queue 0 1761700000000 LIMIT 0 100
redis-cli ZREM delay:queue task:99
```

| 业务场景 | 首选结构 | 原因 |
|---|---|---|
| 对象缓存 | String（JSON） | 一次读写完整对象，反序列化在应用侧 |
| 对象字段独立更新 | Hash | 改一个字段不必重写整个 JSON |
| 去重与标签 | Set | 天然去重，交并差直接可用 |
| 排行榜 | ZSet | 按分数排序与范围查询都是 O(log N) |
| 延迟任务 | ZSet | 分数存到期时间戳，轮询取到期成员 |
| 消息流 | Stream | 有消费组、pending 与确认机制 |

### 4.3 Pipeline 与事务

一次 `GET` 的本机往返约 0.1 ms，跨机房可能 1 ms 以上。循环一千次就是一千次往返，瓶颈在网络上而不是 Redis。

```python
# ========== Pipeline：合并往返 ==========
# transaction=False 表示不包裹 MULTI/EXEC，只做批量发送
pipe = r.pipeline(transaction=False)
for pid in range(1, 1001):
    pipe.get(f"product:detail:{pid}")
values = pipe.execute()

# 每 200 条提交一批，控制客户端与服务端缓冲
for start in range(0, 10000, 200):
    pipe = r.pipeline(transaction=False)
    for pid in range(start, start + 200):
        pipe.hgetall(f"product:{pid}")
    pipe.execute()
```

Pipeline 不是原子操作，中间可以插入其他客户端的命令；它也不减少服务端的命令执行时间，只减少网络往返。集群模式下，一个 pipeline 里的键必须落在同一节点，否则客户端要自行分组。

```text
# ========== MULTI/EXEC：同一连接内排队执行 ==========
127.0.0.1:6379> MULTI
OK
127.0.0.1:6379(TX)> SET order:42 paid
QUEUED
127.0.0.1:6379(TX)> INCR order:count
QUEUED
127.0.0.1:6379(TX)> EXEC
1) OK
2) (integer) 1
```

> **注意**：`MULTI` 之后必须复用同一条连接。用多条独立的 `redis-cli` 命令执行，每条都是一次新连接，事务上下文不存在，`EXEC` 会报错。

```text
# ========== WATCH：乐观锁 ==========
127.0.0.1:6379> WATCH stock:42
OK
127.0.0.1:6379> GET stock:42
"10"
127.0.0.1:6379> MULTI
OK
127.0.0.1:6379(TX)> DECR stock:42
QUEUED
127.0.0.1:6379(TX)> EXEC
1) (integer) 9
```

| 机制 | 是否原子 | 能否回滚 | 适用 |
|---|---|---|---|
| Pipeline | 否 | 不涉及 | 批量读写、降低 RTT |
| `MULTI/EXEC` | 执行期间不插入 | 否 | 多条命令打包，无需读取判断 |
| `WATCH` + `MULTI` | 冲突时整体放弃 | 否 | 读后写的乐观并发控制 |
| Lua 脚本 | 执行期间不插入 | 否 | 读判断写一体的原子逻辑 |

> **注意**：`MULTI` 中某条命令在入队阶段就报语法错误，`EXEC` 会拒绝执行整个事务；如果是运行期错误，例如对字符串执行 `INCR`，其他命令仍然生效。两种失败的语义不同，不能笼统地说"Redis 事务会回滚"。

### 4.4 Lua 脚本与函数

Lua 在命令线程内执行，脚本运行期间不会插入其他命令，这是它唯一的原子性来源。脚本报错前的写入不会撤销。

```bash
# ========== 加载与执行 ==========
# 加载脚本，返回 SHA1，后续用 EVALSHA 复用，避免重复传输正文
redis-cli SCRIPT LOAD "return redis.call('GET', KEYS[1])"

# 按 SHA 执行
redis-cli EVALSHA <sha1> 1 product:42

# 直接执行脚本：1 表示有一个 key
redis-cli EVAL "return redis.call('INCR', KEYS[1])" 1 counter:demo

# 只读脚本，可在副本上执行
redis-cli EVAL_RO "return redis.call('GET', KEYS[1])" 1 product:42

# ========== 原子释放锁 ==========
# 比较 token 后再删除，避免删掉别人持有的锁
redis-cli EVAL "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end" 1 lock:order:42 token-abc
```

脚本编写有四条硬规则：所有键通过 `KEYS` 传入，保证集群同槽；不在脚本里做十万次循环；不依赖随机数与系统时间做业务判断；用 `EVALSHA` 并处理 `NOSCRIPT` 错误后回退到 `EVAL`。

### 4.5 Stream 的队列语义

List 做队列没有确认机制，消费者 `BRPOP` 之后崩溃，消息就丢了。Stream 用消费组、pending 列表和 `XACK` 补上这一层。

```bash
# ========== 建流与消费组 ==========
# * 表示消息 ID 由服务端生成；MKSTREAM 在流不存在时自动创建
redis-cli XADD orders '*' orderId A100 status paid

# 从 0 号位置开始投递，消费组名为 billing
redis-cli XGROUP CREATE orders billing 0 MKSTREAM

# ========== 消费与确认 ==========
# > 表示只读从未投递的新消息，BLOCK 5000 毫秒
redis-cli XREADGROUP GROUP billing consumer-1 COUNT 10 BLOCK 5000 STREAMS orders '>'

# 处理成功后确认，消息移出 pending
redis-cli XACK orders billing <message-id>

# 查看 pending 概要与明细
redis-cli XPENDING orders billing
redis-cli XPENDING orders billing - + 10

# 把空闲超过 60 秒的消息转给另一个消费者
redis-cli XAUTOCLAIM orders billing consumer-2 60000 0-0 COUNT 10

# 近似裁剪，控制流长度，避免无限增长
redis-cli XADD orders MAXLEN '~' 100000 '*' orderId A101 status paid
```

| 场景 | 命令 | 说明 |
|---|---|---|
| 投递新消息 | `XADD` | `*` 自动生成时间戳 ID |
| 创建消费组 | `XGROUP CREATE` | 指定起始 ID，`$` 表示只消费新消息 |
| 读取并挂起 | `XREADGROUP` | 读后进入 pending，未确认不会丢 |
| 确认处理完成 | `XACK` | 从 pending 移除 |
| 处理失败消息 | `XPENDING`、`XAUTOCLAIM` | 查看空闲时长并转移归属 |
| 控制长度 | `MAXLEN ~` | 近似裁剪，按整条宏节点删除 |

Stream 适合"轻量队列 + 可查 pending"，不适合替代 Kafka 做大规模保留与分区。消费者崩溃后，消息留在 pending 里不会自动重投，必须有巡检任务定期执行 `XAUTOCLAIM`，否则 pending 会一直增长。

---

## 五、持久化与高可用

### 5.1 RDB 快照

RDB 是把某一时刻的整个数据集写成二进制文件。`BGSAVE` 会 fork 一个子进程，子进程共享父进程内存页，写入时触发写时复制，因此内存占用可能短时接近翻倍。

```bash
# ========== 手动与自动快照 ==========
# 后台生成快照，立即返回
redis-cli BGSAVE

# 查看最后一次成功保存的时间戳与结果
redis-cli LASTSAVE
redis-cli INFO persistence | grep rdb_

# 前台保存，会阻塞所有请求，仅用于停机维护
redis-cli SAVE

# ========== 恢复 ==========
# 停止服务，把 dump.rdb 放到 dir 指定目录并确保权限可读，再启动
sudo systemctl stop redis-server
sudo cp /backup/dump.rdb /var/lib/redis/dump.rdb
sudo chown redis:redis /var/lib/redis/dump.rdb
sudo systemctl start redis-server
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `save` | `3600 1 300 100 60 10000` | 满足任一条件即触发，空字符串表示关闭自动快照 |
| `rdbcompression` | `yes` | 用 LZF 压缩字符串，省磁盘耗 CPU |
| `rdbchecksum` | `yes` | 文件尾部校验，损坏时拒绝加载 |
| `stop-writes-on-bgsave-error` | `yes` | 快照失败后拒绝写入，防止持续丢备份 |

> **运维红线**：关闭 `stop-writes-on-bgsave-error` 而不监控快照结果，会让"每天都在备份"变成假象。磁盘写满后快照连续失败，写入却照常进行，直到重启才发现备份是几天前的。

### 5.2 AOF 日志

AOF 记录每条写命令，重启时重放。Redis 7 起使用多文件 AOF，目录由 `appenddirname` 指定，清单文件记录基础文件与增量文件。

| 模式 | 行为 | 丢失窗口 | 代价 |
|---|---|---|---|
| `appendfsync always` | 每条写命令都 fsync | 理论不丢 | 吞吐下降明显 |
| `appendfsync everysec` | 每秒 fsync 一次 | 约 1 秒 | 平衡选项，生产默认 |
| `appendfsync no` | 交给操作系统刷盘 | 可达数十秒 | 性能最好，可靠性最差 |

```bash
# ========== AOF 状态与重写 ==========
# 查看 AOF 是否开启、当前大小、上次重写结果
redis-cli INFO persistence | grep aof_

# 手动触发重写，压缩冗余命令
redis-cli BGREWRITEAOF

# 运行时开启 AOF（会触发一次重写）
redis-cli CONFIG SET appendonly yes
redis-cli CONFIG REWRITE

# 检查 AOF 文件完整性，启动失败时先修文件
redis-check-aof --fix /var/lib/redis/appendonlydir/appendonly.aof.manifest
```

AOF 重写不是读旧文件，而是扫描当前数据集生成最小命令集。重写期间新写入同时追加到旧文件与重写缓冲区，完成后原子替换。`auto-aof-rewrite-percentage 100` 与 `auto-aof-rewrite-min-size 64mb` 控制自动重写时机。

### 5.3 主从复制

复制是异步的：主节点写完内存就返回成功，再把命令发给从节点。全量同步时主节点 fork 生成 RDB，传输期间的新写入放入复制积压缓冲区。

```bash
# ========== 建立复制 ==========
# 在从节点执行，指向主节点
redis-cli REPLICAOF 10.0.0.12 6379

# 查看复制状态：master_link_status 为 up 表示链路正常
redis-cli INFO replication

# ========== 写入确认 ==========
# 等待至少 1 个副本确认，超时 1000 毫秒；返回实际确认的副本数
redis-cli WAIT 1 1000
```

| 配置项 | 作用 | 建议 |
|---|---|---|
| `replicaof` | 指定主节点 | 写入配置文件，避免重启丢失 |
| `masterauth` | 连接主节点的密码 | 与 `requirepass` 配套 |
| `repl-backlog-size` | 复制积压缓冲区大小 | 按写入速率与断线时长估算，默认 1 MB 偏小 |
| `min-replicas-to-write` | 至少几个副本在线才允许写 | 可用性换一致性，按业务选择 |
| `replica-read-only` | 从节点是否只读 | 保持 `yes`，避免双写冲突 |

> **注意**：`WAIT` 只保证命令已到达指定数量的副本，不保证主节点故障后这些副本一定被提升，也不等于强一致。故障切换仍可能丢掉未被任何副本确认的写入。

### 5.4 Sentinel 与 Cluster

Sentinel 解决单主故障自动切换，不解决容量扩展；Cluster 解决分片，同时具备故障转移能力。两者不能混用。

```mermaid
flowchart LR
    C["客户端"] -->|"询问主节点地址"| S["Sentinel 集群<br/>奇数节点, quorum 判定"]
    S -->|"监控与投票"| M["主节点<br/>可写"]
    M -->|"异步复制"| R1["从节点 1"]
    M -->|"异步复制"| R2["从节点 2"]
    S -->|"故障时提升"| R1
    C -->|"读写"| M
    C -->|"只读查询"| R1
    classDef client fill:#e3f2fd,stroke:#1565c0;
    classDef engine fill:#e8f5e9,stroke:#2e7d32;
    classDef image fill:#fff3e0,stroke:#ef6c00;
    class C client
    class S,M,R1 engine
    class R2 image
```

Sentinel 的 `quorum` 是"判定客观下线所需票数"，不是"选出新主所需票数"。三节点 Sentinel、一主两从是常见最小生产形态。

```bash
# ========== Sentinel 配置要点 ==========
# sentinel monitor <主节点名> <地址> <端口> <quorum>
# sentinel down-after-milliseconds mymaster 5000
# sentinel failover-timeout mymaster 60000
# sentinel parallel-syncs mymaster 1

# 查看哨兵状态与已知主节点
redis-cli -p 26379 SENTINEL masters
redis-cli -p 26379 SENTINEL replicas mymaster

# 手动触发一次故障转移（演练用）
redis-cli -p 26379 SENTINEL failover mymaster
```

Cluster 把键空间切成 16384 个槽，每个主节点负责一段，从节点复制对应主节点。客户端收到 `MOVED` 后刷新路由表；迁移过程中收到 `ASK` 表示临时去目标节点取一次。

```bash
# ========== 集群创建与检查 ==========
# 三主三从，副本数 1；节点列表按 IP:端口 给出
redis-cli --cluster create \
  10.0.0.21:6379 10.0.0.22:6379 10.0.0.23:6379 \
  10.0.0.24:6379 10.0.0.25:6379 10.0.0.26:6379 \
  --cluster-replicas 1

# 查看集群健康状态与槽覆盖
redis-cli -c -p 6379 CLUSTER INFO
redis-cli -c -p 6379 CLUSTER NODES

# 计算某个键落在哪个槽
redis-cli CLUSTER KEYSLOT product:42

# 检查并修复槽分配
redis-cli --cluster check 10.0.0.21:6379
redis-cli --cluster fix 10.0.0.21:6379
```

| 形态 | 容量 | 故障转移 | 适用 |
|---|---|---|---|
| 单机 | 单机内存 | 无 | 开发、可丢缓存 |
| 主从 | 单机内存 | 手动 | 读扩展、备份 |
| Sentinel | 单机内存 | 自动 | 主从高可用，运维中等 |
| Cluster | 多节点内存之和 | 自动 | 大数据量、高吞吐，运维复杂 |

---

## 六、缓存模式与完整示例

### 6.1 Cache-Aside 读写路径

Cache-Aside 是应用自己管缓存：读时先查缓存，未命中回源并回填；写时先改数据库，再删除缓存。Redis 不参与事务，也不感知数据库提交。

```mermaid
flowchart TD
    A["收到读请求"] --> B{"GET 是否命中"}
    B -->|"命中"| C["反序列化并返回"]
    B -->|"未命中"| D["查询数据库"]
    D --> E{"记录是否存在"}
    E -->|"存在"| F["SET key value EX 随机 TTL"]
    E -->|"不存在"| G["SET key __NULL__ EX 60"]
    F --> C
    G --> C
    classDef client fill:#e3f2fd,stroke:#1565c0;
    classDef engine fill:#e8f5e9,stroke:#2e7d32;
    classDef image fill:#fff3e0,stroke:#ef6c00;
    class A client
    class B,D,E engine
    class C,F,G image
```

写路径有三个必须遵守的顺序约束：

- **先更新数据库，再删除缓存**。先删缓存会让并发读在数据库提交前把旧值重新填回。
- **删除而不是更新缓存**。更新缓存要处理两次写请求的覆盖顺序，删除把重建责任交给下一次读。
- **删除失败要能兜底**。重试、发消息补偿，或给缓存设置较短 TTL，不能假设删除一定成功。

仍存在一个低概率竞态：读请求未命中，从数据库读到旧值；写请求更新数据库并删除缓存；读请求随后把旧值写回。概率取决于回源耗时与写操作的交错，强一致要求高的场景用延迟双删、CDC 订阅 binlog 失效或版本号比较，不能只靠 TTL。

### 6.2 穿透、击穿与雪崩的治理

| 问题 | 触发条件 | 表现 | 治理手段 |
|---|---|---|---|
| 穿透 | 查询不存在的数据 | 缓存与数据库都没有，每次都回源 | 空值缓存、布隆过滤器、参数校验 |
| 击穿 | 单个热点键过期 | 大量请求同时重建同一个键 | 互斥重建、逻辑过期、热点不过期 |
| 雪崩 | 大批键同时过期或实例整体不可用 | 数据库瞬间被打满 | TTL 随机抖动、多级缓存、限流降级 |

> **运维红线**：缓存层整体不可用时，必须假定数据库会被全量流量击穿。上线前要准备限流阈值、降级开关和只读兜底，不能把"Redis 挂了自动回源"当成方案。

互斥重建的流程是：未命中后先抢锁，抢到的人查库回填，没抢到的人短暂等待后重试读缓存。锁的过期时间要大于重建耗时，释放时必须比较持有者令牌。

```bash
# ========== 布隆过滤器防穿透 ==========
# 预留 100 万容量，误判率 0.1%
redis-cli BF.RESERVE product:bloom 0.001 1000000

# 写入存在的商品 ID
redis-cli BF.ADD product:bloom 42

# 查询：0 表示一定不存在，1 表示可能存在
redis-cli BF.EXISTS product:bloom 42
```

### 6.3 热键与本地缓存

单个键每秒几十万次读，会先打满一个分片的带宽，而不是 CPU。处理顺序按成本从低到高：

1. 减小 value，只缓存页面真正需要的字段，不把整行数据序列化进去。
2. 进程内加一层 1–5 秒的本地缓存，挡住同一实例的重复读。
3. 增加只读副本，把读流量分散到多个节点，同时接受复制延迟。
4. 把键拆成多个副本 `hot:42:0` 到 `hot:42:9`，读时随机选一个，更新时全部删除，逻辑最复杂，最后才用。

本地缓存的代价是多实例看到不同旧值。商品描述、配置、榜单摘要可以容忍几秒不一致；库存、余额、券状态不能用。定位热键用 `redis-cli --hotkeys`，它依赖 `allkeys-lfu` 或 `volatile-lfu` 策略，`LRU` 策略下没有意义。

### 6.4 分布式锁与限流

锁的本质是"在 Redis 里占一个带过期时间的键"。`SET NX PX` 把判断与设置合成一条原子命令，避免先 `SETNX` 再 `EXPIRE` 之间的崩溃窗口。

```bash
# ========== 加锁 ==========
# 值为随机令牌，过期时间 30 秒；成功返回 OK，失败返回 nil
redis-cli SET lock:order:42 token-abc NX PX 30000

# ========== 续约 ==========
# 仅当令牌匹配时延长过期时间，防止续到别人的锁
redis-cli EVAL "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end" 1 lock:order:42 token-abc 30000

# ========== 释放 ==========
# 比较令牌后删除，返回 1 成功、0 表示已不属于自己
redis-cli EVAL "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end" 1 lock:order:42 token-abc
```

锁只能保证"同一时刻大概率只有一个执行者"。业务执行超过 TTL 时锁会自动释放，另一个进程进入；主从异步复制下主节点宕机，锁的写入可能尚未到达从节点；进程长时间 GC 会让持锁者实际已失控。关键写入要用 fencing token，每次加锁生成递增序号，下游只接受比已见序号更大的请求；或者把互斥下沉到数据库唯一约束与行锁。

限流用固定窗口计数最省事，但窗口边界会放过两倍流量：

```lua
-- KEYS[1]=rate:user:7  ARGV[1]=窗口毫秒  ARGV[2]=阈值
local n = redis.call("INCR", KEYS[1])
if n == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
if n > tonumber(ARGV[2]) then
  return 0
end
return 1
```

需要平滑时改用滑动窗口 ZSet：以毫秒时间戳为分数，先 `ZREMRANGEBYSCORE` 清掉窗口外的成员，再 `ZCARD` 判断，最后 `ZADD` 并设置过期。限流键必须带 TTL，否则每个用户 ID 都会留下一个永久键。

### 6.5 商品详情缓存完整示例

下面是一次从零搭建到验证的完整过程，命令可直接执行。

```bash
# ========== 1. 准备实例 ==========
# 映射到 6380，避免与本机 6379 冲突
docker run -d --name redis-demo -p 6380:6379 redis:8

# 确认容器已就绪，预期返回 PONG
docker exec redis-demo redis-cli PING
```

```text
# ========== 2. 进入交互式客户端并写入缓存 ==========
# 输出类似，TTL 数值随执行时刻递减
$ docker exec -it redis-demo redis-cli
127.0.0.1:6379> SET product:detail:42 '{"id":42,"name":"keyboard","price":199}' EX 300
OK
127.0.0.1:6379> SET product:stock:42 120 EX 30
OK
127.0.0.1:6379> SET product:detail:999999 '__NULL__' EX 60
OK

# ========== 3. 验证命中与过期 ==========
127.0.0.1:6379> GET product:detail:42
"{\"id\":42,\"name\":\"keyboard\",\"price\":199}"
127.0.0.1:6379> TTL product:detail:42
(integer) 298
127.0.0.1:6379> TTL product:detail:999999
(integer) 58
127.0.0.1:6379> INFO stats
# 输出中关注 keyspace_hits 与 keyspace_misses
```

```bash
# ========== 4. 从宿主机观察命中率 ==========
# 只取命中与未命中两行
docker exec redis-demo redis-cli INFO stats | grep keyspace
```

```text
# 输出类似（数值随访问变化）
keyspace_hits:1842
keyspace_misses:96
```

命中率 = hits / (hits + misses)。低于 90% 时先查三件事：是否有大量不存在的键、TTL 是否过短、实例是否刚重启导致缓存为空。

```bash
# ========== 5. 定位大键与慢命令 ==========
# 抽样扫描各类型最大的键
docker exec redis-demo redis-cli --bigkeys

# 查看最慢的 10 条命令
docker exec redis-demo redis-cli SLOWLOG GET 10

# 查看延迟事件与诊断建议
docker exec redis-demo redis-cli LATENCY DOCTOR

# ========== 6. 改造后的观测 ==========
# 内存、碎片、连接数一起看
docker exec redis-demo redis-cli INFO memory | grep -E 'used_memory_human|mem_fragmentation_ratio'
docker exec redis-demo redis-cli INFO clients | grep connected_clients
```

| 指标 | 改造前（示例值） | 改造后（示例值） | 说明 |
|---|---|---|---|
| 缓存命中率 | 60% | 95% | 空值缓存与 TTL 抖动减少回源 |
| 数据库 QPS | 5000 | 500 | 回源量下降一个数量级 |
| 接口 P99 | 800 ms | 120 ms | 大 value 拆分后网络传输减少 |
| 平均 value 大小 | 200 KB | 8 KB | 详情、库存、列表摘要分离 |

收益来自"减少回源"和"减小 value"，不是把 `maxmemory` 调大。改造顺序也应按这个优先级：先治穿透与热点，再拆大键，最后才考虑扩容。

---

## 七、选型与容量规划

### 7.1 缓存与存储的边界

| 需求 | 是否适合 Redis | 原因 |
|---|---|---|
| 高频随机读、可回源 | 适合 | 内存访问延迟低，失效后能重建 |
| 会话与令牌 | 适合 | 天然 TTL，读写简单 |
| 计数、排行榜、限流 | 适合 | 原子命令与有序结构 |
| 强事务、复杂查询 | 不适合 | 无回滚、无关联查询、无二级索引 |
| 长期可靠存储 | 谨慎 | 持久化有窗口，复制是异步的 |
| 大规模消息保留与重放 | 不适合 | Stream 受内存限制，无分区保留策略 |

判断标准只有一条：数据丢了能不能从别处重建。能重建，Redis 可以当缓存；不能重建，Redis 只能是加速层，事实来源必须另有其库。

### 7.2 单机、哨兵与集群的取舍

| 场景 | 推荐形态 | 理由 |
|---|---|---|
| 开发与测试 | 单机 | 成本最低，够用 |
| 数据量小于单机内存、要求自动切换 | 主从 + Sentinel | 运维简单，客户端改动小 |
| 数据量超过单机内存 | Cluster | 分片扩展，槽位自动迁移 |
| 多 key 事务频繁 | 单机或 Sentinel | Cluster 跨槽事务不支持 |
| 读多写少、可容忍旧值 | 主从 + 副本读 | 分散读压力，注意复制延迟 |

Cluster 的代价是约束：多 key 命令要求同槽，`MULTI` 不能跨节点，`SELECT` 只能选 0 号库，运维要处理槽迁移与节点扩缩容。为了同槽，可以用 hash tag 把相关键绑在一起：

```text
{order:42}:items
{order:42}:total
```

大括号内的内容参与哈希计算，两个键必然落在同一节点。代价是热点集中，同一订单的所有键都压在一个分片上，设计时要评估单键流量。

### 7.3 容量与成本估算

内存占用近似为：键数量 ×（value 大小 + 键名长度 + 每键约 50–100 字节的管理开销）。经验上按业务数据量的 1.5–2 倍预留，给碎片、复制缓冲和 fork 留余量。

示例：1000 万个缓存键，平均 value 2 KB，键名 40 字节，每键开销按 80 字节计。

```text
单键占用 ≈ 2048 + 40 + 80 = 2168 字节
总内存 ≈ 10,000,000 × 2168 ≈ 21.7 GB
加 30% 余量 ≈ 28 GB
```

这决定了两件事：单机放不下就必须分片；RDB fork 期间写时复制可能再增加最多一倍的物理内存，容器限额要按峰值设置。带宽同样要算：10 万 QPS、平均响应 2 KB，出口带宽约 200 MB/s，千兆网卡会先于 CPU 成为瓶颈。

---

## 八、常见故障与排查

### 8.1 故障对照表

| 现象 | 最可能原因 | 处理 |
|---|---|---|
| 命中率突然下降 | 键集中过期、实例重启、缓存被清空 | 查 `keyspace_hits/misses`、TTL 分布与重启记录 |
| 数据库 QPS 飙升 | 穿透、击穿或雪崩 | 空值缓存、互斥重建、TTL 抖动、入口限流 |
| `OOM command not allowed` | 达到 `maxmemory` 且策略为 `noeviction` | 查大键与内存构成，改淘汰策略或扩容 |
| 延迟周期性尖刺 | RDB fork、AOF 重写、大键删除 | 查 `INFO persistence`、`SLOWLOG`、`LATENCY` |
| 主从切换丢写入 | 异步复制尚未同步 | 能重建则重建，不能丢则加 `WAIT` 或换存储 |
| `CROSSSLOT` 错误 | 多 key 不在同一槽 | 用 hash tag，或拆成单键操作 |
| 锁被他人删除 | 释放时未比较令牌 | 用 Lua 比较后删除，令牌随机生成 |
| 锁提前失效 | 业务耗时超过 TTL | 延长 TTL 并续约，关键路径加 fencing token |
| 连接数暴涨 | 客户端未复用连接或连接泄漏 | 用连接池，查 `INFO clients` 与 `CLIENT LIST` |
| 内存碎片率高 | 大量增删、value 大小不一 | 看 `mem_fragmentation_ratio`，低峰整理或切换 |
| `READONLY You can't write against a read only replica` | 连到了从节点 | 写请求指向主节点，或检查 Sentinel 地址 |
| `NOAUTH Authentication required` | 未认证或密码错误 | 检查 ACL 用户与密码，确认客户端配置 |

### 8.2 排查顺序

```mermaid
flowchart TD
    A["Redis 异常"] --> B["INFO 总览<br/>内存、命中率、连接、复制"]
    B --> C{"是否 OOM 或延迟尖刺"}
    C -->|"是"| D["SLOWLOG 与 LATENCY<br/>定位慢命令与事件"]
    C -->|"否"| E["--bigkeys 与 MEMORY USAGE<br/>定位大键"]
    D --> F["检查持久化与 fork<br/>INFO persistence"]
    E --> G["检查客户端<br/>连接池、超时、重试"]
    F --> H["确认容量与策略"]
    G --> H
    classDef client fill:#e3f2fd,stroke:#1565c0;
    classDef engine fill:#e8f5e9,stroke:#2e7d32;
    classDef image fill:#fff3e0,stroke:#ef6c00;
    class A client
    class B,C,D,E,F engine
    class G,H image
```

按固定顺序推进，避免一上来就重启：

1. `INFO` 看 `used_memory`、`maxmemory`、命中率、连接数、`master_link_status`，先判断是容量、命中率还是复制问题。
2. `INFO persistence` 看 `rdb_last_bgsave_status`、`aof_last_bgrewrite_status`，确认备份是否正常。
3. `SLOWLOG GET 10` 与 `LATENCY DOCTOR` 定位慢命令与延迟事件，重点看 `KEYS`、大集合运算、大键删除。
4. `redis-cli --bigkeys` 与 `MEMORY USAGE` 找大键，再决定拆分、压缩或异步删除。
5. `CLIENT LIST` 看连接来源与空闲连接，确认是否存在连接泄漏或异常客户端。
6. 最后才调整 `maxmemory`、淘汰策略或重启实例；重启前先确认持久化文件可用。

> **运维提示**：把 `keyspace_hits`、`keyspace_misses`、`evicted_keys`、`connected_clients`、`mem_fragmentation_ratio`、`master_link_status` 六项做成固定看板，比事后翻日志快得多。

> **运维提示**：全文可压缩为三句话——缓存是旁路，先改库再删缓存，TTL 只兜底不保证一致；锁是大概率互斥，关键写入要有 fencing token 或数据库约束；持久化与复制都有窗口，Redis 里的数据必须能从源头重建。
