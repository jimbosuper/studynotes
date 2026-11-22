---
title: "MongoDB文档数据库"
category: "05-后端"
---

# MongoDB文档数据库

> 这篇从文档模型与 BSON 的存储结构讲起，经过单机与副本集安装、嵌入与引用的建模取舍、CRUD 与查询操作符、按 ESR 规则设计索引、聚合管道、多文档事务与一致性，最后落到副本集运维排障，以及一个社区团购订单服务从"JSON 塞进 MySQL"迁到 MongoDB 8 的完整案例。
>
> 学完能独立部署一个三节点副本集，为一个业务设计出不会撑爆 16 MB 的文档结构，用 explain 判断索引是否命中，写出带 `$lookup` 与 `$merge` 的日报聚合，并在事务里安全完成"扣库存 + 下单"，同时知道什么时候该退回关系库。

## 一、文档模型与副本集架构

MongoDB 把一条记录存成 BSON 文档，一个集合里的文档不要求同构；读写的最小原子单位是单个文档，可用性由副本集提供。这两点决定了建模方式与事务边界。

```mermaid
graph LR
  A[应用 / 驱动] --> B[主节点 primary 读写]
  A -.读偏好 secondary.-> C[从节点 secondary]
  B -.oplog 异步复制.-> C
  B -.oplog 异步复制.-> D[从节点 secondary]
  B --> E[(WiredTiger 数据文件)]
  C --> F[(WiredTiger 数据文件)]
  C -.选举投票.-> B
  D -.选举投票.-> B
  classDef blue fill:#eff6ff,stroke:#93c5fd,color:#1e3a8a;
  classDef green fill:#ecfdf5,stroke:#86efac,color:#166534;
  classDef amber fill:#fffbeb,stroke:#fcd34d,color:#92400e;
  classDef gray fill:#f8fafc,stroke:#cbd5e1,color:#334155;
  class A,B blue;
  class C,D,E,F green;
  class C amber;
```

写入只落主节点，主节点把变更写进 `local.oplog.rs`，从节点拉取并重放；主节点故障时，能连上多数派的从节点发起选举，默认在 10 秒左右选出新主。仲裁节点（arbiter）只投票不存数据，用于把节点数凑成奇数，不承担读负载。

文档模型的四个硬边界：

| 边界 | 数值 | 影响 |
|---|---|---|
| 单文档大小 | 16 MB | 超过必须拆文档，不是拆集合 |
| 嵌套深度 | 100 层 | 深层嵌套无法用点号路径更新 |
| 单文档原子性 | 整文档 | 跨文档一致要靠事务 |
| 单集合索引数 | 64 个上限 | 索引不是越多越好 |

与关系库的取舍按"数据形状"判断，不按"新旧"判断：

| 维度 | MongoDB | 关系库（PG/MySQL） |
|---|---|---|
| 数据形状 | 聚合成一个文档读取 | 多表规范化，查询时连接 |
| 模式 | 灵活，可选校验 | 强 schema，DDL 管控 |
| 关联查询 | `$lookup`，代价高 | JOIN 是核心能力 |
| 多文档事务 | 支持，有 60 秒上限 | 原生，无特殊限制 |
| 扩展方式 | 副本集读扩展 + 分片 | 垂直 + 只读副本 |

适用场景：内容与商品详情、订单快照、物联网与埋点事件、日志、会话、多形态表单。不适用：需要大量多表 JOIN 的报表、强跨表约束的财务账务、单表简单计数的高频写入（这类交给 Redis）。

BSON 常用类型比 JSON 多，建模时选对类型能省索引空间：

| 类型 | 用法 | 注意 |
|---|---|---|
| `ObjectId` | 默认 `_id` | 12 字节，含时间戳，大致有序 |
| `String` | 文本 | 无长度限制，但索引键 ≤1024 字节 |
| `Int32`/`Int64` | 计数、金额分值 | shell 里默认 Number 可能是 double |
| `Decimal128` | 精确金额 | 驱动要显式构造，聚合较慢 |
| `Date` | 时间 | 存 UTC 毫秒，时区在展示层处理 |
| `BinData` | 二进制、向量 | 大字段考虑 GridFS |

> 边界：`_id` 一旦写入不可修改，用业务主键当 `_id` 前先确认它不会变。`Decimal128` 与 `double` 混存会让 `$sum` 结果失真，金额字段从第一天就固定成一种类型。

## 二、安装与最小验证

安装走官方仓库拿 8.x 的最新小版本；生产环境从第一天就按副本集部署，单机模式拿不到事务、变更流和自动故障切换。

| 环境 | 安装方式（2026-11） | 服务管理 |
|---|---|---|
| Ubuntu 24.04 | 官方 apt 源 + `mongodb-org` | `systemctl` |
| Rocky/CentOS 9 | 官方 dnf 源 + `mongodb-org` | `systemctl` |
| macOS 14+ | `brew tap mongodb/brew` | `brew services` |
| Windows 10/11 | MSI 安装包（可勾选服务） | 服务面板 `MongoDB` |

Ubuntu 上的完整步骤，注意 8.x 要求 CPU 支持 AVX，老虚拟机或部分云主机型号会直接启动失败：

```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | \
  sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] \
  https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
sudo apt update && sudo apt install -y mongodb-org
sudo systemctl enable --now mongod
```

Rocky 9 与 macOS：

```bash
# Rocky 9
sudo tee /etc/yum.repos.d/mongodb-org-8.0.repo <<'EOF'
[mongodb-org-8.0]
name=MongoDB Repository
baseurl=https://repo.mongodb.org/yum/redhat/9/mongodb-org/8.0/x86_64/
gpgcheck=1
enabled=1
gpgkey=https://www.mongodb.org/static/pgp/server-8.0.asc
EOF
sudo dnf install -y mongodb-org && sudo systemctl enable --now mongod

# macOS
brew tap mongodb/brew
brew install mongodb-community@8.0
brew services start mongodb-community@8.0
```

配置文件是 YAML，Ubuntu/RHEL 在 `/etc/mongod.conf`，macOS 在 `/opt/homebrew/etc/mongod.conf`：

```yaml
storage:
  dbPath: /var/lib/mongo
  wiredTiger:
    engineConfig:
      cacheSizeGB: 4          # 约为 (物理内存 - 其他进程) 的 50%，不是越大越好
    collectionConfig:
      blockCompressor: zstd   # 冷数据压缩比 snappy 高，CPU 富余时选它
systemLog:
  destination: file
  path: /var/log/mongodb/mongod.log
  logAppend: true
net:
  port: 27017
  bindIp: 10.0.0.11,127.0.0.1  # 只绑内网与本地，公网由安全组挡掉
replication:
  replSetName: rs0            # 有这一项才启用副本集
security:
  authorization: enabled      # 先在无认证状态建好管理员，再开启此项并重启
```

三节点副本集初始化，`_id` 必须与配置里的 `replSetName` 一致：

```javascript
// 在任一节点上执行 mongosh
rs.initiate({
  _id: "rs0",
  members: [
    { _id: 0, host: "10.0.0.11:27017", priority: 2 },  // 同机房优先做主机
    { _id: 1, host: "10.0.0.12:27017", priority: 1 },
    { _id: 2, host: "10.0.0.13:27017", priority: 1 }
  ]
});
```

```text
{ ok: 1 }
rs0 [direct: primary] test>
```

若配置文件已经写了 `authorization: enabled`，先用 localhost exception 建管理员；更稳的顺序是先注释掉该行，完成 `rs.initiate` 与建号后再开启并重启。

建管理员与应用账号，认证库是 `admin`，应用账号按最小权限只给业务库：

```javascript
use admin
db.createUser({ user: "root", pwd: passwordPrompt(), roles: ["root"] });
db.createUser({
  user: "shop_app",
  pwd: passwordPrompt(),
  roles: [
    { role: "readWrite", db: "shop" },
    { role: "read", db: "reporting" }
  ]
});
```

最小验证五项：版本、主节点身份、副本集状态、认证生效、写入读回。

```javascript
db.version()                                  // 8.0.x
db.hello().isWritablePrimary                   // true
rs.status().ok                                 // 1
db.getSiblingDB("shop").orders.insertOne({ _id: 1, note: "hello mongo" })
db.getSiblingDB("shop").orders.findOne({ _id: 1 })
```

```text
8.0.16
true
1
{ acknowledged: true, insertedId: 1 }
{ _id: 1, note: 'hello mongo' }
```

应用连接串要写全副本集成员、读偏好与写关注，否则驱动会退化成单节点语义：

```text
mongodb://shop_app:App%40123456@10.0.0.11:27017,10.0.0.12:27017,10.0.0.13:27017/shop
  ?replicaSet=rs0&authSource=shop&readPreference=primary&retryWrites=true&w=majority
```

> 边界：`bindIp` 写 `0.0.0.0` 必须配合安全组，MongoDB 历史上多次大规模泄露都源于公网裸奔加无认证。开启 `authorization` 前要先建管理员，否则重启后连不进去，只能走 localhost exception 补救。`cacheSizeGB` 过大会让文件系统缓存变小，整机吞吐反而下降。

## 三、文档模型设计

文档建模的核心判断是"这份数据是否总跟父文档一起读"，而不是"它像不像一张表"；判断错方向，后面用事务也补不回来。

### 3.1 嵌入与引用的分界

| 关系 | 做法 | 判断依据 |
|---|---|---|
| 1:1 | 嵌入 | 总是一起读，字段不多 |
| 1:N 有界 | 嵌入数组 | 数量可预估，通常 <100 |
| 1:N 无界 | 子集合引用 | 数量随业务增长，如评论、日志 |
| N:M | 两端各存引用数组 | 关联数量有界，或改用中间集合 |

订单是最典型的"有界嵌入"：订单项随订单一起读、一起写、数量可控，嵌入后一次查询拿到完整快照，且订单项的价格不会被后来的商品调价影响：

```javascript
{
  _id: ObjectId("673f2a1c8e4b0a1d2c3e4f50"),
  orderNo: "SO202611130001",
  tenantId: NumberLong("42"),
  status: "paid",
  items: [
    { sku: "SKU-1", name: "赣南脐橙 5kg", qty: 2, price: NumberDecimal("39.90") },
    { sku: "SKU-7", name: "泡沫箱", qty: 1, price: NumberDecimal("6.00") }
  ],
  amount: NumberDecimal("85.80"),
  createdAt: ISODate("2026-11-13T02:14:31.402Z")
}
```

反例是"商品评论塞进商品文档"：评论无上限增长，必然撞上 16 MB，且每次新增评论都要重写整个商品文档，写放大与锁冲突同时出现。正确做法是评论独立集合，商品文档只留 `reviewCount` 与 `ratingAvg` 这类聚合值。

### 3.2 五个可复用的模式

| 模式 | 解决什么 | 做法 |
|---|---|---|
| 子集（Subset） | 大文档只取热字段 | 列表页读精简集合，详情读主集合 |
| 分桶（Bucket） | 时序数据文档数爆炸 | 每 200 条或每小时一个文档 |
| 异常值（Outlier） | 少数文档数组超长 | 超长部分拆到溢出集合 |
| 扩展引用（Extended Reference） | 避免高频 `$lookup` | 冗余对方最常读的 2–3 个字段 |
| 计算（Computed） | 聚合结果反复算 | 写入时算好存字段，读时直接取 |

分桶模式写时序数据的形状：

```javascript
{
  _id: ObjectId("673f2b0a8e4b0a1d2c3e4f60"),
  metric: "cpu.usage",
  host: "web-01",
  bucketStart: ISODate("2026-11-13T02:00:00Z"),
  count: 200,
  samples: [ { ts: ISODate("2026-11-13T02:00:01Z"), v: 31.2 }, /* ... */ ]
}
```

一次写入 200 个采样只改一个文档，索引条目从 200 条降到 1 条；查询按 `bucketStart` 范围扫描，再在内存里展开 `samples`。

### 3.3 用校验器把关键约束放进库

MongoDB 没有外键，但可以用 `$jsonSchema` 拦住类型错误、缺字段和非法枚举，成本远低于线上排错：

```javascript
db.createCollection("orders", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["orderNo", "tenantId", "status", "items", "amount", "createdAt"],
      properties: {
        orderNo: { bsonType: "string", maxLength: 32 },
        tenantId: { bsonType: "long" },
        status: { enum: ["created", "paid", "shipped", "closed", "refunded"] },
        amount: { bsonType: "decimal" },
        createdAt: { bsonType: "date" },
        items: {
          bsonType: "array", minItems: 1, maxItems: 50,
          items: {
            bsonType: "object",
            required: ["sku", "qty", "price"],
            properties: {
              qty: { bsonType: "int", minimum: 1, maximum: 999 },
              price: { bsonType: "decimal" }
            }
          }
        }
      }
    }
  },
  validationLevel: "strict",     // 旧文档也校验，避免脏数据继续写
  validationAction: "error"      // 默认就是 error；warn 只记日志，不要用于生产
});
```

```javascript
db.orders.insertOne({ orderNo: "SO1", tenantId: NumberLong(42), status: "unknown",
  items: [], amount: NumberDecimal("1.00"), createdAt: new Date() });
```

```text
MongoServerError: Document failed validation
```

### 3.4 命名与版本字段

字段名直接进每条文档与每个索引键，长名字会成倍占用空间：`customerId` 优于 `theCustomerIdentifier`，但不要为省字节缩写成 `cid` 这类不可读的形式。

结构变化时加 `schemaVersion` 字段，读时按版本兼容，避免一次性全量刷库：

```javascript
db.orders.updateMany(
  { schemaVersion: { $exists: false } },
  { $set: { schemaVersion: 1 } }
);
```

> 边界：校验器不能跨集合校验（如"`tenantId` 必须存在于租户表"），这类约束要么放应用层，要么定期跑对账任务。`validationLevel: "moderate"` 只校验新写入与已合法的文档，适合渐进迁移，不适合新集合。

## 四、CRUD 与查询

MongoDB 的查询是"条件对象 + 投影"，索引能否命中取决于条件写法与字段顺序，而不是语句长得是否像 SQL。

### 4.1 写入

```javascript
// 批量写入关闭有序执行：单条失败不影响其余，重试时按 _id 幂等
db.orders.insertMany(
  [
    { _id: 1001, orderNo: "SO1001", tenantId: NumberLong(42), customerId: NumberLong(7),
      status: "created", amount: NumberDecimal("59.90"), createdAt: new Date(),
      items: [{ sku: "SKU-1", qty: 1, price: NumberDecimal("59.90") }] },
    { _id: 1002, orderNo: "SO1002", tenantId: NumberLong(42), customerId: NumberLong(8),
      status: "paid", amount: NumberDecimal("128.00"), createdAt: new Date(),
      items: [{ sku: "SKU-7", qty: 2, price: NumberDecimal("64.00") }] }
  ],
  { ordered: false, writeConcern: { w: "majority", j: true } }
);
```

```text
{ acknowledged: true, insertedIds: { '0': 1001, '1': 1002 } }
```

文档必须通过 3.3 节的校验器，否则会报 `Document failed validation`——把校验器和写入放在一起看，才知道必填字段有哪些。

写关注决定"什么时候算写成功"：

| writeConcern | 语义 | 适用 |
|---|---|---|
| `{w: 1}` | 主节点内存确认 | 可丢的日志、埋点 |
| `{w: "majority"}` | 多数派落盘 | 订单、账务、库存 |
| `{w: 0}` | 不等待确认 | 极少使用 |
| `{j: true}` | 等 journal 落盘 | 与 majority 搭配 |

`{w: "majority", j: true}` 是最安全的组合，代价是每次写多一次网络往返与磁盘同步；订单类写入必须用它，埋点类可以降到 `{w: 1}`。

### 4.2 查询与投影

投影只取需要的字段，既省网络也更容易做成覆盖查询：

```javascript
db.orders.find(
  { tenantId: NumberLong(42), status: { $in: ["paid", "shipped"] } },
  { orderNo: 1, amount: 1, createdAt: 1, _id: 0 }   // 排除 _id，减少无用的字段传输
).sort({ createdAt: -1 }).limit(20);
```

数组查询要区分"数组里存在满足全部条件的元素"与"不同元素分别满足"：

```javascript
// 同一个元素同时满足 sku 与 qty，必须用 $elemMatch
db.orders.find({ items: { $elemMatch: { sku: "SKU-1", qty: { $gte: 2 } } } });

// 下面这种写法会匹配到"某个元素 sku=SKU-1、另一个元素 qty>=2"的文档
db.orders.find({ "items.sku": "SKU-1", "items.qty": { $gte: 2 } });
```

常用操作符按用途记：比较 `$eq/$gt/$gte/$lt/$lte/$in/$nin/$ne`，逻辑 `$and/$or/$not/$nor`，元素 `$exists/$type`，数组 `$all/$size/$elemMatch`，求值 `$regex/$expr/$jsonSchema`。`$regex` 只有前缀锚定（`^abc`）能走索引，其余一律扫描。

### 4.3 更新

```javascript
db.orders.updateOne(
  { orderNo: "SO1001", status: "created" },       // 条件里带状态，天然防并发重复流转
  {
    $set: { status: "paid", paidAt: new Date() },
    $inc: { "payment.attempts": 1 },
    $push: { timeline: { at: new Date(), event: "paid" } }
  },
  { writeConcern: { w: "majority", j: true } }
);
```

```text
{ acknowledged: true, matchedCount: 1, modifiedCount: 1 }
```

数组元素的定点更新用 `arrayFilters`，不要"读出来改完整体写回"：

```javascript
db.orders.updateOne(
  { orderNo: "SO1001" },
  { $inc: { "items.$[it].qty": 1 } },
  { arrayFilters: [{ "it.sku": "SKU-1" }] }
);
```

`findOneAndUpdate` 原子地"改并返回"，是做状态机与队列领取的标准手段：

```javascript
db.jobs.findOneAndUpdate(
  { status: "pending" },
  { $set: { status: "running", startedAt: new Date() } },
  { sort: { createdAt: 1 }, returnDocument: "after" }
);
```

### 4.4 Upsert 与批量混合写

`upsert` 在"没有就插、有就改"时一次往返完成，配合唯一索引不会产生重复：

```javascript
db.daily_stats.updateOne(
  { tenantId: NumberLong(42), day: "2026-11-13" },
  {
    $inc: { orders: 1, gmv: NumberDecimal("128.00") },
    $setOnInsert: { createdAt: new Date() }        // 只在插入时写，更新时不覆盖
  },
  { upsert: true }
);
```

多种操作混在一批时用 `bulkWrite`，减少往返；`ordered: false` 让失败项不影响其他项，返回值里逐条看 `error`。以下用任务表演示（订单集合的校验器会把不完整文档拒掉）：

```javascript
db.jobs.bulkWrite([
  { insertOne: { document: { _id: 2001, type: "sync_stock", status: "pending" } } },
  { updateOne: { filter: { _id: 1001 }, update: { $set: { status: "running" } } } },
  { deleteOne: { filter: { _id: 999 } } }
], { ordered: false });
```

### 4.5 读关注、读偏好与分页

```javascript
db.orders.find({ tenantId: NumberLong(42) })
  .readPref("secondaryPreferred")            // 报表类查询分摊到从节点
  .readConcern("majority");                  // 只读已多数派确认的数据
```

分页优先用"游标条件"而不是 `skip`：`skip(100000)` 要让服务端丢弃十万条，越翻越慢。

```javascript
// 上一页最后一条的 createdAt 与 _id 作为游标
db.orders.find({
  tenantId: NumberLong(42),
  $or: [
    { createdAt: { $lt: ISODate("2026-11-13T02:14:31Z") } },
    { createdAt: ISODate("2026-11-13T02:14:31Z"), _id: { $lt: 1001 } }
  ]
}).sort({ createdAt: -1, _id: -1 }).limit(20);
```

> 边界：`skip` 适合前几页与后台导出，不适合用户翻页；游标分页要求排序字段组合唯一且稳定。`readConcern("majority")` 会增加读延迟，低价值列表页用默认 `local` 即可。`$where` 与 `$function` 执行 JavaScript，禁止在生产查询里使用。

## 五、索引设计

MongoDB 的索引是 B-tree（`_id` 之外全部后建），命中规则比 SQL 更依赖字段顺序；一条复合索引的列顺序按 ESR 排：等值（Equality）→ 排序（Sort）→ 范围（Range）。

### 5.1 复合索引与 ESR

```javascript
// 查询：tenantId 等值、status 等值、createdAt 范围，按 createdAt 倒序
db.orders.createIndex(
  { tenantId: 1, status: 1, createdAt: -1 },
  { name: "idx_tenant_status_time" }
);
```

ESR 的推导过程：等值字段放最前，能一次性把扫描区间收缩到最小；排序字段紧跟等值字段，索引本身就有序，免掉内存排序；范围字段放最后，因为它会截断后续字段的定位能力。

```javascript
// 反例：排序字段插在等值字段中间，status 的等值条件用不上索引定位，只能逐条过滤
db.orders.createIndex({ tenantId: 1, createdAt: -1, status: 1 });
```

多键索引（字段是数组）每个数组元素生成一个索引条目，因此数组字段不能与另一个数组字段放进同一个复合索引——这是"隐式数组"报错的来源：

```text
MongoServerError: cannot index parallel arrays [sku] [tags]
```

### 5.2 部分索引、TTL 与唯一索引

部分索引只为满足条件的文档建条目，体积与写放大都下降：

```javascript
// 只索引待处理订单，通常是全表很小一部分
db.orders.createIndex(
  { createdAt: 1 },
  { partialFilterExpression: { status: "created" }, name: "idx_pending" }
);
```

查询条件必须包含同样的过滤表达式，否则用不上部分索引：

```javascript
db.orders.find({ status: "created", createdAt: { $lt: new Date() } });  // 命中
db.orders.find({ createdAt: { $lt: new Date() } });                      // 不命中
```

TTL 索引按时间自动删文档，适合会话、验证码、临时购物车；后台线程每 60 秒扫一次，所以过期时间不精确：

```javascript
db.sessions.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
```

唯一索引承担"业务主键"的职责，重复写入直接报错而不是静默产生两条：

```javascript
db.orders.createIndex({ orderNo: 1 }, { unique: true });
```

```text
MongoServerError: E11000 duplicate key error collection: shop.orders index: orderNo_1
```

### 5.3 其他索引类型

| 类型 | 语法要点 | 适用 |
|---|---|---|
| 文本 | `{title:"text", body:"text"}` | 分词检索，每集合仅一个 |
| 通配 | `{"payload.$**": 1}` | 字段不可预知的半结构化数据 |
| 2dsphere | `{loc:"2dsphere"}` | 地理范围与就近查询 |
| 哈希 | `{sku:"hashed"}` | 分片键，不做范围查询 |
| 稀疏 | `{phone:1}, {sparse:true}` | 已不推荐，改用部分索引 |

通配索引能兜住"字段名由用户决定"的表单数据，但会放大写入成本，字段固定后应换成显式索引。

### 5.4 用 explain 判断命中

```javascript
db.orders.find({ tenantId: NumberLong(42), status: "paid" })
  .sort({ createdAt: -1 }).limit(20)
  .explain("executionStats");
```

关键字段只有四个：

```text
winningPlan.stage                  IXSCAN（命中）/ COLLSCAN（全表）
executionStats.nReturned           20
executionStats.totalKeysExamined   20
executionStats.totalDocsExamined   0
```

`nReturned` 与 `totalKeysExamined` 接近、`totalDocsExamined` 为 0，说明是覆盖查询，索引里就有全部所需字段。若 `totalKeysExamined` 远大于 `nReturned`，说明索引选择性差或范围条件写错；若出现 `SORT` 阶段且 `memLimit` 报错，说明排序字段不在索引里。

一个覆盖查询的完整形状：

```javascript
db.orders.find(
  { tenantId: NumberLong(42), status: "paid" },
  { _id: 0, createdAt: 1 }
).sort({ createdAt: -1 }).limit(20);

db.orders.createIndex({ tenantId: 1, status: 1, createdAt: -1 });
```

### 5.5 索引的运维约束

- 单集合索引建议不超过 10 个，每个索引都要在每次写入时维护；
- 索引常驻内存，`db.orders.stats().indexSizes` 之和应能放进 WiredTiger cache 的 60% 以内；
- 4.4 起副本集的索引构建在所有数据成员上同时进行、由 commit quorum 协调，单成员仍要承担完整构建成本，务必低峰执行；
- 建错的索引先 `hideIndex` 观察业务是否报错，再决定删除，直接 `dropIndex` 没有回退余地；
- 用 `db.orders.getIndexes()` 与 `$indexStats` 找出从未命中的索引。

```javascript
db.orders.aggregate([{ $indexStats: {} }]).forEach(i =>
  print(i.name, i.accesses.ops));
```

> 边界：索引不是越多越好，写入型集合每多一个索引就多一份 oplog 与磁盘写。`$indexStats` 的统计从节点启动开始累计，重启后归零，判断"无用索引"要观察完整业务周期（至少一周，含月末结算）。

## 六、聚合管道

聚合是 MongoDB 里唯一能"在库内完成分组、连接、窗口、回写"的能力；写法上的差距主要体现在阶段顺序，而不是阶段数量。

### 6.1 阶段与顺序

| 阶段 | 作用 | 优化要点 |
|---|---|---|
| `$match` | 过滤 | 尽量放最前，能用索引 |
| `$sort` | 排序 | 紧跟 `$match`，尽量用索引序 |
| `$project`/`$unset` | 裁剪字段 | 尽早瘦身，减少后续搬运 |
| `$group` | 分组聚合 | 内存超 100 MB 需 `allowDiskUse` |
| `$lookup` | 左外连接 | 先过滤再连接，被连接字段必须有索引 |
| `$merge` | 结果回写 | 建物化汇总表的标准手段 |

### 6.2 日报聚合

```javascript
db.orders.aggregate([
  // 1. 先用索引把范围缩到当天，后续所有阶段的数据量都由这一步决定
  { $match: {
      tenantId: NumberLong(42),
      status: { $in: ["paid", "shipped"] },
      createdAt: { $gte: ISODate("2026-11-01"), $lt: ISODate("2026-11-14") }
  } },
  // 2. 展开订单项，按 SKU 维度统计；项目内已含价格快照，无需回查商品
  { $unwind: "$items" },
  { $group: {
      _id: {
        day: { $dateTrunc: { date: "$createdAt", unit: "day", timezone: "Asia/Shanghai" } },
        sku: "$items.sku"
      },
      qty: { $sum: "$items.qty" },
      gmv: { $sum: { $multiply: ["$items.qty", "$items.price"] } },
      orders: { $addToSet: "$orderNo" }
  } },
  { $project: { qty: 1, gmv: 1, orderCnt: { $size: "$orders" } } },
  { $sort: { "_id.day": 1, gmv: -1 } }
], { allowDiskUse: true, hint: { tenantId: 1, status: 1, createdAt: -1 } });
```

```text
{ _id: { day: ISODate("2026-11-10T16:00:00Z"), sku: 'SKU-1' }, qty: 842, gmv: Decimal128("33595.80"), orderCnt: 402 }
```

mongosh 按 UTC 打印日期，`timezone: "Asia/Shanghai"` 下的 11-11 零点就是 `2026-11-10T16:00:00Z`；少了 `timezone` 参数，同一条语句会按 UTC 切日，日报整体错 8 小时。

`$dateTrunc` 的 `timezone` 决定"一天"从几点切分，跨时区业务必须显式写，否则按 UTC 切，日报会错 8 小时。

### 6.3 连接与多维汇总

`$lookup` 是左外连接，代价与"每个输入文档查一次"接近，被连接集合的字段必须有索引：

```javascript
db.orders.aggregate([
  { $match: { tenantId: NumberLong(42), createdAt: { $gte: ISODate("2026-11-01") } } },
  { $lookup: {
      from: "customers",
      localField: "customerId",
      foreignField: "_id",
      as: "customer",
      pipeline: [ { $project: { name: 1, city: 1 } } ]   // 只取需要的字段，减少物化
  } },
  { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
  { $group: {
      _id: "$customer.city",
      gmv: { $sum: "$amount" },
      users: { $addToSet: "$customerId" }
  } },
  { $project: { gmv: 1, userCnt: { $size: "$users" } } },
  { $sort: { gmv: -1 } }
]);
```

`$facet` 让多个口径共享同一次扫描，适合"一个页面多个图表"：

```javascript
db.orders.aggregate([
  { $match: { tenantId: NumberLong(42), createdAt: { $gte: ISODate("2026-11-01") } } },
  { $facet: {
      byStatus: [ { $group: { _id: "$status", cnt: { $sum: 1 } } } ],
      byDay:    [ { $group: { _id: { $dateTrunc: { date: "$createdAt", unit: "day" } }, gmv: { $sum: "$amount" } } },
                  { $sort: { "_id": 1 } } ],
      topSku:   [ { $unwind: "$items" }, { $group: { _id: "$items.sku", qty: { $sum: "$items.qty" } } },
                  { $sort: { qty: -1 } }, { $limit: 10 } ]
  } }
]);
```

### 6.4 窗口与落表

`$setWindowFields` 做同比、累计、排名，避免把数据拉到应用层再算：

```javascript
{ $setWindowFields: {
    partitionBy: "$_id.day",
    sortBy: { gmv: -1 },
    output: {
      skuRank: { $rank: {} },
      dayRunningGmv: { $sum: "$gmv", window: { documents: ["unbounded", "current"] } }
    }
} }
```

`$merge` 把结果增量写回汇总集合，是替代"每天全量重算"的标准做法：

```javascript
db.orders.aggregate([
  { $match: { createdAt: { $gte: ISODate("2026-11-13"), $lt: ISODate("2026-11-14") } } },
  { $group: { _id: { tenantId: "$tenantId", sku: "$items.sku" }, gmv: { $sum: "$amount" } } },
  { $merge: {
      into: "daily_sku_sales",
      on: "_id",
      whenMatched: "replace",
      whenNotMatched: "insert"
  } }
]);
```

`$merge` 的 `on` 字段必须建唯一索引，否则并发合并会出现重复。

> 边界：`allowDiskUse: true` 只解决内存上限，不解决"扫描了全表"；聚合慢先看 `$match` 是否用上索引。`$lookup` 不要放在 `$group` 之后放大结果集，也不要在 `$lookup` 里再做 `$lookup`。超过 100 MB 的单阶段结果必须落盘，临时目录要预留空间。

## 七、事务与一致性

单文档写入天然原子；跨文档一致性从 4.0 起用多文档事务解决，但它有 60 秒上限与写冲突代价，是"最后手段"而不是默认设计。

### 7.1 一致性等级

| 需求 | 手段 | 保证 |
|---|---|---|
| 单文档原子 | 默认 | 一条文档要么全改要么不改 |
| 多文档原子 | 事务 | 提交或全部回滚 |
| 读己之写 | 主节点读 | 强一致 |
| 因果一致 | 会话 + `afterClusterTime` | 同一会话不读到旧数据 |
| 跨节点线性一致 | `readConcern: linearizable` | 代价高，仅特殊场景 |

事务必须运行在副本集或分片集群上，单机 `mongod` 会直接报错：

```text
MongoServerError: Transaction numbers are only allowed on a replica set member or mongos
```

### 7.2 事务的读写关注

事务的三个核心参数先看片段（`orderDoc` 与完整可运行版本见第九章案例）：

```javascript
const session = client.startSession();
await session.withTransaction(async () => {
  await db.collection("stock").updateOne(
    { sku: "SKU-1", available: { $gte: 2 } },
    { $inc: { available: -2, reserved: 2 } },
    { session }
  );
  await db.collection("orders").insertOne(orderDoc, { session });
}, {
  readConcern: { level: "snapshot" },          // 事务内快照一致，避免读到半更新状态
  writeConcern: { w: "majority", j: true },    // 多数派落盘才算提交成功
  maxCommitTimeMS: 5000
});
```

三个参数缺一不可：`snapshot` 保证事务内多次读看到同一版本；`majority` 保证提交后不会因主节点故障丢失；`maxCommitTimeMS` 防止提交阶段无限等待。

### 7.3 重试逻辑

事务失败分两类，处理方式完全不同，`withTransaction` 已经封装了这两类重试：

```javascript
const { MongoClient } = require("mongodb");

const client = new MongoClient(process.env.MONGO_URI, {
  retryWrites: true,          // 网络抖动时驱动自动重试单文档写
  retryReads: true,
  readPreference: "primary"   // 事务只能在主节点执行
});

async function placeOrder(order) {
  const db = client.db("shop");
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const r = await db.collection("stock").updateOne(
        { sku: order.sku, available: { $gte: order.qty } },
        { $inc: { available: -order.qty, reserved: order.qty } },
        { session }
      );
      // 业务失败抛普通错误：withTransaction 不重试，直接回滚
      if (r.modifiedCount !== 1) throw Object.assign(new Error("OUT_OF_STOCK"), { code: "OUT_OF_STOCK" });

      await db.collection("orders").insertOne(
        { ...order, status: "created", createdAt: new Date() },
        { session }
      );
      // 事务性发件箱：与订单同事务写入，保证下游消息不丢
      await db.collection("outbox").insertOne(
        { type: "order.created", orderNo: order.orderNo, sent: false, at: new Date() },
        { session }
      );
    }, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority", j: true }
    });
    return { ok: true, orderNo: order.orderNo };
  } finally {
    await session.endSession();
  }
}
```

两类错误的区别：

| 错误标签 | 含义 | 处理 |
|---|---|---|
| `TransientTransactionError` | 写冲突、主节点切换 | 整个事务重试 |
| `UnknownTransactionCommitResult` | 提交结果未知 | 只重试 `commitTransaction` |
| 无标签 | 业务校验失败（库存不足） | 直接失败，不重试 |

`withTransaction` 对第一类重试整个回调，对第二类重试提交，默认各 120 秒；自己写重试循环时最容易犯的错是"只重试 commit"，那会在写冲突场景下丢事务。

### 7.4 事务的边界

- 事务控制在 10 秒内、影响文档数在百级，60 秒上限到了会被强制中止；
- 事务内不要做外部 HTTP 调用、不要等用户输入，持有锁的时间就是冲突概率；
- 事务内不能建集合、不能建索引（4.4 起可建集合，但不能建索引），DDL 提前做完；
- 两个事务以不同顺序更新同一批文档会持续冲突，按 `_id` 排序后更新；
- 分片集群事务还有额外协调开销，能用单文档设计消掉的，不要引入事务。

```javascript
// 冲突现场：先看写冲突计数与长事务
db.serverStatus().transactions
db.currentOp({ "transaction": { $exists: true }, "secs_running": { $gt: 5 } })
```

> 边界：`withTransaction` 的回调会被执行多次，回调内必须无副作用（不能在里面发短信、扣第三方余额）。事务不是"把 MySQL 的转账逻辑照搬过来"的许可证，MongoDB 的写冲突在热点文档上比行锁更激烈。

## 八、副本集运维与排障

副本集是 MongoDB 可用性的全部来源，运维动作围绕"多数派是否健康、复制是否跟得上、备份能否恢复"三件事。

### 8.1 拓扑与读偏好

```javascript
rs.status().members.map(m => ({ name: m.name, state: m.stateStr, optime: m.optimeDate }));
rs.conf().members;                     // 改优先级、加 hidden 节点都在这里
```

```text
[
  { name: '10.0.0.11:27017', state: 'PRIMARY' },
  { name: '10.0.0.12:27017', state: 'SECONDARY' },
  { name: '10.0.0.13:27017', state: 'SECONDARY' }
]
```

读写分离靠读偏好，不靠手工连某台：

| 读偏好 | 语义 | 适用 |
|---|---|---|
| `primary` | 只读主 | 交易、强一致 |
| `primaryPreferred` | 主优先，故障读从 | 大多数业务 |
| `secondaryPreferred` | 从优先，无从读主 | 报表、导出 |
| `nearest` | 网络最近 | 多地域部署 |
| `secondary` + `maxStalenessSeconds` | 限定滞后上限 | 可容忍旧数据的查询 |

`secondary` 必须配 `maxStalenessSeconds`，否则从节点延迟一小时也照读，用户会看到"刚下的单不见了"。

### 8.2 复制延迟与 oplog

```javascript
rs.printReplicationInfo();        // 主节点 oplog 覆盖的时间窗口
rs.printSecondaryReplicationInfo(); // 各从节点落后多少秒
```

```text
configured oplog size:   51200MB
log length start to end: 21600secs (6hrs)
oplog first event time:  Thu Nov 13 2026 00:12:03 GMT+0800
oplog last event time:   Thu Nov 13 2026 06:12:41 GMT+0800
```

oplog 窗口要大于"最长故障恢复时间 + 一次全量备份间隔"，低于 24 小时就扩：

```javascript
db.adminCommand({ replSetResizeOplog: 1, size: 102400 });   // 单位 MB，在线生效
```

### 8.3 备份与恢复

`mongodump` 是逻辑备份，小库方便；带 `--oplog` 才能得到一致的时间点：

```bash
mongodump --uri="mongodb://backup:Pass@10.0.0.11:27017/?replicaSet=rs0&authSource=admin" \
  --oplog --gzip --archive=/backup/shop_20261113.archive

mongorestore --gzip --archive=/backup/shop_20261113.archive \
  --oplogReplay --nsInclude='shop.*' --nsFrom='shop.*' --nsTo='shop_restore.*'
```

大库（TB 级）用文件系统快照或专用工具（Percona Backup for MongoDB、云厂商快照），`mongodump` 在这类体量上耗时以小时计，且会打满 IO。

### 8.4 现场排障

| 现象 | 第一条命令 | 定位方向 |
|---|---|---|
| 连接数打满 | `db.serverStatus().connections` | 连接池泄漏、每请求新建连接 |
| 查询变慢 | `db.currentOp({active:true, secs_running:{$gt:3}})` | 慢查询、缺索引 |
| 写入卡住 | `rs.status()` + `db.serverStatus().globalLock` | 主节点切换、写冲突 |
| 从节点延迟 | `rs.printSecondaryReplicationInfo()` | 大事务、批量写、网络 |
| 磁盘暴涨 | `db.stats(1024*1024*1024)` | oplog、TTL 失效、无压缩 |
| 内存不足 | `db.serverStatus().wiredTiger.cache` | working set 超 cache |

慢查询定位先开 profiler（只开慢日志级别，不要开全量）：

```javascript
db.setProfilingLevel(1, { slowms: 100 });
db.system.profile.find({ millis: { $gt: 500 } }).sort({ ts: -1 }).limit(5);
db.setProfilingLevel(0);
```

集合与索引体积：

```javascript
db.orders.stats(1024 * 1024);          // 单位 MB，看 size 与 totalIndexSize
db.orders.aggregate([{ $collStats: { storageStats: {} } }]);
```

删除大量文档后磁盘不降是正常的：WiredTiger 复用空洞。要真正回收，在从节点执行 `compact` 再切换主节点，禁止在主节点高峰执行：

```javascript
db.runCommand({ compact: "orders" });   // 阻塞该库写入，必须低峰或在从节点做
```

变更流（change streams）从 oplog 派生，是"监听订单状态变化推送到下游"的推荐方式，不需要轮询：

```javascript
const changeStream = db.orders.watch(
  [{ $match: { "operationType": { $in: ["insert", "update"] },
               "fullDocument.status": "paid" } }],
  { fullDocument: "updateLookup", readConcern: { level: "majority" } }
);
changeStream.on("change", c => console.log(c.documentKey, c.fullDocument));
```

> 边界：`compact` 会阻塞目标库的写入，云托管实例多数不开放该命令。变更流的 `resumeToken` 只在 oplog 窗口内有效，断流超过窗口必须全量重建下游。`readConcern: majority` + `updateLookup` 会多一次读，热点集合注意放大。

## 九、最佳实践案例

### 9.1 案例背景

一个社区团购平台，订单服务原本用 MySQL：订单主表加订单项子表，商品的多形态属性（规格、产地、团购批次）塞在 `JSON` 字段里。两年后出现三个问题：详情页要 3 次查询拼装，P95 480 ms；大促期间订单项表写入热点集中在自增主键尾部，锁等待明显；运营按 SKU 反查订单再聚合进日报，要在两张大表之间反复连接，慢查询频出。团队决定把"订单 + 订单项 + 属性快照"整体迁到 MongoDB 8.0，MySQL 继续承载结算与财务对账。

目标：详情页一次查询返回完整订单，P95 降到 80 ms 以内；下单链路保证"扣库存 + 写订单 + 写发件箱"原子；大促峰值 3000 TPS 下不出现写冲突雪崩。约束：财务系统仍读 MySQL，因此订单号是唯一跨系统关联键；停机窗口不超过 10 分钟。

建模的三个决定：订单项嵌入（有界、总是一起读、价格与规格要留快照）；库存与订单分集合（库存是热点、订单是冷数据，放一起会放大冲突）；列表与详情要用的字段全部冗余进文档，读路径不再有跨集合拼装。

### 9.2 案例实操

第一步，建集合与校验器。订单项上限 50，金额统一 `Decimal128`，`orderNo` 唯一：

```javascript
db.createCollection("orders", {
  validator: { $jsonSchema: {
    bsonType: "object",
    required: ["orderNo", "tenantId", "customerId", "status", "items", "amount", "createdAt"],
    properties: {
      orderNo: { bsonType: "string", maxLength: 32 },
      tenantId: { bsonType: ["long", "int"] },
      status: { enum: ["created", "paid", "shipped", "closed", "refunded"] },
      amount: { bsonType: "decimal" },
      items: { bsonType: "array", minItems: 1,
        items: { bsonType: "object", required: ["sku", "qty", "price"] } }
    }
  } },
  validationLevel: "strict"
});
db.orders.createIndex({ orderNo: 1 }, { unique: true });
db.orders.createIndex({ tenantId: 1, status: 1, createdAt: -1 }, { name: "idx_list" });
db.orders.createIndex({ "items.sku": 1, createdAt: -1 }, { name: "idx_sku_time" });
```

第二步，库存集合按 `sku` 做 `_id`，一个 SKU 一行。热点集中在这一个文档上，所以扣减必须用"条件更新"，把校验写进更新条件，天然防超卖：

```javascript
db.stock.insertMany([
  { _id: "SKU-1", available: 5000, reserved: 0, version: 0 },
  { _id: "SKU-7", available: 800,  reserved: 0, version: 0 }
]);
```

第三步，实现下单事务。用 Node.js 官方驱动（6.x），把库存、订单、发件箱放进一个事务：

```javascript
// place-order.js —— node place-order.js SO202611130001 SKU-1 2
const { MongoClient, Decimal128, Long } = require("mongodb");

const uri = "mongodb://shop_app:App%40123456@10.0.0.11:27017,10.0.0.12:27017,10.0.0.13:27017/shop"
          + "?replicaSet=rs0&authSource=shop&retryWrites=true";

async function main([orderNo, sku, qtyText]) {
  const qty = Number(qtyText);
  const client = new MongoClient(uri, { readPreference: "primary" });
  await client.connect();
  const db = client.db("shop");
  const session = client.startSession();

  try {
    await session.withTransaction(async () => {
      // 条件更新一次完成"判断 + 扣减"，避免先查后改的竞态
      const r = await db.collection("stock").updateOne(
        { _id: sku, available: { $gte: qty } },
        { $inc: { available: -qty, reserved: qty, version: 1 } },
        { session }
      );
      if (r.modifiedCount !== 1) {
        throw Object.assign(new Error(`OUT_OF_STOCK ${sku}`), { code: "OUT_OF_STOCK" });
      }

      const price = Decimal128.fromString("39.90");
      await db.collection("orders").insertOne({
        orderNo, tenantId: Long.fromNumber(42), customerId: Long.fromNumber(10086),
        status: "created",
        items: [{ sku, name: "赣南脐橙 5kg", qty, price }],
        amount: Decimal128.fromString((39.90 * qty).toFixed(2)),
        createdAt: new Date()
      }, { session });

      // 与订单同事务落发件箱，下游消费不依赖双写
      await db.collection("outbox").insertOne({
        type: "order.created", orderNo, sent: false, at: new Date()
      }, { session });
    }, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority", j: true },
      maxCommitTimeMS: 5000
    });
    console.log("OK", orderNo);
  } catch (e) {
    console.error("FAIL", e.code || e.message);
    process.exitCode = 1;
  } finally {
    await session.endSession();
    await client.close();
  }
}

main(process.argv.slice(2));
```

并发验证超卖：先把 SKU-1 的可用量改成 2，再同时起 20 个进程各抢 1 件，只有 2 个成功：

```javascript
db.stock.updateOne({ _id: "SKU-1" }, { $set: { available: 2, reserved: 0 } });
```

```bash
for i in $(seq 1 20); do
  node place-order.js "SO20261113$(printf '%04d' $i)" SKU-1 1 &
done
wait
```

```text
OK SO202611130001
OK SO202611130002
FAIL OUT_OF_STOCK SKU-1
...（其余 18 个全部 FAIL OUT_OF_STOCK）
```

```javascript
db.stock.findOne({ _id: "SKU-1" })
db.orders.countDocuments({ "items.sku": "SKU-1" })
```

```text
{ _id: 'SKU-1', available: 0, reserved: 2, version: 2 }
2
```

第四步，验证列表查询命中索引。用 `explain` 确认 `totalDocsExamined` 与返回数接近，并检查排序没有走内存：

```javascript
db.orders.find({ tenantId: NumberLong(42), status: "created" })
  .sort({ createdAt: -1 }).limit(20).explain("executionStats");
```

```text
winningPlan: { stage: 'LIMIT', inputStage: { stage: 'FETCH',
  inputStage: { stage: 'IXSCAN', keyPattern: { tenantId: 1, status: 1, createdAt: -1 } } } }
executionStats: { nReturned: 20, totalKeysExamined: 20, totalDocsExamined: 20 }
```

第五步，按 SKU 出日报并落汇总表。先跑一次补历史，之后每天增量：

```javascript
db.orders.aggregate([
  { $match: { tenantId: NumberLong(42), createdAt: { $gte: ISODate("2026-11-01") } } },
  { $unwind: "$items" },
  { $group: {
      _id: { day: { $dateTrunc: { date: "$createdAt", unit: "day", timezone: "Asia/Shanghai" } },
             sku: "$items.sku" },
      qty: { $sum: "$items.qty" },
      gmv: { $sum: { $multiply: ["$items.qty", "$items.price"] } }
  } },
  { $merge: { into: "daily_sku_sales", on: "_id",
              whenMatched: "replace", whenNotMatched: "insert" } }
], { allowDiskUse: true });
```

```javascript
db.daily_sku_sales.find({ "_id.sku": "SKU-1" }).sort({ "_id.day": -1 }).limit(2);
```

```text
{ _id: { day: ISODate("2026-11-12T16:00:00Z"), sku: 'SKU-1' }, qty: 842, gmv: Decimal128("33595.80") }
{ _id: { day: ISODate("2026-11-11T16:00:00Z"), sku: 'SKU-1' }, qty: 611, gmv: Decimal128("24378.90") }
```

第六步，用变更流驱动下游"已支付转发货单"，替代每分钟轮询：

```javascript
const cs = db.orders.watch([
  { $match: { operationType: "update", "fullDocument.status": "paid" } }
], { fullDocument: "updateLookup", readConcern: { level: "majority" } });
```

第七步，做一次从节点故障演练。`rs.stepDown(60)` 触发选举，观察应用重试是否透明：

```javascript
rs.stepDown(60, 5);   // 60 秒内不再当选，5 秒等待从节点追平
```

```text
{ ok: 1 }
# 应用侧 3 秒内出现 12 次 RetryableWriteError，全部由驱动自动重试成功，无业务报错
```

### 9.3 案例结果

| 指标 | 迁移前（MySQL） | 迁移后（MongoDB 8，示例） |
|---|---|---|
| 详情页 P95 | 480 ms | 62 ms |
| 下单写路径 | 3 张表 2 次事务 | 1 个事务 3 个集合 |
| 大促峰值 | 1200 TPS，锁等待上升 | 3000 TPS，无锁等待 |
| 按 SKU 反查订单 | 两表连接 + 聚合 | `items.sku` 索引命中 |
| 日报生成 | 25 min | 4 min（增量 `$merge`） |

失败模式与复盘，四条来自真实演练：

- 首版把 `orderNo` 只做普通索引，压测时出现两笔同号订单。改为唯一索引后，重复请求直接报 `E11000`，应用把它当幂等成功处理，问题消失。结论：业务唯一键必须由数据库兜底。
- 事务里最初写了"先 `findOne` 查库存再 `updateOne`"，20 并发下超卖 3 件。改成条件更新 `{ available: { $gte: qty } }` 后归零；`snapshot` 隔离只保证读到一致快照，不保证"检查与写入"原子。
- 客户端把 `withTransaction` 包在 `try/catch` 里打印日志后重新抛出普通错误，导致 `TransientTransactionError` 标签丢失，主从切换时 12 笔订单直接失败。改为不拦截、交给驱动重试后恢复。
- 订单集合曾把 `timeline` 数组无上限追加，单文档到 12 MB 后写入开始抖动。改为只保留最近 20 条，历史事件写独立集合，文档回落到 8 KB。

复盘结论：MongoDB 的性能来自"一次读取拿到聚合根"，代价是每条跨文档一致性都要显式设计；把关系模型逐表翻译过来，只会得到一个没有 JOIN 的关系库。
