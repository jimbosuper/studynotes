---
title: "SQL基础与查询优化"
category: "05-后端"
---

# SQL基础与查询优化

> 这篇从 SQL 的声明式执行模型讲起，经过环境与样例库、单表查询、连接与聚合、子查询与窗口函数、执行计划解读、索引设计与失效、慢查询治理，最后落到一个订单报表从 4.3 秒到 45 毫秒的完整优化案例。
>
> 学完能写出正确的多表查询与窗口函数，用 EXPLAIN 独立判断查询瓶颈，按访问路径设计索引，并把一条慢查询从定位到改写完整做完。

## 一、SQL 的声明式执行模型

SQL 描述"要什么结果"，不描述"怎么取"；优化器决定访问路径。优化写 SQL 的本质是给优化器提供它能用上的索引与统计信息，而不是教它按想象的顺序执行。

写在前面的语句顺序和实际执行顺序不同，优化之前必须先建立这个映射：

```text
书写顺序：SELECT → DISTINCT → FROM → JOIN → WHERE → GROUP BY → HAVING → ORDER BY → LIMIT
执行顺序：FROM → ON → JOIN → WHERE → GROUP BY → 聚合 → HAVING → SELECT → DISTINCT → ORDER BY → LIMIT
```

由此得出四条常用推论：

- `WHERE` 在 `GROUP BY` 之前执行，过滤条件放 `WHERE` 而不是 `HAVING`；
- 别名在 `SELECT` 里定义，`WHERE` 里不能用（`HAVING` 可以，但不推荐）；
- `ON` 与 `WHERE` 对内连接等价，对外连接不等价：`LEFT JOIN ... WHERE 右表.xx IS NOT NULL` 会把外连接退化成内连接；
- `LIMIT` 最后执行，前面的结果集多大它就扫描多大，深分页的问题出在 `LIMIT` 之前。

空值参与比较的三值逻辑（TRUE / FALSE / UNKNOWN）是 SQL 最常见的隐性 bug 来源：

```sql
SELECT COUNT(*) FROM orders WHERE coupon_id <> 100;   -- 不含 coupon_id IS NULL 的行
SELECT COUNT(*) FROM orders WHERE coupon_id <> 100
   OR coupon_id IS NULL;                              -- 与直觉一致的数量
SELECT NULL = NULL, NULL <> NULL, NULL IS NULL;       -- NULL NULL 1
```

> 边界：判断空值只能用 `IS NULL` / `IS NOT NULL`；聚合函数忽略 NULL，`COUNT(coupon_id)` 与 `COUNT(*)` 结果可能不同。可空列除非有明确语义，否则加 `NOT NULL DEFAULT`。

> 版本基线（2026-11）：MySQL 8.4 LTS（8.0 已于 2026-04 停止维护，企业新增负载应选 8.4）。本文全部 SQL 在 MySQL 8.4 验证语法；未标注"示例"的输出均为可复现结果。

## 二、环境与样例库

优化练习必须建立在真实数据量上：一百万行的表才看得见全表扫描、临时表和深分页的代价，一百行的表演示任何写法都是"很快"。

### 2.1 安装

| 环境 | 安装方式（2026-11） | 验证 |
|---|---|---|
| Windows 10/11 | MySQL 官网下载 MySQL Installer 8.4，选 Server only | `mysql --version` |
| macOS | `brew install mysql@8.4`，`brew services start mysql@8.4` | `mysql --version` |
| Ubuntu 24.04 | 官网装 `mysql-apt-config` 后 `sudo apt install mysql-community-server` | `mysql --version` |
| Rocky/CentOS 9 | 官网装 mysql84-community yum 源后 `sudo dnf install mysql-community-server` | `mysql --version` |

已有 Docker 的环境一条命令起一个 8.4 实例，练习完整体丢弃：

```bash
docker run -d --name mysql84 \
  -e MYSQL_ROOT_PASSWORD=pass1234 \
  -e MYSQL_DATABASE=shop \
  -p 3306:3306 mysql:8.4
docker exec -it mysql84 mysql -uroot -p shop
```

### 2.2 样例库

四张表构成一个最小电商订单模型，后续所有查询都基于它：

```sql
CREATE DATABASE shop DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE shop;

CREATE TABLE customers (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(64)  NOT NULL,
  level       TINYINT      NOT NULL DEFAULT 1,      -- 会员等级
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_level (level)
) ENGINE=InnoDB;

CREATE TABLE products (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title       VARCHAR(128) NOT NULL,
  category    VARCHAR(32)  NOT NULL,
  price       DECIMAL(10,2) NOT NULL,
  KEY idx_category (category)
) ENGINE=InnoDB;

CREATE TABLE coupons (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code        CHAR(12)      NOT NULL,
  discount    DECIMAL(8,2)  NOT NULL,
  UNIQUE KEY uk_code (code)
) ENGINE=InnoDB;

CREATE TABLE orders (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_no     CHAR(20)     NOT NULL,
  customer_id  BIGINT UNSIGNED NOT NULL,
  status       TINYINT      NOT NULL,       -- 0待支付 1已支付 2已发货 3已完成
  amount       DECIMAL(10,2) NOT NULL,
  coupon_id    BIGINT UNSIGNED NULL,
  created_at   DATETIME    NOT NULL,
  UNIQUE KEY uk_order_no (order_no),
  KEY idx_customer (customer_id),
  KEY idx_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE order_items (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id     BIGINT UNSIGNED NOT NULL,
  product_id   BIGINT UNSIGNED NOT NULL,
  quantity     INT          NOT NULL,
  unit_price   DECIMAL(10,2) NOT NULL,
  KEY idx_order (order_id),
  KEY idx_product (product_id)
) ENGINE=InnoDB;
```

数据用"倍增插入"生成：一条语句复制一倍，二十几条语句就能到百万行，比存储过程逐行插入快几个数量级：

```sql
-- 基础数据
INSERT INTO customers (name, level) VALUES
  ('张三', 1), ('李四', 2), ('王五', 3), ('赵六', 2), ('钱七', 1);

INSERT INTO products (title, category, price) VALUES
  ('机械键盘', '数码', 399.00), ('无线鼠标', '数码', 129.00),
  ('纯棉T恤', '服饰', 89.00),   ('运动水壶', '户外', 49.00);

-- 种子行：倍增插入必须从一行开始
INSERT INTO orders (order_no, customer_id, status, amount, coupon_id, created_at)
VALUES ('SN2026000001', 1, 1, 199.00, NULL, '2026-06-01 10:00:00');

-- 倍增：每执行一次行数翻倍，连续执行 20 次约 104 万行
INSERT INTO orders (order_no, customer_id, status, amount, coupon_id, created_at)
SELECT CONCAT('SN', LPAD(FLOOR(RAND() * 1000000000000000), 15, '0')),  -- 15 位随机单号，避免倍增时唯一键冲突
       FLOOR(1 + RAND() * 5),
       ELT(1 + FLOOR(RAND() * 4), 0, 1, 2, 3),
       ROUND(RAND() * 500 + 20, 2),
       IF(RAND() < 0.3, FLOOR(1 + RAND() * 100), NULL),
       DATE_ADD('2026-05-01', INTERVAL FLOOR(RAND() * 180) DAY)
         + INTERVAL FLOOR(RAND() * 86400) SECOND
FROM orders;

-- 明细按订单生成；同一条语句执行 3 次，约 300 万行
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT id, FLOOR(1 + RAND() * 4), 1 + FLOOR(RAND() * 3), ROUND(RAND() * 300 + 10, 2)
FROM orders;

-- 生成统计信息，优化器按真实分布做决策
ANALYZE TABLE orders, order_items, customers;
```

预期输出（最后一条）：

```text
+-----------+---------+----------+----------+
| Table     | Op      | Msg_type | Msg_text |
+-----------+---------+----------+----------+
| shop.orders | analyze | status   | OK       |
+-----------+---------+----------+----------+
```

> 边界：练习库用 `DATE_ADD` 随机分布时间；生产数据往往有"最近数据集中"的倾斜，优化时要按生产的真实分布验证，不要拿均匀分布的结论上线。

## 三、单表查询与常见陷阱

单表查询的优化目标是让 `WHERE` 条件命中索引，让排序复用索引顺序；先把这些基础写对，多表问题才有优化的意义。

### 3.1 过滤、排序与投影

```sql
-- 只取需要的列：覆盖索引的前提是查询列足够窄
SELECT order_no, amount FROM orders
WHERE status = 1 AND created_at >= '2026-10-01'
ORDER BY created_at DESC
LIMIT 20;
```

`LIKE` 前导通配符无法走 B+ 树索引，这是最高频的索引失效场景：

```sql
WHERE order_no LIKE 'SN20261%'   -- 走 uk_order_no 范围扫描
WHERE order_no LIKE '%0123'      -- 全表/全索引扫描
```

### 3.2 隐式类型转换

字符列与数字比较时，MySQL 把每一行的列值转成数字，等价于对列套函数，索引失效：

```sql
SELECT * FROM orders WHERE order_no = 20261113000001;   -- 隐式转换，索引失效
SELECT * FROM orders WHERE order_no = '20261113000001'; -- 类型一致，走唯一索引
```

预期输出（EXPLAIN 对比，示例数据 104 万行）：

| 条件 | type | key | rows | Extra |
|---|---|---|---|---|
| `order_no = 20261113000001` | ALL | NULL | 1048576 | Using where |
| `order_no = '20261113000001'` | const | uk_order_no | 1 | NULL |

日期与字符串同理：`created_at >= '2026-10-01'` 是安全的常量折叠，`DATE(created_at) = '2026-10-01'` 则对列套函数。过滤条件尽量写成"裸列 + 操作符 + 常量"。

### 3.3 深分页

`LIMIT 900000, 20` 要先算出前 900020 行再丢弃 900000 行，代价随偏移线性增长：

```sql
-- 逐页扫描：偏移越大越慢
SELECT id, order_no, amount FROM orders
ORDER BY id LIMIT 900000, 20;

-- 延迟关联：先用覆盖索引定位 20 个 id，再回表取列
SELECT o.*
FROM orders o
JOIN (SELECT id FROM orders ORDER BY id LIMIT 900000, 20) t ON o.id = t.id;

-- 游标分页：记住上一页末尾，扫描量恒定
SELECT id, order_no, amount FROM orders
WHERE id > 900000
ORDER BY id LIMIT 20;
```

三种写法的适用面不同：延迟关联兼容"跳页"的交互，游标分页最快但只能顺序翻页。列表页能用"下一页"就不要做"跳到第 N 页"。

> 边界：`LIMIT` 不带 `ORDER BY` 时结果顺序不保证，翻页会丢行或重复；分页必须与唯一排序键绑定。

## 四、连接与聚合

多表查询的正确性取决于连接条件，性能取决于驱动表和小结果集；聚合的坑集中在 `GROUP BY` 的语义上。

### 4.1 三种连接

```sql
-- 内连接：订单与会员，条件放 ON 或 WHERE 等价
SELECT o.order_no, c.name
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.status = 1;

-- 左连接：保留没有明细的订单（报表必须保留总量口径）
SELECT o.order_no, COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS item_total
FROM orders o
LEFT JOIN order_items oi ON oi.order_id = o.id
GROUP BY o.id;

-- 反连接：从未下过单的会员
SELECT c.*
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
WHERE o.id IS NULL;
```

对 `LEFT JOIN` 的右表再在 `WHERE` 里加非空条件，会把外连接悄悄变成内连接，报表口径随之改变：

```sql
-- 这条等价于 INNER JOIN：coupon_id IS NULL 的行被过滤掉了
SELECT * FROM orders o
LEFT JOIN coupons cp ON cp.id = o.coupon_id
WHERE cp.discount > 0;
```

### 4.2 GROUP BY 与 ONLY_FULL_GROUP_BY

MySQL 8.0 起 `ONLY_FULL_GROUP_BY` 默认开启：`SELECT` 里的非聚合列必须出现在 `GROUP BY` 里。这条 SQL 模式拦住了大量"随机取一行"的隐患：

```sql
-- 报错：ERROR 1055 -- SELECT 列表里 status 不在 GROUP BY 中
SELECT customer_id, status, COUNT(*) FROM orders GROUP BY customer_id;

-- 正确：要么聚合，要么进 GROUP BY
SELECT customer_id, status, COUNT(*) FROM orders GROUP BY customer_id, status;

-- 只要每个会员一条，用窗口函数或 ANY_VALUE() 显式表达
SELECT customer_id, ANY_VALUE(status) AS a_status, COUNT(*) FROM orders GROUP BY customer_id;
```

`HAVING` 在聚合之后执行，过滤聚合结果的写法：

```sql
SELECT customer_id, COUNT(*) AS cnt, SUM(amount) AS total
FROM orders
WHERE status IN (1, 2, 3)              -- 行级过滤放 WHERE，先减数据量
GROUP BY customer_id
HAVING COUNT(*) >= 10 AND SUM(amount) > 1000;   -- 聚合结果过滤
```

### 4.3 自连接算同比

```sql
-- 本月与上月对比：先各自聚合，再按客户对齐
SELECT a.customer_id, a.month_total, b.month_total,
       ROUND(100 * (a.month_total - b.month_total) / NULLIF(b.month_total, 0), 1) AS pct
FROM (SELECT customer_id, SUM(amount) month_total
      FROM orders WHERE created_at >= '2026-10-01' AND created_at < '2026-11-01'
      GROUP BY customer_id) a
JOIN (SELECT customer_id, SUM(amount) month_total
      FROM orders WHERE created_at >= '2026-09-01' AND created_at < '2026-10-01'
      GROUP BY customer_id) b ON b.customer_id = a.customer_id;
```

`NULLIF` 防除零返回 `NULL`，报表端按"无环比"处理。

> 边界：连接列类型必须一致（都 `BIGINT UNSIGNED`），隐式转换不仅丢索引，还可能丢行。跨表关联先核对 `SHOW CREATE TABLE`，再写 SQL。

## 五、子查询、CTE 与窗口函数

子查询解决"先算中间结果再查询"，CTE 让复杂逻辑可读，窗口函数解决"分组内逐行计算"，三者组合能替代大部分临时表和应用层循环。

### 5.1 子查询的四种形态

```sql
-- 标量子查询：单行单列，当常量用
SELECT (SELECT MAX(amount) FROM orders) AS max_amount;

-- IN / NOT IN：注意 NULL 会让 NOT IN 整体返回空，反连接优先用 NOT EXISTS
SELECT * FROM customers c
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);

-- 派生表：先聚合再连接，把"明细级 JOIN"降为"结果级 JOIN"
SELECT c.name, t.total
FROM customers c
JOIN (SELECT customer_id, SUM(amount) total
      FROM orders GROUP BY customer_id) t ON t.customer_id = c.id;

-- LATERAL：对左表每一行执行一次右侧子查询（8.0.14+），取"每类前 N"
SELECT p.category, p.title, top_orders.order_no
FROM products p,
     LATERAL (SELECT o.order_no FROM order_items oi
              JOIN orders o ON o.id = oi.order_id
              WHERE oi.product_id = p.id
              ORDER BY o.created_at DESC LIMIT 3) top_orders;
```

### 5.2 CTE 与递归

```sql
-- 普通 CTE：命名中间结果，长查询的可读性工具
WITH paid AS (
  SELECT * FROM orders WHERE status IN (1, 2, 3)
),
by_customer AS (
  SELECT customer_id, SUM(amount) AS total FROM paid GROUP BY customer_id
)
SELECT c.name, b.total
FROM by_customer b JOIN customers c ON c.id = b.customer_id
ORDER BY b.total DESC LIMIT 10;

-- 递归 CTE：生成日期序列，做"无数据也要有行"的报表骨架
WITH RECURSIVE days AS (
  SELECT DATE('2026-11-01') AS d
  UNION ALL
  SELECT d + INTERVAL 1 DAY FROM days WHERE d < '2026-11-13'
)
SELECT days.d, COUNT(o.id) AS order_cnt
FROM days
LEFT JOIN orders o ON DATE(o.created_at) = days.d
GROUP BY days.d;
```

递归默认上限 1000 层，需要更长序列时 `SET SESSION cte_max_recursion_depth = 100000;`。

### 5.3 窗口函数

窗口函数在"保留每一行"的前提下计算分组内的统计，`GROUP BY` 做不到这一点。语法是 `函数(...) OVER (PARTITION BY ... ORDER BY ...)`。

```sql
SELECT customer_id, order_no, amount,
       ROW_NUMBER() OVER w AS rn,          -- 连续不重复：1,2,3
       RANK()       OVER w AS rk,          -- 并列同名次，跳号：1,1,3
       DENSE_RANK() OVER w AS drk,         -- 并列不跳号：1,1,2
       SUM(amount) OVER w AS running,      -- 累计金额
       LAG(amount)  OVER w AS prev_amount  -- 上一单金额
FROM orders
WHERE status IN (1, 2, 3)
WINDOW w AS (PARTITION BY customer_id ORDER BY created_at);
```

三个高频应用：

```sql
-- 1. 每个客户最近一笔订单（去重取最新）
SELECT * FROM (
  SELECT o.*, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created_at DESC) rn
  FROM orders o WHERE status IN (1, 2, 3)
) t WHERE rn = 1;

-- 2. 每类商品销量 Top 3
SELECT * FROM (
  SELECT p.category, p.title,
         SUM(oi.quantity) AS sold,
         DENSE_RANK() OVER (PARTITION BY p.category ORDER BY SUM(oi.quantity) DESC) drk
  FROM order_items oi
  JOIN products p ON p.id = oi.product_id
  GROUP BY p.category, p.title
) t WHERE drk <= 3;

-- 3. 各等级会员消费的组内占比
SELECT c.level, SUM(o.amount) AS total,
       ROUND(100 * SUM(o.amount) / SUM(SUM(o.amount)) OVER (), 1) AS pct
FROM orders o JOIN customers c ON c.id = o.customer_id
WHERE o.status IN (1, 2, 3)
GROUP BY c.level;
```

窗口函数的 `OVER` 里只能放分区和排序，不能放行级过滤；需要"按窗口结果筛选"时套一层子查询，像上面 `rn = 1` 那样。

> 边界：窗口函数在结果集上计算，无法减少扫描量；对千万行的窗口排序要先在 `WHERE` 里把行数减下来。`GROUP_CONCAT` 有 `group_concat_max_len`（默认 1024）截断，超长拼接不要依赖它。

## 六、执行计划

`EXPLAIN` 展示优化器选择的访问路径；读执行计划的顺序是 `type → key → rows → Extra`，四项就能定位绝大多数问题。

### 6.1 EXPLAIN 输出

```sql
EXPLAIN
SELECT o.order_no, c.name
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.customer_id = 3;
```

预期输出（节选）：

```text
id | select_type | table | type | possible_keys  | key          | rows | Extra
 1 | SIMPLE      | o     | ref  | idx_customer   | idx_customer |  20  | NULL
 1 | SIMPLE      | c     | eq_ref| PRIMARY       | PRIMARY      |   1  | NULL
```

`type` 从好到坏的序列与含义：

| type | 含义 | 出现时该做什么 |
|---|---|---|
| system / const | 主键或唯一键等值命中 | 无需优化 |
| eq_ref | 被驱动表按主键/唯一键关联 | 无需优化 |
| ref | 普通索引等值命中 | 正常 |
| range | 索引范围扫描 | 关注扫描行数 |
| index | 全索引扫描 | 通常需要改条件 |
| ALL | 全表扫描 | 优先加索引或改写 |

`Extra` 的关键取值：

| Extra | 含义 | 处理 |
|---|---|---|
| Using index | 覆盖索引，不回表 | 目标状态 |
| Using index condition | 索引条件下推（ICP） | 正常且良好 |
| Using where | 服务层过滤 | 看 rows 是否过大 |
| Using temporary | 临时表 | GROUP BY/ORDER BY 列无索引 |
| Using filesort | 额外排序 | 排序列加索引或复用索引序 |
| Using join buffer (hash join) | 被驱动表无索引 | 给关联列加索引 |

### 6.2 EXPLAIN ANALYZE

`EXPLAIN ANALYZE` 真正执行查询并输出每一步的实际行数与耗时，是判断"优化器估错"和"哪个算子贵"的直接证据：

```sql
EXPLAIN ANALYZE
SELECT c.name, SUM(o.amount) AS total
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.created_at >= '2026-11-01'
GROUP BY c.name;
```

示例输出（百万行数据，4C8G 虚机）：

```text
-> Table scan on <temporary>  (actual time=312.5..312.6 rows=5 loops=1)
-> Temporary  (actual time=312.4..312.5 rows=5 loops=1)
    -> Group aggregate: sum(orders.amount)  (actual time=233.1..312.3 rows=5 loops=1)
        -> Hash inner join (customers.id = orders.customer_id)
            (actual time=0.6..289.4 rows=42190 loops=1)
            -> Index scan on customers using PRIMARY  (actual time=0.1..0.1 rows=5 loops=1)
            -> Filter: (orders.created_at >= '2026-11-01')
                (actual time=0.3..241.2 rows=42190 loops=1)
                -> Index range scan on orders using idx_created
                    (actual time=0.3..185.9 rows=42190 loops=1)
```

从下往上读：范围扫描 42190 行、Hash join 之后聚合、最后落临时表。要提速，目标是让 `Filter` 剩下的行数更少或让扫描直接使用更窄的索引。

> 边界：`EXPLAIN ANALYZE` 会真实执行 DML 语义的 SELECT（包括锁等待），生产高峰期只对只读查询使用。树形输出里 `estimated rows` 与 `actual rows` 差距大时，先 `ANALYZE TABLE` 更新统计信息。

### 6.3 干预优化器

统计信息更新后仍选错索引时，用提示词（hint）干预，并把原因写进注释：

```sql
-- 强制走指定索引（验证后尽快移除）
SELECT * FROM orders USE INDEX (idx_created)
WHERE customer_id = 3 AND created_at >= '2026-10-01';

-- 固定连接顺序
SELECT STRAIGHT_JOIN c.name, COUNT(*) FROM customers c
JOIN orders o ON o.customer_id = c.id GROUP BY c.name;

-- 索引可见性开关：上线前验证"删掉这个索引"的影响
ALTER TABLE orders ALTER INDEX idx_created INVISIBLE;
-- 验证完恢复
ALTER TABLE orders ALTER INDEX idx_created VISIBLE;
```

`INVISIBLE` 是安全的索引下线演练：优化器忽略它但索引仍在维护，回滚只需一条 `VISIBLE`。确认无影响后再真正 `DROP INDEX`。

## 七、索引设计与失效场景

InnoDB 的二级索引是 B+ 树，叶子节点存索引列与主键；查询需要的列不在索引里就要回表。索引设计的全部目标可以概括成一句：**让过滤、排序、覆盖尽量发生在同一棵索引树上**。

### 7.1 设计规则

- 联合索引遵循最左前缀：`(customer_id, status, created_at)` 支持 `customer_id`、`customer_id + status`、三者组合，不支持单独 `created_at`；
- 区分度高的列在前，等值列在范围列前面：`WHERE customer_id = ? AND created_at >= ?` 对应 `(customer_id, created_at)`；
- 排序列接在等值列后面，让 `ORDER BY` 复用索引序，消掉 filesort；
- 覆盖索引：高频列表查询把 `SELECT` 的列并入索引，代价是索引变宽、写入变慢；
- 单表索引控制在 5 个以内：每个索引都拖慢写入并占用空间。

```sql
-- 为"客户的状态订单按时间倒序"设计
ALTER TABLE orders ADD INDEX idx_cust_status_created (customer_id, status, created_at);

-- 等值 + 范围 + 排序组合验证
EXPLAIN SELECT id, order_no, amount FROM orders
WHERE customer_id = 3 AND status = 1
ORDER BY created_at DESC LIMIT 20;
-- type=ref, key=idx_cust_status_created, Extra 无 Using filesort
```

### 7.2 索引失效的高频场景

| 写法 | 结果 | 改法 |
|---|---|---|
| `WHERE DATE(created_at) = '2026-11-01'` | 对列套函数，失效 | 范围条件 `>=` 且 `< 次日` |
| `WHERE order_no = 20261113000001` | 隐式转换，失效 | 常量加引号，类型对齐 |
| `WHERE a = 1 OR b = 2`（a、b 各有索引） | 可能全表扫 | 拆成 `UNION ALL` |
| `LIKE '%xx'` | 前导通配，失效 | 改搜索方案或反向存储 |
| `WHERE customer_id IN (1,2,...,10000)` | 索引仍可用但计划退化 | 缩小集合或走批量接口 |
| 联合索引不满足最左前缀 | 不用该索引 | 调整条件或补索引 |

`OR` 两侧条件分别命中不同索引时，MySQL 可以用 index merge，但实际常见的是退化全表扫；确定瓶颈后改成 `UNION ALL` 两路各走各的索引。

### 7.3 索引条件下推与函数索引

ICP（Index Condition Pushdown）把 `WHERE` 中能用索引列判断的部分下推到存储引擎层，减少回表次数，`Extra` 显示 `Using index condition`：

```sql
-- 假设有索引 (a, b)，查询 WHERE a = 1 AND b LIKE '%x%'
-- 命中 a 的范围后，b 的判断在引擎层完成，不满足的行不回表
```

对确实需要按表达式查询的列，用函数索引（8.0.13+）替代改表：

```sql
ALTER TABLE orders ADD INDEX idx_created_date ((DATE(created_at)));
EXPLAIN SELECT COUNT(*) FROM orders WHERE DATE(created_at) = '2026-11-01';
-- key=idx_created_date，不再全表扫
```

> 边界：函数索引存的是表达式结果，写入开销翻倍，只给确实高频的表达式查询建。所有"加索引"决策都要同时评估写入放大：`INSERT` 每多一个索引就多维护一棵树。

## 八、慢查询治理

慢查询治理是一条流水线：开启慢日志定位语句 → 聚合出 Top N → 逐条用 EXPLAIN 分析 → 改索引或改写 → 回归验证。

### 8.1 打开慢日志

```sql
SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 0.5;             -- 超过 0.5 秒记录
SET GLOBAL log_queries_not_using_indexes = ON; -- 不走索引的也记（排查期打开）
SHOW VARIABLES LIKE 'slow_query_log_file';
```

```bash
# 实时跟踪（Ctrl-C 退出）
tail -f /var/lib/mysql/<hostname>-slow.log
```

### 8.2 聚合分析

`pt-query-digest` 把慢日志按"语句指纹"聚合并排序，治理从第一名开始：

```bash
pt-query-digest /var/lib/mysql/<hostname>-slow.log | head -40
```

示例输出（节选）：

```text
Rank  Query ID           Response time   Calls  R/Call   V/M
===== ================== =============== ====== ======== =====
    1 0x8A2B...         4312.0000 45.2%    912   4.7281  0.02
    2 0xF10C...         1902.0000 19.9%   5214   0.3648  0.05
```

Rank 1 占了 45% 的总响应时间，一条语句平均 4.7 秒，先治理它。

线上没开慢日志时，用 Performance Schema 按摘要（digest）补位：

```sql
SELECT DIGEST_TEXT                         AS query,
       COUNT_STAR                          AS calls,
       ROUND(SUM_TIMER_WAIT / 1e12, 1)     AS total_s,
       ROUND(AVG_TIMER_WAIT / 1e9, 1)      AS avg_ms
FROM performance_schema.events_statements_summary_by_digest
ORDER BY SUM_TIMER_WAIT DESC
LIMIT 5;
```

### 8.3 三类可复用的改写模式

```sql
-- 模式一：深分页 → 延迟关联 / 游标
SELECT o.* FROM orders o
JOIN (SELECT id FROM orders WHERE status = 1 ORDER BY id LIMIT 900000, 20) t
  ON o.id = t.id;

-- 模式二：明细级 JOIN 聚合 → 先聚合再 JOIN
-- 慢：JOIN 后每行参与 GROUP BY
SELECT c.name, SUM(oi.quantity * oi.unit_price)
FROM orders o
JOIN customers c ON c.id = o.customer_id
JOIN order_items oi ON oi.order_id = o.id
GROUP BY c.id;
-- 快：先在小结果集上聚合
SELECT c.name, t.total
FROM (SELECT order_id, SUM(quantity * unit_price) total
      FROM order_items GROUP BY order_id) t
JOIN orders o ON o.id = t.order_id
JOIN customers c ON c.id = o.customer_id
GROUP BY c.id;

-- 模式三：OR 跨列 → UNION ALL
SELECT * FROM orders WHERE order_no = 'SN2026123400'
UNION ALL
SELECT * FROM orders WHERE coupon_id = 34;
```

> 边界：改写完成后必须核对结果一致（行数、合计、抽样比对），优化器语义等价不等于业务口径等价；`UNION ALL` 需要人工保证两路不重复，可能重复时要 `UNION`。

## 九、最佳实践案例

### 9.1 案例背景

一个电商订单中台的后台列表页，运营反馈"订单查询经常转圈十几秒"。数据库是 MySQL 8.4，四张表按第二章的样例结构建库，`orders` 约 100 万行、`order_items` 约 300 万行。故障时段慢日志中排名第一的语句占了 45% 的数据库时间，平均 4.3 秒。目标是在不改表结构语义、不改接口的前提下把该查询压到 100 毫秒以内，并沉淀成团队可复用的索引与改写规范。约束：白天不能执行 `ALTER TABLE` 以外的批量任务；列表页必须支持按时间倒序和跳页。

### 9.2 案例实操

第一步，取出目标 SQL 并确认口径。列表页展示订单号、客户名、下单时间、商品总额与状态，按时间倒序分页：

```sql
SELECT o.id, o.order_no, c.name AS customer_name, o.status,
       o.created_at, SUM(oi.quantity * oi.unit_price) AS item_total
FROM orders o
JOIN customers c ON c.id = o.customer_id
LEFT JOIN order_items oi ON oi.order_id = o.id
WHERE o.created_at >= '2026-05-01'
GROUP BY o.id, c.name
ORDER BY o.created_at DESC
LIMIT 900000, 20;
```

第二步，看执行计划。`EXPLAIN ANALYZE` 的示例输出（示例数据 100 万订单，4C8G 虚机）：

```text
-> Limit: 20 row(s)  (actual time=4280.1..4280.2 rows=20 loops=1)
    -> Sort: orders.created_at DESC, offset 900000  (actual time=4279.8..4279.8 rows=900020)
        -> Stream results  (actual time=0.4..3601.5 rows=900020 loops=1)
            -> Group aggregate: sum(oi.quantity * oi.unit_price)
               (actual time=0.5..3392.7 rows=900020 loops=1)
                -> Left hash join (oi.order_id = o.id)
                   (actual time=0.8..2900.4 rows=2510300 loops=1)
                    -> Index range scan on orders using idx_created
                       (actual time=0.3..410.2 rows=900020 loops=1)
                    -> Table scan on oi  (actual time=0.2..1800.6 rows=3000000 loops=1)
```

三个问题：驱动侧范围扫描出 90 万订单就为了取 20 行；`order_items` 全表扫 300 万行做 Hash join；`GROUP BY o.id` 之上再排序 90 万行。任何一步都不是"取 20 行"该有的代价。

第三步，按依赖顺序改写。两个要点：把"明细级 JOIN + GROUP BY"从主查询剥离，只对当前页的 20 个订单聚合；把深分页改成"覆盖索引取 id → 回表取列"的延迟关联。`page` 会被主查询和明细聚合各引用一次，用 CTE 一次定义、两处引用：

```sql
WITH page AS (
  SELECT id FROM orders
  WHERE created_at >= '2026-05-01'
  ORDER BY created_at DESC
  LIMIT 900000, 20
),
item_totals AS (
  SELECT oi.order_id, SUM(oi.quantity * oi.unit_price) AS item_total
  FROM order_items oi
  JOIN page p ON p.id = oi.order_id     -- 只聚合 20 个订单的明细
  GROUP BY oi.order_id
)
SELECT o.id, o.order_no, c.name AS customer_name, o.status,
       o.created_at, it.item_total
FROM page
JOIN orders o     ON o.id = page.id
JOIN customers c  ON c.id = o.customer_id
LEFT JOIN item_totals it ON it.order_id = o.id;
```

第四步，核对索引。改写方案需要 `page` 能在索引上直接定位 `id`；InnoDB 的二级索引叶子节点本来就包含主键，`idx_created (created_at)` 已经覆盖 `(created_at, id)`，不需要新建索引。先加后删的教训保留在复盘里；确认现有索引可用的依据是执行计划：

```sql
EXPLAIN FORMAT=TREE
SELECT id FROM orders
WHERE created_at >= '2026-05-01'
ORDER BY created_at DESC
LIMIT 900000, 20;
```

示例输出：

```text
-> Limit: 20 row(s)  (cost=90123 rows=20)
    -> Index range scan on orders using idx_created (reverse)  (cost=90123 rows=900020)
```

无 `Using filesort`、无回表列，`idx_created` 直接满足定位需求。

第五步，验证改写后的计划与结果。`EXPLAIN ANALYZE` 的示例输出：

```text
-> Nested loop left join  (actual time=46.8..48.3 rows=20 loops=1)
    -> Nested loop inner join  (actual time=45.9..47.1 rows=20 loops=1)
        -> Limit: 20 row(s)  (actual time=41.5..41.6 rows=20 loops=1)
            -> Index range scan on orders using idx_created (created_at DESC)
               (actual time=0.4..41.2 rows=900020 loops=1)
        -> Single-row index lookup on orders using PRIMARY (o.id = page.id)  (rows=1)
    -> Index lookup on item_totals using <auto_key0>  (rows=1)
```

关键变化：明细聚合从 300 万行降到 20 个订单的约 60 行；主查询不再有 90 万行的 `GROUP BY` 与 `Sort`。`page` 仍要扫过 90 万索引条目，这是支持"跳页"的固定代价。

第六步，结果一致性核对。优化后的语句必须与原语句逐页对账，用同一页的计数与合计做校验和（片段：两个括号内分别替换为改写前、改写后的完整语句）：

```sql
SELECT 'old' AS ver, COUNT(*) AS cnt, SUM(id) AS id_sum, SUM(item_total) AS total_sum
FROM ( /* 改写前的完整语句 */ ) x
UNION ALL
SELECT 'new', COUNT(*), SUM(id), SUM(item_total)
FROM ( /* 改写后的完整语句 */ ) y;
-- 两行结果必须完全一致；再抽查第 1 页、最后一页与偏移 = 总数-20 的边界页
```

### 9.3 案例结果

| 指标 | 优化前 | 优化后（示例数据） |
|---|---|---|
| 列表页 P95 | 4.3 s | 48 ms |
| 扫描行数 | 约 390 万 | 约 90 万索引条目 + 80 行 |
| 临时表/排序 | 90 万行 Sort | 无 |
| 明细聚合范围 | 全量 300 万行 | 单页 20 单 |
| 索引数量变化 | — | 0（未新增） |

失败模式与复盘：第一版直接把 `LEFT JOIN` 改成先 `page` 再逐单聚合，但漏了"无明细订单也要显示"的口径，`INNER JOIN` 让 12% 的订单从列表消失，用回 `LEFT JOIN` 并以抽页核对兜底。第二版只加了一个 `(created_at, id)` 索引，没有改写 SQL，优化器仍然先做 90 万行聚合，耗时只降到 3.1 秒；而且这个索引与 `idx_created` 在 InnoDB 里完全重复——二级索引叶子本来就带主键，等于白付一份写入开销，验证后立即删除。结论是索引救不了错误的执行顺序，必须先改写再判断是否真的缺索引。最终版本里 `page` 的偏移扫描仍在，这是"跳页"交互的本性；产品确认运营只有"下一页"场景后，追加游标模式 `WHERE (created_at, id) < (:last_created, :last_id) ORDER BY created_at DESC, id DESC LIMIT 20`，示例数据下稳定在 3 毫秒。沉淀三条规范：列表页禁止"明细级 JOIN + GROUP BY"聚合；深分页默认延迟关联，产品确认无跳页需求后切游标；上线前用 `EXPLAIN ANALYZE` 对比行数与算子，不只看总耗时。
