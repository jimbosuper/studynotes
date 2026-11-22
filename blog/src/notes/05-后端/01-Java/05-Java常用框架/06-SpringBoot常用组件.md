---
title: "SpringBoot常用组件"
category: "05-后端"
---

# SpringBoot常用组件

> 这篇从 Spring Boot 的自动配置与 starter 讲起，经过日志与 MDC、缓存、定时任务、异步线程池、OpenAPI 文档、邮件与 WebSocket，最后落到一个带链路 ID、缓存和异步重试的通知服务案例。
>
> 学完能独立把日志、缓存、调度、异步、接口文档和消息推送接进一个 Spring Boot 3.5 工程，并能判断线程池、缓存和定时任务在生产上最容易出什么问题。

## 一、组件接入方式与版本基线

Spring Boot 的组件接入统一走 starter：依赖带进来，自动配置按条件装配，业务代码只声明自己要用的 Bean。理解 `@ConditionalOnClass`、`@ConditionalOnMissingBean`、`@ConditionalOnProperty` 这三个条件，就能判断“为什么自动配置没生效”。

自动配置的优先级低于用户定义的 Bean。自己声明 `CacheManager`、`TaskScheduler`、`ThreadPoolTaskExecutor` 后，Boot 的默认实现会退让；反过来，只加依赖不写配置，Boot 会用一个能启动的默认值，这个默认值通常不适合生产。

| 组件 | starter | 默认行为 |
|---|---|---|
| 日志 | 内置于 `spring-boot-starter` | Logback，控制台输出 |
| 缓存 | `spring-boot-starter-cache` | 简单 ConcurrentMap |
| 定时任务 | 内置于 core | 单线程调度器 |
| 异步 | 内置于 core | 简单线程池 |
| OpenAPI | `springdoc-openapi-starter-webmvc-ui` | `/swagger-ui.html` |
| 邮件 | `spring-boot-starter-mail` | 需配置 SMTP |
| WebSocket | `spring-boot-starter-websocket` | 需注册端点 |

版本基线（2026-11）：Spring Boot 3.5.x、Spring Framework 6.2.x、springdoc 2.8.x、Caffeine 3.2.x、Resilience4j 2.x。补丁号随 Boot BOM 更新，业务代码不锁小版本。

### 1.1 自动配置的排查入口

启动加 `--debug`，或在 `application.yml` 打开：

```yaml
debug: true
```

日志会打印 `Positive matches` 和 `Negative matches`。常见否定原因：

```text
CacheAutoConfiguration matched:
  - @ConditionalOnClass found required class 'org.springframework.cache.CacheManager'

CacheAutoConfiguration#cacheManager did not match:
  - @ConditionalOnMissingBean (types: org.springframework.cache.CacheManager) found bean 'cacheManager'
```

看到 `found bean` 就说明自定义 Bean 已经接管，不需要再改自动配置。看到 `@ConditionalOnProperty` 不匹配，就去核对属性名和值。

> 边界：不要用 `@Import` 手工把自动配置类再导入一次，容易造成重复 Bean 和顺序问题。需要改默认值时，优先用属性；属性覆盖不了，再声明同类型的 Bean。

## 二、日志与 MDC

日志的第一原则是“一条请求的日志能串起来”。MDC（Mapped Diagnostic Context，映射诊断上下文）是 Logback/SLF4J 提供的线程级上下文，放进去的键值会自动出现在每条日志的 pattern 里。

请求入口生成或透传 `X-Request-Id`，写入 MDC，响应头带回同一个值；异步线程必须显式复制 MDC，否则日志里的 `traceId` 是空的。

```java
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class TraceIdFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain)
            throws ServletException, IOException {
        // 上游网关已传 ID 就复用，便于跨服务串联；没有才生成
        String traceId = request.getHeader("X-Request-Id");
        if (!StringUtils.hasText(traceId)) {
            traceId = UUID.randomUUID().toString().substring(0, 8);
        }
        MDC.put("traceId", traceId);
        response.setHeader("X-Request-Id", traceId);
        try {
            chain.doFilter(request, response);
        } finally {
            // 线程池复用，必须清理，否则下一个请求会串到上一个 ID
            MDC.remove("traceId");
        }
    }
}
```

`logback-spring.xml` 里引用 MDC 键：

```xml
<configuration>
    <property name="PATTERN"
              value="%d{HH:mm:ss.SSS} %-5level [%thread] [%X{traceId:-}] %logger{36} - %msg%n"/>

    <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
        <encoder>
            <pattern>${PATTERN}</pattern>
        </encoder>
    </appender>

    <appender name="ASYNC" class="ch.qos.logback.classic.AsyncAppender">
        <queueSize>1024</queueSize>
        <!-- 0 表示队列满也不丢弃，代价是阻塞业务线程 -->
        <discardingThreshold>0</discardingThreshold>
        <appender-ref ref="CONSOLE"/>
    </appender>

    <root level="INFO">
        <appender-ref ref="ASYNC"/>
    </root>
</configuration>
```

预期日志：

```text
14:22:31.087 INFO  [http-nio-8080-exec-1] [8f3c1a2b] c.e.components.ArticleController - get article id=1
```

`%X{traceId:-}` 的 `:-` 表示没有值时输出空串。生产环境通常把日志输出成 JSON，接入 Loki/ELK 后按 `traceId` 聚合；控制台 pattern 只用于本地。

### 2.1 异步与线程池中的 MDC

MDC 基于 `ThreadLocal`，`@Async` 切换到新线程后上下文丢失。用 `TaskDecorator` 在任务提交时复制、执行完清理：

```java
public class MdcTaskDecorator implements TaskDecorator {

    @Override
    public Runnable decorate(Runnable runnable) {
        Map<String, String> context = MDC.getCopyOfContextMap();
        return () -> {
            if (context != null) {
                MDC.setContextMap(context);
            }
            try {
                runnable.run();
            } finally {
                MDC.clear(); // 线程池复用，不清理会污染下一个任务
            }
        };
    }
}
```

> 边界：`TaskDecorator` 只对 `ThreadPoolTaskExecutor` 生效，不覆盖 `CompletableFuture` 默认的 `ForkJoinPool`、Reactor 线程或第三方 SDK 自建线程。跨线程追踪统一用 Micrometer Tracing 的 `traceId` 传播，MDC 只做日志展示。

## 三、缓存

缓存的收益来自“读多写少 + 允许短暂旧值”。加 `@Cacheable` 之前先确认三件事：数据能被接受延迟多久、更新时如何失效、缓存击穿时会不会打垮数据库。

Spring Cache 是抽象层，底层可以是 Caffeine（本地）、Redis（分布式）或同时多级。本地缓存快但各实例不一致；Redis 一致性好但有网络往返和序列化成本。

| 维度 | Caffeine | Redis |
|---|---|---|
| 位置 | JVM 堆内 | 独立服务 |
| 读延迟 | 纳秒到微秒 | 毫秒 |
| 多实例一致 | 不保证 | 共享 |
| 容量 | 受堆限制 | 独立扩容 |
| 适用 | 热点字典、单机只读 | 会话、跨实例共享 |

Caffeine 的最小配置：

```java
@Configuration
@EnableCaching
public class CacheConfig {

    @Bean
    CacheManager cacheManager() {
        Cache<Object, Object> nativeCache = Caffeine.newBuilder()
            .maximumSize(500)
            .expireAfterWrite(Duration.ofMinutes(5))
            .recordStats()
            .build();

        // 每个缓存单独命名，后续可以按 name 配不同 TTL
        CaffeineCache articles = new CaffeineCache("articles", nativeCache);
        SimpleCacheManager manager = new SimpleCacheManager();
        manager.setCaches(List.of(articles));
        return manager;
    }
}
```

```java
@Service
public class ArticleService {

    @Cacheable(cacheNames = "articles", key = "#id", sync = true)
    public Article find(long id) {
        // 只有未命中才执行；sync=true 让同 key 的并发请求只放一个进数据库
        return loadFromDatabase(id);
    }

    @CacheEvict(cacheNames = "articles", key = "#id")
    public void updateTitle(long id, String title) {
        // 先写库再删缓存；删除失败要重试或走消息补偿
        updateDatabase(id, title);
    }
}
```

`sync = true` 只对单个缓存实例有效，多实例部署时每个 JVM 仍会各放一个请求进数据库。防止缓存击穿还要加分布式锁、逻辑过期或单飞（singleflight）。

三个常见失效场景：

- 自调用：`this.find(id)` 不经过代理，`@Cacheable` 不生效；
- key 不一致：查询用 `#id`，更新用 `#article.id`，删除删不掉；
- 序列化：Redis 换序列化器后旧数据读不出来，发布前要清缓存或兼容旧格式。

> 边界：不要给实时库存、账户余额这类强一致数据加本地缓存；不要用 `@Cacheable` 缓存 `null` 而不设 `unless`，否则空结果会长期占坑。缓存是性能手段，不是数据源。

## 四、定时任务

`@Scheduled` 适合“单机、可重复执行、允许延迟”的任务。三种时间写法：

| 写法 | 含义 | 风险 |
|---|---|---|
| `fixedRate = 5000` | 上次开始后每 5 秒 | 任务变慢会堆积 |
| `fixedDelay = 5000` | 上次结束后隔 5 秒 | 总周期被拉长 |
| `cron = "0 */5 * * * *"` | 整点每 5 分钟 | 时区、夏令时 |

```java
@Component
public class ReportJob {

    private static final Logger log = LoggerFactory.getLogger(ReportJob.class);

    // fixedDelay 保证上一轮跑完再等 5 秒，避免慢任务重叠
    @Scheduled(fixedDelayString = "${app.report.delay:5000}",
               initialDelayString = "3000")
    public void generate() {
        log.info("report job start");
        // 业务逻辑
        log.info("report job end");
    }

    // 每天 02:30 执行；服务器时区必须是 Asia/Shanghai，或显式写 zone
    @Scheduled(cron = "0 30 2 * * *", zone = "Asia/Shanghai")
    public void cleanup() {
        // 清理临时文件
    }
}
```

默认调度器只有一个线程，两个任务会互相排队。需要并行时声明 `TaskScheduler`：

```java
@Bean
TaskScheduler taskScheduler() {
    ThreadPoolTaskScheduler scheduler = new ThreadPoolTaskScheduler();
    scheduler.setPoolSize(4);
    scheduler.setThreadNamePrefix("sched-");
    scheduler.setWaitForTasksToCompleteOnShutdown(true);
    scheduler.setAwaitTerminationSeconds(30);
    return scheduler;
}
```

`@Scheduled` 的 cron 是 6 位（秒 分 时 日 月 周），不是 Linux crontab 的 5 位；写 5 位会启动失败。`zone` 不写时用 JVM 默认时区，容器里通常是 UTC，容易出现“凌晨任务跑到早上 8 点”。

多实例部署时每个实例都会执行同一个任务。要么把任务拆到单独的调度服务，要么加分布式锁。ShedLock 的最小用法：

```java
@Scheduled(cron = "0 */5 * * * *")
@SchedulerLock(name = "reportJob", lockAtMostFor = "PT4M", lockAtLeastFor = "PT1M")
public void generate() {
    // 同一时刻只有一个实例拿到锁
}
```

> 边界：`@Scheduled` 方法不能有参数，返回值会被忽略；异常必须自己捕获，否则线程可能被调度器替换。长任务要设超时和中断检查，不要无限期占用调度线程。

## 五、异步与线程池

`@Async` 把方法调用提交到线程池，调用方立即返回。它只适合“不需要返回值、失败可重试或可补偿”的工作，例如发通知、写审计、刷新索引；不适合必须与主流程同成败的扣库存。

线程池参数按“任务类型”定，不按“CPU 核数”拍脑袋：

| 任务类型 | 核心线程 | 队列 | 拒绝策略 |
|---|---|---|---|
| IO 密集（HTTP、DB） | 8–32 | 有界 200–1000 | `CallerRunsPolicy` |
| CPU 密集 | CPU 核数 + 1 | 小 | `AbortPolicy` |
| 短任务高吞吐 | 较大 | 有界 | `CallerRunsPolicy` |

```java
@Configuration
@EnableAsync
public class AsyncConfig implements AsyncConfigurer {

    @Bean("mailExecutor")
    public ThreadPoolTaskExecutor mailExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(4);
        executor.setMaxPoolSize(8);
        executor.setQueueCapacity(200);
        executor.setThreadNamePrefix("mail-");
        // 队列满时由调用线程执行，形成背压，避免任务被静默丢弃
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        // 把请求线程的 traceId 复制到异步线程
        executor.setTaskDecorator(new MdcTaskDecorator());
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setAwaitTerminationSeconds(20);
        executor.initialize();
        return executor;
    }

    @Override
    public Executor getAsyncExecutor() {
        return mailExecutor();
    }

    @Override
    public AsyncUncaughtExceptionHandler getAsyncUncaughtExceptionHandler() {
        return (ex, method, params) ->
            log.error("async method {} failed", method.getName(), ex);
    }
}
```

```java
@Service
public class MailService {

    // 指定线程池，避免和 Web 请求、调度任务抢同一个池
    @Async("mailExecutor")
    public void send(String to, String subject) {
        // 真实发送逻辑
    }
}
```

四个失效点：

- 同类自调用：`this.send()` 不经过代理，方法同步执行；
- 方法 `private` 或 `final`：CGLIB 无法覆写；
- 返回 `void` 且异常未捕获：异常进了 `AsyncUncaughtExceptionHandler`，调用方完全不知道；
- 未加 `@EnableAsync`：注解被忽略，方法同步执行。

> 边界：`@Async` 不是消息队列。应用重启时队列里的任务会丢，失败重试要落库；需要跨实例、可追溯、可重放的任务，用 Kafka/RabbitMQ 或任务表，不要用内存线程池硬扛。

## 六、OpenAPI 文档

springdoc 根据 Spring MVC 的映射和注解生成 OpenAPI 3 文档，Swagger UI 直接渲染。它适合内部联调和契约评审，不替代鉴权：文档端点本身也要保护，生产环境默认关闭或只对内网开放。

```xml
<dependency>
    <groupId>org.springdoc</groupId>
    <artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>
    <version>2.8.9</version>
</dependency>
```

```yaml
springdoc:
  api-docs:
    path: /v3/api-docs
  swagger-ui:
    path: /swagger-ui.html
    operations-sorter: method
```

```java
@Configuration
public class OpenApiConfig {

    @Bean
    OpenAPI componentsOpenApi() {
        return new OpenAPI()
            .info(new Info()
                .title("Components Demo API")
                .version("1.0.0")
                .description("日志、缓存、异步与通知接口"))
            .components(new Components().addSecuritySchemes("bearer",
                new SecurityScheme()
                    .type(SecurityScheme.Type.HTTP)
                    .scheme("bearer")
                    .bearerFormat("JWT")))
            .addSecurityItem(new SecurityRequirement().addList("bearer"));
    }
}
```

```java
@Operation(summary = "按 ID 查询文章", description = "首次查询回源，后续命中本地缓存")
@GetMapping("/{id}")
public Article get(@Parameter(description = "文章 ID") @PathVariable long id) {
    return articleService.find(id);
}
```

验证：

```bash
curl -s http://localhost:8080/v3/api-docs | python3 -m json.tool | head -20
```

预期返回 `openapi`、`info.title`、`paths` 三个关键字段。Swagger UI 在 `http://localhost:8080/swagger-ui.html`。

> 边界：`@Operation`、`@Schema` 只影响文档，不影响校验；参数校验仍要 `@Valid`、`@NotNull`。生产环境把 `springdoc.api-docs.enabled=false`，或给 `/v3/api-docs/**`、`/swagger-ui/**` 加管理员权限。

## 七、邮件与 WebSocket

邮件是典型的“外部依赖慢、失败率高、必须异步”的组件。`JavaMailSender` 只负责把消息交给 SMTP 服务器，不保证对方收件箱一定收到；重试、退信、限速都要业务层处理。

```yaml
spring:
  mail:
    host: localhost
    port: 1025
    properties:
      mail.smtp.auth: false
      mail.smtp.starttls.enable: false
```

```java
@Service
public class SmtpMailService {

    private final JavaMailSender sender;

    public SmtpMailService(JavaMailSender sender) {
        this.sender = sender;
    }

    public void sendHtml(String to, String subject, String html) throws MessagingException {
        MimeMessage message = sender.createMimeMessage();
        // true 表示 multipart，支持 HTML 和内嵌图片
        MimeMessageHelper helper = new MimeMessageHelper(
            message, true, StandardCharsets.UTF_8.name());
        helper.setFrom("noreply@example.com");
        helper.setTo(to);
        helper.setSubject(subject);
        helper.setText(html, true); // 第二个参数 true 表示 HTML
        sender.send(message);
    }
}
```

本地用 MailHog 收信，不依赖真实邮箱：

```bash
docker run -d --name mailhog -p 1025:1025 -p 8025:8025 mailhog/mailhog
```

发送后打开 `http://localhost:8025` 能看到邮件列表。生产环境换成企业 SMTP，开启 TLS、认证和连接池，并对 4xx/5xx 做区分：4xx 可重试，5xx 永久失败。

WebSocket 用于服务端主动推送。Spring 的 STOMP 支持让客户端订阅主题，服务端向主题发消息：

```java
@Configuration
@EnableWebSocketMessageBroker
public class WsConfig implements WebSocketMessageBrokerConfigurer {

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        // 开发期允许前端端口；生产改成确切域名
        registry.addEndpoint("/ws")
            .setAllowedOriginPatterns("http://localhost:5173");
    }

    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {
        registry.enableSimpleBroker("/topic");
        registry.setApplicationDestinationPrefixes("/app");
    }
}
```

```java
@Controller
public class AlertController {

    @MessageMapping("/alert")
    @SendTo("/topic/alerts")
    public Alert alert(Alert alert) {
        // 返回值广播给所有订阅 /topic/alerts 的客户端
        return alert;
    }

    public record Alert(String level, String message) {
    }
}
```

> 边界：内置 `SimpleBroker` 只在单实例内广播，多实例要接 RabbitMQ/ActiveMQ 的 STOMP broker；WebSocket 握手不经过 `@PreAuthorize`，要配置 `ChannelInterceptor` 校验令牌。邮件和 WebSocket 都不是事务资源，失败不能回滚数据库。

## 八、排障与上线检查

组件的故障大多不是“不会用”，而是“默认值上了生产”。按现象定位：

| 现象 | 原因 | 第一条检查 |
|---|---|---|
| 定时任务不执行 | 没开 `@EnableScheduling` | 启动类/配置类注解 |
| 任务重复执行 | 多实例无分布式锁 | 实例数与日志来源 |
| `@Async` 同步执行 | 自调用或方法 `private` | 线程名是否变化 |
| 缓存不命中 | 自调用、key 不一致 | 打开 cache 统计 |
| 日志无 traceId | 异步线程未复制 MDC | 线程名与 TaskDecorator |
| 文档 404 | 路径被安全拦截 | `/v3/api-docs` 是否放行 |
| 邮件超时 | SMTP 地址/端口/TLS | `telnet host 25` |

缓存统计可以直接从 Caffeine 取：

```java
CaffeineCache cache = (CaffeineCache) cacheManager.getCache("articles");
CacheStats stats = cache.getNativeCache().stats();
System.out.println("hitRate=" + stats.hitRate() + " evictions=" + stats.evictionCount());
```

上线检查清单：

- 线程池全部有界，拒绝策略明确，关闭时等待任务完成；
- 缓存有 TTL、容量上限和空值保护，更新路径能删到对应 key；
- 定时任务有时间区、超时、分布式锁和失败告警；
- 日志有请求 ID，异步和调度线程也带上下文；
- 文档端点在公网关闭，至少加认证；
- 邮件、WebSocket 的失败有重试上限和死信记录。

## 九、最佳实践案例

### 9.1 案例背景

一个内容站需要给订阅用户发送站内通知。现状是接口同步发邮件，SMTP 一慢请求就超时；文章详情每次查库，热点文章把数据库打满；所有日志没有请求 ID，排障只能按时间猜。

目标是：文章详情加 5 分钟本地缓存；通知创建后异步发送，失败每分钟重试，最多 3 次；每个请求有 `traceId` 并透传到异步线程；对外提供 OpenAPI 文档。约束是单实例、不引入 Redis 和消息队列，先用内存存储验证行为。

### 9.2 案例实操

依赖：

```xml
<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-cache</artifactId>
    </dependency>
    <dependency>
        <groupId>com.github.ben-manes.caffeine</groupId>
        <artifactId>caffeine</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-validation</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-actuator</artifactId>
    </dependency>
    <dependency>
        <groupId>org.springdoc</groupId>
        <artifactId>springdoc-openapi-starter-webmvc-ui</artifactId>
        <version>2.8.9</version>
    </dependency>
</dependencies>
```

`application.yml`：

```yaml
server:
  port: 8080

spring:
  application:
    name: components-demo

app:
  retry:
    delay: 5000

management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics

springdoc:
  api-docs:
    path: /v3/api-docs
  swagger-ui:
    path: /swagger-ui.html
```

启动类一次开三个开关：

```java
@SpringBootApplication
@EnableCaching
@EnableScheduling
@EnableAsync
public class ComponentsDemoApplication {
    public static void main(String[] args) {
        SpringApplication.run(ComponentsDemoApplication.class, args);
    }
}
```

文章服务用 `AtomicInteger` 记录回源次数，方便验证缓存：

```java
@Service
public class ArticleService {

    private final Map<Long, Article> database = new ConcurrentHashMap<>();
    private final AtomicInteger databaseLoads = new AtomicInteger();

    public ArticleService() {
        database.put(1L, new Article(1L, "Spring Boot 3.5 组件",
            "日志、缓存、调度、异步与文档"));
    }

    @Cacheable(cacheNames = "articles", key = "#id", sync = true)
    public Article find(long id) {
        databaseLoads.incrementAndGet();
        sleep(300); // 模拟慢查询，便于观察第二次调用变快
        Article article = database.get(id);
        if (article == null) {
            throw new IllegalArgumentException("article not found: " + id);
        }
        return article;
    }

    public int databaseLoads() {
        return databaseLoads.get();
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted", ex);
        }
    }

    public record Article(long id, String title, String body) {
    }
}
```

通知存储与发送：

```java
@Repository
public class NotificationRepository {

    private final Map<Long, Notification> store = new ConcurrentHashMap<>();
    private final AtomicLong sequence = new AtomicLong();

    public Notification create(String to, String subject) {
        long id = sequence.incrementAndGet();
        Notification notification = new Notification(id, to, subject, "PENDING", 0);
        store.put(id, notification);
        return notification;
    }

    public Optional<Notification> find(long id) {
        return Optional.ofNullable(store.get(id));
    }

    public void save(Notification notification) {
        store.put(notification.id(), notification);
    }

    public List<Notification> retryable() {
        return store.values().stream()
            .filter(n -> ("PENDING".equals(n.status()) || "FAILED".equals(n.status()))
                && n.attempts() < 3)
            .toList();
    }

    public record Notification(long id, String to, String subject,
                               String status, int attempts) {
    }
}
```

```java
public interface MailGateway {
    void send(String to, String subject, String body);
}
```

```java
@Component
public class LoggingMailGateway implements MailGateway {

    private static final Logger log = LoggerFactory.getLogger(LoggingMailGateway.class);

    @Override
    public void send(String to, String subject, String body) {
        if (to.endsWith("@fail.test")) {
            throw new IllegalStateException("SMTP 550 mailbox unavailable");
        }
        // 本地用日志代替真实 SMTP，生产替换成 JavaMailSender 实现
        log.info("[mail] to={} subject={}", to, subject);
    }
}
```

异步发送器是独立 Bean，确保 `@Async` 经过代理：

```java
@Service
public class MailDispatcher {

    private static final Logger log = LoggerFactory.getLogger(MailDispatcher.class);

    private final NotificationRepository repository;
    private final MailGateway gateway;

    public MailDispatcher(NotificationRepository repository, MailGateway gateway) {
        this.repository = repository;
        this.gateway = gateway;
    }

    @Async("mailExecutor")
    public void dispatch(long id) {
        NotificationRepository.Notification notification =
            repository.find(id).orElseThrow();
        try {
            gateway.send(notification.to(), notification.subject(), "hello");
            repository.save(new NotificationRepository.Notification(
                id, notification.to(), notification.subject(), "SENT",
                notification.attempts() + 1));
            log.info("notification {} sent", id);
        } catch (RuntimeException ex) {
            // 失败落库，调度任务下一轮会再取出来
            repository.save(new NotificationRepository.Notification(
                id, notification.to(), notification.subject(), "FAILED",
                notification.attempts() + 1));
            log.warn("notification {} failed: {}", id, ex.getMessage());
        }
    }
}
```

```java
@Service
public class NotificationService {

    private final NotificationRepository repository;
    private final MailDispatcher dispatcher;

    public NotificationService(NotificationRepository repository,
                               MailDispatcher dispatcher) {
        this.repository = repository;
        this.dispatcher = dispatcher;
    }

    public NotificationRepository.Notification create(String to, String subject) {
        NotificationRepository.Notification notification = repository.create(to, subject);
        // 调用另一个 Bean，@Async 才会经过代理
        dispatcher.dispatch(notification.id());
        return notification;
    }

    public int retryPending() {
        List<NotificationRepository.Notification> pending = repository.retryable();
        pending.forEach(n -> dispatcher.dispatch(n.id()));
        return pending.size();
    }
}
```

调度任务每 5 秒扫一次失败通知：

```java
@Component
public class NotificationRetryJob {

    private static final Logger log = LoggerFactory.getLogger(NotificationRetryJob.class);

    private final NotificationService notificationService;

    public NotificationRetryJob(NotificationService notificationService) {
        this.notificationService = notificationService;
    }

    @Scheduled(fixedDelayString = "${app.retry.delay:5000}", initialDelayString = "3000")
    public void retry() {
        int count = notificationService.retryPending();
        if (count > 0) {
            log.info("retry scheduled for {} notifications", count);
        }
    }
}
```

控制器：

```java
@RestController
@RequestMapping("/api")
public class DemoController {

    private final ArticleService articleService;
    private final NotificationService notificationService;

    public DemoController(ArticleService articleService,
                          NotificationService notificationService) {
        this.articleService = articleService;
        this.notificationService = notificationService;
    }

    @GetMapping("/articles/{id}")
    public Map<String, Object> article(@PathVariable long id) {
        // dbLoads 用来证明第二次请求没有回源
        return Map.of("article", articleService.find(id),
            "dbLoads", articleService.databaseLoads());
    }

    @PostMapping("/notifications")
    public ResponseEntity<NotificationRepository.Notification> create(
            @Valid @RequestBody CreateRequest request) {
        return ResponseEntity.accepted()
            .body(notificationService.create(request.to(), request.subject()));
    }

    public record CreateRequest(@NotBlank String to, @NotBlank String subject) {
    }
}
```

启动并验证缓存：

```bash
./mvnw spring-boot:run
```

```bash
curl -s -H 'X-Request-Id: demo-001' http://localhost:8080/api/articles/1
curl -s -H 'X-Request-Id: demo-002' http://localhost:8080/api/articles/1
```

预期输出（第二次 `dbLoads` 仍为 1，耗时从约 300 ms 降到几毫秒）：

```text
{"article":{"id":1,"title":"Spring Boot 3.5 组件","body":"日志、缓存、调度、异步与文档"},"dbLoads":1}
{"article":{"id":1,"title":"Spring Boot 3.5 组件","body":"日志、缓存、调度、异步与文档"},"dbLoads":1}
```

创建成功通知：

```bash
curl -i -X POST http://localhost:8080/api/notifications \
  -H 'Content-Type: application/json' \
  -H 'X-Request-Id: demo-003' \
  -d '{"to":"dev@example.com","subject":"welcome"}'
```

预期响应与日志：

```text
HTTP/1.1 202
X-Request-Id: demo-003
{"id":1,"to":"dev@example.com","subject":"welcome","status":"PENDING","attempts":0}

14:25:10.312 INFO  [mail-1] [demo-003] c.e.components.MailDispatcher - [mail] to=dev@example.com subject=welcome
14:25:10.313 INFO  [mail-1] [demo-003] c.e.components.MailDispatcher - notification 1 sent
```

失败重试：

```bash
curl -s -X POST http://localhost:8080/api/notifications \
  -H 'Content-Type: application/json' \
  -d '{"to":"bad@fail.test","subject":"retry"}'
```

预期日志（每 5 秒一次，最多 3 次后不再重试）：

```text
14:25:20.101 WARN  [mail-2] [8f3c1a2b] c.e.components.MailDispatcher - notification 2 failed: SMTP 550 mailbox unavailable
14:25:25.104 INFO  [sched-1] [] c.e.components.NotificationRetryJob - retry scheduled for 1 notifications
```

OpenAPI 文档：

```bash
curl -s http://localhost:8080/v3/api-docs | python3 -c \
  'import json,sys; d=json.load(sys.stdin); print(d["openapi"], d["info"]["title"], len(d["paths"]))'
```

预期：

```text
3.1.0 Components Demo API 2
```

### 9.3 案例结果

缓存第二次请求没有回源，`dbLoads` 保持 1；通知接口立即返回 202，邮件在 `mail-*` 线程发送，日志里的 `traceId` 与请求头一致；失败通知进入 `FAILED`，调度器每 5 秒重试，3 次后停止；`/v3/api-docs` 能列出 2 个路径。

失败模式与复盘：

- 最初把 `dispatch` 写在 `NotificationService` 内部直接调用，`@Async` 不生效，接口仍被 SMTP 拖慢；拆成独立 Bean 后恢复 202。
- 线程池队列设为无界，压测时内存上涨；改成 200 有界队列 + `CallerRunsPolicy`，队列满时接口变慢而不是 OOM。
- 调度器默认单线程，重试任务和报表任务互相阻塞；声明 4 线程的 `TaskScheduler` 后隔离。
- 本地缓存只适合单实例，扩容到两台后同一文章会各有 5 分钟旧值；下一步换成 Redis 并保留 Caffeine 一级缓存，同时给 TTL 加随机抖动，避免同一时刻集中失效。
- 失败通知用内存存储，重启会丢；生产改为数据库任务表，状态机加 `SENDING` 和乐观锁，避免多实例重复发送。
