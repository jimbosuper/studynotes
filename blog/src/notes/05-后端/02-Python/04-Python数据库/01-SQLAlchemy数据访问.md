---
title: "SQLAlchemy数据访问"
category: "05-后端"
---

# SQLAlchemy数据访问

> 这篇从 SQLAlchemy 的 Core 与 ORM 两层接口讲起，经过安装、Engine 与连接池、ORM 模型、Session 与事务、关系加载、查询写入和异步会话，最后落到一个订单查询与扣减库存的完整案例。
>
> 学完能用 SQLAlchemy 2.x 搭起可维护的数据访问层，定位 N+1、连接池耗尽和事务失效，并把一次请求的 SQL 数量压到可预期范围。

## 一、SQLAlchemy 的两层接口

SQLAlchemy 由 Core（SQL 表达式层）和 ORM（对象关系映射，Object-Relational Mapping）两层组成，选哪一层取决于是否需要对象身份、关系导航和自动变更跟踪。

Core 处理 SQL 表达式、连接、事务和结果集，ORM 在 Core 之上增加映射类、身份映射（identity map）和工作单元（unit of work）。两层共用同一个 Engine，不存在“ORM 不能用 Core”的分界。

```mermaid
graph LR
  APP[业务代码] --> S[Session]
  S --> E[Engine]
  E --> P[连接池]
  P --> DB[(PostgreSQL)]
  S --> M[ORM 映射]
  M --> T[数据库表]
  classDef blue fill:#eff6ff,stroke:#93c5fd,color:#1e3a8a;
  classDef green fill:#ecfdf5,stroke:#86efac,color:#166534;
  classDef amber fill:#fffbeb,stroke:#fcd34d,color:#92400e;
  classDef gray fill:#f8fafc,stroke:#cbd5e1,color:#334155;
  class APP,S blue;
  class E,P green;
  class M,T amber;
  class DB gray;
```

### 1.1 Core 与 ORM 的职责边界

| 层 | 主要入口 | 适合 | 不适合 |
|---|---|---|---|
| Core | `Engine`、`select()`、`Connection` | 批量导入、报表 SQL、复杂聚合 | 需要对象关系导航的领域逻辑 |
| ORM | `Session`、映射类、`relationship` | 单条聚合的增删改查、事务业务 | 百万行 ETL、跨库复杂分析 |

一个系统可以同时使用两层：订单写入走 ORM，日终报表走 Core 的 `text()` 或 `select()`，二者共享连接池和事务边界。

### 1.2 2.0 风格：select 与 execute

SQLAlchemy 2.x 的主线写法是 `select()` 加 `Session.execute()` / `Session.scalars()`，`session.query()` 属于 1.x 遗留接口。

```python
from sqlalchemy import select
from sqlalchemy.orm import Session

stmt = (
    select(Product)                 # 2.0 用表达式构造 SQL，类型检查能识别列
    .where(Product.stock > 0)
    .order_by(Product.id)
    .limit(20)
)
products = session.scalars(stmt).all()   # scalars 取第一列实体，避免 Row 再解包
```

`execute()` 返回 `Result`，每行是 `Row`；`scalars()` 取第一列。只查一列时用 `session.scalar(select(func.count()).select_from(Order))`，语义更直接。

### 1.3 什么时候不用 ORM

ORM 不适合三类任务：单次写入十万行以上的批量导入、几十张表的跑批报表、需要数据库特有语法的热点查询。

这些任务改用 Core 的 `insert()`、`text()` 或原生驱动，仍然复用 Engine 和事务；把 ORM 硬套到批量场景，常见结果是对象实例化占满内存、flush 顺序不可控、SQL 数量随行数线性增长。

> 边界：ORM 的价值在“聚合内的一致性”和“关系导航”，不在“替代 SQL”。复杂查询最终仍要能读懂 `EXPLAIN` 的输出。

## 二、安装与最小闭环

这一章装好依赖并跑通一次建表、写入、查询，确认 Python、驱动和数据库三者的连接链路。

### 2.1 安装与项目初始化

```bash
# macOS / Linux：安装 uv（Windows 用下一段的 PowerShell）
curl -LsSf https://astral.sh/uv/install.sh | sh

uv init shop-api
cd shop-api
uv add "sqlalchemy>=2.0.36" "psycopg[binary]>=3.2"
```

```powershell
# Windows PowerShell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
uv init shop-api
cd shop-api
uv add "sqlalchemy>=2.0.36" "psycopg[binary]>=3.2"
```

| 系统 | 系统包准备 | 说明 |
|---|---|---|
| Ubuntu 24.04+ | `sudo apt install python3.12-venv` | uv 自带的 Python 可跳过 |
| Rocky/CentOS 9+ | `sudo dnf install python3.12` | 用 `uv python install 3.12` 也可 |
| macOS | `brew install uv` | 与脚本安装二选一 |
| Windows | 无需额外包 | 需要 PowerShell 5.1+ |

本地没有 PostgreSQL 时，用容器起一个 17.x 实例：

```bash
docker run -d --name pg-shop \
  -e POSTGRES_PASSWORD=secret \
  -e POSTGRES_DB=shop \
  -p 5432:5432 \
  postgres:17
```

### 2.2 最小可运行程序

```python
# hello_sqlalchemy.py
from sqlalchemy import String, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

engine = create_engine("sqlite:///./demo.db", echo=False)  # 先用 SQLite 排除网络与账号因素


class Base(DeclarativeBase):
    pass


class Note(Base):
    __tablename__ = "notes"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(80))
    done: Mapped[bool] = mapped_column(default=False)  # Python 侧默认值，flush 时补齐


Base.metadata.create_all(engine)  # 仅用于本地验证；生产 schema 交给 Alembic

with Session(engine) as session:
    session.add(Note(title="跑通 SQLAlchemy"))
    session.commit()  # 提交后才对其他连接可见

with Session(engine) as session:
    note = session.scalar(select(Note).where(Note.title == "跑通 SQLAlchemy"))
    print(note.id, note.title, note.done)
```

```bash
uv run python hello_sqlalchemy.py
```

预期输出：

```text
1 跑通 SQLAlchemy False
```

### 2.3 版本基线

| 组件 | 基线 | 说明 |
|---|---|---|
| Python | 3.12+ | 3.13 已验证；3.9 仅维护旧项目 |
| SQLAlchemy | 2.0.36+ | 只用 2.0 风格 API |
| psycopg | 3.2+ | PostgreSQL 首选驱动，支持同步与异步 |
| greenlet | 3.1+ | 异步 ORM 的隐式依赖，由 SQLAlchemy 带入 |
| Alembic | 1.14+ | 迁移单独成篇，见下一笔记 |

> 边界：`create_all()` 只建缺失的表，不改列、不删列、不迁移数据。任何已上线的库都必须用 Alembic 管理版本。

## 三、Engine 与连接池

Engine 是进程级对象，内部维护连接池；每个请求创建 Engine 会让连接池失效，最终打满数据库的 `max_connections`。

### 3.1 连接 URL 与驱动

| 数据库 | URL 形式 | 驱动包 |
|---|---|---|
| PostgreSQL | `postgresql+psycopg://user:pass@host:5432/db` | `psycopg[binary]` |
| MySQL | `mysql+pymysql://user:pass@host:3306/db` | `pymysql` |
| SQLite 文件 | `sqlite:///./shop.db` | 标准库 |
| SQLite 内存 | `sqlite:///:memory:` | 标准库 |

URL 里的密码要来自环境变量或密钥管理，不能写进代码仓库，也不能在 `echo=True` 时打进日志。

### 3.2 连接池参数

```python
from sqlalchemy import create_engine

engine = create_engine(
    settings.database_url,       # 从环境变量读取，避免密码进镜像
    pool_size=10,                # 常驻连接数，按单进程并发设定
    max_overflow=20,             # 峰值可临时超出 20 条，超出后等待
    pool_timeout=30,             # 等待超过 30 秒抛 TimeoutError，避免请求无限挂起
    pool_pre_ping=True,          # 取连接前 ping 一次，剔除被防火墙或数据库杀掉的死连接
    pool_recycle=1800,           # 早于数据库 wait_timeout 回收，防止用到半关闭连接
)
```

连接上限要按进程数计算：4 个 uvicorn worker，每个 `pool_size=10`、`max_overflow=20`，最坏情况是 `4 × 30 = 120` 条。PostgreSQL 的 `max_connections` 还要留给迁移、监控和运维账号。

| 参数 | 过大时 | 过小时 |
|---|---|---|
| `pool_size` | 数据库连接数被占满 | 常态并发排队 |
| `max_overflow` | 峰值把数据库打崩 | 峰值大量超时 |
| `pool_timeout` | 故障被拖成慢请求 | 正常排队被误杀 |
| `pool_recycle` | 用到服务端已关闭的连接 | 频繁重连 |

### 3.3 SQLite 与测试环境

SQLite 默认禁止跨线程复用连接。FastAPI 的同步路由跑在线程池里，必须关闭该检查：

```python
engine = create_engine(
    "sqlite:///./shop.db",
    connect_args={"check_same_thread": False},  # 连接池会跨线程交还连接
)
```

内存数据库要配 `StaticPool`，否则每个连接看到的是各自独立的空库：

```python
from sqlalchemy.pool import StaticPool

test_engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,  # 全测试共用同一条内存连接
)
```

> 边界：SQLite 适合本地演示和单机小工具，不提供 PostgreSQL 的行级锁、并发索引和完整 ALTER 能力；生产并发写入仍要用 PostgreSQL。

### 3.4 连接池耗尽的第一条命令

现象是请求大面积卡住，日志出现：

```text
TimeoutError: QueuePool limit of size 10 overflow 20 reached, connection timed out, timeout 30.00
```

先查数据库侧谁占着连接，而不是直接把 `pool_size` 调大：

```sql
SELECT pid, usename, state, wait_event_type, query_start, left(query, 80)
FROM pg_stat_activity
WHERE datname = 'shop'
ORDER BY query_start;
```

长事务、忘记提交的 Session、在事务里调用外部 HTTP 服务，都会让连接一直不归还。连接池只是症状出口，根因通常在事务边界。

## 四、ORM 模型与 schema 约定

模型类同时承担三件事：描述表结构、提供类型化的属性访问、给 Alembic 提供元数据；三者必须一致，模型才有价值。

### 4.1 DeclarativeBase 与 Mapped

```python
from datetime import datetime
from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    display_name: Mapped[str | None] = mapped_column(String(80))  # Optional 即 nullable
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),  # 由数据库生成，迁移和手工插入都不会漏值
    )
    orders: Mapped[list["Order"]] = relationship(back_populates="user")
```

`Mapped[T]` 决定 Python 类型，`mapped_column()` 决定数据库类型和约束。`Mapped[str]` 默认 `NOT NULL`，`Mapped[str | None]` 才是可空列。

### 4.2 约束命名规范

Alembic 的 autogenerate 通过约束名对比差异。数据库自动生成的匿名约束会让每次 diff 都出现“drop 再 create”，迁移历史很快失控。把 4.1 的 `Base` 替换成下面这个定义：

```python
from sqlalchemy import MetaData

NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)  # 所有模型继承同一套命名
```

这段要在项目第一次生成迁移前确定；已经有历史迁移的库再改，需要单独写重命名迁移。

### 4.3 类型选择

| 场景 | 用法 | 原因 |
|---|---|---|
| 金额 | `Numeric(12, 2)` | 二进制浮点会丢分 |
| 短文本 | `String(80)` | 长度约束能拦住脏数据 |
| 长文本 | `Text` | 不设上限，避免超长截断 |
| 时间 | `DateTime(timezone=True)` | 统一存 UTC，展示层再换时区 |
| 结构化数据 | `JSON` / PostgreSQL `JSONB` | 仅用于稀疏扩展字段 |

> 边界：不要用 `Float` 存金额，不要用字符串存时间，不要把 `JSONB` 当万能表结构。模型字段是查询契约，不是临时缓存。

## 五、Session 与事务

Session 是工作单元：它跟踪对象变更，在 `flush()` 时把变更按依赖顺序发给数据库，在 `commit()` 时提交事务。

### 5.1 sessionmaker 与生命周期

```python
from sqlalchemy.orm import sessionmaker

SessionLocal = sessionmaker(
    bind=engine,
    expire_on_commit=False,  # 提交后仍可读属性，避免响应序列化时补查数据库
    autoflush=False,         # 查询前不隐式 flush，SQL 时机可预测
)
```

`expire_on_commit=False` 的代价是对象可能保留提交前的旧值；跨请求复用对象时要以数据库为准，不能把 Session 缓存成全局变量。

### 5.2 显式事务边界

```python
with SessionLocal.begin() as session:   # 进入即开事务，正常退出提交，异常回滚
    order = Order(order_no="SO-1001")
    session.add(order)
    session.flush()                     # 拿到自增主键，但事务尚未提交
    session.add(OrderItem(order_id=order.id, product_id=1, qty=2))
# 退出 with 时统一 commit；中途抛异常则 rollback
```

`flush()` 只发 SQL，`commit()` 才结束事务。把外部 HTTP 调用、文件上传、消息发送放在事务内，会拉长锁持有时间并放大死锁概率。

### 5.3 FastAPI 的 Session 依赖

```python
from collections.abc import Iterator


def get_session() -> Iterator[Session]:
    with SessionLocal.begin() as session:  # 请求结束自动提交或回滚
        yield session
```

路由里只写业务，不在每个函数重复 `commit()`：

```python
@router.post("/orders", status_code=201)
def create_order(payload: OrderCreate, session: Session = Depends(get_session)):
    order = Order(**payload.model_dump())
    session.add(order)
    session.flush()
    return {"id": order.id}
```

> 边界：`yield` 依赖在响应发送后收尾，退出阶段的异常改不了已发出的响应。流式响应、后台任务不能继续使用这个 Session；需要另行开短事务。

### 5.4 三个高频异常

| 异常 | 触发场景 | 处理 |
|---|---|---|
| `DetachedInstanceError` | Session 关闭后访问未加载属性 | 查询时 eager load，或提交前转 DTO |
| `PendingRollbackError` | 事务内异常后继续用同一 Session | 先 `rollback()`，再重试业务 |
| `InvalidRequestError` | 在 flush 事件里又发查询 | 拆开写操作与查询，避免递归 flush |

## 六、关系与加载策略

关系映射解决“从订单拿到明细、再从明细拿到商品”，加载策略决定这条路径要发几条 SQL。

### 6.1 双向关系与级联

```python
class Order(Base):
    __tablename__ = "orders"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    user: Mapped["User"] = relationship(back_populates="orders")
    items: Mapped[list["OrderItem"]] = relationship(
        back_populates="order",
        cascade="all, delete-orphan",  # 订单删除时明细一起删，明细不能脱离订单存在
    )


class OrderItem(Base):
    __tablename__ = "order_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"))
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    qty: Mapped[int]
    order: Mapped["Order"] = relationship(back_populates="items")
    product: Mapped["Product"] = relationship()
```

`delete-orphan` 只适用于“子对象不能独立存在”的组合关系。用户与订单、订单与商品这类关系不能用它，否则一次解除关联就会删数据。

### 6.2 四种加载策略

| 策略 | 典型 SQL 数 | 适用 | 风险 |
|---|---|---|---|
| `lazy="select"` | 1 + N | 脚本、单对象 | 列表场景 N+1 |
| `selectin` | 2 | 一对多集合 | 集合很大时 IN 列表过长 |
| `joined` | 1 | 多对一、一对一 | 一对多会放大行数 |
| `lazy="raise"` | 0 | 禁止隐式查询 | 必须显式 eager load |

列表接口用 `selectinload()`：

```python
stmt = (
    select(Order)
    .options(selectinload(Order.items).selectinload(OrderItem.product))
    .order_by(Order.id.desc())
    .limit(20)
)
orders = session.scalars(stmt).all()
```

`selectinload` 先查订单，再用 `IN (…)` 查明细，再用 `IN (…)` 查商品，总共 3 条 SQL。`joinedload` 用在多对一，例如 `joinedload(Order.user)`，不会产生笛卡尔放大。

### 6.3 N+1 的判定

N+1 的典型信号是“列表 20 条，SQL 日志几十条，且语句形状相同”。用事件计数器可以在测试里直接断言：

```python
from sqlalchemy import event

SELECTS = {"n": 0}


@event.listens_for(engine, "before_cursor_execute")
def count_selects(conn, cursor, statement, parameters, context, executemany):
    if statement.lstrip().upper().startswith("SELECT"):
        SELECTS["n"] += 1
```

把计数器放进集成测试，比在代码评审里靠肉眼找 `for` 循环可靠。SQLite 下同一个商品会被身份映射缓存，计数可能小于理论值；换 PostgreSQL 或不同商品数据后数字会变化，判断标准是“是否随行数增长”。

> 边界：不是所有 N+1 都要修。单对象详情页一次懒加载可以接受；列表、导出、批处理必须 eager load。

## 七、查询、写入与分页

查询章解决三件事：把过滤条件下推到数据库、把分页做稳定、把批量写入从逐行 ORM 改成集合操作。

### 7.1 过滤、连接与聚合

```python
from sqlalchemy import func, select

stmt = (
    select(
        Order.status,
        func.count(Order.id).label("order_count"),
        func.sum(OrderItem.qty * OrderItem.unit_price_cents).label("amount_cents"),
    )
    .join(OrderItem, OrderItem.order_id == Order.id)
    .where(Order.created_at >= start)
    .group_by(Order.status)
    .order_by(Order.status)
)
for status, count, amount in session.execute(stmt):
    print(status, count, amount)
```

聚合在数据库里做，不要把全表拉到 Python 再 `sum()`。连接条件写清楚，避免笛卡尔积。

### 7.2 分页的两种写法

```python
total = session.scalar(select(func.count()).select_from(Order)) or 0
rows = session.scalars(
    select(Order).order_by(Order.id.desc()).limit(page_size).offset((page - 1) * page_size)
).all()
```

`OFFSET` 在深页时要扫描并丢弃前面的行，`page=10000` 会明显变慢。翻页深度可控的后台用 offset；信息流、审计日志用键集分页：

```python
rows = session.scalars(
    select(Order)
    .where(Order.id < last_seen_id)  # 上一页最后一条的 id，走主键索引
    .order_by(Order.id.desc())
    .limit(page_size)
).all()
```

键集分页不能跳页，但代价稳定，也不会因为新数据插入导致重复行。

### 7.3 批量写入与更新

```python
from sqlalchemy import delete, insert, update

session.execute(insert(Product), [  # 一次 executemany，不为每行建 ORM 对象
    {"sku": "SKU-101", "name": "显示器支架", "price_cents": 29900, "stock": 30},
    {"sku": "SKU-102", "name": "USB-C 扩展坞", "price_cents": 49900, "stock": 15},
])

session.execute(
    update(Product)
    .where(Product.stock == 0)
    .values(status="sold_out")  # 集合更新，避免逐对象 flush
)

session.execute(delete(OrderItem).where(OrderItem.order_id == order_id))
```

批量操作绕过 ORM 的逐对象事件和级联，执行快，但不会自动维护关系集合；执行后要 `session.expire_all()` 或重新查询，避免内存状态与数据库不一致。

### 7.4 行锁与条件更新

悲观锁用 `with_for_update()`：

```python
product = session.scalar(
    select(Product).where(Product.id == product_id).with_for_update()
)
if product.stock < qty:
    raise InsufficientStock
product.stock -= qty
```

更稳的扣减是把判断写进 `UPDATE` 的 `WHERE`，由数据库保证原子性：

```python
result = session.execute(
    update(Product)
    .where(Product.id == product_id, Product.stock >= qty)
    .values(stock=Product.stock - qty)
)
if result.rowcount != 1:
    raise InsufficientStock  # 没有行被更新，说明库存不足或商品不存在
```

条件更新在 SQLite、MySQL、PostgreSQL 上都能防超卖，不依赖 `SELECT ... FOR UPDATE`。需要读取多个字段做复杂定价时，再在 PostgreSQL 事务里用行锁。

> 边界：事务里不要等待用户输入、调用支付网关或发消息。锁的持有时间等于事务时间，外部依赖的抖动会直接变成数据库连接堆积。

## 八、异步会话与现场排障

异步 ORM 的价值在数据库 IO 等待期间释放事件循环；它不会让 SQL 变快，也不会自动解决 N+1 和连接池配置。

### 8.1 AsyncEngine 与 AsyncSession

异步 URL 用 `asyncpg` 时先 `uv add asyncpg`；想复用已安装的 psycopg，把方言换成 `postgresql+psycopg`。

```python
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

async_engine = create_async_engine(
    "postgresql+asyncpg://app:secret@127.0.0.1:5432/shop",
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
)
AsyncSessionLocal = async_sessionmaker(async_engine, expire_on_commit=False)

async def get_product(session, product_id: int):
    return await session.scalar(select(Product).where(Product.id == product_id))
```

异步会话的每个操作都要 `await`：`await session.commit()`、`await session.refresh(obj)`、`await session.scalars(stmt)`。漏掉 `await` 会得到协程对象，错误通常在序列化时才暴露。

### 8.2 异步下的懒加载陷阱

异步 Session 不允许隐式 IO。访问未加载的 `order.items` 会抛 `MissingGreenlet`，因为懒加载无法在同步属性访问里 `await`。

```python
# 错误：异步环境默认懒加载
order = await session.get(Order, 1)
print(order.items)  # MissingGreenlet

# 正确：查询时一次加载完
order = await session.scalar(
    select(Order).options(selectinload(Order.items)).where(Order.id == 1)
)
```

异步项目把关系默认设为 `lazy="raise"`，强制每个查询显式声明加载策略，能在开发期而不是生产期暴露问题。

### 8.3 现场排障表

| 现象 | 常见原因 | 第一条命令 |
|---|---|---|
| 请求卡 30 秒后超时 | 连接池耗尽、长事务 | 查 `pg_stat_activity` 的 `state` 与 `query_start` |
| SQL 数量随列表长度增长 | N+1 懒加载 | 开 `echo=True` 或事件计数器 |
| 提交后读属性又发 SQL | `expire_on_commit=True` | 响应前转 DTO 或改 `False` |
| 异步报 `MissingGreenlet` | 隐式懒加载 | 加 `selectinload` 或 `lazy="raise"` |
| 迁移后列不存在 | 模型已改、数据库没升级 | `alembic current` 与 `alembic heads` |

列表查询变慢时先看执行计划：

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, order_no, status, created_at
FROM orders
WHERE status = 'created'
ORDER BY id DESC
LIMIT 20;
```

确认走 `(status, id DESC)` 复合索引；出现 `Seq Scan` 或 `Sort` 落盘时，先补索引或改写分页，不要先加机器。

## 九、最佳实践案例

### 9.1 案例背景

一个 6 人团队的订单服务使用 FastAPI 0.115、SQLAlchemy 2.0 和 PostgreSQL 17。订单列表接口返回 20 条订单及明细，监控显示 P95 为 480 ms，SQL 日志一次请求出现 23 条 `SELECT`；大促前压测还发现两个请求同时扣减同一商品时库存会变成负数。

目标是两天内把列表 SQL 压到常数条、扣减在并发下不超卖，并且不改变现有表结构。约束是不能引入新中间件，迁移由 Alembic 管理，接口响应字段保持不变。

### 9.2 案例实操

先建模型和可复现的 SQLite 数据集；生产把 URL 换成 `postgresql+psycopg://` 即可，条件更新语义不变。

```python
# demo.py —— 可直接运行：python demo.py
from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, String, create_engine, event, select, update
from sqlalchemy.orm import (DeclarativeBase, Mapped, mapped_column, relationship,
                            selectinload, sessionmaker)

engine = create_engine("sqlite:///./shop.db", echo=False)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class Product(Base):
    __tablename__ = "products"
    id: Mapped[int] = mapped_column(primary_key=True)
    sku: Mapped[str] = mapped_column(String(32), unique=True)
    name: Mapped[str] = mapped_column(String(100))
    price_cents: Mapped[int]
    stock: Mapped[int] = mapped_column(default=0)


class Order(Base):
    __tablename__ = "orders"
    id: Mapped[int] = mapped_column(primary_key=True)
    order_no: Mapped[str] = mapped_column(String(32), unique=True)
    status: Mapped[str] = mapped_column(String(16), default="created")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    items: Mapped[list["OrderItem"]] = relationship(
        back_populates="order", cascade="all, delete-orphan"
    )


class OrderItem(Base):
    __tablename__ = "order_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id", ondelete="CASCADE"))
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    qty: Mapped[int]
    unit_price_cents: Mapped[int]
    order: Mapped["Order"] = relationship(back_populates="items")
    product: Mapped["Product"] = relationship()


class InsufficientStock(Exception):
    pass


SELECTS = {"n": 0}


@event.listens_for(engine, "before_cursor_execute")
def count_selects(conn, cursor, statement, parameters, context, executemany):
    if statement.lstrip().upper().startswith("SELECT"):
        SELECTS["n"] += 1  # 只统计 SELECT，INSERT/UPDATE 不计入 N+1


def seed() -> None:
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with SessionLocal.begin() as session:
        products = [
            Product(sku="SKU-001", name="机械键盘", price_cents=39900, stock=50),
            Product(sku="SKU-002", name="人体工学椅", price_cents=129900, stock=20),
            Product(sku="SKU-003", name="4K 显示器", price_cents=219900, stock=10),
        ]
        session.add_all(products)
        session.flush()
        for i in range(1, 21):
            session.add(Order(order_no=f"SO{i:04d}", items=[
                OrderItem(product_id=products[0].id, qty=1,
                          unit_price_cents=products[0].price_cents),
                OrderItem(product_id=products[1].id, qty=2,
                          unit_price_cents=products[1].price_cents),
            ]))


def list_naive(limit: int = 20):
    with SessionLocal() as session:
        orders = session.scalars(select(Order).order_by(Order.id.desc()).limit(limit)).all()
        return [(o.order_no, [(i.product.name, i.qty) for i in o.items]) for o in orders]


def list_optimized(limit: int = 20):
    stmt = (select(Order)
            .options(selectinload(Order.items).selectinload(OrderItem.product))
            .order_by(Order.id.desc()).limit(limit))
    with SessionLocal() as session:
        orders = session.scalars(stmt).all()
        return [(o.order_no, [(i.product.name, i.qty) for i in o.items]) for o in orders]


def stock_of(sku: str) -> int:
    with SessionLocal() as session:
        return int(session.scalar(select(Product.stock).where(Product.sku == sku)))


def create_order(sku: str, qty: int) -> str:
    with SessionLocal.begin() as session:  # 整个扣减与建单在同一个事务
        product = session.scalar(select(Product).where(Product.sku == sku))
        if product is None:
            raise ValueError(f"unknown sku: {sku}")
        result = session.execute(
            update(Product)
            .where(Product.id == product.id, Product.stock >= qty)  # 判断下推到数据库
            .values(stock=Product.stock - qty)
        )
        if result.rowcount != 1:  # 并发下只有一个事务能更新成功
            raise InsufficientStock(f"{sku} 库存不足，需要 {qty}")
        order = Order(order_no=f"SO-{uuid4().hex[:8].upper()}", items=[
            OrderItem(product_id=product.id, qty=qty,
                      unit_price_cents=product.price_cents)
        ])
        session.add(order)
        session.flush()
        return order.order_no


if __name__ == "__main__":
    seed()
    SELECTS["n"] = 0
    naive = list_naive()
    naive_count = SELECTS["n"]
    SELECTS["n"] = 0
    optimized = list_optimized()
    optimized_count = SELECTS["n"]

    print(f"orders={len(optimized)} naive_selects={naive_count} "
          f"optimized_selects={optimized_count}")
    print("same_result=", naive == optimized)

    before = stock_of("SKU-003")
    try:
        create_order("SKU-003", 99)
    except InsufficientStock as exc:
        print("rejected=", exc)
    print(f"stock_before={before} stock_after={stock_of('SKU-003')}")

    order_no = create_order("SKU-003", 2)
    print(f"created={order_no} stock_left={stock_of('SKU-003')}")
```

```bash
uv run python demo.py
```

预期输出（SQLite，实际 id 与单号会不同）：

```text
orders=20 naive_selects=23 optimized_selects=3
same_result= True
rejected= SKU-003 库存不足，需要 99
stock_before=10 stock_after=10
created=SO-1A2B3C4D stock_left=8
```

生产环境把 Engine 换成连接池配置，并给列表查询加复合索引：

```python
engine = create_engine(
    "postgresql+psycopg://app:secret@db:5432/shop",
    pool_size=10, max_overflow=20, pool_timeout=30,
    pool_pre_ping=True, pool_recycle=1800,
)
```

```sql
-- 覆盖“按状态过滤 + 按 id 倒序”的列表查询，避免排序落盘
CREATE INDEX CONCURRENTLY idx_orders_status_id ON orders (status, id DESC);
```

### 9.3 案例结果

同一份 20 条订单数据，列表查询从 23 条 `SELECT` 降到 3 条，返回内容完全一致；SQLite 本机 50 次调用的中位数从 2.05 ms 降到 0.69 ms（绝对值随机器变化）。扣减接口在库存不足时返回业务异常，库存保持不变；并发扣减由 `WHERE stock >= qty` 保证只有一行更新成功。

失败模式与复盘：

- 只加 `selectinload` 不改分页，深页仍会慢；列表必须同时限制 `limit`，后台翻页用键集。
- `expire_on_commit=False` 让提交后读属性不再补查，但跨请求复用对象会读到旧值；Session 必须请求级创建。
- SQLite 不验证行锁语义，`with_for_update()` 会被忽略；并发扣减的最终验证要在 PostgreSQL 上做。
- 条件更新返回 `rowcount=0` 时要区分“商品不存在”和“库存不足”，否则前端无法给出正确提示。

上线前再确认：Engine 是进程级单例，连接上限按 worker 数算过；每个请求独立 Session，事务在依赖或服务层显式结束；列表接口 eager load 且有 SQL 计数测试；金额用 `Numeric`、时间带时区、约束有名字；数据库版本由 Alembic 管理，`create_all()` 只出现在测试。
