---
title: "RabbitMQ消息队列"
category: "05-后端"
---

# RabbitMQ消息队列

> 这篇从 RabbitMQ 的 AMQP 模型和 4.x 版本边界讲起，经过安装与最小收发、连接与信道、交换机与队列、quorum 队列、发布确认与消费确认，最后落到可靠投递、死信与延迟、Spring AMQP 集成、运维排障和一个订单消息链路案例。
>
> 学完能独立部署 RabbitMQ 4.x，按业务语义设计交换机和队列，写出不丢消息、可重试、可幂等的生产者和消费者，并在积压、重复投递和消息丢失时定位到具体环节。

## 一、RabbitMQ 的消息模型与版本边界

RabbitMQ 是一个以 AMQP 0-9-1 为主协议的通用消息代理（message broker），核心模型是「生产者把消息发给交换机，交换机按绑定规则路由到队列，消费者从队列拉取消息」，属于智能代理、简单消费者的推模式。它擅长的是**按路由规则分发、单条消息确认、低延迟任务队列和复杂重试**，不是海量日志重放。

| 维度 | RabbitMQ | Kafka |
|---|---|---|
| 消息模型 | 交换机路由到队列，消费后删除 | 分区追加日志，按 offset 重放 |
| 路由能力 | direct/topic/fanout/headers | 按 key 分区，无服务端路由 |
| 单条确认 | ack/nack，可重新入队 | offset 提交，批量位点 |
| 吞吐量级 | 万级到十万级每秒 | 十万到百万级每秒 |
| 典型场景 | 任务分发、延迟任务、业务事件 | 日志、流处理、事件溯源 |

```mermaid
graph LR
  P[生产者 Publisher] -->|"publish"| X[交换机 Exchange]
  X -->|"binding: order.created"| Q1[订单队列]
  X -->|"binding: order.#"| Q2[审计队列]
  Q1 --> C1[消费者 A]
  Q2 --> C2[消费者 B]
  Q1 -.->|"失败 / 过期"| DLX[死信交换机]
  DLX --> DLQ[死信队列]
  classDef blue fill:#eff6ff,stroke:#93c5fd,color:#1e3a8a;
  classDef green fill:#ecfdf5,stroke:#86efac,color:#166534;
  classDef amber fill:#fffbeb,stroke:#fcd34d,color:#92400e;
  classDef gray fill:#f8fafc,stroke:#cbd5e1,color:#334155;
  class P,X blue;
  class Q1,Q2,C1,C2 green;
  class DLX amber;
  class DLQ gray;
```

4.x 的边界必须提前确认，否则设计会落在已删除的能力上：

| 版本事实 | 影响 |
|---|---|
| 4.0 起移除经典镜像队列 | HA 只能用 quorum 队列或 stream |
| classic 队列仅保留 v2 实现 | 老集群升级前先迁 quorum |
| 4.0 要求 Erlang/OTP 26.2+ | 系统包里的 Erlang 往往过旧 |
| 4.1 优化 quorum 吞吐与内存 | 高吞吐队列优先 4.1+ |
| AMQP 1.0 与 0-9-1 并存 | 客户端插件与网关需对齐协议 |

> 版本基线（2026-11）：本文以企业仍在维护的 RabbitMQ 4.1.x 为基线，4.2–4.4 沿用同一套 AMQP 与 quorum 模型；4.3 起 quorum 支持严格优先级和延迟重试，4.4 起支持原生延迟投递。环境为 Erlang/OTP 26.2–27.x、Java 21、amqp-client 5.22+、Spring Boot 3.5.x（Spring AMQP 3.2.x）。补丁版本可以平滑替换；升级大版本先读 release notes 的弃用项。

**什么时候不用 RabbitMQ**：需要保留历史消息供多个团队反复重放、单 topic 百万级吞吐、按 offset 回溯计算时，用 Kafka；只需要进程内异步、重启可丢的任务，用线程池或本地队列，不要为了“架构完整”引入 broker。

## 二、安装、启动与最小验证

安装分两步：先装兼容的 Erlang/OTP，再装 RabbitMQ；版本不匹配时 broker 直接起不来。下面命令按 Linux 为主，macOS 与 Windows 给出等价路径。

Ubuntu 24.04 用官方仓库安装，系统自带的 `rabbitmq-server` 版本通常落后：

```bash
# 先加 Erlang 仓库，避免系统自带 Erlang 低于 26.2
curl -s https://packagecloud.io/install/repositories/rabbitmq/rabbitmq-erlang/script.deb.sh | sudo bash
curl -s https://packagecloud.io/install/repositories/rabbitmq/rabbitmq-server/script.deb.sh | sudo bash

# 安装 broker；erlang-base 与 erlang-nox 提供运行时
sudo apt-get update
sudo apt-get install -y erlang-base erlang-nox rabbitmq-server

# 开机自启并立即启动
sudo systemctl enable --now rabbitmq-server
```

Rocky Linux 9 / CentOS Stream 用 dnf：

```bash
curl -s https://packagecloud.io/install/repositories/rabbitmq/rabbitmq-erlang/script.rpm.sh | sudo bash
curl -s https://packagecloud.io/install/repositories/rabbitmq/rabbitmq-server/script.rpm.sh | sudo bash
sudo dnf install -y erlang rabbitmq-server
sudo systemctl enable --now rabbitmq-server
```

macOS 用 Homebrew，Windows 用 Chocolatey 或官方安装包（先装 Erlang）：

```bash
# macOS
brew install rabbitmq
brew services start rabbitmq

# Windows PowerShell（管理员）
choco install erlang
choco install rabbitmq
# 若用官方安装包：先安装 Erlang/OTP，再运行 rabbitmq-server-4.1.x.exe
```

启用管理插件并创建最小账号，不要长期使用 `guest/guest`（它默认只允许 localhost）：

```bash
sudo rabbitmq-plugins enable rabbitmq_management

sudo rabbitmqctl add_user ops 'ChangeMe_2026'
sudo rabbitmqctl set_user_tags ops administrator
sudo rabbitmqctl set_permissions -p / ops ".*" ".*" ".*"

# 确认节点、Erlang 与监听端口
sudo rabbitmqctl status
ss -lntp | grep -E '5672|15672'
```

预期输出（示例）：

```text
Status of node rabbit@node-1 ...
RabbitMQ version: 4.1.2
Erlang/OTP 27 ...
Listeners: amqp :::5672, http :::15672
```

| 端口 | 协议/用途 | 是否对外 |
|---|---|---|
| 5672 | AMQP 0-9-1 | 内网 |
| 5671 | AMQP over TLS | 内网 |
| 15672 | 管理 HTTP API/UI | 仅运维网 |
| 15692 | Prometheus 指标 | 仅监控网 |
| 1883 | MQTT（启用插件后） | 按需 |

最小闭环不写代码也能验证：声明一个 quorum 队列，通过默认交换机投递，再取回消息。默认交换机没有名字，管理 API 中记作 `amq.default`，路由键就是队列名。

```bash
# 1) 声明持久化 quorum 队列 hello
curl -s -u ops:'ChangeMe_2026' -X PUT \
  -H 'content-type: application/json' \
  -d '{"durable":true,"arguments":{"x-queue-type":"quorum"}}' \
  http://localhost:15672/api/queues/%2F/hello

# 2) 经默认交换机投递，routing_key 必须等于队列名
curl -s -u ops:'ChangeMe_2026' -X PUT \
  -H 'content-type: application/json' \
  -d '{"properties":{"delivery_mode":2},"routing_key":"hello","payload":"hello rabbit","payload_encoding":"string"}' \
  http://localhost:15672/api/exchanges/%2F/amq.default/publish

# 3) 取一条并确认，ack_requeue_false 表示取走并 ack
curl -s -u ops:'ChangeMe_2026' -X POST \
  -H 'content-type: application/json' \
  -d '{"count":1,"ackmode":"ack_requeue_false","encoding":"auto"}' \
  http://localhost:15672/api/queues/%2F/hello/get
```

预期输出（示例）：

```text
{"routed":true}
[{"payload":"hello rabbit","payload_encoding":"string","routing_key":"hello","redelivered":false,"exchange":"","message_count":0}]
```

> 边界：`routed:true` 只说明消息进了至少一个队列，不说明消费者处理成功；队列未声明、路由键写错时返回 `routed:false`，这类消息会被 broker 丢弃，生产端必须同时开 mandatory 与 returns 回调。

## 三、连接、信道与虚拟主机

一条 TCP 连接可以承载多个信道（channel），信道是 AMQP 的操作单位；**信道不是线程安全的**，多线程共用一个信道会出现帧交错和确认错乱。生产端的正确做法是每条线程使用独立信道，或使用客户端的连接/信道池。

```mermaid
sequenceDiagram
  participant APP as 应用线程
  participant CONN as TCP 连接
  participant CH as 信道 Channel
  participant BR as Broker
  APP->>CONN: 建立连接（TLS/心跳）
  APP->>CH: connection.createChannel()
  CH->>BR: basic.publish(exchange, routingKey)
  BR-->>CH: basic.ack（发布确认）
  BR->>CH: basic.deliver（推送消息）
  CH-->>BR: basic.ack(deliveryTag)
```

| 对象 | 作用 | 生命周期 |
|---|---|---|
| Connection | 一条 TCP/TLS 连接 | 应用启动到关闭 |
| Channel | 复用连接上的逻辑会话 | 线程级，短生命周期 |
| Virtual Host | 逻辑隔离与权限边界 | 集群级，需显式创建 |
| Exchange | 路由规则 | 持久化声明 |
| Queue | 消息存储与竞争消费 | 持久化声明 |

虚拟主机（virtual host，vhost）把交换机、队列、权限隔离开；多环境或多租户不要挤在 `/` 里：

```bash
sudo rabbitmqctl add_vhost order-dev
sudo rabbitmqctl set_permissions -p order-dev ops ".*" ".*" ".*"
```

连接的 URI 里 vhost 是路径，`/` 要写成 `%2F`：

```text
amqp://ops:password@rabbitmq.internal:5672/order-dev
amqp://ops:password@rabbitmq.internal:5672/%2F
```

> 边界：连接是稀缺资源，不要每发一条消息建一次连接；但也不要无限复用信道。心跳（heartbeat）建议 30–60 秒，网络设备空闲超时更短时会被断链。客户端自动恢复（automatic recovery）会重建连接和信道，但**恢复不保证未确认消息不重复**，业务仍要幂等。

## 四、交换机、队列与绑定

交换机决定消息去哪，队列决定消息怎么存、怎么被消费。设计时先定路由键规范，再定交换机和队列，不要先建一堆队列再反推路由。

| 交换机类型 | 路由规则 | 典型用途 |
|---|---|---|
| direct | routing key 完全相等 | 按事件类型精确分发 |
| fanout | 忽略 routing key，广播到所有绑定队列 | 通知、缓存刷新 |
| topic | `*` 匹配一个词，`#` 匹配零到多个词 | 领域事件多级订阅 |
| headers | 按消息头键值匹配，`x-match=all/any` | 复杂条件路由 |

```mermaid
graph TD
  E1[order.exchange topic] -->|"order.created"| QA[order.created.queue]
  E1 -->|"order.*"| QB[order.audit.queue]
  E1 -->|"order.#"| QC[order.all.queue]
  E2[notify.exchange fanout] --> QD[sms.queue]
  E2 --> QE[email.queue]
  classDef blue fill:#eff6ff,stroke:#93c5fd,color:#1e3a8a;
  classDef green fill:#ecfdf5,stroke:#86efac,color:#166534;
  classDef amber fill:#fffbeb,stroke:#fcd34d,color:#92400e;
  class E1,E2 blue;
  class QA,QB,QC,QD,QE green;
```

队列声明参数决定可靠性与清理行为：

| 参数 | 含义 | 生产建议 |
|---|---|---|
| `durable` | broker 重启后队列仍在 | 业务队列必须 true |
| `exclusive` | 仅声明连接可用，连接关闭即删 | 只用于临时回复队列 |
| `auto-delete` | 最后一个消费者断开后删除 | 临时队列才用 |
| `x-queue-type` | classic/quorum/stream | 关键业务用 quorum |
| `x-single-active-consumer` | 同组只一个消费者活跃 | 需要严格顺序时用 |

绑定（binding）是交换机与队列之间的关系，可以带参数；topic 的通配符只作用于 routing key 的点分单词，不会匹配空字符串中的任意字符：

```text
order.created   匹配 order.*、order.#
order.paid.cn   匹配 order.#，不匹配 order.*
```

> 边界：生产环境不要在应用启动时用 `auto-delete` 或 `exclusive` 声明业务队列，一次发布滚动重启就可能把队列和积压删掉。声明是幂等的，但**参数不一致会报 `PRECONDITION_FAILED`**，修改队列参数要新建队列并迁移，不能原地改。

## 五、队列类型：classic、quorum 与 stream

4.x 只有三种队列值得选：classic v2 用于单节点、可丢的短生命周期任务；quorum 用于需要副本和崩溃恢复的业务队列；stream 用于大容量、可重放、多消费者各自读的日志型场景。

| 类型 | 复制 | 消费模型 | 重放 | 适用 |
|---|---|---|---|---|
| classic v2 | 无 | 竞争消费，消息消费即删 | 不支持 | 临时任务、低价值通知 |
| quorum | Raft 多数派 | 竞争消费，消费即删 | 不支持 | 订单、支付等关键业务 |
| stream | 分区复制 | 每个消费者维护 offset | 支持 | 审计、事件回放、大扇出 |

quorum 队列是 4.x 的默认推荐，声明时必须 durable，且不能 exclusive/auto-delete：

```bash
# 通过管理 API 声明 quorum 队列，并设置投递次数上限
curl -s -u ops:'ChangeMe_2026' -X PUT \
  -H 'content-type: application/json' \
  -d '{"durable":true,"arguments":{"x-queue-type":"quorum","x-delivery-limit":5,"x-max-length":100000}}' \
  http://localhost:15672/api/queues/%2F/order.created.queue
```

`x-delivery-limit` 是 quorum 队列的毒消息保护：同一消息被重新投递超过次数后自动死信，避免无限循环。消费失败时用 `basic.nack(requeue=true)` 会消耗投递计数。

> 边界：quorum 队列不能声明为独占或非持久化，也不支持全局 QoS；消息 TTL 和优先级本身可用（4.3 起为严格 31 级），但按延迟档位拆队列仍比在同一队列混不同 TTL 更可控，队头阻塞和容量都更好计算。quorum 写入要等多数派确认，延迟高于 classic，但对订单类业务这是必要成本。classic 队列在节点故障时消息可能丢失，不能因为“有持久化”就当成高可用。

## 六、消息生命周期与确认机制

一条消息从发布到删除要经过四个确认点：到交换机、进队列、被消费者接收、被消费者 ack。任意一个环节没有确认，可靠性就依赖另一个机制补齐。

```mermaid
sequenceDiagram
  participant P as 生产者
  participant X as 交换机
  participant Q as quorum 队列
  participant C as 消费者
  P->>X: basic.publish(persistent)
  X->>Q: route + 持久化 + 复制
  Q-->>P: basic.ack（publisher confirm）
  Q->>C: basic.deliver(deliveryTag)
  C->>C: 执行业务并提交事务
  C-->>Q: basic.ack(deliveryTag)
  Note over C,Q: 业务失败时 nack(requeue=false) 进死信
```

发布确认（publisher confirm）解决“消息有没有到 broker”。开启后 broker 对每条消息异步回 `ack/nack`，`mandatory=true` 时不可路由的消息会通过 `basic.return` 退回：

```java
ConnectionFactory factory = new ConnectionFactory();
factory.setHost("rabbitmq.internal");
factory.setUsername("ops");
factory.setPassword(System.getenv("RABBIT_PASSWORD")); // 密码不落代码库
factory.setVirtualHost("order-dev");
factory.setAutomaticRecoveryEnabled(true); // 网络闪断后自动重建连接

try (Connection connection = factory.newConnection();
     Channel channel = connection.createChannel()) {
    channel.confirmSelect(); // 开启发布确认，后续 waitForConfirms 才有意义
    channel.addConfirmListener((seq, multiple) -> { /* ack 回调 */ },
                               (seq, multiple) -> { /* nack 回调，需重发或落库 */ });
    channel.addReturnListener(returned -> {
        // 交换机能收到但没有任何队列绑定时触发，必须记录并补偿
        System.err.println("unroutable: " + returned.getRoutingKey());
    });

    AMQP.BasicProperties props = new AMQP.BasicProperties.Builder()
            .deliveryMode(2) // 2 = persistent，quorum 队列重启后可恢复
            .messageId(UUID.randomUUID().toString()) // 消费端幂等键
            .contentType("application/json")
            .build();
    channel.basicPublish("order.exchange", "order.created", true, props,
            "{\"orderId\":\"A1001\"}".getBytes(StandardCharsets.UTF_8));
    channel.waitForConfirmsOrDie(5_000); // 同步等待仅用于低吞吐或启动校验
}
```

消费确认解决“消息有没有被处理完”。`autoAck=true` 在消息发出时就删除，消费者崩溃会丢消息；业务消费应使用手动 ack，并在业务事务提交后再确认：

```java
channel.basicQos(20); // 每个消费者最多 20 条未确认，防止一次推太多压垮进程
channel.basicConsume("order.created.queue", false, (tag, delivery) -> {
    try {
        handle(delivery); // 幂等处理 + 数据库事务
        channel.basicAck(delivery.getEnvelope().getDeliveryTag(), false);
    } catch (Exception e) {
        // requeue=false：不无限重试，交给死信队列和重试队列
        channel.basicNack(delivery.getEnvelope().getDeliveryTag(), false, false);
    }
}, tag -> { });
```

| 确认方式 | 语义 | 风险 |
|---|---|---|
| autoAck=true | 至多一次 | 消费中崩溃即丢消息 |
| 手动 ack | 至少一次 | 重复投递，需要幂等 |
| nack(requeue=true) | 重新入队 | 毒消息无限循环 |
| nack(requeue=false) | 死信或丢弃 | 必须有 DLX 兜底 |

> 边界：确认只覆盖 broker 与消费者之间的交接，不覆盖业务数据库。业务提交成功但 ack 丢失时，消息会重投，消费端必须用 `messageId` 或业务唯一键去重。`waitForConfirms` 会阻塞，吞吐敏感的生产者应使用异步确认加未确认集合，而不是每条都同步等。

## 七、可靠投递：生产、存储与消费三段

“消息不丢”不是打开一个开关，而是三段各自成立：生产端确认到 broker、broker 端持久化并复制、消费端处理完再 ack。缺任何一段，都只能得到有条件的可靠。

| 环节 | 必做配置 | 失败表现 |
|---|---|---|
| 生产端 | confirm + mandatory + 失败落库重发 | 消息未到 broker 或不可路由 |
| broker 端 | durable exchange/queue + persistent + quorum | 节点故障丢数据 |
| 消费端 | 手动 ack + 幂等 + 失败进重试/DLQ | 重复消费或毒消息卡住队列 |

生产端最容易被忽略的是“本地事务与发消息不是原子的”：数据库提交成功、消息发送失败，下游永远收不到。订单类业务用本地消息表（outbox）补齐：

```sql
-- 与业务在同一个数据库事务里写入，保证“业务成功则消息一定可重发”
CREATE TABLE outbox (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  event_id VARCHAR(64) NOT NULL UNIQUE,
  exchange_name VARCHAR(128) NOT NULL,
  routing_key VARCHAR(128) NOT NULL,
  payload JSON NOT NULL,
  status TINYINT NOT NULL DEFAULT 0, -- 0 待发送 1 已确认 2 失败
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
```

一个后台任务扫描 `status=0` 的记录发送，收到 confirm 后置为 1；重复发送由 `event_id` 在消费端去重。这个模式比“先发消息再写库”可靠，也比分布式事务简单。

消费端幂等的最小实现是唯一键 + 捕获重复异常：

```java
@Transactional
public void handle(OrderCreatedEvent event) {
    try {
        orderRepository.insert(event); // order_id 上有唯一索引
    } catch (DuplicateKeyException e) {
        // 重复投递说明上一次已成功，直接返回，不重复扣库存
        return;
    }
    inventoryService.reserve(event.sku(), event.quantity());
}
```

> 边界：quorum 队列提供的是至少一次（at-least-once），不是恰好一次；跨数据库和 MQ 的恰好一次要靠幂等或事务消息表实现。不要用 `basic.recover` 或反复 requeue 处理业务异常，业务异常应直接进重试队列或 DLQ。

## 八、死信、重试与延迟消息

死信交换机（dead letter exchange，DLX）承接三类消息：被 `nack(requeue=false)` 拒绝的、TTL 过期的、超过队列长度被挤出的。死信不是“删除”，而是换一个交换机继续路由，因此可以保留现场并告警。

```bash
# 业务队列绑定 DLX；消息被拒绝或过期后进入 order.dlq
curl -s -u ops:'ChangeMe_2026' -X PUT \
  -H 'content-type: application/json' \
  -d '{"durable":true,"arguments":{"x-queue-type":"quorum","x-dead-letter-exchange":"order.dlx","x-dead-letter-routing-key":"order.dead"}}' \
  http://localhost:15672/api/queues/%2F/order.created.queue
```

固定延迟用「TTL 队列 + DLX 回流」：消息先进无消费者的 TTL 队列，到期后由 broker 死信到业务交换机，重新走正常消费。不同延迟建不同队列，避免队头阻塞：

```text
order.retry.5s.queue    x-message-ttl=5000    DLX -> order.exchange / order.retry
order.retry.30s.queue   x-message-ttl=30000   DLX -> order.exchange / order.retry
order.retry.5m.queue    x-message-ttl=300000  DLX -> order.exchange / order.retry
```

```mermaid
graph LR
  BIZ[order.created.queue] -->|"处理失败 nack"| RE[order.retry.exchange]
  RE -->|"5s"| R5[retry.5s.queue]
  RE -->|"30s"| R30[retry.30s.queue]
  R5 -.->|"TTL 到期死信"| BIZ
  R30 -.->|"TTL 到期死信"| BIZ
  R5 -->|"超过重试次数"| DLQ[order.dlq]
  R30 -->|"超过重试次数"| DLQ
  classDef blue fill:#eff6ff,stroke:#93c5fd,color:#1e3a8a;
  classDef green fill:#ecfdf5,stroke:#86efac,color:#166534;
  classDef amber fill:#fffbeb,stroke:#fcd34d,color:#92400e;
  classDef gray fill:#f8fafc,stroke:#cbd5e1,color:#334155;
  class BIZ green;
  class RE,R5,R30 amber;
  class DLQ gray;
```

延迟消息插件 `rabbitmq_delayed_message_exchange` 用 `x-delayed-message` 交换机按消息头 `x-delay` 延迟投递，适合不规则延迟；代价是多一个插件依赖，且延迟消息在交换机内暂存，容量和精度要评估：

```bash
# 社区插件不随发行版自带：先从 rabbitmq-delayed-message-exchange 的 release 下载
# 与 broker 4.x 匹配的 .ez 放进 plugins 目录，再启用
sudo cp rabbitmq_delayed_message_exchange-*.ez /usr/lib/rabbitmq/plugins/
sudo rabbitmq-plugins enable rabbitmq_delayed_message_exchange
```

```text
声明交换机：type=x-delayed-message，参数 x-delayed-type=direct
发布消息：headers={"x-delay": 1800000}  // 30 分钟，单位毫秒
```

> 边界：TTL 队列的过期是“到达队头才判断”，大量不同 TTL 混在一个队列会造成队头阻塞；必须按延迟档位拆队列。延迟插件不适合分钟级以上、量级很大的场景，重启和集群迁移时消息状态要单独验证（4.4 起 broker 原生支持 `x-opt-delivery-time` 延迟投递，升级后可替代插件）。死信路由键不要指回消息的来源路由，否则会形成“业务队列 → 死信 → 业务队列”的循环。

## 九、Spring AMQP 集成

Spring AMQP 把连接工厂、信道管理、序列化和监听容器封装起来；业务代码只写 `RabbitTemplate` 与 `@RabbitListener`。关键是确认模式、预取数量、异常重试和 JSON 序列化要显式配置，不能依赖默认值。

```xml
<dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-amqp</artifactId>
</dependency>
```

```yaml
spring:
  rabbitmq:
    host: rabbitmq.internal
    port: 5672
    virtual-host: order-dev
    username: ops
    password: ${RABBIT_PASSWORD}
    publisher-confirm-type: correlated # 异步确认，能拿到每条消息的 correlationData
    publisher-returns: true            # 不可路由消息退回，配合 mandatory
    template:
      mandatory: true
    listener:
      simple:
        acknowledge-mode: manual       # 业务提交后再 ack，避免处理中丢消息
        prefetch: 20                   # 控制未确认消息上限
        concurrency: 4
        max-concurrency: 16
        default-requeue-rejected: false # 业务异常不无限 requeue，交给重试/DLQ
```

声明交换机、队列与绑定，统一放在配置类，避免生产者在运行时隐式声明：

```java
@Configuration
public class RabbitConfig {

    @Bean
    public TopicExchange orderExchange() {
        return ExchangeBuilder.topicExchange("order.exchange").durable(true).build();
    }

    @Bean
    public DirectExchange retryExchange() {
        return ExchangeBuilder.directExchange("order.retry.exchange").durable(true).build();
    }

    @Bean
    public DirectExchange deadLetterExchange() {
        return ExchangeBuilder.directExchange("order.dlx").durable(true).build();
    }

    @Bean
    public Queue orderCreatedQueue() {
        return QueueBuilder.durable("order.created.queue")
                .quorum() // 关键业务用 quorum，节点故障不丢消息
                .deadLetterExchange("order.dlx")
                .deadLetterRoutingKey("order.dead")
                .deliveryLimit(5) // 毒消息最多投递 5 次
                .build();
    }

    @Bean
    public Queue retry5sQueue() {
        return QueueBuilder.durable("order.retry.5s.queue")
                .quorum()
                .ttl(5_000) // 队列级 TTL，到期后死信回业务交换机
                .deadLetterExchange("order.exchange")
                .deadLetterRoutingKey("order.created")
                .build();
    }

    @Bean
    public Queue deadLetterQueue() {
        return QueueBuilder.durable("order.dlq").quorum().build();
    }

    @Bean
    public Binding bindCreated(Queue orderCreatedQueue, TopicExchange orderExchange) {
        return BindingBuilder.bind(orderCreatedQueue).to(orderExchange).with("order.created");
    }

    @Bean
    public Binding bindRetry(Queue retry5sQueue, DirectExchange retryExchange) {
        return BindingBuilder.bind(retry5sQueue).to(retryExchange).with("order.retry");
    }

    @Bean
    public Binding bindDlq(Queue deadLetterQueue, DirectExchange deadLetterExchange) {
        return BindingBuilder.bind(deadLetterQueue).to(deadLetterExchange).with("order.dead");
    }

    @Bean
    public Jackson2JsonMessageConverter messageConverter(ObjectMapper mapper) {
        return new Jackson2JsonMessageConverter(mapper); // 统一 JSON，避免 Java 序列化跨语言不可读
    }
}
```

生产者用 `CorrelationData` 关联确认结果；失败必须落到本地表或日志，不能只打一行 warn：

```java
@Service
public class OrderEventPublisher {
    private final RabbitTemplate rabbitTemplate;

    public OrderEventPublisher(RabbitTemplate rabbitTemplate) {
        this.rabbitTemplate = rabbitTemplate;
    }

    public void publish(OrderCreatedEvent event) {
        CorrelationData correlation = new CorrelationData(event.eventId());
        correlation.getFuture().whenComplete((confirm, ex) -> {
            if (ex != null || confirm == null || !confirm.isAck()) {
                // confirm 失败代表 broker 未接收，必须进入补偿任务重发
                log.error("publish failed, eventId={}", event.eventId(), ex);
            }
        });
        rabbitTemplate.convertAndSend("order.exchange", "order.created", event,
                message -> {
                    message.getMessageProperties().setMessageId(event.eventId());
                    message.getMessageProperties().setDeliveryMode(MessageDeliveryMode.PERSISTENT);
                    return message;
                }, correlation);
    }
}
```

消费者手动 ack；失败按重试次数选择 5s/30s/5m 队列，超过次数进 DLQ：

```java
@Component
public class OrderCreatedListener {
    private final OrderService orderService;
    private final RabbitTemplate rabbitTemplate;

    @RabbitListener(queues = "order.created.queue")
    public void onMessage(OrderCreatedEvent event, Message message, Channel channel) throws IOException {
        long tag = message.getMessageProperties().getDeliveryTag();
        try {
            orderService.handle(event); // 幂等 + 本地事务
            channel.basicAck(tag, false);
        } catch (DuplicateKeyException e) {
            channel.basicAck(tag, false); // 已处理过，确认掉，避免重复
        } catch (Exception e) {
            int retries = retryCount(message);
            if (retries >= 3) {
                channel.basicNack(tag, false, false); // 进 DLQ，保留现场
                return;
            }
            rabbitTemplate.convertAndSend("order.retry.exchange", "order.retry",
                    event, m -> {
                        m.getMessageProperties().setHeader("x-retries", retries + 1);
                        m.getMessageProperties().setDeliveryMode(MessageDeliveryMode.PERSISTENT);
                        return m;
                    });
            channel.basicAck(tag, false); // 已转入重试队列，原消息确认
        }
    }
}
```

> 边界：`@RabbitListener` 默认自动 ack，异常时按 `defaultRequeueRejected` 决定是否 requeue；示例改成手动 ack 后，任何分支都必须 ack 或 nack，漏掉会让消息一直处于 unacked 并占满 prefetch。监听器里不要做长耗时阻塞，超过心跳或消费超时会触发连接重建。JSON 转换器要固定 `ObjectMapper` 配置，避免生产与消费端的日期格式不一致。

## 十、运维、监控与故障排查

RabbitMQ 的排障顺序是「先看队列积压与消费者数，再看连接与信道，最后看资源告警」。管理界面只是展示，命令行和 HTTP API 才是可脚本化的证据。

```bash
# 队列积压、就绪数、未确认数、消费者数
sudo rabbitmqctl list_queues name type messages messages_ready messages_unacknowledged consumers

# 连接与信道，定位“连接很多但消费者为 0”
sudo rabbitmqctl list_connections name peer_host state channels
sudo rabbitmqctl list_channels connection number consumer_count messages_unacknowledged

# 资源与告警
sudo rabbitmqctl status
sudo rabbitmq-diagnostics check_running
sudo rabbitmq-diagnostics check_local_alarms
sudo rabbitmq-diagnostics memory_breakdown
```

预期输出（示例）：

```text
name                    type    messages  messages_ready  messages_unacknowledged  consumers
order.created.queue     quorum  1284      1200            84                       4
order.dlq               quorum  37        37              0                        0
```

| 现象 | 常见原因 | 第一条命令 |
|---|---|---|
| 队列持续积压 | 消费者慢或宕机 | `list_queues ... consumers` |
| 有消费者但 ready 不降 | prefetch 太小、处理阻塞 | `list_channels ... unacked` |
| 消息反复重投 | 业务异常后 requeue | 查日志 + `x-death` 头 |
| 发布端收不到 confirm | 连接断、磁盘/内存告警 | `check_local_alarms` |
| 磁盘告警 | 数据目录满、积压过多 | `df -h` + `list_queues` |
| 集群节点异常 | 网络分区、quorum 少数派 | `rabbitmq-diagnostics cluster_status` |

内存与磁盘告警会阻塞发布端（publisher blocking），这是保护 broker 的机制，不是 bug：

```bash
# 内存高水位默认 0.6，磁盘默认剩余 50MB；按机器规格调整并留余量
sudo rabbitmqctl set_vm_memory_high_watermark 0.6
sudo rabbitmqctl set_disk_free_limit 5GB
```

启用 Prometheus 插件抓关键指标：

```bash
sudo rabbitmq-plugins enable rabbitmq_prometheus
curl -s http://localhost:15692/metrics | grep -E 'rabbitmq_queue_messages|rabbitmq_consumers'
```

> 边界：`messages_ready` 高且 `consumers=0` 是“没人消费”，不是“消息丢了”；`messages_unacknowledged` 高且消费者在线，通常是 prefetch 过大或业务卡住。不要用删除队列的方式清理积压，先确认消息能否重放；DLQ 也要有人值守，否则死信只是换了个地方堆积。

## 十一、最佳实践案例

### 11.1 案例背景

一个电商订单服务每天约 3 万单，下单后要锁定库存，并在 30 分钟未支付时自动取消。现状是订单接口里同步调用库存服务：库存服务超时会拖垮下单接口，超时取消靠定时任务全表扫描。

目标是：下单主链路只写订单库并投递事件，库存异步消费；消息不丢、失败可重试、30 分钟延迟取消可落地；重复投递不重复扣库存。约束是 RabbitMQ 4.1、Spring Boot 3.5、MySQL 8.4，团队不引入 Kafka 和额外调度系统。

### 11.2 案例实操

工程结构：

```text
order-service/
├── pom.xml
└── src/main/
    ├── java/com/example/order/
    │   ├── OrderApplication.java
    │   ├── config/RabbitConfig.java
    │   ├── event/OrderCreatedEvent.java
    │   ├── mq/OrderOutboxRelay.java
    │   ├── mq/OrderCreatedListener.java
    │   ├── service/OrderService.java
    │   ├── service/OrderProcessService.java
    │   └── service/InventoryService.java
    └── resources/application.yml
```

依赖只加 Web、AMQP、JDBC 和校验，版本由 Boot 3.5 管理：

```xml
<parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.5.6</version>
    <relativePath/>
</parent>
<groupId>com.example</groupId>
<artifactId>order-service</artifactId>
<version>1.0.0</version>
<properties><java.version>21</java.version></properties>
<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-amqp</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-jdbc</artifactId>
    </dependency>
    <dependency>
        <groupId>com.mysql</groupId>
        <artifactId>mysql-connector-j</artifactId>
        <scope>runtime</scope>
    </dependency>
</dependencies>
```

配置把确认、手动 ack、预取和重试边界固定下来：

```yaml
server:
  port: 18084
spring:
  datasource:
    url: jdbc:mysql://mysql.internal:3306/order?useSSL=false&serverTimezone=Asia/Shanghai
    username: order_app
    password: ${DB_PASSWORD}
  rabbitmq:
    host: rabbitmq.internal
    port: 5672
    virtual-host: order-prod
    username: order_app
    password: ${RABBIT_PASSWORD}
    publisher-confirm-type: correlated
    publisher-returns: true
    template:
      mandatory: true
    listener:
      simple:
        acknowledge-mode: manual
        prefetch: 20
        concurrency: 4
        max-concurrency: 16
        default-requeue-rejected: false
```

声明业务队列、5 秒重试队列、30 分钟延迟取消队列和死信队列：

```java
@Configuration
public class RabbitConfig {

    @Bean
    public TopicExchange orderExchange() {
        return ExchangeBuilder.topicExchange("order.exchange").durable(true).build();
    }

    @Bean
    public DirectExchange retryExchange() {
        return ExchangeBuilder.directExchange("order.retry.exchange").durable(true).build();
    }

    @Bean
    public DirectExchange deadLetterExchange() {
        return ExchangeBuilder.directExchange("order.dlx").durable(true).build();
    }

    @Bean
    public Queue orderCreatedQueue() {
        return QueueBuilder.durable("order.created.queue")
                .quorum()
                .deadLetterExchange("order.dlx")
                .deadLetterRoutingKey("order.dead")
                .deliveryLimit(5)
                .build();
    }

    @Bean
    public Queue orderCancelDelayQueue() {
        // 只等待、不消费：30 分钟后死信到 order.cancel，由真正的取消消费者处理
        return QueueBuilder.durable("order.cancel.delay.queue")
                .quorum()
                .ttl(1_800_000)
                .deadLetterExchange("order.exchange")
                .deadLetterRoutingKey("order.cancel")
                .build();
    }

    @Bean
    public Queue orderCancelQueue() {
        // 到达这里的消息已经等满 30 分钟，消费时才真正检查并取消订单
        return QueueBuilder.durable("order.cancel.queue")
                .quorum()
                .deadLetterExchange("order.dlx")
                .deadLetterRoutingKey("order.dead")
                .deliveryLimit(5)
                .build();
    }

    @Bean
    public Queue retryQueue() {
        return QueueBuilder.durable("order.retry.5s.queue")
                .quorum()
                .ttl(5_000)
                .deadLetterExchange("order.exchange")
                .deadLetterRoutingKey("order.created")
                .build();
    }

    @Bean
    public Queue deadLetterQueue() {
        return QueueBuilder.durable("order.dlq").quorum().build();
    }

    @Bean
    public Binding bindCreated(Queue orderCreatedQueue, TopicExchange orderExchange) {
        return BindingBuilder.bind(orderCreatedQueue).to(orderExchange).with("order.created");
    }

    @Bean
    public Binding bindCancelDelay(Queue orderCancelDelayQueue, TopicExchange orderExchange) {
        // 注意路由键是 order.cancel.delay；若绑 order.cancel 会与死信回流形成自循环
        return BindingBuilder.bind(orderCancelDelayQueue).to(orderExchange).with("order.cancel.delay");
    }

    @Bean
    public Binding bindCancel(Queue orderCancelQueue, TopicExchange orderExchange) {
        return BindingBuilder.bind(orderCancelQueue).to(orderExchange).with("order.cancel");
    }

    @Bean
    public Binding bindRetry(Queue retryQueue, DirectExchange retryExchange) {
        return BindingBuilder.bind(retryQueue).to(retryExchange).with("order.retry");
    }

    @Bean
    public Binding bindDlq(Queue deadLetterQueue, DirectExchange deadLetterExchange) {
        return BindingBuilder.bind(deadLetterQueue).to(deadLetterExchange).with("order.dead");
    }
}
```

事件用 record 固定字段，`eventId` 同时作为消息 ID 与消费端幂等键：

```java
public record OrderCreatedEvent(String eventId, String orderId, String sku,
                                int quantity, Instant createdAt) {
}
```

库存扣减用条件更新，避免先查后改的并发超卖；幂等插入与扣减放在同一个本地事务里：

```java
@Service
public class InventoryService {
    private final JdbcTemplate jdbc;

    public InventoryService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Transactional
    public void reserve(String sku, int quantity) {
        int updated = jdbc.update(
                "UPDATE inventory SET available = available - ? WHERE sku = ? AND available >= ?",
                quantity, sku, quantity);
        if (updated == 0) {
            throw new IllegalStateException("库存不足: " + sku); // 触发重试，最终进 DLQ
        }
    }
}
```

```java
@Service
public class OrderProcessService {
    private final JdbcTemplate jdbc;
    private final InventoryService inventory;

    public OrderProcessService(JdbcTemplate jdbc, InventoryService inventory) {
        this.jdbc = jdbc;
        this.inventory = inventory;
    }

    @Transactional // 幂等记录与库存扣减同成败，避免"记了已消费但没扣库存"
    public void handle(OrderCreatedEvent event) {
        jdbc.update("INSERT INTO consumed_event(event_id) VALUES (?)", event.eventId());
        inventory.reserve(event.sku(), event.quantity());
    }
}
```

outbox 表与业务表在同一个库，`status` 记录投递状态：

```sql
CREATE TABLE outbox (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  event_id VARCHAR(64) NOT NULL UNIQUE,
  exchange_name VARCHAR(128) NOT NULL,
  routing_key VARCHAR(128) NOT NULL,
  payload JSON NOT NULL,
  status TINYINT NOT NULL DEFAULT 0, -- 0 待发送 1 已确认
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);
```

下单服务在同一个本地事务里写订单和 outbox，后台任务扫描 outbox 投递并确认：

```java
@Service
public class OrderService {
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;

    public OrderService(JdbcTemplate jdbc, ObjectMapper mapper) {
        this.jdbc = jdbc;
        this.mapper = mapper;
    }

    @Transactional(rollbackFor = Exception.class) // 序列化失败也要回滚订单写入
    public String create(String sku, int quantity) throws JsonProcessingException {
        String orderId = "ORD-" + System.currentTimeMillis();
        jdbc.update("INSERT INTO orders(order_id, sku, quantity, status) VALUES (?,?,?,?)",
                orderId, sku, quantity, "CREATED");
        OrderCreatedEvent event = new OrderCreatedEvent(
                UUID.randomUUID().toString(), orderId, sku, quantity, Instant.now());
        String payload = mapper.writeValueAsString(event);
        // 同事务写 outbox：DB 成功则事件必可重发，解决"库成功消息丢"
        jdbc.update("INSERT INTO outbox(event_id, exchange_name, routing_key, payload) VALUES (?,?,?,?)",
                event.eventId(), "order.exchange", "order.created", payload);
        jdbc.update("INSERT INTO outbox(event_id, exchange_name, routing_key, payload) VALUES (?,?,?,?)",
                event.eventId() + ":cancel", "order.exchange", "order.cancel.delay", payload);
        return orderId;
    }
}
```

发送器统一设置持久化、消息 ID 和确认回调，确认成功后才把 outbox 置为已发送：

```java
@Component
public class OrderOutboxRelay {
    private static final Logger log = LoggerFactory.getLogger(OrderOutboxRelay.class);
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final RabbitTemplate template;

    public OrderOutboxRelay(JdbcTemplate jdbc, ObjectMapper mapper, RabbitTemplate template) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.template = template;
    }

    @Scheduled(fixedDelay = 1_000) // 每秒扫描；投递失败留在 status=0，下一轮重试
    public void relay() {
        jdbc.query("SELECT id, event_id, exchange_name, routing_key, payload " +
                   "FROM outbox WHERE status = 0 ORDER BY id LIMIT 100", rs -> {
            long id = rs.getLong("id");
            String messageId = rs.getString("event_id");
            try {
                OrderCreatedEvent event = mapper.readValue(rs.getString("payload"),
                        OrderCreatedEvent.class);
                CorrelationData correlation = new CorrelationData(messageId);
                correlation.getFuture().whenComplete((confirm, ex) -> {
                    if (ex == null && confirm != null && confirm.isAck()) {
                        jdbc.update("UPDATE outbox SET status = 1 WHERE id = ?", id);
                    }
                });
                template.convertAndSend(rs.getString("exchange_name"),
                        rs.getString("routing_key"), event, message -> {
                            message.getMessageProperties().setMessageId(messageId);
                            message.getMessageProperties()
                                    .setDeliveryMode(MessageDeliveryMode.PERSISTENT);
                            return message;
                        }, correlation);
            } catch (JsonProcessingException e) {
                log.error("outbox payload 损坏, id={}", id, e);
            }
        });
    }
}
```

启动类需要 `@EnableScheduling`，否则扫描任务不会执行：

```java
@SpringBootApplication
@EnableScheduling
public class OrderApplication {
    public static void main(String[] args) {
        SpringApplication.run(OrderApplication.class, args);
    }
}
```

消费者先做幂等插入，再扣库存；失败消息转 5 秒重试队列，重试三次后进 DLQ：

```java
@Component
public class OrderCreatedListener {
    private final OrderProcessService processService;
    private final RabbitTemplate template;

    public OrderCreatedListener(OrderProcessService processService, RabbitTemplate template) {
        this.processService = processService;
        this.template = template;
    }

    @RabbitListener(queues = "order.created.queue")
    public void onCreated(OrderCreatedEvent event, Message message, Channel channel) throws IOException {
        long tag = message.getMessageProperties().getDeliveryTag();
        try {
            processService.handle(event); // 本地事务：幂等记录 + 扣库存
            channel.basicAck(tag, false);
        } catch (DuplicateKeyException e) {
            channel.basicAck(tag, false); // 该事件已处理，重复投递直接确认
        } catch (Exception e) {
            int retries = (int) message.getMessageProperties().getHeaders()
                    .getOrDefault("x-retries", 0);
            if (retries >= 3) {
                channel.basicNack(tag, false, false); // 超过次数，进入 order.dlq
                return;
            }
            try {
                template.convertAndSend("order.retry.exchange", "order.retry", event, m -> {
                    m.getMessageProperties().setHeader("x-retries", retries + 1);
                    m.getMessageProperties().setDeliveryMode(MessageDeliveryMode.PERSISTENT);
                    return m;
                });
                channel.basicAck(tag, false); // 已转入重试队列，原消息确认
            } catch (Exception sendFailure) {
                // 重试消息都没发出去时不能 ack，requeue 原消息，靠 delivery-limit 兜底
                channel.basicNack(tag, false, true);
            }
        }
    }
}
```

延迟取消消费者检查订单是否仍为未支付，已支付则忽略：

```java
@Component
public class OrderCancelListener {
    private final JdbcTemplate jdbc;

    public OrderCancelListener(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @RabbitListener(queues = "order.cancel.queue")
    public void onCancelDelay(OrderCreatedEvent event, Channel channel, Message message) throws IOException {
        long tag = message.getMessageProperties().getDeliveryTag();
        int updated = jdbc.update(
                "UPDATE orders SET status='CANCELLED' WHERE order_id=? AND status='CREATED'",
                event.orderId()); // 条件更新保证已支付订单不会被误取消
        channel.basicAck(tag, false);
    }
}
```

启动 broker 侧资源与消费者，然后发一笔订单：

```bash
mvn -B clean package
java -jar target/order-service-1.0.0.jar --spring.profiles.active=prod

curl -s -X POST 'http://localhost:18084/api/orders?sku=SKU-1&quantity=2'
```

预期输出（示例，命令和字段真实，数值为演示）：

```text
{"orderId":"ORD-1762992000123","status":"CREATED"}
```

查看队列与确认链路：

```bash
sudo rabbitmqctl list_queues name messages messages_ready messages_unacknowledged consumers | \
  grep -E 'order\.(created|cancel|retry|dlq)'
```

```text
order.created.queue        0    0    0    4
order.cancel.delay.queue   1    1    0    0
order.cancel.queue         0    0    0    1
order.retry.5s.queue       0    0    0    0
order.dlq                  0    0    0    0
```

模拟库存不足，失败消息先进入 5 秒重试队列，三次重试耗尽后进入 DLQ：

```bash
curl -s -X POST 'http://localhost:18084/api/orders?sku=SKU-OUT&quantity=1'
sleep 20   # 等三轮 5 秒 TTL 重试走完
sudo rabbitmqctl list_queues name messages messages_ready | grep order
```

```text
order.created.queue        0    0
order.cancel.delay.queue   2    2
order.cancel.queue         0    0
order.retry.5s.queue       0    0
order.dlq                  1    1
```

### 11.3 案例结果

下单接口 P99 从同步调用库存时的 820ms 降到 48ms（示例），库存服务故障不再拖垮下单接口；quorum 队列在单节点重启后保留全部消息，未出现订单事件丢失；5 秒重试队列消化了瞬时数据库连接超时，超过三次的异常进入 DLQ 并触发告警；30 分钟延迟队列在到期后把取消事件回流到业务交换机，已支付订单因条件更新不会被误取消。

复盘三个失败模式：第一，最初用 classic 队列存订单事件，节点重启后丢了一批消息，迁到 quorum 后恢复能力才成立；第二，消费者用 `nack(requeue=true)` 处理库存不足，导致同一条消息在队列头无限循环，改成重试队列加投递上限后队列恢复流动；第三，延迟取消最初用单条消息 TTL，队头阻塞让后面的消息延迟被拉长，改成独立 TTL 队列后到期时间才稳定。下一步是把 DLQ 接入告警和人工重放工具，并用 Prometheus 对 `messages_ready` 做持续监控。
