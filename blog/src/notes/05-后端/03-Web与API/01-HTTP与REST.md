# HTTP 与 REST

HTTP 是客户端与服务端之间的请求—响应协议，规定报文如何书写、连接如何建立、结果如何表达；REST 是在 HTTP 之上组织资源的接口风格。两者共同解决跨系统调用的互操作问题，但不负责业务规则、消息可靠投递和实时双向通信。

---

## 一、HTTP 与 REST 是什么

### 1.1 核心概念

HTTP 的核心模型是**一次请求对应一次响应**。客户端构造请求行、请求头、请求体，服务端解析后返回状态行、响应头、响应体。协议本身不保存上一次请求的上下文，因此称为无状态；登录态、分页位置、购物车内容都必须由 Cookie、令牌或请求参数额外携带。

REST 不是协议，而是一组架构约束。它要求客户端与服务端分离、通信无状态、响应可缓存、接口统一、系统分层，并可选地支持按需下发代码。统一接口进一步展开为四条：每个资源有唯一标识；通过表示操作资源；消息自描述；超媒体驱动应用状态。满足全部约束成本很高，工程上通常只落实资源命名、方法语义和状态码这三项。

| 概念 | 本质 | 观察位置 |
|---|---|---|
| 资源 | 被操作的对象，如订单、用户 | URL 路径 |
| 表示 | 资源在某一时刻的序列化形态 | 响应体与 `Content-Type` |
| 方法 | 对资源执行的动作语义 | 请求行 |
| 状态码 | 本次请求的处理结果分类 | 状态行 |
| 头字段 | 描述报文、连接、缓存、认证的元数据 | 请求头与响应头 |
| 连接 | 承载报文的传输通道 | TCP/TLS 或 QUIC |

HTTP 不解决三件事：业务状态如何流转、跨请求的事务如何保证、消息在断线后如何补发。把这三件事误当成协议能力，是接口设计中最常见的起点错误。

> **注意**：REST 的“无状态”指服务端不在两次请求之间保存会话上下文，不表示客户端不能保存令牌。把 Session 存进服务端内存会让服务端保存会话状态，严格来说违背无状态约束；工程上常用共享存储加 Cookie 做折中，但这不是纯 REST 形态。

### 1.2 在技术栈中的位置

HTTP 位于应用层。HTTP/1.1 与 HTTP/2 依赖 TCP，HTTP/3 改用基于 UDP 的 QUIC；TLS 在 HTTP/1.1 与 HTTP/2 中位于 TCP 之上，在 HTTP/3 中已集成进 QUIC 握手。HTTP 之上才是 REST、GraphQL、gRPC、WebSocket 与 SSE 这些接口形态。

| 技术 | 与 HTTP 的关系 | 典型职责 |
|---|---|---|
| REST | 使用 HTTP 方法与状态码 | 资源型接口，通用性最好 |
| GraphQL | 通常以单个 `POST` 端点承载 | 由客户端声明字段，减少多次往返 |
| gRPC | 独立于 HTTP 语义，可跑在 HTTP/2 上 | 二进制 RPC，强类型、高性能 |
| WebSocket | 用 HTTP 完成一次协议升级 | 握手后转为双向帧通信 |
| SSE | 复用普通 HTTP 响应流 | 服务端单向推送文本事件 |

反向代理、API 网关和 CDN 都工作在 HTTP 层。它们会改写头字段、缓存响应、限制请求体大小、设置超时，因此“直连后端正常、经过网关失败”是排障中的常见分叉点。

### 1.3 一次完整交互

一次页面请求要经过域名解析、连接建立、报文交换和渲染四个阶段。下图把一次带网关和数据库的读取请求展开：

```mermaid
sequenceDiagram
    participant B as 浏览器
    participant R as DNS 解析器
    participant G as 网关或 Nginx
    participant A as 应用服务
    participant D as 数据库
    B->>R: 查询 api.example.com
    R-->>B: 返回 A 记录
    B->>G: TCP 握手并完成 TLS 握手
    B->>G: GET /api/orders?limit=20
    G->>A: 反向代理转发请求
    A->>D: 执行 SELECT
    D-->>A: 返回结果集
    A-->>G: 200 OK + JSON + ETag
    G-->>B: 压缩后的响应
    B->>B: 解析 JSON 并更新页面
    Note over B,G: 任一环节超时都表现为页面持续等待
```

| 阶段 | 主要耗时来源 | 观察手段 |
|---|---|---|
| DNS | 递归查询、缓存未命中 | `dig`、`nslookup` |
| TCP | 往返时延、丢包重传 | `curl -w` 的 `time_connect` |
| TLS | 证书链、密钥交换、OCSP | `curl -v`、`openssl s_client` |
| 首字节 | 排队、鉴权、数据库慢查询 | `time_starttransfer`、网关日志 |
| 内容传输 | 响应体大小、带宽、压缩 | `size_download`、`Content-Encoding` |
| 渲染 | 前端脚本、图片、布局 | 浏览器 Performance 面板 |

排障时先确定停在哪一段，再进入对应层。只看到“页面转圈”就往数据库查，往往会绕开真正的瓶颈。

---

## 二、报文与语义结构

### 2.1 请求报文

一个带 JSON 请求体的创建请求如下：

```http
POST /api/orders?dry_run=false HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.example
Content-Type: application/json
Accept: application/json
Idempotency-Key: 9f1c2d7e-4a6b-4c8d-9e0f-123456789abc
Content-Length: 28
Connection: keep-alive

{"sku":"A-100","quantity":2}
```

请求报文由四段组成：请求行、请求头、空行、请求体。请求行包含方法、目标路径和协议版本；请求头每行一个 `名称: 值`；空行是头与体的分界；请求体长度由 `Content-Length` 或分块编码决定。

| 头字段 | 作用 | 常见值 |
|---|---|---|
| `Host` | 指定目标主机与端口，虚拟主机依赖它路由 | `api.example.com` |
| `Content-Type` | 声明请求体的媒体类型 | `application/json` |
| `Accept` | 声明客户端能处理的响应类型 | `application/json` |
| `Authorization` | 携带认证凭据 | `Bearer <token>` |
| `Cookie` | 浏览器自动携带的会话数据 | `session=abc123` |
| `Idempotency-Key` | 标识一次可重试的写操作 | 客户端生成的 UUID |
| `If-None-Match` | 条件请求，携带上次的 ETag | `"7c9e1a"` |
| `Origin` | 跨源请求的来源标识 | `https://app.example.com` |

请求体并非所有方法都必须存在。`GET` 携带请求体在规范中没有定义语义，部分代理和缓存会直接丢弃，因此查询条件应放查询字符串；条件复杂到 URL 放不下时，改用 `POST /orders/search` 并在契约中说明它只读。

> **注意**：`Content-Length` 表示字节数而不是字符数。包含中文的 JSON 按 UTF-8 编码后，一个汉字通常占三个字节，手工计算长度极易出错，应交给 HTTP 客户端生成。

### 2.2 响应报文

创建成功后的响应：

```http
HTTP/1.1 201 Created
Content-Type: application/json
Location: /api/orders/A100
ETag: "7c9e1a"
Cache-Control: no-store
Set-Cookie: session=abc123; HttpOnly; Secure; SameSite=Lax

{"id":"A100","status":"pending","total_cents":19900}
```

响应报文同样由四段组成。状态行包含协议版本、三位状态码和原因短语；原因短语只是给人看的描述，客户端判断结果必须依据状态码。

| 头字段 | 作用 | 常见值 |
|---|---|---|
| `Content-Type` | 响应体的媒体类型与字符集 | `application/json; charset=utf-8` |
| `Content-Length` | 响应体字节数 | `58` |
| `Location` | 创建结果或重定向的目标 | `/api/orders/A100` |
| `ETag` | 当前表示版本的标识 | `"7c9e1a"` |
| `Cache-Control` | 缓存策略 | `no-store`、`max-age=3600` |
| `Set-Cookie` | 下发会话 Cookie | 含 `HttpOnly`、`Secure` |
| `Vary` | 声明缓存键随哪些请求头变化 | `Accept-Encoding`、`Origin` |
| `Retry-After` | 限流或维护时建议的重试等待 | 秒数或 HTTP 日期 |

### 2.3 方法与状态码语义

方法表达动作意图，安全性和幂等性决定它能否被预取、缓存或自动重试。

| 方法 | 安全 | 幂等 | 典型用途 |
|---|---|---|---|
| `GET` | 是 | 是 | 读取列表、详情、搜索 |
| `HEAD` | 是 | 是 | 只取响应头，检查存在性与缓存 |
| `POST` | 否 | 否 | 创建资源、执行有副作用的动作 |
| `PUT` | 否 | 是 | 用请求体整体替换资源 |
| `PATCH` | 否 | 不一定 | 部分更新字段 |
| `DELETE` | 否 | 是 | 删除资源 |
| `OPTIONS` | 是 | 是 | 查询支持的方法，或处理 CORS 预检 |

状态码按首位数字分成五段，每段表达不同的处理方向。

| 段 | 含义 | 常见状态码 |
|---|---|---|
| `2xx` | 请求已成功处理 | `200`、`201`、`204`、`206` |
| `3xx` | 需要进一步动作或命中缓存 | `301`、`302`、`304`、`307`、`308` |
| `4xx` | 请求本身有问题 | `400`、`401`、`403`、`404`、`409`、`412`、`422`、`429` |
| `5xx` | 服务端处理失败 | `500`、`502`、`503`、`504` |

几个容易混淆的组合：

| 状态码 | 准确含义 | 客户端动作 |
|---|---|---|
| `401` | 未认证，或凭据无效、过期 | 跳登录页或刷新令牌 |
| `403` | 已认证但无权限 | 提示申请权限，不要反复登录 |
| `400` | 请求语法或参数格式错误 | 修正请求，不重试 |
| `409` | 与资源当前状态冲突 | 读取最新状态后决定 |
| `412` | 条件请求的前置条件不成立 | 重新获取资源再提交 |
| `422` | 语法正确但业务校验不通过 | 展示字段级错误 |
| `429` | 触发限流 | 按 `Retry-After` 退避 |
| `502` | 网关从上游收到无效响应 | 查上游进程与端口 |
| `504` | 网关等待上游超时 | 查慢查询、连接池、下游超时 |

`401` 响应应带 `WWW-Authenticate` 头，告诉客户端使用哪种认证方案；`429` 应带 `Retry-After`；`503` 也可带 `Retry-After` 表示维护窗口。缺少这些头，客户端只能盲目重试。

重定向要区分方法与请求体：`301` 与 `302` 在历史上可能把 `POST` 改成 `GET`，`307` 与 `308` 则明确保留原方法和请求体。登录跳转、HTTPS 跳转、尾斜杠跳转都要确认方法是否被改写，以及 Cookie 是否会随新地址发送。

### 2.4 报文边界与传输编码

接收方必须知道一个报文在哪里结束，否则会把下一个响应误读成当前响应体。HTTP/1.1 提供三种边界方式：

| 机制 | 边界表示 | 适用场景 |
|---|---|---|
| `Content-Length` | 明确的字节数 | 长度已知的定长响应 |
| `Transfer-Encoding: chunked` | 每个分块前写长度，末块长度为 0 | 流式生成、长度未知 |
| 连接关闭 | 服务端关闭 TCP 连接作为结束 | HTTP/1.0 或无长度信息时 |
| HTTP/2 与 HTTP/3 | `END_STREAM` 标志 | 多路复用下的流式传输 |

`HEAD` 响应、`204 No Content`、`304 Not Modified` 都不携带响应体。代理若给这些响应补上 `Content-Length` 或写入内容，会破坏客户端解析。

> **安全警告**：请求同时带 `Content-Length` 和 `Transfer-Encoding`，或两个头取值互相矛盾时，前端代理与后端可能采用不同边界，形成请求走私。生产网关应拒绝这类报文，并统一由一层负责规范化。

---

## 三、HTTP 报文的观察方法

### 3.1 本地服务与 curl

不依赖框架，用 Python 自带静态服务器就能观察完整报文。

```bash
# ========== 准备静态文件 ==========
# 建目录并写入一个最小页面
mkdir -p /tmp/http-demo && cd /tmp/http-demo
printf '<h1>hello</h1>\n' > index.html

# ========== 启动服务 ==========
# 绑定回环地址，避免暴露到局域网
python3 -m http.server 8000 --bind 127.0.0.1

# ========== 基本请求 ==========
# 另开终端，-i 同时打印响应头
curl -i http://127.0.0.1:8000/

# 只发 HEAD，观察响应头而不下载正文
curl -I http://127.0.0.1:8000/

# 请求不存在的路径，观察 404
curl -i http://127.0.0.1:8000/nope

# ========== 方法探测 ==========
# 静态服务器未实现 OPTIONS，预期返回 501
curl -i -X OPTIONS http://127.0.0.1:8000/

# ========== 构造 POST ==========
# -d 默认把 Content-Type 设为表单类型
curl -i -X POST http://127.0.0.1:8000/ \
  -H 'Content-Type: application/json' \
  -d '{"sku":"A-100","quantity":2}'
```

`curl -i` 的输出类似：

```text
HTTP/1.0 200 OK
Server: SimpleHTTP/0.6 Python/3.12.4
Date: Tue, 27 Oct 2026 08:00:00 GMT
Content-type: text/html
Content-Length: 15
Last-Modified: Tue, 27 Oct 2026 07:59:00 GMT

<h1>hello</h1>
```

首行给出协议版本与状态码，随后是响应头，空行之后是正文。Python 的 `http.server` 默认以 HTTP/1.0 应答，且未实现 `OPTIONS`，因此方法探测返回 `501 Unsupported method`；这正好说明“服务端支持哪些方法”取决于实现，而不是协议强制。

```bash
# ========== 观察耗时构成 ==========
# 分别输出 DNS、连接、TLS、首字节和总耗时
curl -sS -o /dev/null -w \
  'dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n' \
  https://example.com/

# ========== 指定协议版本 ==========
# 强制 HTTP/1.1，便于对比头字段
curl -sS -o /dev/null --http1.1 -w '%{http_version}\n' https://example.com/

# 协商 HTTP/2，观察多路复用是否生效
curl -sS -o /dev/null --http2 -w '%{http_version}\n' https://example.com/

# ========== 解析到指定地址 ==========
# 绕过 DNS，把域名指向测试机，验证网关配置
curl -i --resolve api.example.com:443:127.0.0.1 https://api.example.com/api/orders
```

| 参数 | 观察内容 | 常见用途 |
|---|---|---|
| `-i` | 响应头与响应体 | 确认状态码、`Content-Type`、缓存头 |
| `-I` | 只发 `HEAD` | 检查资源是否存在、是否被缓存 |
| `-v` | 连接、TLS、请求头、响应头 | 排查握手与代理改写 |
| `-N` | 关闭输出缓冲 | 观察 SSE 等流式响应 |
| `-w` | 输出耗时与传输统计 | 定位慢在 DNS、连接还是首字节 |
| `--resolve` | 把域名固定到指定 IP | 绕过 DNS 验证目标节点 |

### 3.2 连接与 TLS 观察

```bash
# ========== 查看握手与报文方向 ==========
# -o /dev/null 丢弃正文，只保留诊断信息
curl -v https://example.com/ -o /dev/null

# ========== 查看证书链与有效期 ==========
# 只取证书部分，输出主题、签发者与起止时间
openssl s_client -connect example.com:443 -servername example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates

# ========== 检查 ALPN 协商结果 ==========
# 输出服务端支持的协议列表，h2 表示 HTTP/2
openssl s_client -connect example.com:443 -servername example.com -alpn h2,http/1.1 </dev/null 2>/dev/null \
  | grep -i 'ALPN protocol'
```

`curl -v` 的输出按符号区分方向：`*` 是客户端诊断信息，`>` 是发往服务端的请求行与请求头，`<` 是收到的状态行与响应头。TLS 握手阶段会打印协议版本、密码套件和证书校验结果，证书过期或域名不匹配会在这里直接报错。

### 3.3 浏览器与网关观察

浏览器开发者工具的 Network 面板把一次请求拆成排队、DNS、连接、TLS、等待、下载六段。勾选 `Preserve log` 可以看到跳转前的请求，勾选 `Disable cache` 可以排除缓存干扰；右键请求选择 `Copy as cURL` 能把浏览器实际发送的头字段完整复制出来，比手工复现可靠。

| 面板字段 | 含义 | 排障价值 |
|---|---|---|
| `Status` | 状态码，括号内可能是缓存来源 | 区分 `200`、`304`、`from disk cache` |
| `Protocol` | `http/1.1`、`h2`、`h3` | 判断是否走了预期协议 |
| `Remote Address` | 实际连接的 IP 与端口 | 确认是否命中测试节点 |
| `Timing` | 各阶段耗时 | 定位 DNS、TLS 或首字节瓶颈 |
| `Response Headers` | 服务端返回的全部头 | 查 CORS、缓存、`Set-Cookie` |

网关侧的日志能补上浏览器看不到的上游信息。Nginx 可配置如下格式：

```nginx
# ========== 记录上下游状态与耗时 ==========
# $status 是返回给客户端的状态码，$upstream_status 是上游返回的状态码
log_format api '$remote_addr "$request" status=$status upstream=$upstream_status '
               'rt=$request_time urt=$upstream_response_time '
               'rid=$http_x_request_id';

server {
    listen 80;
    server_name api.example.com;

    # 使用上面定义的格式记录上下游状态
    access_log /var/log/nginx/api.log api;

    location /api/ {
        # 把请求 ID 传给上游，便于串联应用日志
        proxy_set_header X-Request-ID $request_id;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_pass http://127.0.0.1:8080;
    }
}
```

一行正常日志类似 `status=200 upstream=200 rt=0.032 urt=0.028`。`status=502 upstream=502` 说明上游返回了错误；`status=504` 且 `urt` 接近超时阈值，说明上游处理过慢；`status=499` 是客户端在服务端响应前主动断开，常见于前端超时或用户刷新。

---

## 四、连接、缓存与状态机制

### 4.1 连接复用与协议版本

HTTP/1.0 默认每次请求后关闭连接；HTTP/1.1 默认保持连接，通过 `Connection: keep-alive` 复用同一个 TCP 通道。复用省掉了重复握手，但同一连接上的响应仍按顺序返回，前一个响应慢会阻塞后面的请求。

| 版本 | 传输层 | 并发与压缩 | 典型特征 |
|---|---|---|---|
| HTTP/1.0 | TCP | 无多路复用，无头压缩 | 每次请求新建连接 |
| HTTP/1.1 | TCP | 无多路复用，无头压缩 | 持久连接、分块传输 |
| HTTP/2 | TCP | 多流复用，HPACK | 单连接并发、服务端推送已弱化 |
| HTTP/3 | QUIC/UDP | 多流复用，QPACK | 避免 TCP 层队头阻塞，握手更快 |

HTTP/2 解决了 HTTP 层的队头阻塞，但所有流仍共享一条 TCP 连接，丢包时内核要按序重传，传输层仍会阻塞。HTTP/3 把流搬到 QUIC 上，单个流丢包不影响其他流，这也是弱网环境下它更有优势的原因。

> **注意**：浏览器只会在 TLS 之上通过 ALPN 协商 HTTP/2，明文 `h2c` 主要存在于内网服务之间。用 `curl --http2` 测试 HTTPS 地址才会真正走 ALPN。

### 4.2 缓存与条件请求

缓存分两级：强缓存直接复用本地副本，不发请求；协商缓存带着版本标识去问服务端，未变化时返回 `304`，只省正文不省往返。

```mermaid
flowchart TD
    A["客户端发起请求"] -->|"检查本地缓存"| B{"本地有缓存副本"}
    B -->|"没有"| C["发送完整请求"]
    B -->|"有"| D{"强缓存仍在有效期"}
    D -->|"是"| E["直接使用本地副本"]
    D -->|"否"| F["携带 If-None-Match 或 If-Modified-Since"]
    F -->|"发送条件请求"| G{"服务端校验版本"}
    G -->|"未变化"| H["304 Not Modified，无正文"]
    G -->|"已变化"| I["200 返回新表示与新 ETag"]
    C -->|"返回新表示"| I
    H -->|"复用本地正文"| J["客户端复用本地正文"]
    I -->|"写入缓存"| K["客户端更新缓存"]
    classDef client fill:#e3f2fd,stroke:#1565c0;
    classDef engine fill:#e8f5e9,stroke:#2e7d32;
    classDef image fill:#fff3e0,stroke:#ef6c00;
    class A,E,J client
    class B,D,F,G,H engine
    class C,I,K image
```

| 指令或头字段 | 作用 | 常见误用 |
|---|---|---|
| `Cache-Control: max-age=3600` | 客户端可复用一小时 | 给 HTML 设长缓存导致发版不生效 |
| `Cache-Control: no-cache` | 可存储，但每次使用前必须校验 | 误以为等于不缓存 |
| `Cache-Control: no-store` | 禁止存储任何副本 | 与 `no-cache` 混用 |
| `Cache-Control: private` | 只允许浏览器缓存 | 把用户数据放进 CDN |
| `Cache-Control: s-maxage` | 覆盖共享缓存的过期时间 | 忽略 CDN 仍按旧值缓存 |
| `ETag` / `If-None-Match` | 按表示内容做条件请求 | ETag 每次请求都随机生成 |
| `Last-Modified` / `If-Modified-Since` | 按修改时间做条件请求 | 时间精度只到秒，短时间多次修改会漏 |
| `Vary` | 声明缓存键随请求头变化 | 漏写 `Origin` 导致跨源响应串用 |

静态资源通常采用“文件名带内容哈希 + 长缓存”的策略，例如 `app.7c9e1a.js` 配 `Cache-Control: public, max-age=31536000, immutable`。文件内容一变，文件名就变，浏览器自然请求新地址。HTML 入口不能长缓存，否则用户会一直引用旧的文件名。

```bash
# ========== 观察协商缓存 ==========
# 第一次请求，记录响应中的 ETag
curl -sS -D - -o /dev/null https://example.com/

# 把上一步响应中的 ETag 原样填入变量后再请求
ETAG='<上一步响应中的 ETag>'
curl -sS -D - -o /dev/null \
  -H "If-None-Match: $ETAG" \
  https://example.com/
```

### 4.3 无状态、Cookie 与令牌

HTTP 不记忆上一次请求，登录态必须由客户端在每次请求中携带。两种主流方式各有代价：

| 方式 | 存放位置 | 撤销能力 | 跨域表现 |
|---|---|---|---|
| 服务端 Session | 内存、Redis 或数据库 | 强，删除即失效 | 依赖 Cookie 的域与 `SameSite` |
| 自包含令牌 | JWT 等，客户端保存 | 弱，需短过期或黑名单 | 可放 `Authorization` 头 |
| 浏览器 Cookie | 浏览器按域自动携带 | 服务端可清 Cookie | 受 `SameSite`、`Secure` 约束 |

JWT 更适合服务间调用、第三方 API 和不需要服务端会话的网关；同源 Web 会话优先使用 `HttpOnly` Cookie，减少脚本读取令牌的机会。选择哪种方式取决于撤销需求、跨域范围和客户端类型，不存在一律适用的默认答案。

Cookie 的安全属性必须成组使用：

```http
Set-Cookie: session=abc123; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600
```

- `HttpOnly` 让脚本读不到 Cookie，降低 XSS 窃取会话的概率。
- `Secure` 限制只在 HTTPS 上发送，明文 HTTP 下浏览器不会带上它。
- `SameSite=Lax` 限制跨站子请求携带，降低 CSRF 风险；`Strict` 更严，但从外部链接进入时会丢失登录态；`None` 必须同时加 `Secure`。
- `Domain` 不写时默认只作用于当前主机，写了会把 Cookie 扩大到子域，范围越大泄露面越大。
- `Path` 只控制发送路径，不是安全边界，不能靠它隔离权限。

> **安全警告**：把 JWT 放进 `localStorage` 意味着任何 XSS 都能读走令牌，且服务端无法主动撤销未过期的令牌。同源 Web 应用优先使用 `HttpOnly + Secure + SameSite` 的 Cookie；必须用 Bearer 令牌时，缩短有效期并配合刷新令牌与撤销名单。

### 4.4 同源策略与 CORS

同源指协议、主机、端口三者完全一致。`https://app.example.com` 与 `https://api.example.com` 主机不同，属于跨源；`http://` 与 `https://` 也不同源。浏览器默认阻止脚本读取跨源响应，CORS 是一套由响应头组成的放行机制。

跨源请求分两类。简单请求直接发出，浏览器检查响应头；非简单请求先发 `OPTIONS` 预检，预检通过后才发实际请求。简单请求需同时满足：方法是 `GET`、`HEAD` 或 `POST`；只使用安全列表内的头；`Content-Type` 限于 `application/x-www-form-urlencoded`、`multipart/form-data`、`text/plain`。

```mermaid
sequenceDiagram
    participant B as 浏览器
    participant S as 服务端
    B->>S: OPTIONS /api/orders + Origin + Access-Control-Request-Method
    S-->>B: 204 + Allow-Origin + Allow-Methods + Allow-Headers
    Note over B: 预检通过，进入实际请求
    B->>S: POST /api/orders + Origin + JSON
    S-->>B: 201 + Allow-Origin + Allow-Credentials
    Note over B: 浏览器校验响应头后交给前端代码
```

| 响应头 | 作用 | 注意 |
|---|---|---|
| `Access-Control-Allow-Origin` | 允许的来源 | 带凭据时必须是具体源，不能为 `*` |
| `Access-Control-Allow-Methods` | 预检允许的方法 | 只影响预检，不替代服务端鉴权 |
| `Access-Control-Allow-Headers` | 预检允许的请求头 | 自定义头必须逐项列出 |
| `Access-Control-Allow-Credentials` | 允许携带 Cookie | 为 `true` 时来源必须精确匹配 |
| `Access-Control-Max-Age` | 预检结果缓存秒数 | 过长会让权限变更延迟生效 |
| `Access-Control-Expose-Headers` | 允许前端读取的响应头 | 默认只能读少数安全头 |

> **安全警告**：CORS 是浏览器的读取限制，不是服务端访问控制。`curl`、服务端脚本和攻击者都能直接请求接口，真正的权限校验必须在服务端完成。不要为了省事把 `Origin` 原样反射并同时允许凭据，这等同于对所有站点开放登录态接口。

常见误判是“浏览器报 CORS，所以接口不通”。实际上简单请求可能已经到达服务端并写入了数据，只是浏览器拒绝把响应交给前端。判断方法是看 Network 面板里请求是否发出、状态码是多少，再用 `curl` 直连对比。

---

## 五、REST 接口的设计取舍

### 5.1 资源建模与方法选择

REST 用名词表示资源，用方法表示动作。路径层级表达从属关系，查询参数表达过滤、排序和分页。

| 端点 | 方法 | 语义 |
|---|---|---|
| `/orders` | `GET` | 列出订单，支持过滤与分页 |
| `/orders` | `POST` | 创建订单 |
| `/orders/{id}` | `GET` | 读取单笔订单 |
| `/orders/{id}` | `PATCH` | 修改收货地址等可变字段 |
| `/orders/{id}` | `DELETE` | 删除或作废订单 |
| `/orders/{id}/cancel` | `POST` | 取消订单，带前置条件与审计 |
| `/orders/{id}/items` | `GET` | 读取订单明细 |

取消、支付、退款这类动作有独立的前置条件、副作用和审计要求，硬套 `PATCH status` 会把状态机塞进一个字段，鉴权与日志都难做。用子资源端点表达动作更清楚，但它不再是纯资源风格，需要在契约中明确说明。

> **注意**：路径中不要出现动词堆叠，如 `/getOrderById`、`/createOrder`。资源名用复数名词和小写短横线，嵌套层级控制在两层以内，更深的从属关系用查询参数或独立资源表达。

### 5.2 错误响应与状态码

错误响应要同时服务三类读者：人看说明，程序看稳定错误码，运维看请求 ID。RFC 9457 定义的 `application/problem+json` 提供了通用骨架：

```json
{
  "type": "https://example.com/problems/invalid-cursor",
  "title": "Invalid cursor",
  "status": 400,
  "detail": "cursor is not a valid opaque token",
  "instance": "/orders",
  "code": "INVALID_CURSOR",
  "request_id": "01J8Z9K3Q7"
}
```

| 字段 | 读者 | 要求 |
|---|---|---|
| `type` | 开发者 | 指向问题说明的稳定 URI |
| `title` | 人 | 简短、可读、不随实例变化 |
| `status` | 程序 | 与 HTTP 状态码一致 |
| `detail` | 人 | 针对本次请求的具体描述 |
| `code` | 程序 | 稳定枚举，不随文案调整 |
| `request_id` | 运维 | 能关联到服务端日志 |

不要返回 `200` 加 `{"success":false}`。这会让网关、监控、缓存和客户端库都误判成功，重试策略也失去依据。字段级校验错误可在 `errors` 数组中给出 `field`、`code`、`message`，但顶层仍使用对应的 `4xx` 状态码。

### 5.3 分页、幂等与版本

| 方案 | 写法 | 优点 | 缺点 |
|---|---|---|---|
| 偏移分页 | `?page=3&size=20` | 可跳页，实现简单 | 深翻页慢，插入删除会错位 |
| 游标分页 | `?cursor=eyJpZCI6MTIzfQ&limit=20` | 翻页稳定，适合大数据量 | 不能随机跳页 |
| 键集分页 | `?after_id=123&limit=20` | 查询高效，顺序稳定 | 需要唯一且可排序的键 |

游标应不透明，内部可以编码 `(created_at, id)` 这样的复合排序键。只按时间排序时，同一毫秒的多条记录顺序不稳定，翻页会重复或遗漏；加上唯一键做次级排序才能保证全序。

写操作的幂等靠客户端生成 `Idempotency-Key`，服务端以 `(调用方, key)` 建唯一约束，首次执行后保存结果，重复请求返回同一结果。键要有有效期，失败结果是否缓存要按业务决定，不能把临时故障永久固化。

并发更新用 `ETag` 配合 `If-Match`：读取时拿到版本标识，提交时带上，服务端比对不一致就返回 `412`，避免后写覆盖先写。版本策略则决定破坏性变更如何交付：

| 策略 | 示例 | 优点 | 缺点 |
|---|---|---|---|
| 路径版本 | `/v1/orders` | 直观，网关与日志易识别 | URL 变长，资源标识不稳定 |
| 请求头版本 | `Accept-Version: 1` | URL 干净 | 调试与缓存不便 |
| 媒体类型版本 | `Accept: application/vnd.example.v1+json` | 语义最严谨 | 客户端与工具支持成本高 |

### 5.4 REST 的适用边界

| 形态 | 数据特征 | 实时性 | 适用场景 |
|---|---|---|---|
| REST | 资源快照，请求响应 | 客户端主动拉取 | 通用业务接口、开放平台 |
| GraphQL | 客户端声明字段 | 查询式 | 多端字段差异大、聚合多个来源 |
| gRPC | 强类型二进制消息 | 支持流式 | 内部服务调用、低延迟高吞吐 |
| WebSocket | 双向帧 | 长连接实时 | 聊天、协作、交易推送 |
| SSE | 服务端单向文本流 | 长连接实时 | 通知、进度、行情 |

REST 的优势在通用、可缓存、易调试，代价是多次往返和字段冗余。字段需求由客户端决定、且前端变化频繁时，GraphQL 能减少接口数量；内部服务之间追求吞吐和强类型时，gRPC 更合适。不要为了“统一”把实时推送硬做成轮询，也不要为了“先进”把简单查询改成 GraphQL。

---

## 六、完整示例：订单接口的端到端验证

### 6.1 服务端实现

示例只依赖 Node 内置模块，覆盖列表、创建、详情、条件请求、幂等重放和 CORS 预检。

| 端点 | 方法 | 关键行为 |
|---|---|---|
| `/api/orders` | `GET` | 游标分页，返回 `ETag`，支持 `If-None-Match` |
| `/api/orders` | `POST` | 校验 JSON，要求 `Idempotency-Key`，重复键返回原结果 |
| `/api/orders/{id}` | `GET` | 返回单笔订单，不存在时返回 `404` |
| `/api/orders` | `OPTIONS` | 返回 CORS 预检头，状态码 `204` |

```js
// /tmp/http-demo/server.js
const http = require("node:http");
const { randomUUID } = require("node:crypto");

const orders = new Map();
const idempotency = new Map();
let nextId = 1001;

const ALLOW_ORIGIN = "http://127.0.0.1:5173";

function corsHeaders(origin) {
  if (origin !== ALLOW_ORIGIN) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,idempotency-key,if-none-match",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

function send(res, status, body, headers = {}) {
  const payload = body === null ? null : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
    ...headers,
  });
  res.end(payload);
}

function problem(res, status, code, detail, reqId) {
  send(res, status, {
    type: `https://example.com/problems/${code.toLowerCase()}`,
    title: code,
    status,
    detail,
    code,
    request_id: reqId,
  }, { "Content-Type": "application/problem+json" });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 65536) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); }
      catch { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const reqId = randomUUID();
  const url = new URL(req.url, "http://127.0.0.1");
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/api/orders") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
    const offset = Math.max(Number(url.searchParams.get("cursor")) || 0, 0);
    const all = [...orders.values()];
    const items = all.slice(offset, offset + limit);
    const next = offset + limit < all.length ? String(offset + limit) : null;
    const etag = `W/"${all.length}-${items.at(-1)?.id ?? "none"}"`;
    const headers = { ...cors, ETag: etag, "Cache-Control": "no-store" };

    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    return send(res, 200, { items, next_cursor: next }, headers);
  }

  if (req.method === "POST" && url.pathname === "/api/orders") {
    const key = req.headers["idempotency-key"];
    if (!key || String(key).length < 8) {
      return problem(res, 400, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key is required", reqId);
    }
    if (idempotency.has(key)) {
      const saved = idempotency.get(key);
      return send(res, saved.status, saved.body, { ...cors, ...saved.headers, "Idempotent-Replayed": "true" });
    }

    let body;
    try { body = await readJson(req); }
    catch { return problem(res, 400, "INVALID_JSON", "request body is not valid JSON", reqId); }

    if (!Array.isArray(body.items) || body.items.length === 0) {
      return problem(res, 422, "EMPTY_ITEMS", "items must contain at least one entry", reqId);
    }

    const id = `A${nextId++}`;
    const order = {
      id,
      status: "pending",
      total_cents: body.items.reduce((sum, item) => sum + (item.quantity || 0) * 100, 0),
      created_at: new Date().toISOString(),
    };
    orders.set(id, order);

    const headers = { ...cors, Location: `/api/orders/${id}` };
    idempotency.set(key, { status: 201, body: order, headers });
    return send(res, 201, order, headers);
  }

  const match = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (req.method === "GET" && match) {
    const order = orders.get(match[1]);
    if (!order) return problem(res, 404, "ORDER_NOT_FOUND", "order does not exist", reqId);
    return send(res, 200, order, { ...cors, "Cache-Control": "no-store" });
  }

  return problem(res, 404, "ROUTE_NOT_FOUND", "no route matches this path", reqId);
});

server.listen(8080, "127.0.0.1", () => {
  console.log("listen http://127.0.0.1:8080");
});
```

示例把订单存在内存里，进程重启即丢失；生产环境要换成数据库，并把幂等键建成唯一索引。`Idempotent-Replayed` 是示例自定义的响应头，用来说明本次结果来自重放，不属于 HTTP 标准。

运行示例时重点观察三处：创建响应的 `Location` 是否指向新资源；重放请求的响应体与首次是否完全一致；列表请求带 `If-None-Match` 后是否只返回头而不返回正文。三处都符合，说明状态码、幂等与条件请求形成了闭环。

### 6.2 调用与验证

```bash
# ========== 启动服务 ==========
node /tmp/http-demo/server.js

# ========== 创建订单 ==========
# 同一个 Idempotency-Key 连续提交两次，观察结果是否一致
curl -i -X POST http://127.0.0.1:8080/api/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-key-0001' \
  -d '{"items":[{"sku":"A-100","quantity":2}]}'

curl -i -X POST http://127.0.0.1:8080/api/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-key-0001' \
  -d '{"items":[{"sku":"A-100","quantity":2}]}'

# ========== 查询列表 ==========
curl -i 'http://127.0.0.1:8080/api/orders?limit=20'

# ========== 条件请求 ==========
# 用上一步响应里的 ETag 验证 304
curl -i -H 'If-None-Match: W/"1-A1001"' \
  'http://127.0.0.1:8080/api/orders?limit=20'

# ========== 触发业务校验失败 ==========
curl -i -X POST http://127.0.0.1:8080/api/orders \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-key-0002' \
  -d '{"items":[]}'

# ========== 预检请求 ==========
curl -i -X OPTIONS http://127.0.0.1:8080/api/orders \
  -H 'Origin: http://127.0.0.1:5173' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,idempotency-key'
```

第一次创建返回 `201 Created`，带 `Location: /api/orders/A1001`；用同一个键重放返回 `201 Created` 和 `Idempotent-Replayed: true`，订单号不变。列表请求返回 `ETag: W/"1-A1001"`，带上该值再请求得到 `304`。空数组返回 `422` 与 `EMPTY_ITEMS`，预检返回 `204` 和允许的方法、头字段。

### 6.3 网关接入与生产配置

```nginx
# ========== 上游与超时 ==========
upstream order_api {
    server 127.0.0.1:8080;
    keepalive 32;
}

server {
    listen 443 ssl;
    server_name api.example.com;

    # 证书路径按实际环境替换
    ssl_certificate     /etc/nginx/certs/api.crt;
    ssl_certificate_key /etc/nginx/certs/api.key;

    # 请求体上限按业务调整，避免大包打满内存
    client_max_body_size 1m;

    location /api/ {
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Request-ID $request_id;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 连接与读取超时要大于应用的最长处理时间
        proxy_connect_timeout 3s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;

        proxy_pass http://order_api;
    }
}
```

| 指令 | 作用 | 配置不当的后果 |
|---|---|---|
| `client_max_body_size` | 限制请求体大小 | 过小导致正常上传被拒，过大易被大包耗尽内存 |
| `proxy_connect_timeout` | 连接上游的超时 | 上游宕机时请求长时间挂起 |
| `proxy_read_timeout` | 等待上游响应的超时 | 小于应用处理时间会稳定返回 `504` |
| `proxy_set_header Connection ""` | 清空逐跳连接头 | 复用上游长连接时出现连接错乱 |
| `X-Forwarded-Proto` | 告知上游原始协议 | 应用生成的回调地址变成 `http` |

接入网关后，先用 `curl --resolve` 把域名指向网关，重复 6.2 的三组请求；对比直连与经过网关的状态码、响应头和耗时。若直连正常而网关失败，优先查路径重写、请求体上限和超时配置。

> **安全警告**：TLS 通常在网关终止，网关到上游这一段可能是明文。跨主机部署时应继续使用 TLS 或放在可信内网，并禁止在访问日志中记录 `Authorization` 与 Cookie 原文。

---

## 七、常见故障与排查

| 现象 | 最可能原因 | 处理 |
|---|---|---|
| 浏览器报 CORS，`curl` 返回 200 | 响应缺 `Access-Control-Allow-Origin`，或预检未处理 | 看 Network 的 `OPTIONS` 与响应头，补齐来源、方法、头 |
| 带 Cookie 的跨域请求失败 | 来源写成 `*`，或缺 `Allow-Credentials` | 返回具体来源并允许凭据，Cookie 设 `SameSite=None; Secure` |
| `401` 与 `403` 混用 | 未认证写成无权限 | `401` 跳登录并带 `WWW-Authenticate`，`403` 提示申请权限 |
| 刷新后登录失效 | Cookie 的域、路径、`Secure`、`SameSite` 不匹配 | 看 `Set-Cookie` 与请求实际携带的 Cookie |
| `404` 但接口存在 | 路径前缀、尾斜杠、网关 rewrite 不一致 | `curl -i` 直连后端，再对比网关转发规则 |
| `500` | 应用未捕获异常 | 查应用日志与堆栈，不要先改前端 |
| `502` | 网关连不上上游或收到无效响应 | 查上游端口、进程、健康检查与协议版本 |
| `504` | 网关等待上游超时 | 查慢查询、连接池、下游调用与超时配置 |
| 改了代码仍是旧页面 | HTML 被强缓存、Service Worker 或 CDN 缓存 | 查 `Cache-Control`、文件名哈希，禁用缓存复现 |
| `304` 响应却有正文 | 代理或框架错误写入内容 | 确认 `304` 只回头字段，不写响应体 |
| `GET` 带请求体偶发失败 | 代理或缓存不保证转发请求体 | 查询参数放 URL；复杂查询改用 `POST /search` |
| 上传大文件返回 `413` | 网关请求体上限过小 | 调整 `client_max_body_size`，同步应用层限制 |

```mermaid
flowchart TD
    A["请求异常"] -->|"先直连验证"| B{"curl 直连后端是否正常"}
    B -->|"正常"| C["查网关与 CDN<br/>转发规则、超时、缓存"]
    B -->|"异常"| D["看状态码分段"]
    D -->|"4xx"| E["4xx 查请求<br/>参数、认证、权限、路径"]
    D -->|"5xx"| F["5xx 查服务端<br/>日志、上游、数据库"]
    E -->|"对比头字段"| G["对比浏览器与 curl 的头字段"]
    F -->|"串联日志"| H["按请求 ID 串联网关与应用日志"]
    C -->|"核查链路"| I["确认协议、TLS、跨源与缓存头"]
    classDef client fill:#e3f2fd,stroke:#1565c0;
    classDef engine fill:#e8f5e9,stroke:#2e7d32;
    classDef image fill:#fff3e0,stroke:#ef6c00;
    class A,G client
    class B,D,E,F,H engine
    class C,I image
```

排查顺序按“先直连、再看网关、最后怀疑前端”推进：

1. `curl -i` 直连接口，确认服务端本身返回的状态码、头字段与正文。
2. 用 `curl -w` 拆分耗时，判断慢在 DNS、连接、TLS、首字节还是传输。
3. 打开浏览器 Network，核对请求头、响应头、`Origin`、Cookie 与协议版本。
4. 有网关时查访问日志的 `status`、`upstream_status`、`request_time`，区分客户端断开、上游错误与超时。
5. 用响应中的 `request_id` 到应用日志定位具体请求，核对参数与异常堆栈。
6. 最后才检查前端代码、构建产物与缓存，避免把服务端问题误判为页面问题。

> **注意**：排查时不要只看状态码。`200` 也可能是缓存命中或错误的业务响应，`304` 也可能因为 ETag 生成不当而永远不命中。状态码、响应头、响应体三者要一起看。
