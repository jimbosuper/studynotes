# RabbitMQ

---

## 一、RabbitMQ 是什么

RabbitMQ 是一个实现 AMQP 0-9-1 协议的消息代理（broker）。生产者把消息发给交换机，交换机按绑定规则把消息路由到一个或多个队列，消费者再从队列取走消息并确认。它解决的是**系统之间的异步解耦、流量削峰、失败重试和事件广播**，而不是大数据量的长期留存。

从使用者的角度看，RabbitMQ 的价值集中在四处：

- **路由灵活**：direct、topic、fanout、headers 四种交换机覆盖按类型、按模式、广播和按属性匹配的常见需求。
- **确认精细**：发布确认和消费确认都以单条消息为单位，失败可以重投，成功才删除。
- **低延迟**：消息到达队列后由 broker 主动推送给消费者，适合交互链路上的异步化。
- **可观测**：管理插件提供队列深度、未确认数、消费者数、连接状态和 HTTP API，排障入口集中。

它不解决的问题同样要划清：RabbitMQ 不擅长保留几 TB 历史消息并按 offset 重放；没有端到端的 exactly-once；原生也不提供任意时长的延迟消息，需要 TTL 加死信或延迟插件组合实现。把 RabbitMQ 当数据库用，或者用它承载日志采集，都会在容量和运维上付出代价。

> **版本现状（2026）**：RabbitMQ 4.x 为当前稳定线，本文命令以 4.1 为基线。4.0 起移除经典镜像队列，需要复制的队列统一使用 quorum queue（基于 Raft）；4.3 起 quorum queue 提供原生延迟重试和消费超时参数。具体补丁版本以官方发布说明为准。

### 1.1 核心概念

AMQP 模型里，消息不直接从生产者到消费者，中间要经过交换机和队列两层。理解这两层分工，是后面所有排查的基础。

| 概念 | 本质 | 需要记住的点 |
|---|---|---|
| vhost | 逻辑隔离的命名空间 | 队列、交换机、绑定、权限都按 vhost 划分 |
| connection | 到 broker 的一条 TCP 连接 | 认证、心跳、TLS 在这一层 |
| channel | 连接上的多路复用通道 | 轻量，但不是线程安全的 |
| exchange | 路由规则，不保存消息 | 没有匹配绑定时消息会被丢弃 |
| queue | 真正存储消息的实体 | 持久化、副本、死信都挂在队列上 |
| binding | exchange 到 queue 的规则 | 可带 routing key 或 headers |
| consumer | 订阅队列的客户端 | 手动 ack 才能保证不丢 |
| ack | 消费者告诉 broker 处理完成 | 未 ack 的消息在连接断开后重投 |

**connection 与 channel 的关系**相当于一条光纤和其中的多条波长：TCP 握手、TLS 协商、SASL 认证的成本很高，所以一个进程通常只维护一条连接；真正的发布、消费、声明操作都在 channel 上完成。channel 是协议层的复用单元，同一个 channel 上的帧有严格顺序，多线程并发写同一个 channel 会打乱帧的次序，因此不能跨线程共享。

**exchange 只路由，不存储**。这是初学者最常见的误解。生产者把消息发到 exchange 后，如果没有任何 binding 匹配，消息不会停在 exchange 里等待，而是直接被丢弃。要发现这种情况，发布时必须设置 `mandatory=true`，broker 会把不可路由的消息通过 `basic.return` 退回；或者在 exchange 上配置备用交换机（alternate exchange），把无法路由的消息转走。

**queue 才是消息的落脚点**。队列的 `durable` 决定队列定义能否在 broker 重启后恢复，消息属性 `delivery_mode=2` 决定消息本身能否落盘，两者互相独立。只声明持久化队列而不设置持久化消息，重启后队列还在，消息已经没了。

### 1.2 与相邻技术的关系

消息中间件不是只有一种模型。RabbitMQ 是“智能 broker + 传统队列”，Kafka 是“分区日志 + 消费者自维护位点”，RocketMQ 在队列模型上补了事务和定时消息，Redis Stream 则是内存数据结构。选型时先看语义，再看吞吐。

| 技术 | 消息模型 | 消费语义 | 典型定位 |
|---|---|---|---|
| RabbitMQ | exchange 路由到队列，推送 | 单条 ack，at-least-once | 业务解耦、复杂路由、低延迟 |
| Kafka | 分区追加日志，拉取 | offset 提交，at-least-once | 高吞吐、留存、重放、流处理 |
| RocketMQ | 队列，支持重试与定时 | 消费确认，at-least-once | 交易链路、延迟消息、事务消息 |
| Redis Stream | 内存追加流，消费组 | ACK 与 pending 列表 | 轻量异步、已有 Redis 的场景 |
| 云托管队列 | 队列或主题 | 由服务定义 | 无运维团队、按量付费 |

RabbitMQ 与 Kafka 的差别不在“谁更快”，而在**消息的生命周期由谁决定**。RabbitMQ 的消息在被确认后删除，队列长度反映的是待处理工作量；Kafka 的消息按保留期删除，与是否消费无关，所以同一个 topic 可以被多个消费组反复读取。需要“一条事件通知多个下游且路由经常变”，RabbitMQ 更直接；需要“保留一周、随时重放、吞吐优先”，Kafka 更合适。

RabbitMQ 与 RocketMQ 的差别在**业务语义的完整度**。RocketMQ 原生提供定时消息、事务消息和顺序消息的完整封装；RabbitMQ 的延迟依赖 TTL 加死信或插件，事务只覆盖 AMQP 的 `tx` 类操作且性能差，生产上更常用“本地消息表 + 确认”替代。

> **运维提示**：同一套业务不要同时引入两套消息中间件来“互补”。双写、双订阅带来的重复和一致性问题，通常比单套系统的容量问题更难处理。

### 1.3 架构组成

```mermaid
flowchart LR
    P["生产者应用"] -->|"建立连接"| C["Connection<br/>TCP 5672"]
    C -->|"多路复用"| CH["Channel"]
    CH -->|"basic_publish"| X["Exchange<br/>按 binding 路由"]
    X -->|"routing key 匹配"| Q1["Queue<br/>order.paid"]
    X -->|"广播或模式匹配"| Q2["Queue<br/>order.audit"]
    Q1 -->|"push 投递"| C1["消费者 A"]
    Q1 -->|"push 投递"| C2["消费者 B"]
    Q1 -->|"拒绝或过期"| DLX["Dead Letter Exchange"]
    DLX --> DQ["Queue<br/>order.paid.dlq"]
    classDef client fill:#e3f2fd,stroke:#1565c0;
    classDef engine fill:#e8f5e9,stroke:#2e7d32;
    classDef image fill:#fff3e0,stroke:#ef6c00;
    class P,C,CH,C1,C2 client
    class X,Q1,Q2 engine
    class DLX,DQ image
```

RabbitMQ 运行在 Erlang/OTP 之上，这个事实解释了它的几个运维特征：

- **节点身份由节点名决定**，格式为 `rabbit@hostname`。hostname 变了，节点名就变了，集群里的旧成员记录会对不上。
- **Erlang cookie 是集群门票**，所有节点必须持有相同内容。cookie 不一致时，`join_cluster` 会直接失败。
- **元数据存放在 Mnesia**，包括 vhost、用户、权限、交换机、绑定和队列定义；quorum queue 的消息数据则由各队列自己的 Raft 日志维护。
- **调度和网络由 Erlang VM 管理**，大量连接和小消息场景下，VM 的调度器、文件描述符、内存水位是排查重点。

一个 broker 节点内部可以粗分为四层：协议接入层负责 connection 和 channel；路由层由 exchange 与 binding 组成；存储层由 classic queue 或 quorum queue 实现；管理层由 `rabbitmqctl`、管理插件和 HTTP API 构成。vhost 把前三层的命名空间切开，不同 vhost 之间默认完全隔离。

> **注意**：管理插件不是 broker 的核心组件。生产镜像建议使用 `rabbitmq:4.1-management`，或者在包安装后执行 `rabbitmq-plugins enable rabbitmq_management`；只装基础镜像时 15672 端口不会监听。

---

## 二、安装与连接

RabbitMQ 的安装方式分容器和系统包两类。容器适合本地验证和单机部署，系统包适合需要 systemd 管理、固定节点名和集群配置的生产环境。无论哪种方式，先确认四个端口：5672 用于 AMQP，15672 用于管理界面，4369 与 25672 用于集群内部通信。

### 2.1 单节点容器部署

```bash
# ========== 启动单节点 ==========
# 管理镜像自带 management 插件，端口 15672 可直接访问
docker run -d --name rabbitmq \
  -p 5672:5672 \
  -p 15672:15672 \
  -e RABBITMQ_DEFAULT_USER=app \
  -e RABBITMQ_DEFAULT_PASS=change-me \
  -v rabbitmq-data:/var/lib/rabbitmq \
  rabbitmq:4.1-management

# ========== 观察启动过程 ==========
# 等待日志出现 Server startup complete，再执行后续操作
docker logs -f rabbitmq

# ========== 验证节点与监听端口 ==========
# 查看节点版本、运行时长和 Erlang 版本
docker exec rabbitmq rabbitmqctl version
# 查看内存、磁盘、文件描述符和运行状态
docker exec rabbitmq rabbitmq-diagnostics status
# 查看 5672、15672 等监听端口是否就绪
docker exec rabbitmq rabbitmq-diagnostics listeners
```

`RABBITMQ_DEFAULT_USER` 和 `RABBITMQ_DEFAULT_PASS` 只在数据目录为空、节点首次初始化时生效。如果挂载的卷里已经有 `mnesia` 数据，改环境变量不会改掉旧用户，必须进容器用 `rabbitmqctl` 修改。这个行为在反复重建容器时经常被忽略。

端口分工如下：

| 端口 | 协议或用途 | 是否对外 |
|---|---|---|
| 5672 | AMQP 0-9-1 明文 | 应用需要访问 |
| 5671 | AMQP over TLS | 应用需要访问 |
| 15672 | 管理界面与 HTTP API | 仅运维网段 |
| 4369 | epmd，Erlang 端口映射 | 仅集群内 |
| 25672 | 节点间通信与 CLI | 仅集群内 |

> **安全警告**：15672 不要暴露到公网。管理界面拥有发布、删除队列、清空消息的能力，弱口令等同于把 broker 交给攻击者。生产环境应在反向代理后加认证和 IP 白名单。

### 2.2 系统包安装与基础配置

```bash
# ========== Debian / Ubuntu ==========
# 更新软件包索引
sudo apt update
# 安装发行版仓库中的 RabbitMQ 与 Erlang 依赖
sudo apt install -y rabbitmq-server

# ========== RHEL / CentOS / Rocky ==========
# 发行版仓库版本可能偏旧，生产环境按官方文档配置 RabbitMQ 仓库
sudo dnf install -y rabbitmq-server

# ========== 启动与开机自启 ==========
# 启动服务并注册开机自启
sudo systemctl enable --now rabbitmq-server

# ========== 启用管理插件 ==========
# 启用后 15672 端口提供管理界面和 HTTP API
sudo rabbitmq-plugins enable rabbitmq_management

# ========== 验证 ==========
# 确认 systemd 单元处于 active (running)
sudo systemctl status rabbitmq-server
# 查看节点资源与运行状态
sudo rabbitmq-diagnostics status
# 查看 AMQP 与管理端口是否监听
sudo rabbitmq-diagnostics listeners
```

系统包安装的配置分布在三个文件，职责不同：

| 文件 | 格式 | 用途 |
|---|---|---|
| `/etc/rabbitmq/rabbitmq.conf` | `key = value` | 常用配置，如监听、水位、分区处理 |
| `/etc/rabbitmq/advanced.config` | Erlang terms | 配置文件中没有对应项的高级参数 |
| `/etc/rabbitmq/rabbitmq-env.conf` | shell 变量 | 节点名、数据目录、Erlang cookie 路径 |

```yaml
# docker-compose.yml：单机验证环境的完整编排
services:
  rabbitmq:
    image: rabbitmq:4.1-management
    container_name: rabbitmq
    hostname: rabbit1
    ports:
      - "5672:5672"
      - "15672:15672"
    environment:
      RABBITMQ_DEFAULT_USER: app
      RABBITMQ_DEFAULT_PASS: change-me
    volumes:
      - rabbitmq-data:/var/lib/rabbitmq
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 30s
      timeout: 10s
      retries: 5

volumes:
  rabbitmq-data:
```

> **注意**：集群部署必须固定 `hostname`。容器每次重建拿到新主机名时，节点名会从 `rabbit@rabbit1` 变成 `rabbit@<随机ID>`，旧节点的队列和成员关系无法直接接回。

### 2.3 用户、vhost 与权限

RabbitMQ 的权限模型是“用户 + vhost + 三类操作正则”。用户全局存在，权限按 vhost 授予；没有授予权限的 vhost，用户连声明队列都会被拒绝。

```bash
# ========== 用户管理 ==========
# 创建业务用户并设置密码
rabbitmqctl add_user app 'change-me'

# 打标签：administrator 可管理用户和权限，monitoring 只读监控
rabbitmqctl set_user_tags app monitoring

# 查看用户列表与标签
rabbitmqctl list_users

# ========== vhost 管理 ==========
# 创建独立 vhost，隔离不同环境或业务线
rabbitmqctl add_vhost orders
# 列出全部 vhost，确认创建结果
rabbitmqctl list_vhosts

# ========== 授权 ==========
# 三个正则依次对应 configure、write、read，覆盖 orders 交换机与 order.* 队列
rabbitmqctl set_permissions -p orders app '^(orders|order\.)' '^(orders|order\.)' '^(orders|order\.)'

# 查看某用户在某个 vhost 下的权限
rabbitmqctl list_permissions -p orders
```

| 权限 | 覆盖操作 | 常见收窄方式 |
|---|---|---|
| configure | 声明、删除队列与交换机 | 只允许业务前缀 |
| write | 发布消息到交换机 | 限制到指定交换机名 |
| read | 从队列消费消息 | 限制到指定队列名 |

正则按资源名匹配，`.*` 表示全部放行。生产环境不建议直接给 `.*`，至少按业务前缀收窄，避免一个服务误删另一个服务的队列。

> **安全警告**：默认的 `guest/guest` 只允许从 localhost 登录，这是保护机制，不要为了远程访问把它放开。正确做法是创建独立用户、授予最小 vhost 权限，再通过 TLS 或内网访问。

### 2.4 客户端连接与连接复用

Python 的 pika 是最直接的观察工具。连接串里包含用户、密码、主机、端口和 vhost；vhost 为 `/` 时 URL 编码成 `%2F`，写成 `/` 会被当成路径分隔符。

```python
# /tmp/rmq-demo/connect.py
import pika

# 一条连接对应一个 TCP 会话，heartbeat 用于发现半开连接
params = pika.URLParameters(
    "amqp://app:change-me@127.0.0.1:5672/%2F?heartbeat=30"
)
params.client_properties = {"connection_name": "order-worker"}
conn = pika.BlockingConnection(params)
ch = conn.channel()

# 声明一个持久化队列，quorum 类型需要显式指定
ch.queue_declare(queue="order.paid", durable=True,
                 arguments={"x-queue-type": "quorum"})
print("connected", conn.is_open)
conn.close()
```

| 连接参数 | 作用 | 建议 |
|---|---|---|
| `heartbeat` | 心跳间隔，双方协商取较小非零值 | 小于中间设备的空闲超时 |
| `connection_name` | 连接在管理界面显示的名字 | 带上服务名和实例号 |
| `blocked_connection_timeout` | 被流控阻塞多久后断开 | 显式设置，避免无限等待 |
| `socket_timeout` | 套接字读写超时 | 与心跳配合，不宜过长 |
| `channel_max` | 单连接最大 channel 数 | 默认足够，按并发调整 |

一条连接可以开多个 channel，但每个 channel 上的操作是串行的。常见做法是：一个进程一条连接，每个消费线程或协程一个 channel；发布端可以用连接池，但不要每发一条消息就建一次连接。TCP 握手、TLS 协商和 SASL 认证的成本远高于一次发布本身。

```bash
# ========== 观察连接与通道 ==========
# 列出连接的对端地址、用户、心跳和状态
rabbitmqctl list_connections name user peer_host state channels

# 列出 channel 的预取、未确认数和消费者数
rabbitmqctl list_channels connection number consumer_count messages_unacknowledged prefetch_count

# 查看当前节点的监听端口
rabbitmq-diagnostics listeners
```

> **注意**：连接数暴涨通常不是客户端“连得多”，而是客户端没有复用连接，或者在异常分支里只关了 channel 没关 connection。管理界面的 Connections 页面按连接名排序，能快速定位是哪个服务泄漏。

---

## 三、核心模型：交换机、队列与绑定

RabbitMQ 的路由能力全部来自“交换机 + 绑定”。生产者只负责把消息和 routing key 交给交换机，具体落到哪些队列由绑定决定。把路由规则放在 broker 侧，应用代码就不需要知道下游有哪些队列。

### 3.1 四种交换机类型

| 类型 | 路由规则 | 典型用途 |
|---|---|---|
| direct | routing key 与绑定键完全相等 | 按事件类型分发 |
| fanout | 忽略 routing key，广播到所有绑定队列 | 缓存失效、配置刷新 |
| topic | `*` 匹配一个词，`#` 匹配零到多个词 | `order.paid`、`order.*`、`order.#` |
| headers | 按消息头键值匹配，`x-match` 为 all 或 any | 多条件筛选，较少使用 |

```mermaid
flowchart LR
    P["生产者"] -->|"routing key = order.paid"| X["topic exchange<br/>orders"]
    X -->|"order.paid 精确匹配"| Q1["Queue<br/>order.paid"]
    X -->|"order.* 匹配一个词"| Q2["Queue<br/>order.audit"]
    X -->|"order.# 匹配多级"| Q3["Queue<br/>order.archive"]
    X -.->|"无匹配且 mandatory"| R["basic.return<br/>退回生产者"]
    classDef client fill:#e3f2fd,stroke:#1565c0;
    classDef engine fill:#e8f5e9,stroke:#2e7d32;
    classDef image fill:#fff3e0,stroke:#ef6c00;
    class P client
    class X,Q1,Q2,Q3 engine
    class R image
```

topic 交换机的匹配以“词”为单位，词之间用点分隔。`order.*` 能匹配 `order.paid`，不能匹配 `order.paid.success`；`order.#` 两者都能匹配。`#` 也可以匹配零个词，所以 `order.#` 能匹配 `order` 本身。设计 routing key 时要把层级固定下来，否则消费者会写出大量难以维护的绑定。

默认交换机 `""` 是一个特殊的 direct 交换机，每个队列都会自动以队列名绑定到它。直接向 `exchange=""`、`routing_key="order.paid"` 发布，等价于直接投递到同名队列。这种方式绕过了自定义路由，适合最简单的场景，但路由关系会散落在代码里。

**备用交换机**用于兜底不可路由的消息：在声明主交换机时设置 `alternate-exchange` 参数，消息无法匹配任何绑定时会转到备用交换机。它比 `mandatory` 更适合“不能丢、但也不该阻塞生产者”的场景。

### 3.2 队列类型与声明参数

| 类型 | 复制方式 | 适用场景 | 主要限制 |
|---|---|---|---|
| classic | 不复制 | 单节点、临时队列、低延迟 | 节点故障后队列不可用 |
| quorum | Raft 多数派 | 生产业务队列、要求不丢 | 始终持久化，不支持 exclusive |
| stream | 追加日志，可重复读 | 大吞吐、多消费者重放 | 消费模型不同，专用场景 |

quorum queue 是 4.x 的默认可复制队列。它有三个容易踩到的点：

1. **声明时必须带 `x-queue-type=quorum`**，默认值仍是 classic，且队列类型不能通过 policy 修改。
2. **队列始终 durable**，不能声明为 exclusive 或 auto-delete；临时队列应继续用 classic。
3. **默认成员数为 3**，集群节点不足时会在可用节点上尽量放满；单节点集群只能放 1 个成员，没有容错能力。

quorum queue 使用 Raft 复制，发布确认只在多数派写入后返回，因此延迟高于 classic，但节点故障时队列仍然可写。3 节点集群可以容忍 1 台故障；2 节点集群的多数派是 2，坏一台就失去多数派，反而不如 3 节点。

```bash
# ========== 通过命令行查看队列类型 ==========
# 列出队列名、类型、消息数、消费者数和成员数
rabbitmqctl list_queues -p orders name type messages consumers members

# ========== 通过 policy 批量设置参数 ==========
# 为匹配前缀的队列设置死信交换机，apply-to 指定作用对象
rabbitmqctl set_policy -p orders order-dlx '^order\.' \
  '{"dead-letter-exchange":"orders.dlx","dead-letter-routing-key":"order.dead"}' \
  --apply-to queues

# 查看策略及其优先级
rabbitmqctl list_policies -p orders
```

> **注意**：同名队列重复声明时，`durable`、`x-queue-type`、TTL、死信等参数必须完全一致，否则 broker 返回 `PRECONDITION_FAILED` 并关闭 channel。代码里把声明参数集中到一个常量或配置模块，不要在各个服务里各写一份。

### 3.3 绑定、路由键与退回机制

绑定是 exchange 与 queue 之间的多对多关系。一个队列可以绑定多个交换机，一个交换机也可以绑定多个队列。消息被复制到每个匹配的队列，各队列独立消费，互不影响。

```bash
# ========== 查看拓扑 ==========
# 列出交换机名称、类型、持久化和内部标志
rabbitmqctl list_exchanges -p orders name type durable internal

# 列出绑定的源、目标与 routing key
rabbitmqctl list_bindings -p orders source_name destination_name routing_key

# 查看单个队列的详情
rabbitmqctl list_queues -p orders name messages messages_unacknowledged consumers

# ========== HTTP API 查询 ==========
# 管理插件提供的 REST 接口，适合脚本化巡检
curl -s -u app:change-me \
  'http://127.0.0.1:15672/api/queues/%2F/order.paid' \
  | jq '{messages, messages_unacknowledged, consumers, type}'
```

发布时设置 `mandatory=true`，broker 找不到匹配队列会把消息退回。不同客户端表现不同：pika 在开启确认模式后抛 `UnroutableError`；Java 客户端通过 `ReturnListener` 回调。没有处理退回，消息会静默消失，日志里什么也没有。

> **运维红线**：生产环境的发布路径必须同时具备“确认 + 退回处理 + 失败落库/告警”。只捕获连接异常而不处理 `basic.return`，等于把不可路由的消息直接丢掉。

### 3.4 消息属性与 TTL

消息属性是业务契约的一部分，不只是元数据。消费方靠 `content_type` 反序列化，靠 `message_id` 做幂等，靠 `correlation_id` 关联请求响应。

| 属性 | 作用 | 常见取值 |
|---|---|---|
| `delivery_mode` | 消息是否持久化 | 2 表示持久化 |
| `content_type` | 消息体格式 | `application/json` |
| `message_id` | 全局唯一标识 | 业务事件 ID |
| `correlation_id` | 请求与响应关联 | 请求 ID |
| `reply_to` | RPC 回复队列 | 临时队列名 |
| `expiration` | 单条消息 TTL | 毫秒字符串 |
| `priority` | 消息优先级 | 经典队列常用 0–9，quorum 4.3 起 0–31 |
| `headers` | 自定义元数据 | 重试次数、租户、追踪 ID |

TTL 有三种放法，作用范围完全不同：

- **队列参数 `x-message-ttl`**：队列内所有消息统一过期，单位毫秒。
- **消息属性 `expiration`**：单条消息过期，值是毫秒字符串，不是整数。
- **队列参数 `x-expires`**：队列自身在多久无人使用后删除，不是消息 TTL。

> **注意**：classic queue 的 TTL 只在消息到达队首时判断。队首有一条 60 秒 TTL 的消息，后面 5 秒 TTL 的消息也要等它过期才能被清理，这就是队头阻塞。需要精确的多档延迟，应每档建一个队列，或使用延迟插件。

---

## 四、生产与消费

发布和消费是两条独立的可靠性链路。发布端的核心问题是“broker 到底收没收到”，消费端的核心问题是“处理失败后消息去了哪里”。两边都用确认机制，但确认的对象不同。

### 4.1 发布确认与 mandatory

`basic_publish` 正常返回只代表消息写进了本地 socket 缓冲区，不代表 broker 收到，更不代表落盘。开启 publisher confirm 后，broker 会在消息被交换机接受并完成持久化或复制后返回 `basic.ack`，失败返回 `basic.nack`。

| 模式 | 语义 | 性能 | 适用 |
|---|---|---|---|
| 不确认 | 发出去就不管 | 最高 | 可丢的日志、指标 |
| 发布确认 | broker 确认后才算成功 | 中 | 业务消息，生产默认 |
| AMQP 事务 | `tx_select` / `tx_commit` | 很低 | 几乎不用 |

```python
# /tmp/rmq-demo/publish.py
import json
import pika

params = pika.URLParameters("amqp://app:change-me@127.0.0.1:5672/%2F")
conn = pika.BlockingConnection(params)
ch = conn.channel()

# 声明 topic 交换机与 quorum 队列，参数必须与消费端一致
ch.exchange_declare(exchange="orders", exchange_type="topic", durable=True)
ch.queue_declare(queue="order.paid", durable=True,
                 arguments={"x-queue-type": "quorum"})
ch.queue_bind(queue="order.paid", exchange="orders", routing_key="order.paid")

# 开启确认模式后，basic_publish 会等待 broker 的 ack/nack
ch.confirm_delivery()
body = json.dumps({"orderId": "A100", "status": "paid"}).encode()
ch.basic_publish(
    exchange="orders",
    routing_key="order.paid",
    body=body,
    properties=pika.BasicProperties(
        delivery_mode=2,
        content_type="application/json",
        message_id="evt-A100-paid",
    ),
    mandatory=True,   # 不可路由时抛 UnroutableError，而不是静默丢弃
)
print("published")
conn.close()
```

批量发布时，逐条等待确认会把吞吐压得很低。pika 提供 `confirm_delivery` 的异步回调，Java 客户端可以批量 `waitForConfirms`。批量确认的代价是失败时要重发整批，消费端必须能接受重复。

> **注意**：`mandatory` 与 publisher confirm 解决的是两个问题。前者保证“消息能路由到队列”，后者保证“broker 接住了消息”。只开其中一个，仍然存在丢失路径。

### 4.2 消费确认与预取

消费者订阅队列后，broker 按预取窗口推送消息。预取数决定这个消费者最多持有多少条未确认消息，它是背压，不是批量大小。

```python
# /tmp/rmq-demo/consume.py
import pika

params = pika.URLParameters("amqp://app:change-me@127.0.0.1:5672/%2F")
conn = pika.BlockingConnection(params)
ch = conn.channel()

# 每个消费者最多 10 条未确认；global=False 表示按消费者计
ch.basic_qos(prefetch_count=10)

def on_message(ch, method, properties, body):
    try:
        print("got", body.decode())
        # 业务处理成功后手动确认，broker 才会删除消息
        ch.basic_ack(method.delivery_tag)
    except Exception:
        # requeue=False 让消息进入死信，避免立即回到队首形成忙循环
        ch.basic_nack(method.delivery_tag, requeue=False)

ch.basic_consume(queue="order.paid", on_message_callback=on_message, auto_ack=False)
print("waiting")
ch.start_consuming()
```

| 操作 | 含义 | 后果 |
|---|---|---|
| `basic_ack` | 处理成功 | 从队列删除 |
| `basic_nack(requeue=true)` | 暂时处理不了 | 重新入队，可能立刻被同一消费者拿到 |
| `basic_nack(requeue=false)` | 失败且不再重试 | 进入死信或丢弃 |
| 不 ack 直接断开 | 连接异常关闭 | 未确认消息重新入队 |

`requeue=true` 不适合“下游暂时不可用”的重试，因为它没有延迟，消息会瞬间回到队首，形成忙循环，还会推高 CPU 和日志量。正确做法是显式发布到带 TTL 的重试队列，到期后经死信回到主队列。

预取数按“单条处理耗时 × 目标吞吐”估算，再留一点余量。太小会让消费者频繁等网络往返，太大则会在消费者崩溃时让大量消息卡在未确认状态，直到连接超时才重投。`prefetch_count=0` 表示不限制，生产环境不要使用。

> **运维红线**：消费端必须关闭自动 ack（`auto_ack=false`）。自动 ack 在消息投递出去时就删除，消费者进程崩溃会导致消息永久丢失。

### 4.3 消费者取消与断线重连

网络抖动、broker 重启、队列被删除，都会让消费者停下来。客户端需要处理两类事件：

- **连接恢复**：重连后重新声明 exchange、queue、binding，恢复消费者。pika 不会自动恢复拓扑；Java 客户端有 `automaticRecoveryEnabled`，但要确认它真的开启并测试过。
- **消费者取消**：队列被删除或变为不可用，broker 发送 `basic.cancel`。应用要记录并告警，不能把“没有消息”当成“没有业务”。

重连后重复消费几乎不可避免：消息已经投递但 ack 没到 broker，连接断了就会重投。消费端按 `message_id` 或业务唯一键去重，不能依赖 broker 只投一次。

```bash
# ========== 观察消费者与未确认消息 ==========
# 查看每个队列的消费者数量和未确认消息数
rabbitmqctl list_queues -p orders name consumers messages messages_unacknowledged

# 查看连接状态，判断是否处于 blocked 或 closing
rabbitmqctl list_connections name state blocked

# 查看消费者标签与预取
rabbitmqctl list_consumers -p orders queue_name consumer_tag ack_required prefetch_count
```

> **注意**：`basic_cancel` 是协作式的。收到取消通知后，客户端应停止使用该 consumer tag，不要继续对已取消的投递执行 ack，否则会触发 channel 异常。

### 4.4 客户端参数与心跳

| 参数 | 默认倾向 | 调整原则 |
|---|---|---|
| `heartbeat` | 60 秒 | 小于负载均衡或防火墙的空闲超时 |
| `blocked_connection_timeout` | 未设置时可能无限等待 | 显式设置，配合告警 |
| `socket_timeout` | 依客户端 | 与心跳同量级，避免误判断线 |
| `prefetch_count` | 0（不限） | 按处理耗时设置，生产禁用 0 |
| `consumer_timeout` | 30 分钟 | 长任务拆分或显式调大 |

`consumer_timeout` 是 broker 侧参数：消费者拿到消息后超过这个时间不 ack，channel 会被关闭（quorum 队列 4.3 起也可能只取消该消费者），消息重新入队。它防的是“消费者卡死但连接还在”，不是替代业务超时。长任务要么缩短单条处理时间，要么调大超时，要么改成“先 ack 再异步处理 + 状态表”；单纯调大只是把问题推迟。

---

## 五、可靠性与顺序

“消息丢了”通常不是 broker 的单一缺陷，而是链路上四个环节只做了其中一两个。把每个环节的保证写清楚，才能判断故障时到底丢了哪一段。

### 5.1 消息丢失的四个环节

```mermaid
flowchart LR
    P["生产者"] -->|"1 发布未确认"| X["Exchange"]
    X -->|"2 无绑定被丢弃"| Q["Queue"]
    Q -->|"3 未持久化，重启丢失"| D["磁盘"]
    Q -->|"4 自动 ack 后处理失败"| C["消费者"]
    C -->|"手动 ack"| Q
    classDef client fill:#e3f2fd,stroke:#1565c0;
    classDef engine fill:#e8f5e9,stroke:#2e7d32;
    classDef image fill:#fff3e0,stroke:#ef6c00;
    class P,C client
    class X,Q engine
    class D image
```

| 环节 | 丢失原因 | 对应措施 |
|---|---|---|
| 生产者到交换机 | 网络中断、 broker 未收到 | publisher confirm |
| 交换机到队列 | 无匹配绑定、队列不存在 | `mandatory` + 备用交换机 |
| 队列到磁盘 | 队列或消息未持久化 | durable 队列 + `delivery_mode=2` |
| 队列到消费者 | 自动 ack、处理失败未重投 | 手动 ack + 死信 |

四件事全部做到，语义仍然是 at-least-once：确认可能在网络里丢失，消费者可能处理完还没来得及 ack 就崩溃。要在这之上做到“业务不重复”，只能靠消费端幂等。

> **运维红线**：不要用“消息没有丢”来安慰自己。只要有一环没开确认，故障时一定会有消息消失，而且通常没有任何日志。

### 5.2 重复消费与幂等

重复的来源有四种：发布确认超时后重发、消费者 ack 丢失后重投、重试队列回流、以及运维手动重放。它们都无法在 broker 层彻底消除，因为“确认”本身也可能丢。

| 去重方式 | 实现 | 适用 |
|---|---|---|
| 唯一索引 | 业务表对 `event_id` 建唯一键 | 强一致、单库 |
| 去重表 | 独立表记录已处理 ID，带过期清理 | 跨库、多步骤 |
| 状态机 | 只允许从某状态迁移一次 | 订单、支付 |
| Redis SETNX | 处理前占位，带 TTL | 高吞吐、可容忍极小误差 |

```sql
-- 消费端幂等：以事件 ID 作为唯一键，重复插入直接忽略
INSERT INTO order_event_consumer (event_id, order_id, consumed_at)
VALUES ('evt-A100-paid', 'A100', now())
ON CONFLICT (event_id) DO NOTHING;
```

> **运维红线**：幂等键要来自消息本身（`message_id` 或业务事件 ID），不能由消费端随机生成。随机键每次都不同，去重表永远拦不住重复。

### 5.3 死信、重试与延迟

死信交换机在三种情况下生效：

1. 消费者 `reject` 或 `nack` 且 `requeue=false`。
2. 消息或队列 TTL 到期。
3. 队列超过 `x-max-length` 被挤出（溢出策略为 `drop-head` 时）。

```python
# 声明主队列时绑定死信交换机与死信路由键
ch.queue_declare(
    queue="order.paid",
    durable=True,
    arguments={
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": "orders.dlx",
        "x-dead-letter-routing-key": "order.paid.dead",
    },
)
```

延迟消息有三种做法，取舍不同：

| 方案 | 实现 | 优点 | 缺点 |
|---|---|---|---|
| TTL + DLX | 消息进入带 TTL 的队列，过期后死信回主队列 | 不依赖插件，语义标准 | 每档延迟一个队列，经典队列可能队头阻塞 |
| 延迟插件 | `rabbitmq_delayed_message_exchange`，带 `x-delay` 头 | 任意延迟、单交换机 | 需安装插件，不是核心语义 |
| quorum 原生延迟重试 | 4.3 起 `x-delayed-retry-type` 等参数 | 无需额外队列 | 版本要求高，退避是线性的 |

重试次数放在消息头 `x-retry-count` 里，每次加一，到上限直接进 DLQ。不要依赖 broker 自己记次数，因为消息重新发布后就是一条新消息，broker 不知道它们属于同一次业务重试。

> **运维提示**：重试次数、首次失败时间、最后一次错误原因都应写进消息头或日志。排障时最怕看到一条在 DLQ 里的消息，却不知道它重试过几次、每次错在哪。

### 5.4 顺序保证

RabbitMQ 只保证**同一队列、同一消费者、单线程处理**时的投递顺序。以下任一条件都会打破顺序：

| 场景 | 是否保序 | 说明 |
|---|---|---|
| 单队列单消费者 | 是 | 最基本的有序模型 |
| 单队列多消费者 | 否 | 消息被并发处理，完成顺序不定 |
| 多队列 | 否 | 队列之间没有全局顺序 |
| 重试队列回流 | 否 | 重试消息排到队尾 |
| 消费者内部线程池 | 否 | 提交顺序与处理顺序不一致 |

需要按业务键保序时，有三种做法：按 key 哈希到不同队列，每个队列单消费者；使用 `x-single-active-consumer` 让同组消费者只有一个活跃；或者把有序要求收敛到业务层，用版本号或状态机拒绝乱序更新。扩大消费者数量能提升吞吐，但会直接放弃队列内顺序。

### 5.5 流控与资源水位

RabbitMQ 有两道闸，触发后 broker 会阻塞发布连接，但消费者通常还能继续消费，直到资源恢复。

| 闸门 | 默认值 | 触发后的现象 |
|---|---|---|
| 内存高水位 | `vm_memory_high_watermark.relative=0.4` | 发布连接 blocked，`basic_publish` 卡住 |
| 磁盘低水位 | 剩余 50MB | 同上，且写入停止 |
| 文件描述符 | 由系统 ulimit 决定 | 新连接建立失败 |

```bash
# ========== 查看告警与资源 ==========
# 列出当前触发的所有告警
rabbitmq-diagnostics check_alarms

# 查看内存、磁盘、文件描述符和运行队列
rabbitmq-diagnostics status

# 查看连接是否被阻塞
rabbitmqctl list_connections name state blocked

# ========== 谨慎调整水位 ==========
# 调高内存水位只能推迟问题，不能解决消费能力不足
rabbitmqctl set_vm_memory_high_watermark 0.6
```

处理顺序是：先看告警和队列堆积，再判断是消费能力不足、消息体过大，还是保留时间过长。加消费者、缩短保留、把大消息移到对象存储，才是长期方案。直接把水位调高，下一次会以更严重的方式爆掉。

> **运维红线**：队列持续堆积时不要先调大 prefetch 或重启消费者，先定位消费速率与下游瓶颈。

---

## 六、集群与高可用

单节点 RabbitMQ 没有高可用。集群解决的是“节点故障时队列仍可用”，不是“消息自动分片”。理解这一点，才不会把普通集群当成水平扩展手段。

### 6.1 集群组成与元数据复制

RabbitMQ 集群由多个节点组成，节点名格式为 `rabbit@hostname`。所有节点必须使用相同的 Erlang cookie，并且能通过主机名互相解析。

```bash
# ========== 节点准备 ==========
# 固定主机名，保证节点名稳定
hostnamectl set-hostname rabbit1

# 查看当前节点名
rabbitmqctl cluster_status

# ========== 加入集群 ==========
# 在 rabbit2 上停止应用，准备加入现有集群
rabbitmqctl stop_app
# 指向 rabbit1 的节点名，加入后共享元数据
rabbitmqctl join_cluster rabbit@rabbit1
# 启动应用，开始提供 AMQP 服务
rabbitmqctl start_app

# ========== 查看集群状态 ==========
# 确认节点列表与运行状态
rabbitmqctl cluster_status

# ========== quorum 队列成员状态 ==========
# 查看 leader、成员节点和在线状态
rabbitmq-queues quorum_status order.paid
```

| 对象 | 是否复制 | 故障后的影响 |
|---|---|---|
| 用户、vhost、权限 | 是，Mnesia 复制 | 任一节点可管理 |
| exchange、binding | 是，Mnesia 复制 | 任一节点可声明 |
| classic queue 定义 | 是 | 队列所在节点故障则不可用 |
| classic queue 消息 | 否 | 节点故障后消息不可读 |
| quorum queue 消息 | 是，Raft 多数派 | 多数派在线即可读写 |

> **注意**：普通集群不会把 classic queue 的消息复制到其他节点。队列在哪个节点，消息就在哪个节点；该节点挂了，队列就不可用。需要跨节点容错，必须使用 quorum queue 或 stream。

### 6.2 quorum 队列的多数派

quorum queue 的每个成员都保存一份 Raft 日志，写入需要多数派确认。多数派计算公式是 `(N/2)+1`。

| 成员数 | 多数派 | 可容忍故障 | 说明 |
|---|---|---|---|
| 1 | 1 | 0 | 单节点，无容错 |
| 2 | 2 | 0 | 坏一台即不可写，不推荐 |
| 3 | 2 | 1 | 生产最小推荐 |
| 5 | 3 | 2 | 跨机架或跨可用区 |

成员数建议为奇数。偶数成员不会增加容错，只会增加写入确认的节点数。quorum queue 默认成员数为 3，声明时可以通过 `x-quorum-initial-group-size` 调整，但不要超过集群节点数。

```bash
# ========== 查看队列成员与 leader ==========
rabbitmq-queues quorum_status order.paid

# ========== 增加或移除成员 ==========
# 增加成员前确认队列有可用多数派
rabbitmq-queues add_member -p orders order.paid rabbit@rabbit4

# 永久下线节点前，先把成员迁走
rabbitmq-queues delete_member -p orders order.paid rabbit@rabbit3

# ========== 重新平衡 leader ==========
# 只调整 leader 分布，不改变成员集合
rabbitmq-queues rebalance quorum
```

> **运维红线**：quorum queue 失去多数派后会停止接受写入。此时不要强行启动少数派节点并继续写入，也不要把成员数改成 2 来“恢复”。先确认网络分区范围，恢复多数派，再处理积压。

### 6.3 网络分区与恢复

集群节点之间的网络中断会形成分区。RabbitMQ 提供三种处理策略，配置项是 `cluster_partition_handling`。

| 策略 | 行为 | 适用 |
|---|---|---|
| `ignore` | 不自动处理，分区两侧继续独立运行 | 网络稳定、人工介入 |
| `pause_minority` | 少数派节点暂停，恢复后重新加入 | 推荐，优先保数据一致 |
| `autoheal` | 网络恢复后自动选一侧重建 | 可用性优先，可能丢消息 |

`pause_minority` 的代价是少数派节点上的连接会断开，客户端需要重连到多数派。`autoheal` 会丢弃另一侧的数据，只适合可丢消息的场景。生产环境通常选 `pause_minority`，并配合监控告警。

```bash
# ========== 分区排查 ==========
# 查看集群节点与分区状态
rabbitmqctl cluster_status

# 查看节点是否处于暂停状态
rabbitmqctl eval 'rabbit_mnesia:running_nodes().'

# ========== 恢复后核对 ==========
# 确认队列成员和 leader 已恢复
rabbitmq-queues quorum_status order.paid

# 检查节点是否承载关键 quorum 队列，评估下线风险
rabbitmq-queues check_if_node_is_quorum_critical
```

> **注意**：网络分区恢复后，先看队列的成员数和 leader，再看业务积压。不要急着删除队列或重建拓扑，quorum queue 的日志会在成员重新连通后自动追平。

### 6.4 跨集群复制

federation 和 shovel 都用于跨集群搬运消息，但语义不同：

| 工具 | 方向 | 典型用途 | 一致性 |
|---|---|---|---|
| federation | 上游到下游，按交换机或队列订阅 | 多机房就近消费 | 异步，非强一致 |
| shovel | 从一个队列搬到另一个队列 | 跨集群迁移、隔离环境 | 异步，可配置确认 |

两者都不是强一致复制，也不提供跨集群的原子写。跨机房双活需要业务层接受最终一致，或者使用支持同步复制的存储系统。

---

## 七、完整示例：订单事件的重试与死信

需求：支付成功后发布 `order.paid`，下游处理失败要重试 3 次，间隔递增，最终失败进入 DLQ 并告警。

### 7.1 拓扑设计

| 对象 | 类型 | 关键参数 |
|---|---|---|
| `orders` | topic exchange | durable |
| `orders.dlx` | direct exchange | durable |
| `order.paid` | quorum queue | DLX 指向 `orders.dlx` |
| `order.paid.retry.5s` | quorum queue | `x-message-ttl=5000`，DLX 回 `orders` |
| `order.paid.retry.30s` | quorum queue | `x-message-ttl=30000`，DLX 回 `orders` |
| `order.paid.dlq` | quorum queue | 人工处理，不自动回主队列 |

流程是：生产者确认发布；消费者手动 ack；失败时读取 `x-retry-count`，少于 3 次就发布到对应重试队列并 ack 原消息；达到上限则 `nack(requeue=false)`，由 DLX 送入 DLQ。

> **注意**：重试队列的 TTL 到期后，消息作为死信回到 `orders`，routing key 必须还原成 `order.paid`，否则会再次进入死信或丢失。声明重试队列时要显式设置 `x-dead-letter-routing-key`。

### 7.2 声明拓扑

```bash
# ========== 准备 Python 环境 ==========
# 创建独立的虚拟环境
python3 -m venv /tmp/rmq-demo/.venv
# 激活虚拟环境
source /tmp/rmq-demo/.venv/bin/activate
# 安装 pika 1.x，锁定大版本避免 API 变化
pip install "pika>=1.3,<2"
```

```python
# /tmp/rmq-demo/declare.py
import pika

params = pika.URLParameters("amqp://app:change-me@127.0.0.1:5672/%2F")
conn = pika.BlockingConnection(params)
ch = conn.channel()

# 主交换机与死信交换机
ch.exchange_declare(exchange="orders", exchange_type="topic", durable=True)
ch.exchange_declare(exchange="orders.dlx", exchange_type="direct", durable=True)

# 主队列：失败进入死信交换机
ch.queue_declare(
    queue="order.paid",
    durable=True,
    arguments={
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": "orders.dlx",
        "x-dead-letter-routing-key": "order.paid.dead",
    },
)
ch.queue_bind(queue="order.paid", exchange="orders", routing_key="order.paid")

# 两档重试队列：TTL 到期后回到主交换机
for name, ttl in [("order.paid.retry.5s", 5000), ("order.paid.retry.30s", 30000)]:
    ch.queue_declare(
        queue=name,
        durable=True,
        arguments={
            "x-queue-type": "quorum",
            "x-message-ttl": ttl,
            "x-dead-letter-exchange": "orders",
            "x-dead-letter-routing-key": "order.paid",
        },
    )
    ch.queue_bind(queue=name, exchange="orders", routing_key=name)

# 死信队列：只接收最终失败的消息
ch.queue_declare(queue="order.paid.dlq", durable=True,
                 arguments={"x-queue-type": "quorum"})
ch.queue_bind(queue="order.paid.dlq", exchange="orders.dlx",
              routing_key="order.paid.dead")

print("topology declared")
conn.close()
```

### 7.3 生产者实现

```python
# /tmp/rmq-demo/produce_order.py
import json
import pika

params = pika.URLParameters("amqp://app:change-me@127.0.0.1:5672/%2F")
conn = pika.BlockingConnection(params)
ch = conn.channel()
ch.confirm_delivery()

event = {"orderId": "A100", "status": "paid", "amount": 199.00}
ch.basic_publish(
    exchange="orders",
    routing_key="order.paid",
    body=json.dumps(event).encode(),
    properties=pika.BasicProperties(
        delivery_mode=2,
        content_type="application/json",
        message_id="evt-A100-paid",
        headers={"x-retry-count": 0},
    ),
    mandatory=True,
)
print("published evt-A100-paid")
conn.close()
```

`message_id` 用业务事件 ID，消费端据此去重；`x-retry-count` 从 0 开始，后续每次重试加一。生产者的确认失败要重试或落库，不能只打印日志。

### 7.4 消费者实现

```python
# /tmp/rmq-demo/consume_order.py
import json
import pika

params = pika.URLParameters("amqp://app:change-me@127.0.0.1:5672/%2F")
conn = pika.BlockingConnection(params)
ch = conn.channel()
ch.basic_qos(prefetch_count=10)
ch.confirm_delivery()

RETRY_LIMIT = 3
RETRY_QUEUES = {1: "order.paid.retry.5s", 2: "order.paid.retry.30s"}

def handle(event):
    # 真正的业务处理放在这里，失败时抛异常
    if event.get("amount", 0) <= 0:
        raise ValueError("invalid amount")

def on_message(ch, method, properties, body):
    event = json.loads(body)
    retry = int((properties.headers or {}).get("x-retry-count", 0))
    try:
        handle(event)
        ch.basic_ack(method.delivery_tag)
    except Exception as exc:
        if retry >= RETRY_LIMIT:
            # 达到上限，进入 DLQ
            ch.basic_nack(method.delivery_tag, requeue=False)
            print("dead-lettered", event.get("orderId"), exc)
            return
        target = RETRY_QUEUES.get(retry + 1, "order.paid.retry.30s")
        # 先发布新消息并等待确认，再 ack 原消息
        ch.basic_publish(
            exchange="orders",
            routing_key=target,
            body=body,
            properties=pika.BasicProperties(
                delivery_mode=2,
                content_type="application/json",
                message_id=properties.message_id,
                headers={"x-retry-count": retry + 1, "x-last-error": str(exc)},
            ),
            mandatory=True,
        )
        ch.basic_ack(method.delivery_tag)

ch.basic_consume(queue="order.paid", on_message_callback=on_message, auto_ack=False)
print("waiting")
ch.start_consuming()
```

第 3 步的顺序是“先发新消息，再 ack 旧消息”。顺序反了，进程在中间崩溃就会丢消息；新消息也可能重复，消费端仍要按 `message_id` 去重。

### 7.5 验证与观察

```bash
# ========== 执行示例 ==========
# 第一步：声明交换机、队列与绑定
python /tmp/rmq-demo/declare.py
# 第二步：发布一条订单事件
python /tmp/rmq-demo/produce_order.py
# 第三步：启动消费者，另开终端观察队列变化
python /tmp/rmq-demo/consume_order.py

# ========== 查看队列状态 ==========
# 主队列、重试队列和 DLQ 的消息数与消费者数
rabbitmqctl list_queues -p / name messages messages_unacknowledged consumers

# ========== 查看绑定 ==========
rabbitmqctl list_bindings -p / source_name destination_name routing_key

# ========== 通过 HTTP API 核对 ==========
curl -s -u app:change-me \
  'http://127.0.0.1:15672/api/queues/%2F/order.paid' \
  | jq '{messages, messages_unacknowledged, consumers, type}'
```

输出类似：

```text
name                    messages  messages_unacknowledged  consumers
order.paid              0         0                        1
order.paid.retry.5s     0         0                        0
order.paid.retry.30s    0         0                        0
order.paid.dlq          0         0                        0
```

验证重试路径时，把 `handle` 改成必失败，再发布一条消息。预期是消息在 `retry.5s` 停留约 5 秒，回到主队列，再次失败后进入 `retry.30s`，最终进入 `order.paid.dlq`。观察 `messages` 的变化即可确认 TTL 和 DLX 是否生效。

### 7.6 容器化部署

```yaml
services:
  rabbitmq:
    image: rabbitmq:4.1-management
    hostname: rabbit1
    ports:
      - "5672:5672"
      - "15672:15672"
    environment:
      RABBITMQ_DEFAULT_USER: app
      RABBITMQ_DEFAULT_PASS: change-me
    volumes:
      - rabbitmq-data:/var/lib/rabbitmq
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 30s
      timeout: 10s
      retries: 5

  order-worker:
    build: .
    command: ["python", "consume_order.py"]
    environment:
      RABBITMQ_URL: amqp://app:change-me@rabbitmq:5672/%2F
    depends_on:
      rabbitmq:
        condition: service_healthy

volumes:
  rabbitmq-data:
```

> **注意**：`depends_on` 的 `condition: service_healthy` 只保证 broker 健康检查通过，不保证拓扑已经声明。应用启动时仍要自己声明 exchange、queue、binding，并处理声明冲突。

---

## 八、常见故障与排查

| 现象 | 最可能原因 | 处理 |
|---|---|---|
| `NOT_FOUND - no queue` | 队列未声明、vhost 不对 | 核对 vhost、队列名和声明参数 |
| 发布成功但没人收到 | 无绑定、routing key 不匹配 | 查 `list_bindings`，开启 `mandatory` |
| `PRECONDITION_FAILED` | 同名队列参数不一致 | 统一声明参数，必要时删队列重建 |
| 队列持续堆积 | 消费慢、消费者挂、预取过大 | 看消费速率和 Unacked，扩消费者或优化处理 |
| Unacked 一直不降 | 消费者不 ack 或处理卡住 | 查消费者日志，确认 `consumer_timeout` |
| 发布端卡住 | 内存或磁盘告警触发流控 | `check_alarms`，消费或扩容，清理磁盘 |
| quorum 队列不可写 | 集群失去多数派 | 恢复多数派，检查网络分区 |
| 消息反复重投 | `nack(requeue=true)` 忙循环 | 改用延迟重试队列，限制次数 |
| 消费重复 | ack 丢失、发布重试、手动重放 | 按 `message_id` 幂等 |
| 延迟消息不生效 | TTL 位置错误、DLX 未配置、插件未启用 | 检查队列参数、绑定和插件状态 |
| 管理界面打不开 | 插件未启用、端口未映射 | `rabbitmq-plugins list`，检查 15672 |
| 集群节点加入失败 | cookie 不一致、主机名无法解析 | 对齐 cookie，检查 DNS 与 epmd |

```mermaid
flowchart TD
    A["消息异常"] --> B["管理界面或 HTTP API<br/>看队列 Ready/Unacked/消费者"]
    B --> C{"消息是否到达队列"}
    C -->|"否"| D["查 exchange 绑定与 routing key<br/>检查 mandatory 退回"]
    C -->|"是"| E{"消费者是否在线"}
    E -->|"否"| F["查连接状态、basic.cancel、重连日志"]
    E -->|"是"| G{"Unacked 是否持续增长"}
    G -->|"是"| H["查处理耗时、prefetch、consumer_timeout"]
    G -->|"否"| I["查流控、磁盘、集群多数派"]
    classDef client fill:#e3f2fd,stroke:#1565c0;
    classDef engine fill:#e8f5e9,stroke:#2e7d32;
    classDef image fill:#fff3e0,stroke:#ef6c00;
    class A client
    class B,C,E,G engine
    class D,F,H,I image
```

排障顺序按“先看拓扑、再看消费、最后看资源”推进：

1. 用管理界面或 HTTP API 看 exchange 的绑定、队列的 Ready/Unacked/消费者数，确认消息有没有到达队列。
2. 用 `rabbitmqctl list_queues name messages consumers messages_unacknowledged` 看整体分布，定位是单队列还是全局堆积。
3. 用 `rabbitmqctl list_connections` 和 `list_channels` 看连接是否被阻塞、channel 是否异常关闭。
4. 查消费者日志和 ack 行为，确认是处理慢、不 ack，还是收到 `basic.cancel`。
5. 用 `rabbitmq-diagnostics check_alarms` 和 `status` 看内存、磁盘、文件描述符。
6. 集群场景最后看 `cluster_status` 和 `quorum_status`，确认多数派和 leader。

> **运维提示**：排障时先保留现场再重启。队列深度、Unacked 数、连接状态和消费者日志是判断根因的关键，重启会把这些证据一起清掉。

> **运维红线**：清空队列（`purge`）、删除队列、重置 vhost 都属于不可逆操作。执行前确认没有未确认消息、没有下游依赖，并优先在管理界面导出消息或备份。
