---
title: "OpenAPI与接口契约"
category: "05-后端"
---

# OpenAPI与接口契约

> 这篇从契约与代码的依赖方向讲起，经过 OpenAPI 3.1 的文档结构、资源与错误契约设计、Schema 复用、服务端接口与客户端 SDK 的代码生成、契约测试与 CI 门禁、文档发布与版本演进，最后落到一个 Spring Boot 订单服务从契约生成接口、实现业务并用 curl 验收完整契约行为的案例。
>
> 学完能独立编写并校验一份 OpenAPI 3.1 契约，从契约生成服务端接口和客户端 SDK，把契约校验接入 CI 门禁，并用契约测试守住实现不漂移。

## 一、契约与代码的依赖方向

接口契约（Interface Contract）是服务端和客户端共同承认的协议文本：路径、参数、状态码、错误结构、安全要求都在契约里定义，谁都不能单方面改。OpenAPI 是描述 REST 接口契约的事实标准，当前版本 3.1，由 OpenAPI Initiative 维护，基于 JSON Schema 2020-12。

契约工作方式有三种，区别只在于“契约是谁生成的”：

| 方式 | 契约来源 | 适合场景 |
|---|---|---|
| 契约优先 | 手写 YAML，代码从契约生成 | 多团队并行开发、对外 API |
| 代码优先 | 注解生成契约，契约是产物 | 单团队内部的 CRUD 服务 |
| 混合 | 手写核心契约，注解补细节 | 大多数实际项目 |

契约优先的完整闭环：

```mermaid
graph LR
  A[手写契约 openapi.yaml] --> B[Redocly lint 结构校验]
  B --> C[openapi-generator 生成接口与模型]
  C --> D[实现类继承生成接口]
  D --> E[curl 契约测试验收]
  E --> F[build-docs 发布文档]
  classDef main fill:#eff6ff,stroke:#93c5fd,color:#1e3a8a
  classDef good fill:#ecfdf5,stroke:#86efac,color:#166534
  classDef ext fill:#f8fafc,stroke:#cbd5e1,color:#334155
  class A,B,C,D main
  class E good
  class F ext
```

这条链的关键在第 4 步：实现类继承生成接口，契约里的路径、参数校验、`produces` 全部变成编译期约束，改契约必须重新生成，重新生成必须重新编译，漂移在 `mvn compile` 就暴露，不用等联调。

> 边界：契约优先适合 REST 风格的 API。内部服务间强类型、高频率的调用用 gRPC（契约是 `.proto`），事件流用 AsyncAPI，都不必硬套 OpenAPI。只有一个团队维护、且从不需要对外暴露的内部 CRUD 服务，代码优先（springdoc 注解生成）更省事。

## 二、环境准备与最小验证

工具链的基线是 2026-11-13：OpenAPI 3.1.0、Redocly CLI 2.78.0、OpenAPI Generator 7.27.0（npm 包装器 `@openapitools/openapi-generator-cli` 2.42.2，首次运行下载 7.27.0 的 jar）、Node 22 LTS、JDK 21、Spring Boot 3.5.6。契约校验用 Node 版 Redocly CLI，代码生成用 OpenAPI Generator（Java 实现，经 npm 包装），两者都通过 npm 取得，不需要装 Java 之外的工具链。

Node 22 LTS 的安装：

```bash
# Windows（管理员 PowerShell，用 winget）
winget install OpenJS.NodeJS.LTS

# macOS（Homebrew）
brew install node@22

# Ubuntu 24.04（NodeSource 源）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Rocky 9 / CentOS Stream（同 NodeSource，dnf 安装）
sudo dnf install -y nodejs npm
```

验证安装：

```bash
node --version   # 预期 v22.x
npm --version    # 预期 10.x
```

案例部分要编译 Spring Boot 工程，再装 JDK 21 与 Maven：

```bash
# JDK 21（Temurin）
winget install EclipseAdoptium.Temurin.21.JDK      # Windows
brew install --cask temurin@21                     # macOS
sudo apt-get install -y openjdk-21-jdk             # Ubuntu
sudo dnf install -y java-21-openjdk-devel          # Rocky

# Maven 3.9+
winget install Apache.Maven                        # Windows
brew install maven                                 # macOS
sudo apt-get install -y maven                      # Ubuntu
sudo dnf install -y maven                          # Rocky
```

```bash
java -version   # 预期 openjdk 21.0.x
mvn -v          # 预期 Apache Maven 3.9.x 与 Java 21
```

契约校验器 Redocly CLI 不全局安装，直接 `npx` 拉起，避免团队机器上版本漂移：

```bash
# 校验契约（首次运行会下载包，约几秒）
npx -y @redocly/cli@latest lint openapi.yaml
```

写一个最小契约做首次验证，两分钟内能看到工具链全通：

```yaml
openapi: 3.1.0
info:
  title: 最小契约
  version: 0.1.0
  license:
    name: MIT
    identifier: MIT
servers:
  - url: https://api.internal.net
security: []                 # 明确声明无需认证，lint 的 security-defined 规则靠它
paths:
  /ping:
    get:
      operationId: ping
      summary: 存活探测
      responses:
        '200':
          description: 服务存活
          content:
            application/json:
              schema:
                type: object
                required: [pong]
                properties:
                  pong:
                    type: boolean
        '404':
          description: 路径不存在
        '503':
          description: 服务未就绪
```

预期输出（实测，Redocly CLI 2.78.0）：

```text
validating minimal.yaml...
Woohoo! Your API description is valid. 🎉
```

> 边界：`@latest` 适合个人实验；团队要在 `package.json` 里锁定版本（`"@redocly/cli": "2.78.0"`），否则规则每次升级，CI 结果不可复现。Redocly 的 `recommended` 规则集要求每个 operation 都有 `operationId`、`summary`、安全定义和 4xx 响应，第一次跑通常报一堆警告，属于正常现象，逐条补齐就是契约质量提升的过程。

## 三、OpenAPI 3.1 的文档结构

一份 OpenAPI 3.1 文档是一棵固定结构的 YAML/JSON 树：根节点声明版本，`info` 说明身份，`servers` 声明环境，`paths` 定义操作，`components` 收纳可复用件，`security` 声明全局安全要求。结构本身是规范的一部分，字段名拼错就是校验错误。

| 根字段 | 作用 | 必填 |
|---|---|---|
| `openapi` | 版本号，`3.1.0` | 是 |
| `info` | 标题、版本、描述、许可证 | 是 |
| `servers` | 环境地址列表 | 否 |
| `paths` | 全部操作定义 | 与 `webhooks` 二选一 |
| `components` | 可复用的 Schema、参数、响应 | 否 |
| `security` | 全局安全要求 | 否 |
| `tags` | 文档分组 | 否 |
| `webhooks` | 服务端推送事件定义 | 否 |

3.1 相对 3.0 的变化集中在 Schema 层，因为 3.1 直接采纳了 JSON Schema 2020-12：

| 特性 | 3.0 写法 | 3.1 写法 |
|---|---|---|
| 可空字段 | `nullable: true` | `type: [string, "null"]` |
| 示例 | 单个 `example` | 数组 `examples` |
| 开区间 | `exclusiveMinimum: true` | `exclusiveMinimum: 3` |
| `description` 与 `$ref` | 不能共存 | 可以共存 |
| 任意 Schema 关键字 | 不支持 | 支持 `const`、`patternProperties` 等 |

可空字段的最小对照（`detail` 可以是 null）：

```yaml
properties:
  detail:
    type:
      - string
      - 'null'
    description: 本次问题的具体说明
```

`webhooks` 是 3.1 的一等公民，用于声明服务端主动推送的事件结构，配合回调用：

```yaml
webhooks:
  orderCreated:
    post:
      operationId: orderCreated
      summary: 订单创建事件回调
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Order'
      responses:
        '200':
          description: 事件已接收
```

> 边界：3.1 的工具链到 2026 年已经齐备（Redocly、openapi-generator、springdoc 2.x 都支持），但仍有存量系统停留在 3.0，生成器里要按目标版本选 `openapi: 3.0.3` 或 `3.1.0`，不要在一个团队里混用。`type` 数组写法在 3.0 文档里是非法的，降级时必须换回 `nullable`。

## 四、资源建模与错误契约

契约设计的第一条规则：URI 用名词复数，动作用 HTTP 方法表达，过滤分页用查询参数，和 REST 建模规则一致（详见《HTTP协议与REST》）。契约里多出来的部分是：把状态码、Header、错误结构全部写成显式声明，不留口头约定。

一个订单资源的契约骨架：

```yaml
paths:
  /api/v1/orders:
    get:
      operationId: listOrders
      tags: [Orders]
      parameters:
        - $ref: '#/components/parameters/PageNumber'
        - $ref: '#/components/parameters/PageSize'
      responses:
        '200':
          description: 订单分页结果
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/OrderPage'
        '401':
          $ref: '#/components/responses/UnauthorizedProblem'
```

错误契约统一采用 RFC 9457 的 Problem Details 结构，在 `components.responses` 里定义一次，全部操作引用：

```yaml
components:
  responses:
    NotFoundProblem:
      description: 订单不存在
      content:
        application/problem+json:
          schema:
            $ref: '#/components/schemas/Problem'
          examples:
            notFound:
              value:
                type: 'https://docs.example.net/problems/order-not-found'
                title: 订单不存在
                status: 404
                detail: 订单 9999 不存在
                instance: /api/v1/orders/9999
```

幂等键这类跨操作的约定，定义成可复用的参数，带校验规则和示例：

```yaml
components:
  parameters:
    IdempotencyKey:
      name: Idempotency-Key
      in: header
      required: true
      description: 客户端为一次业务操作生成的幂等键，重试时复用
      schema:
        type: string
        minLength: 8
        maxLength: 64
        examples:
          - req-8f3c2a91
```

> 边界：契约里只写“本版本真的会返回”的状态码。写了 `404` 实现永远不返回，或实现返回 `400` 契约里没有，两者都是漂移。响应 Header 也一样：`ETag`、`Location`、`Idempotency-Key` 的行为必须声明，客户端 SDK 的重试逻辑要靠这些声明做决策。

## 五、Schema 复用与组合

`components` 是契约的复用中心，八个桶各管一类复用件；所有重复定义都收敛到这里，路径节点里只留 `$ref` 引用，是契约可维护的底线。

| 组件桶 | 放什么 |
|---|---|
| `schemas` | 数据模型 |
| `parameters` | 路径/查询/Header 参数 |
| `responses` | 可复用响应 |
| `requestBodies` | 请求体 |
| `headers` | 响应头定义 |
| `securitySchemes` | 认证方案 |
| `examples` | 独立示例 |
| `links` | 响应间跳转关系 |

Schema 的组合关键字按需使用：`allOf` 做字段合并（继承），`oneOf` 做多选一（联合类型），`anyOf` 做任选（宽松联合）。多态响应用 `oneOf` 加 `discriminator`，按 `type` 字段路由：

```yaml
components:
  schemas:
    Payment:
      oneOf:
        - $ref: '#/components/schemas/CardPayment'
        - $ref: '#/components/schemas/WalletPayment'
      discriminator:
        propertyName: method
        mapping:
          CARD: '#/components/schemas/CardPayment'
          WALLET: '#/components/schemas/WalletPayment'
```

读写分离用 `readOnly`/`writeOnly`，同一份 Schema 同时服务创建请求和资源响应：

```yaml
CreateOrderRequest:
  type: object
  required: [sku, quantity]
  properties:
    sku:
      type: string
      minLength: 1
      maxLength: 32
Order:
  type: object
  required: [id, sku, quantity, status, createdAt]
  properties:
    id:
      readOnly: true       # 响应里有，请求里没有
      type: integer
      format: int64
    sku:
      type: string
    status:
      readOnly: true
      type: string
      enum: [CREATED, CANCELLED]
```

`$ref` 的写法只有一种：`#/components/...` 从文档根开始的 JSON Pointer。3.1 允许 `$ref` 与 `description`、`summary` 并存，用来在引用处补充说明，但不要在引用处覆盖被引用对象的字段——生成器对覆盖行为没有统一实现。

> 边界：`$ref` 引用文档外部文件（File Ref）会让单文件工具链全部失效，团队没有拆分压力时保持单文件；真的拆分时用 Redocly 的 `bundle` 命令先打回单文件再分发。`discriminator` 只有在配合 `oneOf` 生成强类型客户端（如 Java、Kotlin）时才有收益，`typescript-fetch` 这类动态语言客户端收益有限。

## 六、代码生成：服务端接口与客户端 SDK

代码生成的核心决策是生成什么：只生成接口和模型（`interfaceOnly=true`），让实现类继承生成接口；不要让生成器直接生成完整带实现的 Controller——带实现的生成代码一旦手改，重新生成就冲突。

生成命令与关键参数：

```bash
npx -y @openapitools/openapi-generator-cli@2.42.2 generate \
  -g spring \
  -i openapi.yaml \
  -o src/generated \
  --additional-properties=interfaceOnly=true,useSpringBoot3=true,useTags=true,apiPackage=com.example.orders.api,modelPackage=com.example.orders.model,openApiNullable=false
```

| 参数 | 作用 | 建议值 |
|---|---|---|
| `interfaceOnly` | 只生成接口不生成实现 | `true` |
| `useSpringBoot3` | Jakarta 命名空间 | `true` |
| `useTags` | 按 tag 拆接口类 | `true` |
| `apiPackage` | 接口包名 | 与工程一致 |
| `openApiNullable` | 是否生成 `JsonNullable` 包装 | `false` 用裸类型 |

生成产物（实测，Generator 7.27.0，契约含 `Orders` tag）：

```text
src/generated/src/main/java/
├── com/example/orders/api/
│   ├── OrdersApi.java        # 4 个操作的接口定义
│   └── ApiUtil.java          # 示例响应工具
├── com/example/orders/model/
│   ├── Order.java
│   ├── OrderPage.java
│   ├── OrderStatus.java
│   ├── CreateOrderRequest.java
│   └── Problem.java
└── org/openapitools/configuration/
    └── EnumConverterConfiguration.java
```

生成的接口签名与契约一一对应，路径常量、参数注解、校验注解全部就位：

```java
public interface OrdersApi {
    String PATH_GET_ORDER = "/api/v1/orders/{orderId}";

    default ResponseEntity<Order> getOrder(
        @PathVariable("orderId") Long orderId,
        @RequestHeader(value = "If-None-Match", required = false) @Nullable String ifNoneMatch
    ) {
        return new ResponseEntity<>(HttpStatus.NOT_IMPLEMENTED); // 未实现时返回 501
    }
}
```

契约里的 `minLength: 1`、`minimum: 1` 直接变成 Bean Validation 注解，校验在参数绑定层完成，实现类里不需要重复校验：

```java
default ResponseEntity<Order> createOrder(
    @NotNull @Size(min = 8, max = 64) @RequestHeader(value = "Idempotency-Key", required = true)
    String idempotencyKey,
    @Valid @RequestBody CreateOrderRequest createOrderRequest
) { ... }
```

客户端 SDK 用 `typescript-fetch` 生成，产物是一套按 tag 组织的 API 类和模型：

```bash
npx -y @openapitools/openapi-generator-cli@2.42.2 generate \
  -g typescript-fetch -i openapi.yaml -o tsclient
```

```text
tsclient/
├── apis/OrdersApi.ts
├── models/Order.ts
├── models/CreateOrderRequest.ts
├── models/Problem.ts
└── runtime.ts
```

> 边界：生成代码不改一行，全部改动走“改契约 → 重新生成”；生成目录加入 `.openapi-generator-ignore` 管理覆盖范围。生成器对 `format: date-time` 默认映射 `OffsetDateTime`，对 3.1 的 `type` 数组可空字段映射 `@Nullable`，对 `enum` 生成同名 Java 枚举——这些映射差异在多语言客户端间会导致行为不一致，联调前先看生成产物的模型类。

## 七、契约测试与 CI 门禁

契约测试的目标只有一个：实现与契约不漂移。三个层次，成本从低到高，缺一不可。

| 层次 | 抓什么问题 | 时机 |
|---|---|---|
| 结构校验 | 契约本身不合法、缺字段 | 提交前 lint |
| 编译约束 | 实现/客户端与契约签名不一致 | 编译期 |
| 运行时验证 | 响应体、状态码与声明不符 | 联调/CI |

结构校验就是第二章的 `lint`，进 CI 的最小配置：

```yaml
# .redocly.yaml：团队规则集，锁定在仓库里
apis:
  contract@v1:
    root: openapi.yaml
lint:
  rules:
    no-server-example.com: off   # 本地开发 server 地址是合法场景
    info-license: off
```

编译约束由第六章的生成接口免费提供：实现类 `implements OrdersApi`，契约改了 `getOrder` 的参数而实现没改，`mvn compile` 直接失败。这是契约优先相对代码优先最大的质量收益。

运行时验证用响应体比对：启动服务后拿真实响应逐字段对照 Schema。Python 生态用 Schemathesis 做基于契约的模糊测试（示例）：

```bash
# 示例：按契约自动生成测试请求并校验响应
pip install schemathesis
schemathesis run openapi.yaml --checks all --base-url http://localhost:18091
```

```text
POST /api/v1/orders .                           [200/200 passed]
GET /api/v1/orders/{orderId}                    [180/180 passed]
```

CI 门禁把三层串成顺序步骤，任何一层失败即退出：

```yaml
# .github/workflows/contract.yml
name: contract
on: [pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - name: lint 契约
        run: npx -y @redocly/cli@2.78.0 lint openapi.yaml
      - name: 生成接口
        run: npx -y @openapitools/openapi-generator-cli@2.42.2 generate \
          -g spring -i openapi.yaml -o src/generated \
          --additional-properties=interfaceOnly=true,useSpringBoot3=true
      - name: 编译实现
        run: mvn -B compile
```

破坏性变更的判断有一条经验法则：改响应 Schema 的必填字段、删字段、收紧校验、删状态码是破坏性的；加可选字段、加新接口、加新响应码通常兼容。版本号规则随之确定：破坏性变更换主版本（`/api/v1` → `/api/v2` 或 `info.version` 大版本），兼容变更升次版本。

> 边界：契约测试验证的是“结构和语义与声明一致”，不能验证“业务逻辑正确”——幂等键是否真的幂等、取消是否真的改了状态，属于集成测试的责任。Schemathesis 的模糊测试会构造合法但业务上奇怪的输入，服务端必须能稳定返回契约声明的 4xx，而不是 500。

## 八、文档发布与版本演进

文档不是手工写的 Markdown，是从契约直接渲染的产品。Redocly CLI 的 `build-docs` 把 YAML 渲染成零依赖的 HTML：

```bash
npx -y @redocly/cli@latest build-docs openapi.yaml -o dist/api.html
```

```text
Prerendering docs

🎉 bundled successfully in: dist/api.html (282 KiB) [⏱ 82ms].
```

交互式文档用 Swagger UI，把 `openapi.yaml` 一起部署，`initOAuth` 接入 OAuth2 授权码流程即可在线调试。文档和契约来自同一份源文件是铁律——手工维护第二份文档，一周内必然与契约不一致。

版本演进的规范写法：

| 变更类型 | 版本动作 | 契约动作 |
|---|---|---|
| 加可选字段、新接口 | 升次版本 | 直接改 |
| 标记废弃 | 升次版本 | `deprecated: true` + 描述写替代方案 |
| 删字段、改必填 | 换主版本 | 新路径或新文档 |
| 下线旧版本 | — | `Sunset` 响应头声明下线日期 |

废弃声明的契约写法：

```yaml
get:
  operationId: listOrdersV1
  deprecated: true
  description: |
    已由 /api/v2/orders 取代，2027-06-30 下线。
```

```text
Deprecation: version="1.0.0"
Sunset: Wed Jun 30 2026 23:59:59 GMT+0000
```

> 边界：`deprecated: true` 只在 Swagger UI 里显示删除线，没有客户端会因此主动迁移；真正的迁移管理靠 `Sunset` 头加访问日志里旧版本的调用量监控，调用量归零才能下线。对外 API 的 `info.version` 要和 CHANGELOG 一一对应，客户报障时能精确还原到契约版本。

## 九、常见故障排查

契约问题的排查顺序永远是：先校验契约本身，再查生成产物，最后查实现行为；顺序反了会在错误的一层浪费时间。

| 现象 | 常见原因 | 第一条命令 |
|---|---|---|
| lint 报 security-defined | 操作没有安全定义 | 在根节点加 `security: [{bearerAuth: []}]` |
| 生成器不识别 3.1 特性 | 生成器版本旧 | `npx @openapitools/openapi-generator-cli@latest version` |
| 生成接口类名是 DefaultApi | 契约没写 `tags` | 给每个操作加 `tags: [Orders]` 重新生成 |
| 编译失败找不到符号 | 实现没跟上契约变更 | 看报错行对应契约哪个字段 |
| 响应多出契约没有的状态码 | 异常被默认处理器接住 | `curl -i` 看 `Content-Type` 是否为默认错误 JSON |
| 401 错误体不是 problem+json | 过滤器直写字符串 | 检查 `response.setContentType` 的媒体类型 |
| 文档页打开空白 | `build-docs` 产物路径错 | `ls dist/api.html` 确认产物存在 |
| 客户端 SDK 时间类型不对 | `format: date-time` 缺失 | 检查 Schema 的 `format` 字段 |

```bash
# 第一步永远是它：契约本身是否合法
npx -y @redocly/cli@latest lint openapi.yaml

# 第二步：重新生成，对比产物差异
npx -y @openapitools/openapi-generator-cli@2.42.2 generate \
  -g spring -i openapi.yaml -o /tmp/regen --additional-properties=interfaceOnly=true

# 第三步：实现行为对照契约（-i 看状态码和 Content-Type）
curl -i http://localhost:18091/api/v1/orders/1001 -H 'Authorization: Bearer demo-token'
```

> 边界：lint 通过不代表实现正确，只代表契约结构合法；实现正确不代表客户端理解正确。三方（契约、实现、客户端 SDK）同源于一份契约文件，是排查能收敛的前提。

## 十、最佳实践案例

### 10.1 案例背景

一个 5 人后端团队要给两个前端团队和一个外部合作伙伴提供订单 API。此前的模式是代码优先：接口先上线，文档靠聊天记录，两周内出现了三类对接事故——前端按旧响应结构写的解析代码在生产 500，合作伙伴超时重试产生重复订单，错误响应有时是 Spring 默认错误页有时是 `{code,msg}`，客户端无法统一处理。

目标是把订单 API 改为契约优先：契约入库、lint 过门禁、生成接口和客户端 SDK、实现继承生成接口、全部错误统一为 Problem Details。约束：Spring Boot 3.5.6、Java 21，不引入新网关，幂等逻辑进程内先行（多实例留到复盘）。

### 10.2 案例实操

目录结构，契约在仓库根，生成代码在 `src/main/java`，实现与生成同包但不同文件：

```text
orders-api/
├── openapi.yaml
├── pom.xml
└── src/main/java/com/example/orders/
    ├── OpenApiCaseApplication.java
    ├── api/
    │   ├── OrdersApi.java            # 生成
    │   ├── ApiUtil.java              # 生成
    │   ├── OrderApiController.java   # 手写实现
    │   └── BearerAuthFilter.java
    ├── model/                        # 全部生成
    └── service/
        ├── OrderService.java
        └── IdempotencyService.java
```

第一步，契约。四个操作：`listOrders`、`createOrder`（幂等）、`getOrder`（ETag/304）、`cancelOrder`。完整文件如下（完整版 341 行，这里用流式写法压到 212 行，语义不变，已用 Redocly 2.78.0 校验、生成器实测）：

```yaml
openapi: 3.1.0
info:
  title: 订单服务 API
  version: 1.0.0
  description: 契约优先演示用订单服务，包含幂等创建、条件查询和取消。
  license: { name: MIT, identifier: MIT }
security:
  - bearerAuth: []
servers:
  - url: http://localhost:18091
tags:
  - name: Orders
    description: 订单资源
paths:
  /api/v1/orders:
    get:
      operationId: listOrders
      tags: [Orders]
      summary: 分页查询订单
      parameters:
        - $ref: '#/components/parameters/PageNumber'
        - $ref: '#/components/parameters/PageSize'
      responses:
        '200':
          description: 订单分页结果
          headers:
            ETag: { $ref: '#/components/headers/ETagHeader' }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/OrderPage' }
        '401': { $ref: '#/components/responses/UnauthorizedProblem' }
    post:
      operationId: createOrder
      tags: [Orders]
      summary: 创建订单（幂等）
      parameters:
        - $ref: '#/components/parameters/IdempotencyKey'
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/CreateOrderRequest' }
      responses:
        '201':
          description: 创建成功
          headers:
            Location: { description: 新订单的 URI, schema: { type: string } }
            ETag: { $ref: '#/components/headers/ETagHeader' }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
        '400': { $ref: '#/components/responses/BadRequestProblem' }
        '409': { $ref: '#/components/responses/ConflictProblem' }
  /api/v1/orders/{orderId}:
    get:
      operationId: getOrder
      tags: [Orders]
      summary: 查询单个订单
      parameters:
        - $ref: '#/components/parameters/OrderId'
        - $ref: '#/components/parameters/IfNoneMatch'
      responses:
        '200':
          description: 订单详情
          headers:
            ETag: { $ref: '#/components/headers/ETagHeader' }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Order' }
        '304':
          description: 资源未变化，命中条件请求
          headers:
            ETag: { $ref: '#/components/headers/ETagHeader' }
        '404': { $ref: '#/components/responses/NotFoundProblem' }
    delete:
      operationId: cancelOrder
      tags: [Orders]
      summary: 取消订单（幂等）
      parameters:
        - $ref: '#/components/parameters/OrderId'
      responses:
        '204': { description: 已取消或本就不存在 }
        '404': { $ref: '#/components/responses/NotFoundProblem' }
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer }
  parameters:
    OrderId:
      name: orderId
      in: path
      required: true
      description: 订单 ID
      schema: { $ref: '#/components/schemas/OrderId' }
    IdempotencyKey:
      name: Idempotency-Key
      in: header
      required: true
      description: 客户端为一次业务操作生成的幂等键，重试时复用
      schema:
        type: string
        minLength: 8
        maxLength: 64
        examples: [req-8f3c2a91]
    IfNoneMatch:
      name: If-None-Match
      in: header
      required: false
      description: 上次响应返回的 ETag，命中时返回 304
      schema: { type: string }
    PageNumber:
      name: page
      in: query
      description: 页码，从 0 开始
      schema: { type: integer, format: int32, minimum: 0, default: 0 }
    PageSize:
      name: size
      in: query
      description: 每页条数
      schema: { type: integer, format: int32, minimum: 1, maximum: 100, default: 20 }
  headers:
    ETagHeader:
      description: 资源版本号，格式为双引号包裹的整数
      schema:
        type: string
        pattern: '^"[0-9]+"$'
        examples: ['"3"']
  responses:
    UnauthorizedProblem:
      description: 缺少或无效凭证
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }
    BadRequestProblem:
      description: 请求体缺失或字段校验失败
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }
    NotFoundProblem:
      description: 订单不存在
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }
          examples:
            notFound:
              value:
                type: 'https://docs.example.net/problems/order-not-found'
                title: 订单不存在
                status: 404
                detail: 订单 9999 不存在
                instance: /api/v1/orders/9999
    ConflictProblem:
      description: 幂等键冲突
      content:
        application/problem+json:
          schema: { $ref: '#/components/schemas/Problem' }
  schemas:
    OrderId:
      type: integer
      format: int64
      description: 订单 ID，服务端生成
      examples: [1001]
    OrderStatus:
      type: string
      description: 订单状态
      enum: [CREATED, CANCELLED]
    CreateOrderRequest:
      type: object
      description: 创建订单请求
      required: [sku, quantity]
      properties:
        sku:
          type: string
          minLength: 1
          maxLength: 32
          description: 商品 SKU 编码
        quantity:
          type: integer
          format: int32
          minimum: 1
          maximum: 99
          description: 购买数量
    Order:
      type: object
      description: 订单资源
      required: [id, sku, quantity, status, createdAt]
      properties:
        id: { $ref: '#/components/schemas/OrderId' }
        sku: { type: string, description: 商品 SKU 编码 }
        quantity: { type: integer, format: int32, minimum: 1 }
        status: { $ref: '#/components/schemas/OrderStatus' }
        createdAt: { type: string, format: date-time, description: 创建时间 }
    OrderPage:
      type: object
      description: 订单分页结果
      required: [items, page, size]
      properties:
        items:
          type: array
          items: { $ref: '#/components/schemas/Order' }
        page: { type: integer, format: int32 }
        size: { type: integer, format: int32 }
    Problem:
      type: object
      description: RFC 9457 错误响应
      required: [type, title, status]
      properties:
        type: { type: string, format: uri }
        title: { type: string }
        status: { type: integer }
        detail: { type: [string, 'null'] }
        instance: { type: [string, 'null'] }
        orderId: { $ref: '#/components/schemas/OrderId' }
```

第二步，lint 过门禁（实测）：

```bash
npx -y @redocly/cli@2.78.0 lint openapi.yaml
```

```text
validating openapi.yaml...
Woohoo! Your API description is valid. 🎉
You have 1 warning.
```

警告来自 `no-server-example.com` 规则（本地 `localhost` 开发地址），团队规则集里显式关闭，写入 `.redocly.yaml`，CI 结果保持绿色且可复现。

第三步，生成接口（实测产物见第六章）：

```bash
npx -y @openapitools/openapi-generator-cli@2.42.2 generate \
  -g spring -i openapi.yaml -o src/generated \
  --additional-properties=interfaceOnly=true,useSpringBoot3=true,useTags=true,apiPackage=com.example.orders.api,modelPackage=com.example.orders.model,openApiNullable=false
```

生成产物在 `src/generated/src/main/java`，把其中的 `com/` 与 `org/` 目录拷贝到 `src/main/java` 后再编译（或把生成目录加进 `build-helper-maven-plugin` 的源码根）。

第四步，订单服务保存资源与版本号。ETag 必须来自稳定的版本字段，不能用时间戳：

```java
@Service
public class OrderService {

    public record OrderRecord(Order order, long version) {
    }

    public static class OrderNotFoundException extends RuntimeException {
        public final Long orderId;

        public OrderNotFoundException(Long orderId) {
            super("订单 " + orderId + " 不存在");
            this.orderId = orderId;
        }
    }

    private final Map<Long, OrderRecord> orders = new ConcurrentHashMap<>();
    private final AtomicLong ids = new AtomicLong(1000);

    public Order create(CreateOrderRequest request) {
        long id = ids.incrementAndGet();
        // ETag 用独立版本号而不是时间戳，保证同一资源版本稳定，304 才可能命中
        Order order = new Order(id, request.getSku(), request.getQuantity(),
                OrderStatus.CREATED, OffsetDateTime.now());
        orders.put(id, new OrderRecord(order, 0));
        return order;
    }

    public Order get(Long id) {
        OrderRecord record = orders.get(id);
        if (record == null) throw new OrderNotFoundException(id);
        return record.order();
    }

    public long version(Long id) {
        OrderRecord record = orders.get(id);
        if (record == null) throw new OrderNotFoundException(id);
        return record.version();
    }

    public void cancel(Long id) {
        // 用 computeIfPresent 保证只改存在的订单；不存在时抛 404，重复取消保持 204
        orders.computeIfPresent(id, (key, record) -> {
            Order cancelled = new Order(record.order().getId(), record.order().getSku(),
                    record.order().getQuantity(), OrderStatus.CANCELLED, record.order().getCreatedAt());
            return new OrderRecord(cancelled, record.version() + 1);
        });
        if (!orders.containsKey(id)) throw new OrderNotFoundException(id);
    }

    public OrderPage list(int page, int size) {
        List<Order> all = orders.values().stream()
                .map(OrderRecord::order)
                .sorted(Comparator.comparing(Order::getId))
                .toList();
        int from = Math.min(page * size, all.size());
        int to = Math.min(from + size, all.size());
        return new OrderPage().items(new ArrayList<>(all.subList(from, to))).page(page).size(size);
    }
}
```

第五步，实现类继承生成接口，幂等与 ETag 逻辑全部在实现层：

```java
@RestController
public class OrderApiController implements OrdersApi {

    private final OrderService orders;
    private final IdempotencyService idempotency;

    public OrderApiController(OrderService orders, IdempotencyService idempotency) {
        this.orders = orders;
        this.idempotency = idempotency;
    }

    @Override
    public Optional<NativeWebRequest> getRequest() {
        return Optional.empty(); // 关掉生成代码里的示例响应兜底
    }

    @Override
    public ResponseEntity<Order> createOrder(String idempotencyKey, CreateOrderRequest createOrderRequest) {
        // 幂等键绑定“业务动作”，请求体哈希用于检测同键不同体
        String bodyHash = idempotency.hash(createOrderRequest.toString());
        IdempotencyService.Outcome outcome =
                idempotency.execute(idempotencyKey, bodyHash, () -> orders.create(createOrderRequest));
        Order order = (Order) outcome.result();
        return ResponseEntity.status(HttpStatus.CREATED)
                .eTag("\"" + orders.version(order.getId()) + "\"")
                .location(URI.create("/api/v1/orders/" + order.getId()))
                .body(order);
    }

    @Override
    public ResponseEntity<Order> getOrder(Long orderId, @Nullable String ifNoneMatch) {
        Order order = orders.get(orderId);
        String etag = "\"" + orders.version(orderId) + "\"";
        if (etag.equals(ifNoneMatch)) {
            // 304 也必须带 ETag，客户端才能继续做条件请求
            return ResponseEntity.status(HttpStatus.NOT_MODIFIED).eTag(etag).build();
        }
        return ResponseEntity.ok().eTag(etag).body(order);
    }

    @Override
    public ResponseEntity<Void> cancelOrder(Long orderId) {
        orders.cancel(orderId);
        return ResponseEntity.noContent().build();
    }

    @Override
    public ResponseEntity<OrderPage> listOrders(Integer page, Integer size) {
        return ResponseEntity.ok(orders.list(page, size));
    }
}
```

幂等服务的实现要点：

```java
@Service
public class IdempotencyService {

    public record Outcome(Object result, boolean replayed) {}

    public static class ConflictException extends RuntimeException {
        public ConflictException(String key) {
            super("幂等键 " + key + " 已用于不同的请求体");
        }
    }

    private record Entry(String bodyHash, Object result) {}

    private final Map<String, Entry> entries = new ConcurrentHashMap<>();
    private final Map<String, Object> locks = new ConcurrentHashMap<>();

    public Outcome execute(String key, String bodyHash, Supplier<?> action) {
        // 每个 key 一把锁：并发重试只放一个请求进去执行
        Object lock = locks.computeIfAbsent(key, ignored -> new Object());
        synchronized (lock) {
            Entry existing = entries.get(key);
            if (existing != null) {
                // 同 key 不同请求体说明客户端复用错了键，拒绝而不是执行第二次
                if (!existing.bodyHash().equals(bodyHash)) {
                    throw new ConflictException(key);
                }
                return new Outcome(existing.result(), true);
            }
            Object result = action.get();
            entries.put(key, new Entry(bodyHash, result));
            return new Outcome(result, false);
        }
    }

    public String hash(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("JVM 必须支持 SHA-256", e);
        }
    }
}
```

错误统一为 Problem 的异常处理，`application/problem+json` 与契约声明一致：

```java
@RestControllerAdvice
static class ProblemAdvice {
    @ExceptionHandler(OrderService.OrderNotFoundException.class)
    public ResponseEntity<Problem> handleNotFound(OrderService.OrderNotFoundException e) {
        Problem problem = new Problem();
        problem.setType(URI.create("https://docs.example.net/problems/order-not-found"));
        problem.setTitle("订单不存在");
        problem.setStatus(404);
        problem.setDetail(e.getMessage());
        problem.setInstance("/api/v1/orders/" + e.orderId);
        problem.setOrderId(e.orderId);
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .contentType(MediaType.parseMediaType("application/problem+json"))
                .body(problem);
    }

    @ExceptionHandler(IdempotencyService.ConflictException.class)
    public ResponseEntity<Problem> handleConflict(IdempotencyService.ConflictException e) {
        Problem problem = new Problem();
        problem.setType(URI.create("https://docs.example.net/problems/idempotency-conflict"));
        problem.setTitle("幂等键冲突");
        problem.setStatus(409);
        problem.setDetail(e.getMessage());
        return ResponseEntity.status(HttpStatus.CONFLICT)
                .contentType(MediaType.parseMediaType("application/problem+json"))
                .body(problem);
    }

    @ExceptionHandler({MethodArgumentNotValidException.class, HttpMessageNotReadableException.class})
    public ResponseEntity<Problem> handleBadRequest(Exception e) {
        // 400 不在最初的契约里，联调暴露后补进契约并重新生成，见案例复盘
        Problem problem = new Problem();
        problem.setType(URI.create("https://docs.example.net/problems/validation-failed"));
        problem.setTitle("参数校验失败");
        problem.setStatus(400);
        problem.setDetail(e instanceof MethodArgumentNotValidException valid
                ? valid.getBindingResult().getFieldErrors().get(0).getDefaultMessage()
                : "请求体缺失或格式错误");
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .contentType(MediaType.parseMediaType("application/problem+json"))
                .body(problem);
    }
}
```

契约声明了 `bearerAuth`，实现层用过滤器兑现，401 的错误体同样是 Problem（契约只写在文档里不校验，是契约与实现脱节最常见的一种）：

```java
@Component
public class BearerAuthFilter extends OncePerRequestFilter {

    private static final String TOKEN = "demo-token";

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String header = request.getHeader("Authorization");
        if (!("Bearer " + TOKEN).equals(header)) {
            // 错误体也用契约声明的 application/problem+json，客户端才能统一解析
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType("application/problem+json");
            response.setCharacterEncoding(StandardCharsets.UTF_8.name());
            response.getWriter().write("{\"type\":\"https://docs.example.net/problems/unauthorized\","
                    + "\"title\":\"未认证\",\"status\":401,"
                    + "\"detail\":\"缺少或无效的 Bearer Token\"}");
            return;
        }
        chain.doFilter(request, response);
    }
}
```

工程骨架用 Spring Boot 3.5.6，依赖只有 Web 与 Validation，生成的接口和模型直接放在 `src/main/java` 下参与编译：

```xml
<parent>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-parent</artifactId>
  <version>3.5.6</version>
  <relativePath/>
</parent>
<properties><java.version>21</java.version></properties>
<dependencies>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-web</artifactId>
  </dependency>
  <dependency>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-validation</artifactId>
  </dependency>
</dependencies>
```

`application.yml` 收掉模型里的可空字段序列化，响应体与契约示例一致：

```yaml
server:
  port: 18091
spring:
  jackson:
    default-property-inclusion: non_null
```

启动与验收（实测，`mvn spring-boot:run` 后逐条 curl）：

```bash
# 未认证：401 + problem+json
curl -i http://localhost:18091/api/v1/orders/1001

# 创建：201 + Location + ETag
curl -i -X POST http://localhost:18091/api/v1/orders \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer demo-token' \
  -H 'Idempotency-Key: req-8f3c2a91' \
  -d '{"sku":"SKU-1","quantity":2}'

# 幂等重放：同一个键、同一个请求体，返回同一结果
curl -i -X POST http://localhost:18091/api/v1/orders \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer demo-token' \
  -H 'Idempotency-Key: req-8f3c2a91' \
  -d '{"sku":"SKU-1","quantity":2}'

# 同键不同请求体：409
curl -i -X POST http://localhost:18091/api/v1/orders \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer demo-token' \
  -H 'Idempotency-Key: req-8f3c2a91' \
  -d '{"sku":"SKU-2","quantity":1}'

# 参数校验失败：400 + problem+json
curl -i -X POST http://localhost:18091/api/v1/orders \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer demo-token' \
  -H 'Idempotency-Key: req-8f3c2a91' \
  -d '{"quantity":2}'

# 条件查询：命中 ETag 返回 304
curl -i http://localhost:18091/api/v1/orders/1001 \
  -H 'Authorization: Bearer demo-token' -H 'If-None-Match: "0"'

# 取消两次：两次都是 204
curl -i -X DELETE http://localhost:18091/api/v1/orders/1001 -H 'Authorization: Bearer demo-token'
curl -i -X DELETE http://localhost:18091/api/v1/orders/1001 -H 'Authorization: Bearer demo-token'

# 取消不存在的订单：404 + problem+json
curl -i -X DELETE http://localhost:18091/api/v1/orders/9999 -H 'Authorization: Bearer demo-token'
```

实测输出（关键行）：

```text
HTTP/1.1 401
Content-Type: application/problem+json;charset=UTF-8
{"type":"https://docs.example.net/problems/unauthorized","title":"未认证","status":401,"detail":"缺少或无效的 Bearer Token"}

HTTP/1.1 201
ETag: "0"
Location: /api/v1/orders/1001
Content-Type: application/json
{"id":1001,"sku":"SKU-1","quantity":2,"status":"CREATED","createdAt":"2026-11-13T04:31:42.7317+08:00"}

HTTP/1.1 201   ← 幂等重放，返回同一订单（id 相同、createdAt 相同）
ETag: "0"
Location: /api/v1/orders/1001
{"id":1001,"sku":"SKU-1","quantity":2,"status":"CREATED","createdAt":"2026-11-13T04:31:42.7317+08:00"}

HTTP/1.1 409
Content-Type: application/problem+json
{"type":"https://docs.example.net/problems/idempotency-conflict","title":"幂等键冲突","status":409,"detail":"幂等键 req-8f3c2a91 已用于不同的请求体"}

HTTP/1.1 400
Content-Type: application/problem+json
{"type":"https://docs.example.net/problems/validation-failed","title":"参数校验失败","status":400,"detail":"不能为null"}

HTTP/1.1 304
ETag: "0"

HTTP/1.1 204
HTTP/1.1 204

HTTP/1.1 404
Content-Type: application/problem+json
{"type":"https://docs.example.net/problems/order-not-found","title":"订单不存在","status":404,"detail":"订单 9999 不存在","instance":"/api/v1/orders/9999","orderId":9999}
```

### 10.3 案例结果

契约入库后，四个操作、七种响应（401/201/304/204/400/404/409）全部与契约一一对应，两个前端团队用生成的 `typescript-fetch` SDK 对接，字段名拼写错误在编译期暴露；合作伙伴拿到的文档由契约渲染，重试逻辑按契约的 `Idempotency-Key` 声明实现，重复订单问题消失（示例：改造前每周约 3 笔重复订单，改造后归零）。

复盘四个失败模式：第一，最初的契约漏了 `400`，联调时参数校验失败返回 Spring 默认错误 JSON，客户端解析崩溃——补进契约、加 `BadRequestProblem` 响应、重新生成后才闭环，说明“契约只写快乐路径”是第一个要改的习惯；第二，最初契约没写 `tags`，生成器把接口命名为 `DefaultApi`，语义丢失，补 `tags: [Orders]` 后才生成 `OrdersApi`；第三，幂等存储在 JVM 内存，多实例部署会重复创建，生产必须换 Redis `SETNX` 或数据库唯一键并加 TTL；第四，契约测试目前只有 lint 和编译两层，运行时响应验证（Schemathesis）还没进 CI，是遗留的缺口，下一步补上。
