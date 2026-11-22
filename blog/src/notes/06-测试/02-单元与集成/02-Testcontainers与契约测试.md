---
title: "Testcontainers与契约测试"
category: "06-测试"
---

# Testcontainers与契约测试

> 这篇从 mock 的失效边界讲起，经过 Testcontainers 的真实依赖环境、数据库与中间件容器、WireMock 的外部 HTTP 替身、Pact 的消费者驱动契约，最后落到 CI 编排与一个订单-库存服务的完整落地案例。
>
> 学完能用 Testcontainers 搭出可重复的集成测试环境，用 WireMock 覆盖第三方故障，并用 Pact 把跨服务接口的破坏性变更拦在合并之前。

## 一、真实依赖与测试替身的边界

Mock 只能证明代码按假定的协议调用了协作者，不能证明协作者真的按这个协议工作；集成测试的价值就是把“假定”换成“事实”。

### 1.1 假依赖放过的事故

四类事故在“全 mock”的测试里永远不会暴露，因为 mock 由写测试的人自己定义，错误假设被自己验证了一遍。

| 事故 | 表现 | 根因 | 能挡住它的测试 |
|---|---|---|---|
| H2 通过、PostgreSQL 报错 | 上线后 SQL 报错或约束冲突 | 方言、类型、锁与迁移行为不同，H2 只是近似 | Testcontainers |
| 双方各自 mock 都通过 | 联调 500，字段名不一致 | 请求/响应形状没有共同事实 | Pact |
| 本地通过、并发下偶发失败 | 死锁、锁等待超时 | mock 没有事务和隔离级别 | Testcontainers |
| 第三方超时后线程挂死 | 大促期间连接池耗尽 | stub 永远返回 200，超时路径没测过 | WireMock 故障注入 |

代价同样真实：一个 Spring 上下文加一个 PostgreSQL 容器，首次启动通常在 3–8 秒，而纯单元测试是毫秒级。所以真实依赖只放在“协作事实”上，不放在分支逻辑上。

### 1.2 三种工具各自替身什么

三种工具不是替代关系，边界由“谁拥有这个依赖”决定。

| 工具 | 替身对象 | 产物 | 主要成本 |
|---|---|---|---|
| Testcontainers | 自己拥有的基础设施：数据库、缓存、消息 | 一次性容器 + 真实端口 | 启动秒级，CI 需要 Docker |
| WireMock | 不受控的第三方 HTTP | 进程内 stub 服务 | stub 是单方面假设，不会自动失效 |
| Pact | 跨团队、跨服务的接口契约 | pact JSON + 验证结果 | 需要 Broker 和流水线顺序 |

- 自己团队的服务（订单调库存）用真实容器或 Pact，不要用 WireMock，否则等于把对方的实现猜了一遍。
- 第三方支付、短信、地图用 WireMock，因为拿不到对方的测试环境，也不该在流水线里真扣款。
- 同一份接口既写 WireMock 又写 Pact 是重复投入：WireMock 管“消费者怎么应对故障”，Pact 管“双方字段是否还对得上”。

### 1.3 不该用的场景

真实依赖测试不是默认选项，以下情况应明确降级，并把风险写进测试策略。

- 纯函数、值对象、DTO 映射：mock 都不需要，直接断言。
- 依赖无法容器化：授权加密机、大型机、专有硬件。做法是定义 fake（带状态的假实现）并单列一份接口契约文档，明确“这部分只能靠联调”。
- CI 没有容器能力且短期无法提供：不要用 `@Testcontainers(disabledWithoutDocker = true)` 把集成测试静默跳过，那等于测试不存在。正确做法是把 `*IT` 拆到夜间流水线，失败必须通知，而不是变绿。
- 契约测试不替代功能测试：Pact 只验证消费者实际用到的字段和状态码，业务规则（库存不足是否拒绝）仍要提供者自己的测试覆盖。

## 二、环境与依赖准备

这章解决“能跑起来”：容器运行时、Maven 依赖、一个 30 秒内可验证的最小用例。

### 2.1 版本基线

版本基线固定在 2026-11-13，镜像 tag 必须写死，禁止 `latest`。

| 组件 | 基线 | 说明 |
|---|---|---|
| Java | 21 LTS | Testcontainers 与 Pact 4.6 均支持 |
| Spring Boot | 3.5.x | `@ServiceConnection` 自 3.1 起可用 |
| Testcontainers | 1.20.x | 用 BOM 统一版本 |
| Pact JVM | 4.6.x | 消费者与提供者模块版本一致 |
| WireMock | 3.9.x | 3.x 起坐标为 `org.wiremock` |
| PostgreSQL 镜像 | `postgres:16.4-alpine` | 与生产大版本一致 |

> 边界：Testcontainers 与生产库的大版本必须一致，小版本可以不同。用 MySQL 5.7 镜像测 MySQL 8.4 生产库，等于换了一种方言。

### 2.2 容器运行时

Testcontainers 通过 Docker API 工作，本机必须有可用的 Docker 守护进程。

```bash
# 三端通用：能输出 ServerVersion 才算可用
docker info --format '{{.ServerVersion}}'
```

macOS：

```bash
brew install --cask docker          # Docker Desktop，自带 compose 与 BuildKit
# 或使用轻量方案
brew install colima docker
colima start --cpu 4 --memory 8     # 容器总数多时内存低于 8G 容易 OOM
```

Ubuntu 24.04：

```bash
sudo apt update
sudo apt install -y docker.io
sudo usermod -aG docker "$USER"     # 重新登录后生效，否则 /var/run/docker.sock 无权限
sudo systemctl enable --now docker
```

Rocky Linux 9：

```bash
sudo dnf install -y dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io
sudo systemctl enable --now docker
```

Windows：安装 Docker Desktop，启用 WSL2 后端，把项目放在 WSL 文件系统内（`\\wsl$` 路径下 IO 慢，会让构建时间翻倍）。

> 边界：Podman 需要额外的 socket 兼容层，且部分 Testcontainers 模块（如 `KafkaContainer` 的端口探测）行为不同，不作为基线。CI 里用 rootless Docker 时，`TESTCONTAINERS_HOST_OVERRIDE` 要指向宿主机可达地址。

### 2.3 Maven 依赖

Testcontainers 用 BOM 管版本，Pact 的消费者与提供者模块分别引入，WireMock 3.x 只有一个坐标。

```xml
<properties>
  <java.version>21</java.version>
  <testcontainers.version>1.20.6</testcontainers.version>
  <pact.version>4.6.17</pact.version>
  <wiremock.version>3.9.1</wiremock.version>
</properties>

<dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>org.testcontainers</groupId>
      <artifactId>testcontainers-bom</artifactId>
      <version>${testcontainers.version}</version>
      <type>pom</type>
      <scope>import</scope>
    </dependency>
  </dependencies>
</dependencyManagement>

<dependencies>
  <!-- 测试基座：JUnit 5、AssertJ、Awaitility 都在里面 -->
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-test</artifactId>
    <scope>test</scope>
  </dependency>

  <!-- @ServiceConnection 与容器 Bean 的生命周期管理 -->
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-testcontainers</artifactId>
    <scope>test</scope>
  </dependency>

  <dependency>
    <groupId>org.testcontainers</groupId>
    <artifactId>junit-jupiter</artifactId>
    <scope>test</scope>
  </dependency>
  <dependency>
    <groupId>org.testcontainers</groupId>
    <artifactId>postgresql</artifactId>
    <scope>test</scope>
  </dependency>
  <dependency>
    <groupId>org.testcontainers</groupId>
    <artifactId>kafka</artifactId>
    <scope>test</scope>
  </dependency>

  <!-- Spring Boot 3.5 用 Flyway 11，数据库专属模块必须单独引入 -->
  <dependency>
    <groupId>org.flywaydb</groupId>
    <artifactId>flyway-core</artifactId>
  </dependency>
  <dependency>
    <groupId>org.flywaydb</groupId>
    <artifactId>flyway-database-postgresql</artifactId>
  </dependency>

  <dependency>
    <groupId>org.wiremock</groupId>
    <artifactId>wiremock-standalone</artifactId>
    <version>${wiremock.version}</version>
    <scope>test</scope>
  </dependency>
  <!-- 2.4 的最小验证用 Jedis 从宿主机连容器端口 -->
  <dependency>
    <groupId>redis.clients</groupId>
    <artifactId>jedis</artifactId>
    <version>5.2.0</version>
    <scope>test</scope>
  </dependency>
  <dependency>
    <groupId>au.com.dius.pact.consumer</groupId>
    <artifactId>junit5</artifactId>
    <version>${pact.version}</version>
    <scope>test</scope>
  </dependency>
  <dependency>
    <groupId>au.com.dius.pact.provider</groupId>
    <artifactId>junit5</artifactId>
    <version>${pact.version}</version>
    <scope>test</scope>
  </dependency>
</dependencies>
```

### 2.4 最小验证

一个 Redis 容器足以验证“Docker 可用、镜像能拉、等待策略正确、测试进程能连上”。

```java
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import redis.clients.jedis.Jedis;

import static org.assertj.core.api.Assertions.assertThat;

@Testcontainers
class RedisSmokeIT {

    @Container
    static final GenericContainer<?> REDIS =
        new GenericContainer<>(DockerImageName.parse("redis:7.4-alpine"))
            .withExposedPorts(6379)
            // 只等端口会拿到"已监听但未加载完配置"的实例，首批命令偶发连接被拒
            .waitingFor(Wait.forLogMessage(".*Ready to accept connections.*", 1));

    @Test
    void redisAcceptsPing() {
        // 容器内 6379 映射到宿主机随机端口，不能硬编码
        try (Jedis jedis = new Jedis(REDIS.getHost(), REDIS.getMappedPort(6379))) {
            assertThat(jedis.ping()).isEqualTo("PONG");
        }
    }
}
```

```bash
mvn -Dtest=RedisSmokeIT test
```

输出（示例）：

```text
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0
[INFO] BUILD SUCCESS
[INFO] Total time: 12.480 s
```

容器日志中能看到 `Ready to accept connections tcp`。若卡在拉镜像，先把镜像手动 `docker pull` 一次，再判断是网络问题还是配置问题。

### 2.5 本机没有 Docker 时

没有容器运行时，Testcontainers 测试无法执行，只能明确跳过，不能用 H2 顶替。

| 做法 | 结果 | 适用 |
|---|---|---|
| `@Testcontainers(disabledWithoutDocker = true)` | 无 Docker 时静默跳过 | 只用于个人本地，CI 禁用 |
| Maven profile 排除 `*IT` | 本地只跑单元测试 | 本地无 Docker，CI 有 |
| 远程 `DOCKER_HOST` | 连到共享 Docker 主机 | 团队统一环境 |
| 直接失败 | 暴露环境缺失 | CI 默认 |

CI 里必须选“直接失败”或“显式排除并报警”。跳过不报警的测试，比没有测试更危险，因为它会让人以为覆盖过了。

## 三、Testcontainers 的容器生命周期

这章解决“容器何时启动、怎么等待、如何复用、何时销毁”，容器管理的错误几乎都表现为偶发失败。

### 3.1 静态容器与实例容器

`static` 容器每个测试类启动一次，实例容器每个测试方法启动一次；选择依据是“测试之间能否共享状态”。

```java
@Testcontainers
class ContainerScopeDemoIT {

    // 静态：整个类共享，启动一次约 5 秒，适合只读或能可靠清理的库
    @Container
    static final PostgreSQLContainer<?> PG =
        new PostgreSQLContainer<>("postgres:16.4-alpine");

    // 实例：每个测试方法一个全新库，隔离彻底，但 10 个方法就是 10 次启动
    @Container
    final PostgreSQLContainer<?> isolated =
        new PostgreSQLContainer<>("postgres:16.4-alpine");

    @Test
    void sharedContainer() {
        assertThat(PG.isRunning()).isTrue();
    }

    @Test
    void isolatedContainer() {
        assertThat(isolated.isRunning()).isTrue();
    }
}
```

> 边界：静态容器的状态会跨测试泄漏。用静态容器就必须在每个测试前清理数据，否则测试顺序变化会引发“单独跑通过、一起跑失败”。

### 3.2 等待策略

端口可连不等于服务可用；等待策略决定容器何时被判定为 ready。

```java
new GenericContainer<>(DockerImageName.parse("mysql:8.4"))
    .withEnv("MYSQL_ROOT_PASSWORD", "test")
    .withExposedPorts(3306)
    // MySQL 首次启动会先监听端口再初始化数据目录；官方镜像没有 HEALTHCHECK，用日志等待最终就绪
    .waitingFor(Wait.forLogMessage(".*ready for connections.*", 2))
    .withStartupTimeout(Duration.ofMinutes(3));  // 慢磁盘或冷镜像拉取需要更长超时
```

| 策略 | 依据 | 适用 |
|---|---|---|
| `Wait.forListeningPort()` | 端口 | 无健康检查的简单服务 |
| `Wait.forLogMessage()` | 日志正则 | 日志能明确表示 ready 的服务 |
| `Wait.forHealthcheck()` | 镜像 HEALTHCHECK | 镜像定义了健康检查时；MySQL、PostgreSQL、Redis 官方镜像通常没有 |
| `Wait.forHttp()` | HTTP 200 | 有管理端点的服务 |
| `Wait.forSuccessfulCommand()` | 容器内命令 | 需要业务级校验 |

> 边界：`forLogMessage` 的正则要匹配“只出现一次”的那行。匹配 `.*started.*` 这种会多次命中的日志时，`times` 参数设错会让等待提前返回。

### 3.3 端口映射与容器网络

宿主机访问用 `getHost()` + `getMappedPort()`，容器之间互访要用共享网络和别名。

```java
Network network = Network.newNetwork();

GenericContainer<?> db = new GenericContainer<>("postgres:16.4-alpine")
    .withNetwork(network)
    .withNetworkAliases("db")          // 应用容器内用 db:5432，不能用宿主机映射端口
    .withEnv("POSTGRES_PASSWORD", "test")
    .withExposedPorts(5432);

GenericContainer<?> app = new GenericContainer<>("myorg/order-service:1.0.0")
    .withNetwork(network)
    .withEnv("SPRING_DATASOURCE_URL", "jdbc:postgresql://db:5432/postgres")
    .dependsOn(db);                     // 只保证启动顺序，不保证 db 已 ready

app.start();
assertThat(app.getLogs()).contains("Started OrderServiceApplication");
```

> 边界：`dependsOn` 只保证启动顺序，不保证被依赖容器就绪。生产代码里配置了重试才能这样用；没有重试就必须显式等待 db 的健康检查。

### 3.4 容器复用

复用能把多模块构建从“每个模块重启一次数据库”降到“整场构建一次”，代价是状态残留。

```java
new PostgreSQLContainer<>("postgres:16.4-alpine")
    .withReuse(true);   // 相同配置的容器在 JVM 重启后继续复用
```

启用复用需要在本机 `~/.testcontainers.properties` 加一行：

```properties
testcontainers.reuse.enable=true
```

> 边界：CI 不复用。共享 runner 上复用容器会把上一个构建的数据带进下一个构建，且 Ryuk 的清理语义会变得不可预测。复用只在本地开发开启。

### 3.5 清理与调试

Ryuk 负责在 JVM 退出后删除容器；调试时要能看到容器日志，而不是只看测试异常。

```java
static final GenericContainer<?> KAFKA =
    new GenericContainer<>(DockerImageName.parse("confluentinc/cp-kafka:7.7.1"))
        .withExposedPorts(9092)
        .withLogConsumer(new Slf4jLogConsumer(LoggerFactory.getLogger("kafka")));
```

- `container.getLogs()` 拿全量日志，适合断言启动失败原因。
- `container.followOutput()` 实时输出，适合本地调试启动卡住。
- 测试进程被 `kill -9` 时 Ryuk 仍会清理；若设置了 `TESTCONTAINERS_RYUK_DISABLED=true`，残留容器会一直占端口和内存。

## 四、数据库与中间件集成测试

这章解决“用真库测真实 SQL 行为”，目标是让测试库与生产库的差异只剩数据量。

### 4.1 Spring Boot 3.5 的 @ServiceConnection

`@ServiceConnection` 让容器直接产出连接信息，省掉手写 `@DynamicPropertySource`，也避免 URL 拼错。

```java
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.testcontainers.containers.PostgreSQLContainer;

@TestConfiguration(proxyBeanMethods = false)
class PostgresContainerConfig {

    @Bean
    @ServiceConnection                    // 自动注册 spring.datasource.*，无需手拼 JDBC URL
    PostgreSQLContainer<?> postgres() {
        // 写死 tag：latest 漂移会让"昨天通过、今天失败"变成常态
        return new PostgreSQLContainer<>("postgres:16.4-alpine");
    }
}
```

```java
@SpringBootTest
@Import(PostgresContainerConfig.class)
class OrderRepositoryIT {

    @Autowired OrderRepository orders;

    @Test
    void duplicateOrderNoIsRejectedByDatabase() {
        orders.save(new Order("ORD-1", "SKU-001", 2));

        // 唯一约束是数据库行为，H2 与 PostgreSQL 的报错类型和时机都不同
        assertThatThrownBy(() -> orders.save(new Order("ORD-1", "SKU-002", 1)))
            .isInstanceOf(DataIntegrityViolationException.class);
    }
}
```

作为 Bean 声明的容器由 Spring Boot 管理生命周期：上下文启动前拉起，上下文关闭后销毁。不要再用 `@Container` 标注同一个字段，两者叠加会导致重复启动。

### 4.2 迁移脚本在容器里执行

每次都是全新容器，Flyway 从零跑完整个迁移链，能发现“本地库手工改过、脚本缺列”的问题。

```yaml
spring:
  jpa:
    hibernate:
      ddl-auto: validate      # 用迁移建表，用实体校验；create/update 会掩盖脚本缺失
  flyway:
    enabled: true
    locations: classpath:db/migration
```

`ddl-auto: validate` 是关键：它让“实体与迁移不一致”在启动时直接失败，而不是等到运行时缺列。

### 4.3 测试间的数据隔离

四种隔离方式没有优劣，只有适用面；选错会得到“偶发失败”或“构建慢到没人跑”。

| 方式 | 速度 | 适用 | 主要坑 |
|---|---|---|---|
| `@Transactional` 回滚 | 快 | 只读与单库写 | 对 `REQUIRES_NEW`、MQ、HTTP 无效 |
| 每测试前 `TRUNCATE` | 中 | 写路径 | 外键顺序、序列不重置 |
| 每测试新 schema | 慢 | 并行写 | 迁移成本翻倍 |
| 每测试新容器 | 最慢 | 少量破坏性用例 | CI 时间不可控 |

```java
@BeforeEach
void cleanDatabase() {
    // 一条语句清空所有业务表，比逐表 delete 少一半时间；RESTART IDENTITY 让自增从头开始
    jdbc.execute("TRUNCATE TABLE orders, order_items RESTART IDENTITY CASCADE");
}
```

> 边界：`@Transactional` 测试里，被测代码如果自己开了新事务（`REQUIRES_NEW`），回滚不会覆盖它。这类测试会污染后续用例，表现为“单独跑通过、全量跑失败”。

### 4.4 值得上真库的断言

只有数据库才能回答的问题才值得启动容器：约束、方言、锁、类型。

```java
@Test
void jsonbContainmentWorksOnlyOnPostgres() {
    jdbc.update("""
        INSERT INTO orders(order_no, sku, quantity, attrs)
        VALUES (?, ?, ?, ?::jsonb)
        """, "ORD-2", "SKU-002", 1, """
        {"channel":"app","coupon":{"code":"C1"}}
        """);

    // @> 是 PostgreSQL 的 JSONB 包含运算符，H2 没有等价语法，这类查询只能上真库
    Integer count = jdbc.queryForObject("""
        SELECT count(*) FROM orders
        WHERE attrs @> '{"coupon":{"code":"C1"}}'::jsonb
        """, Integer.class);

    assertThat(count).isEqualTo(1);
}
```

第二类值得测的是并发行为：`SELECT ... FOR UPDATE` 的等待、唯一索引在并发插入下的冲突。这类测试需要两个线程和真实事务，mock 无法模拟。

### 4.5 Kafka 容器

消息中间件的集成测试要验证的是“序列化后的字节能否被 broker 接收”，而不是业务消费逻辑。

```java
import org.testcontainers.kafka.ConfluentKafkaContainer;

@TestConfiguration(proxyBeanMethods = false)
class KafkaContainerConfig {

    @Bean
    @ServiceConnection                    // 注册 spring.kafka.bootstrap-servers
    ConfluentKafkaContainer kafka() {
        // cp-kafka 镜像对应 ConfluentKafkaContainer；KafkaContainer 只支持 apache/kafka 镜像
        return new ConfluentKafkaContainer("confluentinc/cp-kafka:7.7.1");
    }
}
```

```java
@Test
void brokerAcceptsProducedRecord() throws Exception {
    var props = Map.of(
        ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, kafka.getBootstrapServers(),
        ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class,
        ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);

    try (var producer = new KafkaProducer<String, String>(props)) {
        // get 带超时：不阻塞等待 broker 确认，失败会被当成"测试慢"而不是"消息丢了"
        var meta = producer.send(
            new ProducerRecord<>("order.created", "ORD-1", "{}")).get(10, TimeUnit.SECONDS);
        assertThat(meta.topic()).isEqualTo("order.created");
    }
}
```

> 边界：Kafka 容器首次启动约 10–20 秒。消费逻辑的测试用 `@KafkaListener` + `Awaitility` 轮询，不要用 `Thread.sleep`，否则慢机器上必然偶发失败。

### 4.6 Redis 容器

Spring Boot 3.5 的 `@ServiceConnection` 按容器类型或名称匹配；`GenericContainer` 形式必须加 `name = "redis"`，否则用 `@DynamicPropertySource` 显式映射。

```java
@Testcontainers
@SpringBootTest
class CouponCacheIT {

    @Container
    static final GenericContainer<?> REDIS =
        new GenericContainer<>(DockerImageName.parse("redis:7.4-alpine"))
            .withExposedPorts(6379)
            .waitingFor(Wait.forLogMessage(".*Ready to accept connections.*", 1));

    @DynamicPropertySource
    static void redisProps(DynamicPropertyRegistry registry) {
        registry.add("spring.data.redis.host", REDIS::getHost);
        registry.add("spring.data.redis.port", () -> REDIS.getMappedPort(6379));
    }

    @Autowired CouponCache cache;

    @Test
    void cacheSurvivesRoundTrip() {
        cache.put("C1", 30);
        assertThat(cache.get("C1")).isEqualTo(30);
    }
}
```

## 五、外部 HTTP 依赖：WireMock

这章解决“第三方服务不可控、不能真调用、但必须有故障覆盖”的问题。

### 5.1 边界

WireMock 只能替身“契约由对方决定、但测试里拿不到对方”的 HTTP 服务；它不能替身自己团队的服务。

原因是 stub 由消费者单方面编写：对方把 `status` 改成 `state`，stub 不会失败，测试依然全绿。这正是 Pact 存在的理由。WireMock 的职责是验证消费者在 4xx、5xx、超时、乱序下的行为。

### 5.2 两种部署形态

| 形态 | 启动 | 跨语言 | 适用 |
|---|---|---|---|
| 进程内 `WireMockServer` | 毫秒 | 否 | Java 测试，绝大多数场景 |
| 独立容器 | 秒级 | 是 | 多语言联调、需要固定地址 |

进程内形态用随机端口，避免共享 runner 上的端口冲突。

### 5.3 stub 匹配与优先级

stub 写得越宽，测试越容易假通过；匹配条件要覆盖“这个测试真正依赖的输入”。

```java
import static com.github.tomakehurst.wiremock.client.WireMock.*;

GATEWAY.stubFor(post(urlPathEqualTo("/v1/payments"))
    // 路径相同、金额不同就是两笔支付，不匹配金额会让断言失去意义
    .withQueryParam("currency", equalTo("CNY"))
    .withHeader("Idempotency-Key", matching("[0-9a-f-]{36}"))
    .withRequestBody(matchingJsonPath("$.amount", equalTo("19900")))
    .willReturn(aResponse()
        .withStatus(201)
        .withHeader("Content-Type", "application/json")
        .withBody("""
            {"paymentId":"pay-1","status":"CAPTURED"}
            """)));
```

优先级用 `atPriority` 控制，数字越小越优先。默认规则是“最后添加的优先”，在共享 stub 的测试类里容易互相覆盖。

```java
// 兜底规则：没被更具体的 stub 命中时返回 503，用来验证降级路径
GATEWAY.stubFor(post(urlEqualTo("/v1/payments"))
    .atPriority(10)
    .willReturn(aResponse().withStatus(503)));
```

### 5.4 故障注入

超时、连接重置、5xx 连续返回，是第三方依赖最常见的三种失败，必须在测试里显式构造。

```java
@Test
void paymentTimesOutAndFallsBackToPending() {
    GATEWAY.stubFor(post(urlEqualTo("/v1/payments"))
        // 延迟必须大于客户端超时值，否则测的是"慢但成功"
        .willReturn(aResponse().withFixedDelay(3_000).withStatus(201)));

    var result = checkout.pay(new PaymentCommand("ORD-1", 19_900));

    assertThat(result.status()).isEqualTo("PENDING_CONFIRM");
}

@Test
void connectionResetIsRetriedOnce() {
    GATEWAY.stubFor(post(urlEqualTo("/v1/payments"))
        .willReturn(aResponse().withFault(Fault.CONNECTION_RESET_BY_PEER)));

    assertThatThrownBy(() -> checkout.pay(new PaymentCommand("ORD-2", 9_900)))
        .isInstanceOf(PaymentUnavailableException.class);

    GATEWAY.verify(2, postRequestedFor(urlEqualTo("/v1/payments")));  // 重试一次
}
```

连续状态用 scenario 表达，模拟“第一次 503、第二次成功”：

```java
GATEWAY.stubFor(post(urlEqualTo("/v1/payments"))
    .inScenario("retry")
    .whenScenarioStateIs(STARTED)
    .willReturn(aResponse().withStatus(503))
    .willSetStateTo("recovered"));

GATEWAY.stubFor(post(urlEqualTo("/v1/payments"))
    .inScenario("retry")
    .whenScenarioStateIs("recovered")
    .willReturn(aResponse().withStatus(201)
        .withHeader("Content-Type", "application/json")
        .withBody("""
            {"paymentId":"pay-1","status":"CAPTURED"}
            """)));
```

### 5.5 请求断言

只断言响应不够，还要断言“调用了几次、带了什么头”。幂等键、重试次数、超时后的补偿调用都属于这一类。

```java
GATEWAY.verify(2, postRequestedFor(urlEqualTo("/v1/payments"))
    .withHeader("Idempotency-Key", matching("[0-9a-f-]{36}"))
    .withRequestBody(matchingJsonPath("$.orderNo", equalTo("ORD-1"))));

// 确认没有多余的第三次调用：重试策略写错时，这里会先失败
GATEWAY.verify(exactly(2), postRequestedFor(urlEqualTo("/v1/payments")));
```

### 5.6 录制与快照

WireMock 支持代理录制：把真实第三方的一次调用录成 stub。它适合初次接入，不适合长期维护。

- 录制会把对方的动态字段（时间戳、traceId）一起带进来，下一次回放就对不上。
- 录制不会覆盖异常路径，录到的永远是正常响应。
- 录制的 stub 也不能替代契约：对方改字段名，录制的响应仍然是旧的。

结论：录制只用来生成初稿，落库前必须手工收敛匹配条件。

## 六、契约测试：Pact 的消费者驱动

这章解决“服务之间接口变更靠联调发现”的问题，把破坏性变更提前到提交阶段。

### 6.1 为什么需要契约

N 个消费者与 M 个提供者做真实集成测试，组合数是 N×M；契约测试把它降到 N+M：每个消费者对自己的用法负责，提供者验证所有消费者提交的契约。

契约不是接口文档，而是一组“消费者实际发出的请求 + 实际依赖的响应片段 + 匹配规则”。它只保证消费者用到的那部分不变，不保证接口的其他部分。

### 6.2 流程

```mermaid
sequenceDiagram
  participant C as order-service 消费者测试
  participant B as Pact Broker
  participant P as inventory-service 提供者验证
  participant G as 部署门禁
  C->>C: 用 Pact mock server 跑消费者测试
  C->>B: 发布 pact（版本 = git sha）
  P->>B: 拉取待验证契约
  P->>P: 用真实实例重放交互
  P->>B: 发布验证结果
  G->>B: can-i-deploy 查询
  B-->>G: 允许或拒绝
```

### 6.3 消费者端

消费者测试用 Pact 的 mock server 替代提供者，同时生成契约文件；测试通过意味着“消费者按契约发出了请求”。

```java
import au.com.dius.pact.consumer.MockServer;
import au.com.dius.pact.consumer.dsl.PactDslJsonBody;
import au.com.dius.pact.consumer.dsl.PactDslWithProvider;
import au.com.dius.pact.consumer.junit5.PactConsumerTestExt;
import au.com.dius.pact.consumer.junit5.PactTestFor;
import au.com.dius.pact.core.model.RequestResponsePact;
import au.com.dius.pact.core.model.annotations.Pact;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;

import static org.assertj.core.api.Assertions.assertThat;

@ExtendWith(PactConsumerTestExt.class)
class InventoryClientPactTest {

    @Pact(consumer = "order-service", provider = "inventory-service")
    RequestResponsePact reserveStock(PactDslWithProvider builder) {
        return builder
            // given 描述提供者需要准备的状态，提供者端用 @State 同名方法响应
            .given("stock exists for SKU-001")
            .uponReceiving("reserve 3 units of SKU-001")
            .path("/api/stocks/reservations")
            .method("POST")
            .headers("Content-Type", "application/json")
            .body(new PactDslJsonBody()
                .stringType("sku", "SKU-001")
                .integerType("quantity", 3))
            .willRespondWith()
            .status(201)
            .headers("Content-Type", "application/json")
            .body(new PactDslJsonBody()
                // stringType 只约束"是字符串"，不锁死具体值；锁死会让提供者换 ID 格式就假失败
                .stringType("reservationId", "rsv-1")
                .stringValue("status", "RESERVED"))
            .toPact();
    }

    @Test
    @PactTestFor(pactMethod = "reserveStock")
    void reservesStockThroughContract(MockServer mockServer) {
        var client = new InventoryClient(mockServer.getUrl());

        var reservation = client.reserve("SKU-001", 3);

        assertThat(reservation.status()).isEqualTo("RESERVED");
    }
}
```

```bash
mvn -pl order-service test -Dtest=InventoryClientPactTest
```

输出（示例）：

```text
[INFO] Tests run: 1, Failures: 0, Errors: 0, Skipped: 0
[INFO] Pact successfully written to target/pacts/order-service-inventory-service.json
[INFO] BUILD SUCCESS
```

生成的契约只保留交互，不含实现细节：

```json
{
  "consumer": { "name": "order-service" },
  "provider": { "name": "inventory-service" },
  "interactions": [
    {
      "description": "reserve 3 units of SKU-001",
      "providerStates": [{ "name": "stock exists for SKU-001" }],
      "request": {
        "method": "POST",
        "path": "/api/stocks/reservations",
        "body": { "sku": "SKU-001", "quantity": 3 }
      },
      "response": {
        "status": 201,
        "body": { "reservationId": "rsv-1", "status": "RESERVED" }
      }
    }
  ],
  "metadata": { "pactSpecification": { "version": "4.0" } }
}
```

### 6.4 提供者端

提供者端用真实实例重放契约里的每个交互，失败即说明“消费者依赖的行为已经变了”。

```java
import au.com.dius.pact.provider.junit5.HttpTestTarget;
import au.com.dius.pact.provider.junit5.PactVerificationContext;
import au.com.dius.pact.provider.junit5.PactVerificationInvocationContextProvider;
import au.com.dius.pact.provider.junitsupport.Provider;
import au.com.dius.pact.provider.junitsupport.State;
import au.com.dius.pact.provider.junitsupport.loader.PactFolder;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.TestTemplate;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

@Provider("inventory-service")
@PactFolder("../order-service/target/pacts")   // 单体仓库本地验证；CI 换成 @PactBroker
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class InventoryProviderPactIT {

    @LocalServerPort int port;

    @Autowired StockRepository stocks;

    @BeforeEach
    void pointToRunningApp(PactVerificationContext context) {
        context.setTarget(new HttpTestTarget("localhost", port));
    }

    @TestTemplate
    @ExtendWith(PactVerificationInvocationContextProvider.class)
    void verifyPact(PactVerificationContext context) {
        // 每个交互重放一次真实 HTTP 调用，而不是调 Controller 方法
        context.verifyInteraction();
    }

    @BeforeEach
    void cleanState() {
        stocks.deleteAll();
    }

    @State("stock exists for SKU-001")
    void stockExists() {
        // 状态方法必须自己构造完整前置条件，不能依赖上一个交互留下的数据
        stocks.save(new Stock("SKU-001", 10));
    }
}
```

```bash
mvn -pl inventory-service verify -Dit.test=InventoryProviderPactIT
```

输出（示例）：

```text
[INFO] Verifying a pact between order-service and inventory-service
[INFO]   Given stock exists for SKU-001
[INFO]   POST /api/stocks/reservations
[INFO]     returns a response which
[INFO]       has status code 201 (OK)
[INFO]       has a matching body (OK)
[INFO] 1 interaction, 1 success, 0 failures
[INFO] BUILD SUCCESS
```

### 6.5 匹配器的松紧

契约测试最常见的维护成本来自匹配器过严：提供者换了 ID 格式，消费者根本没用到，却让流水线红了。

| 写法 | 约束 | 适用 |
|---|---|---|
| `stringType("id","rsv-1")` | 类型是字符串 | 消费者只透传的字段 |
| `stringValue("status","RESERVED")` | 值必须完全相等 | 消费者会分支判断的枚举 |
| `regex` / `numberType` | 格式或类型 | 有格式约定的 ID、金额 |
| 数组 `minArrayLike` | 最少元素数 | 消费者只取第一个元素 |

规则只有一条：消费者代码里读到的、会改变行为的字段用严格匹配，其余用类型匹配。

### 6.6 Broker 与版本门禁

Broker 保存契约和验证结果，`can-i-deploy` 把“该版本能否上线”变成一个可查询的布尔值。

```yaml
services:
  postgres:
    image: postgres:16.4-alpine
    environment:
      POSTGRES_USER: pact
      POSTGRES_PASSWORD: pact
      POSTGRES_DB: pact
  broker:
    image: pactfoundation/pact-broker
    ports: ["9292:9292"]
    environment:
      PACT_BROKER_DATABASE_URL: postgres://pact:pact@postgres/pact
      PACT_BROKER_BASE_URL: http://localhost:9292
    depends_on: [postgres]
```

消费者发布契约：

```bash
mvn -pl order-service pact:publish \
  -Dpactbroker.url=http://localhost:9292 \
  -Dpact.publish.consumer.version="$GIT_SHA"
```

提供者验证并回传结果：

```bash
mvn -pl inventory-service verify \
  -Dpactbroker.url=http://localhost:9292 \
  -Dpact.provider.version="$GIT_SHA" \
  -Dpact.verifier.publishResults=true
```

部署前查询：

```bash
docker run --rm --network host pactfoundation/pact-cli \
  pact-broker can-i-deploy \
  --pacticipant order-service \
  --version "$GIT_SHA" \
  --to-environment production \
  --broker-base-url http://localhost:9292
```

输出（示例）：

```text
Computer says yes \o/
All required verification results are published and successful
```

拒绝时输出 `Computer says no`，并列出缺失或失败的验证。门禁要卡在部署 job 上，而不是只打印结果。

### 6.7 契约测试的边界

- 契约不测业务规则：库存不足是否拒绝、金额如何计算，属于提供者自己的单元与集成测试。
- 契约只覆盖消费者用到的字段：新增字段不会让契约失败，这是设计意图，不是漏洞。
- 提供者状态必须能独立构造：一个交互只能依赖自己声明的 `@State`，不能依赖执行顺序。
- 契约数量按“消费者-提供者对”控制，不按接口数量爆炸；一个消费者对一个提供者通常一份契约。
- 消息契约（Kafka）用 Pact 的消息 pact 支持，机制相同：消费者声明消息体，提供者用真实序列化验证。HTTP 契约不能覆盖消息格式。

## 七、CI 编排与排障

这章解决“本地能跑、流水线跑不动”，以及出问题时第一条命令是什么。

### 7.1 单元测试与集成测试分层

Surefire 跑 `*Test`，Failsafe 跑 `*IT`；`mvn test` 不该拉起容器，`mvn verify` 才拉起。

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-failsafe-plugin</artifactId>
  <configuration>
    <includes>
      <include>**/*IT.java</include>
    </includes>
  </configuration>
  <executions>
    <execution>
      <goals>
        <goal>integration-test</goal>
        <goal>verify</goal>   <!-- verify 阶段才会因 IT 失败而让构建失败 -->
      </goals>
    </execution>
  </executions>
</plugin>
```

```bash
mvn verify
```

输出（示例）：

```text
[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0        # surefire
[INFO] Tests run: 8, Failures: 0, Errors: 0, Skipped: 0         # failsafe
[INFO] BUILD SUCCESS
```

### 7.2 CI 里的 Docker

GitHub Actions 的 `ubuntu-24.04` runner 自带 Docker，Testcontainers 不需要额外配置；GitLab 的 DinD 需要显式指向服务。

```yaml
name: verify
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
          cache: maven
      - name: unit and integration tests
        env:
          GIT_SHA: ${{ github.sha }}
          PACT_BROKER_URL: ${{ secrets.PACT_BROKER_URL }}
        run: mvn -B verify
```

GitLab DinD 的关键变量：

```yaml
variables:
  DOCKER_HOST: tcp://docker:2375
  DOCKER_TLS_CERTDIR: ""
  TESTCONTAINERS_HOST_OVERRIDE: docker   # 容器内拿到的 host 必须是 runner 可达的地址
```

> 边界：共享 runner 的磁盘常被镜像占满。`docker system prune -af --volumes` 放在 job 开始时执行，比在失败后清理更有效。

### 7.3 Pact 的执行顺序

流水线必须按“消费者发布 → 提供者验证 → 门禁查询”执行，顺序错了会拿到过期结果。

- 版本号用 `git sha`，不要用 `latest` 或分支名；分支名只作为 tag 便于查询。
- 提供者验证要在消费者发布之后，否则 Broker 里没有待验证的契约。
- `can-i-deploy` 放在部署 job，紧挨着部署动作，避免“查询通过后又有新提交”。
- 主分支合并前跑一次，合并后再跑一次，两次的版本号不同，不能复用结果。

### 7.4 现象、原因与第一条命令

| 现象 | 原因 | 第一条命令 |
|---|---|---|
| `Could not find a valid Docker environment` | 守护进程未启动或无 socket 权限 | `docker info` |
| 容器启动超时 | 镜像拉取慢、内存不足 | `docker pull <image>` |
| 偶发 `Connection refused` | 等待策略只等端口 | 换 `Wait.forHealthcheck()` |
| `database "test" does not exist` | 手拼 URL，库名与容器不一致 | 打印 `container.getJdbcUrl()` |
| `port is already allocated` | 固定端口 | 改用 `getMappedPort()` |
| Pact 验证 404 | 路径前缀或 `@State` 未命中 | 看交互名与提供者日志 |
| 容器不清理、内存持续上涨 | `TESTCONTAINERS_RYUK_DISABLED=true` | `docker ps -a` |

### 7.5 上线检查清单

- 镜像 tag 全部写死，没有 `latest`。
- `*IT` 在 CI 中真实执行，没有 `disabledWithoutDocker` 静默跳过。
- 等待策略覆盖健康检查，不依赖 `sleep`。
- 测试间数据清理方式明确，静态容器有清理钩子。
- WireMock 覆盖至少一条超时和一条 5xx。
- 契约由消费者生成，提供者验证，`can-i-deploy` 卡在部署前。
- Broker 地址、账号从 CI secret 注入，不写进仓库。

## 八、最佳实践案例

### 8.1 案例背景

订单团队维护 `order-service`（Spring Boot 3.5、Java 21），下单时要调用库存服务 `inventory-service` 预留库存，再调用外部支付网关扣款。此前测试用 H2 加 Mockito：库存客户端和支付客户端都被 mock，集成测试只有 3 个，全部通过。

一个季度内出了三次事故：库存服务把响应字段 `reservationId` 改名为 `id`，联调才发现；支付网关超时后订单服务线程池被占满；H2 上用 Hibernate 自动建表没建唯一约束，上线后 PostgreSQL 迁移脚本建了唯一索引，重复订单号才暴露。

目标是：集成测试可重复、外部依赖故障可覆盖、跨服务字段变更在合并前拦截。约束是 CI 只有 4 核 8G、单条流水线不超过 15 分钟、拿不到支付网关的 sandbox。

### 8.2 案例实操

第一步，按“谁拥有依赖”拆分测试类型，避免容器被滥用。

```text
order-service/
  src/test/java/.../unit/           # *Test，Surefire，无容器
  src/test/java/.../it/             # *IT，Failsafe，Testcontainers
  src/test/java/.../contract/       # *PactTest，Surefire，生成契约
inventory-service/
  src/test/java/.../contract/       # *PactIT，Failsafe，验证契约
```

第二步，订单服务用 PostgreSQL 容器替换 H2，并让 Flyway 从零建库。

```java
@TestConfiguration(proxyBeanMethods = false)
class OrderTestContainers {

    @Bean
    @ServiceConnection
    PostgreSQLContainer<?> postgres() {
        // 与生产同大版本，才能在测试里暴露排序规则、JSONB、约束差异
        return new PostgreSQLContainer<>("postgres:16.4-alpine");
    }
}
```

```java
@SpringBootTest
@Import(OrderTestContainers.class)
class OrderRepositoryIT {

    @Autowired OrderRepository orders;
    @Autowired JdbcTemplate jdbc;

    @BeforeEach
    void clean() {
        jdbc.execute("TRUNCATE TABLE orders RESTART IDENTITY CASCADE");
    }

    @Test
    void duplicateOrderNoIsRejected() {
        orders.save(new Order("ORD-1", "SKU-001", 2));

        // 这条用例在 H2 上曾经通过，因为 H2 用实体自动建表，没建唯一索引
        assertThatThrownBy(() -> orders.save(new Order("ORD-1", "SKU-002", 1)))
            .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void jsonbQueryReturnsNestedMatch() {
        jdbc.update("""
            INSERT INTO orders(order_no, sku, quantity, attrs)
            VALUES ('ORD-2', 'SKU-002', 1, '{"coupon":{"code":"C1"}}'::jsonb)
            """);

        Integer count = jdbc.queryForObject("""
            SELECT count(*) FROM orders WHERE attrs @> '{"coupon":{"code":"C1"}}'::jsonb
            """, Integer.class);
        assertThat(count).isEqualTo(1);
    }

    @Test
    void migrationCreatesExpectedColumns() {
        // 迁移脚本从零执行，缺列会在这里暴露，而不是上线后报 Unknown column
        Integer columns = jdbc.queryForObject("""
            SELECT count(*) FROM information_schema.columns
            WHERE table_name = 'orders' AND column_name IN ('order_no','sku','quantity','attrs')
            """, Integer.class);
        assertThat(columns).isEqualTo(4);
    }
}
```

第三步，支付网关用 WireMock，覆盖成功、超时、连续 503 三种路径。

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(OrderTestContainers.class)
class PaymentGatewayIT {

    // 静态初始化而不是 @BeforeAll：@DynamicPropertySource 在上下文创建时就会读取 baseUrl，
    // 那时 @BeforeAll 还没执行，晚启动会拿到 0 或 null
    static final WireMockServer GATEWAY = new WireMockServer(options().dynamicPort());

    static {
        GATEWAY.start();
    }

    @DynamicPropertySource
    static void paymentProps(DynamicPropertyRegistry registry) {
        registry.add("payment.base-url", GATEWAY::baseUrl);
        registry.add("payment.timeout", () -> "1s");   // 比 stub 延迟短，才能测到超时分支
    }

    @AfterAll
    static void stopGateway() {
        GATEWAY.stop();
    }

    @BeforeEach
    void resetStubs() {
        GATEWAY.resetAll();   // 清 stub 与 scenario 状态，避免测试互相污染
    }

    @Test
    void successCapturesPayment() {
        GATEWAY.stubFor(post(urlEqualTo("/v1/payments"))
            .willReturn(aResponse().withStatus(201)
                .withHeader("Content-Type", "application/json")
                .withBody("""
                    {"paymentId":"pay-1","status":"CAPTURED"}
                    """)));

        var result = checkout.pay(new PaymentCommand("ORD-1", 19_900));

        assertThat(result.status()).isEqualTo("CAPTURED");
        GATEWAY.verify(1, postRequestedFor(urlEqualTo("/v1/payments")));
    }

    @Test
    void timeoutMarksOrderPending() {
        GATEWAY.stubFor(post(urlEqualTo("/v1/payments"))
            .willReturn(aResponse().withFixedDelay(3_000).withStatus(201)));

        var result = checkout.pay(new PaymentCommand("ORD-2", 9_900));

        // 超时不能抛出到用户侧：订单进入待确认，由对账补偿
        assertThat(result.status()).isEqualTo("PENDING_CONFIRM");
    }

    @Test
    void retriesOnceOn503ThenSucceeds() {
        GATEWAY.stubFor(post(urlEqualTo("/v1/payments"))
            .inScenario("retry").whenScenarioStateIs(STARTED)
            .willReturn(aResponse().withStatus(503))
            .willSetStateTo("ok"));
        GATEWAY.stubFor(post(urlEqualTo("/v1/payments"))
            .inScenario("retry").whenScenarioStateIs("ok")
            .willReturn(aResponse().withStatus(201)
                .withHeader("Content-Type", "application/json")
                .withBody("""
                    {"paymentId":"pay-9","status":"CAPTURED"}
                    """)));

        var result = checkout.pay(new PaymentCommand("ORD-3", 29_900));

        assertThat(result.status()).isEqualTo("CAPTURED");
        GATEWAY.verify(2, postRequestedFor(urlEqualTo("/v1/payments")));
    }
}
```

第四步，订单服务对库存服务写消费者契约，锁住真正用到的字段。

```java
@ExtendWith(PactConsumerTestExt.class)
class InventoryClientPactTest {

    @Pact(consumer = "order-service", provider = "inventory-service")
    RequestResponsePact reserveStock(PactDslWithProvider builder) {
        return builder
            .given("stock exists for SKU-001")
            .uponReceiving("reserve 3 units of SKU-001")
            .path("/api/stocks/reservations")
            .method("POST")
            .headers("Content-Type", "application/json")
            .body(new PactDslJsonBody()
                .stringType("sku", "SKU-001")
                .integerType("quantity", 3))
            .willRespondWith()
            .status(201)
            .headers("Content-Type", "application/json")
            // 消费者只判断 status，reservationId 只是透传，因此一个严格一个宽松
            .body(new PactDslJsonBody()
                .stringType("reservationId", "rsv-1")
                .stringValue("status", "RESERVED"))
            .toPact();
    }

    @Test
    @PactTestFor(pactMethod = "reserveStock")
    void reservesStock(MockServer mockServer) {
        var client = new InventoryClient(mockServer.getUrl());

        var reservation = client.reserve("SKU-001", 3);

        assertThat(reservation.status()).isEqualTo("RESERVED");
    }
}
```

第五步，库存服务用真实实例验证契约，状态由测试自己构造。

```java
@Provider("inventory-service")
@PactFolder("../order-service/target/pacts")   // 本地验证；CI 按 6.4 换成 @PactBroker
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(InventoryTestContainers.class)
class InventoryProviderPactIT {

    @LocalServerPort int port;
    @Autowired StockRepository stocks;

    @BeforeEach
    void prepare(PactVerificationContext context) {
        context.setTarget(new HttpTestTarget("localhost", port));
        // verifyInteraction() 在测试方法体内执行状态方法，所以这里的清理一定更早
        stocks.deleteAll();
    }

    @TestTemplate
    @ExtendWith(PactVerificationInvocationContextProvider.class)
    void verify(PactVerificationContext context) {
        context.verifyInteraction();
    }

    @State("stock exists for SKU-001")
    void stockExists() {
        stocks.save(new Stock("SKU-001", 10));
    }
}
```

第六步，CI 按顺序执行，并把门禁卡在部署前。CI 中把 `@PactFolder` 换成 `@PactBroker`，验证结果才会回到 Broker；本地复现仍可用文件目录。

```yaml
name: verify
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-24.04
    env:
      GIT_SHA: ${{ github.sha }}
      PACT_BROKER_URL: ${{ secrets.PACT_BROKER_URL }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: '21'
          cache: maven

      - name: consumer tests and publish pact
        run: |
          mvn -B -pl order-service verify
          mvn -B -pl order-service pact:publish \
            -Dpactbroker.url="$PACT_BROKER_URL" \
            -Dpact.publish.consumer.version="$GIT_SHA"

      - name: provider verification
        run: |
          mvn -B -pl inventory-service verify \
            -Dpactbroker.url="$PACT_BROKER_URL" \
            -Dpact.provider.version="$GIT_SHA" \
            -Dpact.verifier.publishResults=true

  gate:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-24.04
    env:
      GIT_SHA: ${{ github.sha }}
      PACT_BROKER_URL: ${{ secrets.PACT_BROKER_URL }}
    steps:
      - name: can-i-deploy
        run: |
          docker run --rm --network host pactfoundation/pact-cli \
            pact-broker can-i-deploy \
            --pacticipant order-service --version "$GIT_SHA" \
            --to-environment production \
            --broker-base-url "$PACT_BROKER_URL"
```

本地复现整条链：

```bash
mvn -B -pl order-service verify
mvn -B -pl inventory-service verify -Dit.test=InventoryProviderPactIT
```

输出（示例）：

```text
[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0   # order-service unit + pact
[INFO] Tests run: 8, Failures: 0, Errors: 0, Skipped: 0    # order-service IT
[INFO] 1 interaction, 1 success, 0 failures                # inventory provider
[INFO] BUILD SUCCESS
```

### 8.3 案例结果

改造后一个季度的观察结果（示例数据，按团队实测替换）：

| 指标 | 改造前 | 改造后 |
|---|---|---|
| 流水线时长 | 22 分钟 | 11 分钟 |
| 集成测试数量 | 3 | 8 |
| 线上事故 | 3 次/季度 | 0 次 |
| 偶发失败率 | 4.2% | 0.6% |

失败模式与修正：

- 首次上线时容器内存不足，PostgreSQL 与 Kafka 同时启动把 8G runner 打满。修正为按模块串行、Kafka 只在消息模块启动，并用 `-T 1` 限制并行。
- WireMock 的静态服务在 `@BeforeAll` 启动，`@DynamicPropertySource` 先执行拿到空地址，测试全部指向默认端口。修正为静态初始化块启动。
- Pact 契约一开始锁死了 `reservationId` 的具体值，库存服务换成 UUID 后流水线红了两天。修正为 `stringType`，只对 `status` 保持严格匹配。
- 提供者状态方法依赖上一个交互的数据，单独跑某个交互时 404。修正为每个 `@State` 自己构造完整前置条件，并在 `@BeforeEach` 清库。
- `can-i-deploy` 最初只打印结果不阻断部署，等于没有门禁。修正为独立 gate job，失败即停止发布。

复盘：三类工具解决的是三个不同问题，边界比工具本身更重要。容器负责“基础设施是真的”，WireMock 负责“故障是真的”，Pact 负责“接口形状是双方确认的”。把 WireMock 当成契约用，或把契约当成功能测试用，都会得到全绿但不可信的测试集。
