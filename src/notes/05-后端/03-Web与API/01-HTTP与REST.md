# HTTP 与 RESTful API 设计

## 一、工程案例：用 curl 定位一个 502：从 DNS、TLS、连接、超时到响应头

**场景**：`https://api.taskhub.example.com/v1/tasks` 在监控上间歇性返回 502，前端偶发「系统繁忙」。链路是云 LB → Nginx（10.0.1.10）→ 容器 `app:8080`（3 个副本）。运维的处理方式是「重启后端」，能好一阵，第二天又出现。

**产出**：一条从客户端到后端的分层定位路径、一份可复用的探针脚本、一张验收表，以及一组让停机不再产生 502 的配置。

**落盘文件**：`deploy/nginx/conf.d/app.conf`、`src/main/resources/application.yml`、`deploy/k8s/deployment.yaml`、`scripts/http-probe.sh`。

**环境**：

| 角色 | 位置 | 版本 |
|---|---|---|
| 客户端 | 本机 macOS | curl 8.x |
| 入口 | `api.taskhub.example.com` | 云 LB + Nginx 1.24 |
| 后端 | `app:8080`，3 副本 | Spring Boot 3.x |

### 1.1 一次带计时的请求：先把「哪一层慢、哪一层错」分开

```bash
curl -sS -o /dev/null -D - \
  -w '\ncode=%{http_code} dns=%{time_namelookup} conn=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n' \
  https://api.taskhub.example.com/v1/tasks
```

```text
HTTP/2 502
server: nginx
date: Wed, 21 Oct 2026 02:14:33 GMT
content-type: text/html
content-length: 157

code=502 dns=0.004 conn=0.021 tls=0.048 ttfb=0.052 total=0.053
```

| 字段 | 读法 | 本例含义 |
|---|---|---|
| `time_namelookup` | 到 DNS 返回 | 4 ms，解析正常 |
| `time_connect` | TCP 握手完成 | 21 ms，443 可达 |
| `time_appconnect` | TLS 握手完成 | 48 ms，证书通过 |
| `time_starttransfer` | 首字节到达 | 52 ms |
| `time_total` | 请求结束 | 53 ms |

三个判读结论：

1. **DNS、TCP、TLS 全部在 50 ms 内完成**，502 不是网络层问题，是应用层问题。
2. **首字节只比 TLS 完成晚 4 ms**，响应不是后端算出来的，是入口自己生成的错误页。
3. `server: nginx` + `content-type: text/html` + 157 字节，是 Nginx 的标准 502 页，不是后端的 JSON 错误体。

### 1.2 DNS：解析结果与绕过解析

502 与 DNS 无关，但「间歇性」必须排除「解析到已下线 IP」这一种可能。

```bash
dig +short api.taskhub.example.com
# 203.0.113.10
# 203.0.113.11

dig +short api.taskhub.example.com @8.8.8.8
# 203.0.113.10
# 203.0.113.11
```

两个 A 记录、本地与公共 DNS 结果一致，说明没有解析漂移。若怀疑某个 IP 有问题，用 `--resolve` 固定解析，绕开 DNS 直接打某一台：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  --resolve api.taskhub.example.com:443:203.0.113.10 \
  https://api.taskhub.example.com/v1/tasks
```

`--resolve` 只改「域名到 IP」这一步，Host 头与 SNI 仍然是原域名，因此能精确验证「是不是某一台入口坏了」。

### 1.3 TLS：握手与证书链

```bash
echo | openssl s_client -connect api.taskhub.example.com:443 \
  -servername api.taskhub.example.com 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

```text
subject=CN = api.taskhub.example.com
issuer=C = US, O = Let's Encrypt, CN = R11
notBefore=Sep 12 00:00:00 2026 GMT
notAfter=Dec 11 23:59:59 2026 GMT
```

证书在有效期内、CN 与访问域名一致、链完整，TLS 层可以排除。`-servername` 不能省：一台 Nginx 上挂多个域名时，不带 SNI 会拿到默认站点的证书，误判成「证书不匹配」。

### 1.4 HTTP 层：响应头里的证据

带上一个自定义请求 ID，再看响应头里有没有它：

```bash
curl -sS -D - -o /dev/null \
  -H 'X-Request-Id: probe-1021' \
  https://api.taskhub.example.com/v1/tasks
```

```text
HTTP/2 502
server: nginx
x-request-id: probe-1021
x-upstream-status: 502
content-type: text/html
```

`x-request-id` 被原样带回，说明请求确实进了 Nginx；`x-upstream-status: 502` 说明 Nginx 认为上游返回了 502。接着去后端日志里搜这个 ID：

```bash
kubectl logs -l app=taskhub --since=10m | grep probe-1021
# 无输出
```

后端没有这条记录，结论收窄为：**请求没有到达应用，或者到达时应用已经在关闭过程中**。

### 1.5 后端：端口、健康检查与 Nginx 错误日志

在 Nginx 主机上确认「能不能连上、连上后多久回」：

```bash
getent ahostsv4 app | awk '{print $1}' | sort -u
# 10.0.3.24
# 10.0.3.25
# 10.0.3.26

# 解析出三个 IP 就逐个直连；只 curl 域名的话每次只会打到其中一台
for ip in $(getent ahostsv4 app | awk '{print $1}' | sort -u); do
  curl -sS -o /dev/null --max-time 2 \
    -w "$ip health=%{http_code} ttfb=%{time_starttransfer}\n" \
    "http://$ip:8080/actuator/health"
done
# 10.0.3.24 health=200 ttfb=0.012
# 10.0.3.25 health=200 ttfb=0.014
# 10.0.3.26 health=200 ttfb=0.011

ss -tnp state established '( dport = :8080 )' | head
#  ESTAB 0 0 10.0.1.10:51234 10.0.3.24:8080
#  ESTAB 0 0 10.0.1.10:51235 10.0.3.24:8080
```

三条副本都健康、端口可达、已有长连接。这时 502 只可能发生在「连接建立之后、响应头返回之前」。Nginx 的 `error.log` 会给出一句精确的短语：

```bash
sudo grep -E 'upstream|502' /var/log/nginx/error.log | tail -5
```

```text
2026/10/21 10:14:33 [error] 812#812: *9931 upstream prematurely closed connection
while reading response header from upstream, client: 203.0.113.7,
request: "GET /v1/tasks HTTP/2.0", upstream: "http://10.0.3.24:8080/v1/tasks"
```

| `error.log` 短语 | 含义 | 下一步 |
|---|---|---|
| `connect() failed (111: Connection refused)` | 端口没人监听 | 查进程、容器端口、`server.port` |
| `upstream prematurely closed connection while reading response header` | 连上了，对端在读响应头前关闭 | 进程退出、崩溃、复用到已关闭的连接 |
| `upstream timed out (110: Connection timed out) while reading response header` | 连上了但迟迟不回 | 线程池满、慢查询、下游阻塞 |
| `no live upstreams` | 所有后端被健康检查摘除 | 健康检查路径与阈值 |
| `SSL_do_handshake() failed` | 回源 TLS 失败 | 回源证书、SNI、协议版本 |

本例落在第二种：`prematurely closed`。它不是超时，也不是拒绝连接，而是「TCP 已建立、对端主动关了」。

### 1.6 根因：滚动发布时被复用的连接

对照发布记录，10:14:28 有一次滚动更新，出问题的 `10.0.3.24` 正是当时正在退出的副本。过程是：

1. Nginx 的 upstream 配了 `keepalive 32`，与 `10.0.3.24:8080` 之间长期保持空闲连接。
2. 副本收到 SIGTERM，Spring Boot 按默认策略立即关闭上下文：Tomcat 停止监听，并关掉包括空闲 keepalive 在内的连接，不等待在途请求。
3. Nginx 从连接池里取出一条「看起来还活着」的连接发请求，写出去后对端已关闭，读响应头时得到 EOF → 502。
4. 重启后端后连接池重建，所以「好一阵」。

三处一起改，缺一处都还会偶发。下面是最终配置，其中请求 ID 与上游状态两行是 1.4 依赖的，必须带 `always`，否则 5xx 响应上不会出现：

```nginx
# deploy/nginx/conf.d/app.conf
# 客户端带了就沿用，没带就由 Nginx 生成，响应头与上游日志用同一个值
map $http_x_request_id $req_id {
    default $http_x_request_id;
    ""      $request_id;
}

upstream app_backend {
    server app:8080;
    keepalive 32;
}

server {
    location /api/ {
        proxy_pass http://app_backend;
        proxy_http_version 1.1;              # keepalive 要求 1.1
        proxy_set_header Connection "";      # 清掉 close，才能复用
        proxy_set_header X-Request-Id $req_id;

        proxy_connect_timeout 2s;
        proxy_send_timeout    10s;
        proxy_read_timeout    10s;

        # error 含连不上、写失败、读响应头失败；timeout 含读写超时。
        # 默认只重试幂等方法，POST 要开 non_idempotent 才会被重试
        proxy_next_upstream error timeout;
        proxy_next_upstream_tries 2;

        add_header X-Request-Id $req_id always;            # 502 时也要带上
        add_header X-Upstream-Status $upstream_status always;
    }
}
```

```yaml
# src/main/resources/application.yml：让进程把在途请求处理完再退出
server:
  shutdown: graceful
spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s
```

```yaml
# deploy/k8s/deployment.yaml：先摘流量，再发 SIGTERM
lifecycle:
  preStop:
    exec:
      command: ["sh", "-c", "sleep 5"]   # 等 Endpoints 摘除传播到入口
terminationGracePeriodSeconds: 40        # 必须大于 preStop + 关闭超时
```

> ⚠️ `proxy_next_upstream` 加 `http_502` 能让「上游明确回了 502」也对用户透明，但它针对的是响应码，不是连接。Nginx 默认不重试 POST 等非幂等方法，一旦有人补了 `non_idempotent`，下单、支付就会被重放，变成重复创建。正确做法是接口本身带幂等键，而不是让网关盲重试。

### 1.7 复现与验证

修复前，用两个终端把 502 打成可观测的比例：一个负责触发滚动发布，另一个在发布窗口内持续打请求。

```bash
# 终端 A：触发滚动发布
kubectl rollout restart deploy/taskhub
```

```bash
# 终端 B：发布期间持续打 300 次，按状态码计数
for i in $(seq 1 300); do
  curl -sS -o /dev/null -w '%{http_code}\n' \
    --max-time 5 https://api.taskhub.example.com/v1/tasks
done | sort | uniq -c
#  287 200
#   13 502
```

改完配置后重复同一过程，同样的 300 次请求应当一个 5xx 都没有：

```bash
# 终端 A
kubectl rollout restart deploy/taskhub

# 终端 B
for i in $(seq 1 300); do
  curl -sS -o /dev/null -w '%{http_code}\n' \
    --max-time 5 https://api.taskhub.example.com/v1/tasks
done | sort | uniq -c
#  300 200
```

仍出现 502 就回到 1.5 对一遍 `error.log` 的短语：`prematurely closed` 说明预停机时间还不够（把 `preStop` 的 `sleep 5` 加大），`timed out` 说明问题在耗时而不是停机。

### 1.8 验收表

| # | 检查项 | 命令或检查 | 通过标准 |
|---|---|---|---|
| 1 | 解析稳定 | `dig +short <域名>` 连查 3 次 | 结果集一致，无已下线 IP |
| 2 | 证书有效 | `openssl s_client -connect <域名>:443 -servername <域名>` | `notAfter` 未过期，CN 匹配 |
| 3 | 入口计时 | `curl -w '%{time_starttransfer}'` | 正常请求 ttfb 小于 200 ms |
| 4 | 请求可追踪 | 响应头含 `x-request-id`，后端日志能搜到 | 两端 ID 一致 |
| 5 | 后端直连 | 逐个 Pod IP `curl http://<ip>:8080/actuator/health` | 200，且 3 个副本都通 |
| 6 | 错误日志无残留 | `grep prematurely /var/log/nginx/error.log` | 滚动发布期间无新增 |
| 7 | 滚动发布零 502 | 发布期间 300 次请求统计 | 无 5xx |
| 8 | 超时配置合理 | `nginx -T` 查看 `proxy_read_timeout` | 大于上游 P99 耗时，且小于客户端超时 |
| 9 | 优雅停机生效 | 发布时观察日志 `Commencing graceful shutdown` | 在途请求完成后再退出 |

### 1.9 固化成脚本

```bash
#!/usr/bin/env bash
# scripts/http-probe.sh <url>：四层探针，把「哪一层坏了」一次说清
# 依赖：dig、nc、openssl、curl、grep
set -uo pipefail
url="${1:?用法: http-probe.sh https://host/path}"
scheme="${url%%://*}"
authority="${url#*://}"; authority="${authority%%/*}"
host="${authority%%:*}"; port="${authority##*:}"
[[ "$port" == "$authority" ]] && port=$([[ "$scheme" == https ]] && echo 443 || echo 80)

echo "① DNS"
dig +short "$host" | sed 's/^/   /'
dig +short "$host" | grep -q . || { echo "   没有解析结果，停在这一层"; exit 1; }

echo "② TCP"
nc -z -w 2 "$host" "$port" || { echo "   ${host}:${port} 不通，停在这一层"; exit 1; }
echo "   ${host}:${port} open"

echo "③ TLS"
if [[ "$scheme" == https ]]; then
  tls=$(echo | openssl s_client -connect "${host}:${port}" -servername "$host" 2>/dev/null)
  echo "$tls" | openssl x509 -noout -subject -dates 2>/dev/null | sed 's/^/   /'
  grep -q 'Verify return code: 0' <<<"$tls" || echo "   证书校验未通过，看上面的 subject/dates"
else
  echo "   跳过（非 https）"
fi

echo "④ HTTP"
curl -sS -o /dev/null -D /tmp/probe.h -w '   code=%{http_code} ttfb=%{time_starttransfer}s\n' "$url"
grep -iE '^(server|x-request-id|x-upstream-status|location|cache-control):' /tmp/probe.h | sed 's/^/   /' || true
```

四层里任何一层失败就停在那层，不要跳过去猜下一层。

---

## 二、高频问答：会卡住你的地方，也是面试最常问的

### 2.1 502 与 504 混为一谈，一律重启后端

**现场**

`curl -w '%{http_code} %{time_starttransfer}'`；Nginx `error.log` 里 `prematurely closed` 与 `timed out` 是两条不同分支。

**要点**

- 502 是上游返回了非法响应或连接被提前关闭；504 是上游在超时时间内没回，一个查"进程与连接"，一个查"耗时与容量"。
- 重启只能治"进程已经坏了"，治不了"连接池里握着已关闭的连接"和"线程池被慢查询占满"，所以总是好一阵又犯。
- 核实靠两个证据对齐：入口的 ttfb 是否接近超时阈值，加 Nginx 错误日志的具体短语。

**追问**

- 两种错分别该盯哪句日志？→ `prematurely closed`/`connect() failed` 查进程与连接，`upstream timed out` 查耗时与容量。
- 为什么重启能好一阵？→ 连接池重建，旧连接被换掉，触发条件还在（见 1.6）。
- 网关要不要对 502 重试？→ 默认只重试幂等方法；给 POST 开 `non_idempotent` 会把下单重放。

### 2.2 POST 后端收不到参数，或者直接 400

**现场**

`curl -v` 看实际发出的 `Content-Type`；后端日志里看原始 body。

```bash
# 声明什么就必须发什么
curl -X POST http://localhost:8080/v1/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"写周报"}'
```

**要点**

- 先看 `Content-Type` 和请求体格式是否一致，不要逐个字段对名字。
- 声明 `application/json` 却发 `a=1&b=2`（或反过来），框架的绑定器直接放弃解析，整个对象是 `null`。
- 字段名错通常报的是"字段校验失败"，而不是"参数为空"。

**追问**

- 什么时候报 415？→ 服务端不支持这个媒体类型，比 400 更明确。
- 表单和 JSON 能同时支持吗？→ 能，但要按 `Content-Type` 分派解析器，别混着猜。
- 怎么快速排除前端问题？→ 同一份 body 用 `curl` 发一遍，能通就是前端构造的问题。

### 2.3 前端报 CORS，后端日志里没有 OPTIONS 记录

**现场**

浏览器 Network 面板看 OPTIONS 的状态码；Nginx access log 里搜 `OPTIONS`。

```bash
curl -i -X OPTIONS http://localhost:8080/v1/tasks \
  -H 'Origin: https://app.example.com' \
  -H 'Access-Control-Request-Method: POST'
# 期望 204 且带 Access-Control-Allow-*；返回 401 就是安全链在拦
```

**要点**

- 预检在到达业务代码之前就被拦了（安全框架 401、网关 403、路由不匹配 404），跨域头根本没机会加。
- 预检被拦时浏览器不会发真实请求，只给真实响应加头等于没加。
- 顺序是先看 OPTIONS 有没有 2xx，再看头对不对。

**追问**

- 哪些请求会触发预检？→ 非简单方法、带自定义请求头（含 `Authorization`）、`Content-Type` 不是三种表单类型。
- 带 Cookie 为什么不能用 `*`？→ `Allow-Origin: *` 与 `Allow-Credentials: true` 不能共存，要回显具体 Origin。
- CORS 能当安全边界吗？→ 不能，`curl` 和 Postman 完全不受约束。

### 2.4 401 与 403 混用，前端登录死循环

**现场**

看响应是否带 `WWW-Authenticate`（401 规范要求带）；看 token 是否被服务端成功解析。

**要点**

- 401 是"身份未确认"，403 是"身份已确认但无权"。
- 把 403 当 401 处理，用户会反复登录却始终进不去；401 要求重新认证，403 要求不要再试。
- 用同一个 token 调一个已知有权限的接口，能通就说明是 403 而不是登录失效。

**追问**

- 前端拦截器最常见的错是什么？→ 对 403 也清 token 跳登录，一个权限配置错误就变成全员掉线。
- 403 该给用户看什么？→ 无权限提示，别给登录入口。
- 401 必须带什么头？→ `WWW-Authenticate`。

### 2.5 重复 DELETE 返回 404，被当成故障触发重试

**现场**

连续删两次，看第一次 204、第二次 404，且数据库里确实没有该行。

**要点**

- 第二次删除 404 是**正确**结果，不是故障。
- 幂等的定义是"服务端状态不变"，不是"每次返回同一个码"；看的是副作用次数。
- 想统一客户端行为，可以让"删除不存在的 ID"也返回 204。

**追问**

- 为什么 PUT 和 DELETE 天然幂等？→ 结果由目标状态决定，重复执行不叠加。
- POST 怎么做到可重试？→ 幂等键加唯一索引（见 3.16）。
- 404 被当故障会怎样？→ 触发无意义重试，可能放大成告警风暴。

### 2.6 静态资源改了不生效，用户看到旧页面

**现场**

DevTools 的 Size 列显示 `(disk cache)` 就是没发请求；`curl -I` 看 `cache-control` 与 `age`。

**要点**

- 部署成功与用户拿到新文件是两件事。
- 强缓存还在有效期内：`Cache-Control: max-age=31536000` 的 JS，浏览器一年内根本不会回源。
- 正确做法是文件名带内容 hash，HTML 入口用 `no-cache`。

**追问**

- 为什么 HTML 不能也设长缓存？→ 它引用带 hash 的文件名，入口被缓存住就换不了引用。
- `no-cache` 和 `no-store` 区别？→ `no-cache` 可以存但每次用前要验证，`no-store` 完全不存。
- 已经发出去的长缓存怎么救？→ 换文件名或 URL，改响应头对已缓存的副本无效。

### 2.7 带鉴权的响应被 CDN 缓存，用户看到别人的数据

**现场**

响应头有 `x-cache: HIT` 且 `cache-control` 是 `public`；换个账号请求同一 URL 拿到相同内容。

**要点**

- 只盯应用层会漏掉中间缓存，这类串号一旦发生就是数据泄露。
- 接口响应没有 `private` / `no-store`，CDN 或反向代理按 URL 缓存，把 A 用户的响应给了 B。
- 修复时个性化接口至少加 `private`，敏感响应再加 `no-store`（取舍见 3.10），并在网关层禁止缓存带 `Authorization` 的请求。

**追问**

- 加 `Vary: Authorization` 能替代 `private` 吗？→ 不能，很多 CDN 默认不按 `Authorization` 分键，实现也不一致。
- 怎么复现？→ 同一 URL 带不同 token 请求两次，比对响应体与 `age` 头。
- 为什么说它低频但致命？→ 平时监控看不到错，发现时数据已经流出去了。

### 2.8 下单接口重试，产生两笔订单

**现场**

查订单表同一用户同一商品的创建时间是否在 1 秒内出现两条。

```bash
curl -X POST https://api.example.com/v1/orders \
  -H 'Idempotency-Key: 9f1c2e7a-4b3d-4f8e-9a10-2c6d5e8f7a01' \
  -H 'Content-Type: application/json' \
  -d '{"sku":"A-100","qty":1}'
```

**要点**

- POST 不幂等；超时只代表"客户端没收到响应"，不代表"服务端没执行"。
- 重试的前提是重复执行不会带来额外副作用。
- 修法是客户端生成唯一键，服务端对键加唯一索引，重复请求直接返回首次结果；这也是网关层不能盲目对 POST 做 `proxy_next_upstream` 的原因。

**追问**

- 幂等键该由谁生成？→ 客户端，服务端生成无法区分重试。
- 同一个键配不同请求体怎么办？→ 拒绝，键要和请求体绑定。
- 键要保留多久？→ 一般 24 小时，过期后允许复用。

### 2.9 token 放在 URL 查询串里

**现场**

在 Nginx access log 里 grep `token=`，能搜到就是泄露面。

**要点**

- URL 会进 access log、浏览器历史、`Referer`、监控与埋点，等于把凭证写进了一堆日志。
- 根因是只考虑了"能不能用"，没考虑"会被谁看到"。
- 正确位置是 `Authorization: Bearer <token>`。

**追问**

- 为什么 `Referer` 会把 URL 带出去？→ 页面里点外链时，当前 URL 会作为 `Referer` 发给对方。
- 已经泄露了怎么办？→ 立刻轮换 token，再调整日志保留策略。
- WebSocket 不能带自定义头怎么办？→ 见 WebSocket 3.9 的四种替代位置。

### 2.10 PUT 当 PATCH 用，没传的字段被清空

**现场**

改一个字段后查详情，看其他字段是否变成 `null` 或默认值。

**要点**

- PUT 的语义是"整体替换"，未提供的字段按缺省处理；局部更新要用 PATCH。
- 把 PUT 当成"字段更多的 POST"是这条的根因。
- 实现上要么严格校验全量字段，要么改用 PATCH。

**追问**

- PATCH 一定幂等吗？→ 看补丁形式，整体赋值幂等，`+1` 或追加数组元素不幂等。
- 前端只提交改动字段该用哪个？→ PATCH。
- 为什么有些框架的 PUT 表现得像 PATCH？→ 绑定器只覆盖非空字段，属于实现偏离规范。

### 2.11 分页 total 与实际条数对不上，深分页越来越慢

**现场**

连续请求第 1、2、3 页，看是否有重复 id；`EXPLAIN` 看是否走覆盖索引。

**要点**

- 翻页期间有数据增删，`offset` 分页的窗口在移动，`total` 和实际条数对不上是正常的。
- 深分页时 `offset 100000` 要扫描并丢弃十万行，加索引只让"丢弃"便宜一点。
- 修法是按 `(created_at, id)` 排序输出游标，并给 `size` 设上限，避免 `size=1000000`。

**追问**

- 游标分页的代价？→ 不能跳页，且要求排序列唯一且稳定。
- 为什么 `total` 会变？→ 它和列表是两条 SQL，中间的数据变动不会落在同一快照里。
- 为什么"快照"这个假设不成立？→ 分页是多次请求，每次都是新的读视图。

### 2.12 用 301 做临时跳转，改完前端还在旧地址

**现场**

`curl -sSI <url>` 看状态码与 `Location`；DevTools 勾 Preserve log，看请求是否直接命中缓存的 301；用 `-L -v` 看第二跳用的是哪个方法。

```bash
# 用 -d 而不是 -X POST：这样才会走标准的「跟随重定向」行为
curl -sS -o /dev/null -L -v -d '{"title":"x"}' \
  -H 'Content-Type: application/json' \
  https://api.example.com/v1/old-tasks 2>&1 | grep -E '^> (POST|GET) '
```

**要点**

- 301 是永久重定向，浏览器会长期缓存这条规则，不依赖 `Cache-Control`。
- 301/302 允许客户端把 POST 改成 GET，提交会被悄悄降级；要保方法用 307/308。
- 临时换路径、换域名一律先发 302/307，只有确定永久迁移才用 301/308；已经发出去的 301 只能靠清缓存或换 URL 收场（几个码的差别见 3.4）。

**追问**

- 303 和 307 区别？→ 303 明确要求改用 GET 看结果，307 保持原方法和请求体。
- 为什么 `curl -X POST` 测不出降级？→ `-X` 强制方法，要测标准跟随行为得用 `-d`。
- 301 缓存能清吗？→ 用户侧清不掉，只能换 URL 或等缓存过期。

---

## 三、核心知识：从零开始要建立的东西

### 3.1 一次请求的四个阶段

```mermaid
flowchart LR
    classDef client fill:#DBEAFE,stroke:#2563EB,color:#1E3A8A
    classDef service fill:#DCFCE7,stroke:#16A34A,color:#14532D
    classDef data fill:#FEF3C7,stroke:#D97706,color:#78350F
    classDef normal fill:#F1F5F9,stroke:#64748B,color:#334155

    A["输入域名"]:::client --> B["DNS 解析"]:::service
    B --> C["TCP 连接"]:::service
    C --> D["TLS 握手"]:::data
    D --> E["HTTP 报文"]:::data
    E --> F["状态码与响应头"]:::normal
    linkStyle default stroke:#94A3B8,stroke-width:1.5px
```

| 阶段 | 解决什么 | 失败时的典型表现 |
|---|---|---|
| DNS | 域名换 IP | `Could not resolve host` |
| TCP | 找到进程并建立可靠通道 | `Connection refused` / `Connection timed out` |
| TLS | 加密与身份验证 | 证书过期、域名不匹配、协议版本不支持 |
| HTTP | 表达「要什么、结果如何」 | 4xx / 5xx、响应体不符合预期 |

分层排查的意义在于：**每一层的错误信息不同，不要用上一层的猜测去解释下一层的现象**。502 出现在 HTTP 层，就不该去改 DNS。

### 3.2 报文结构

请求由四段组成：起始行、字段行、空行、内容。

```http
POST /v1/tasks?dryRun=true HTTP/1.1
Host: api.example.com
Content-Type: application/json
Content-Length: 38
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...

{"title":"写周报","priority":"high"}
```

- **起始行**：方法、请求目标、版本，用空格分隔。请求目标通常是「路径 + 查询串」，代理场景下可能是绝对形式。
- **字段行**：`名字: 值`，名字大小写不敏感，值里可以有空格。
- **空行**：固定分隔符，不可省略。没有它，后面的内容会被当成字段继续解析。
- **内容**：长度由 `Content-Length` 或 `Transfer-Encoding: chunked` 界定，二者不能同时出现。

响应把起始行换成状态行：版本、状态码、原因短语。**原因短语只给人看**，程序判断一律用状态码；它可以被任意改写而不影响语义。

### 3.3 方法与两个正交属性

| 方法 | 安全 | 幂等 | 语义 |
|---|---|---|---|
| GET | 是 | 是 | 取资源，可有缓存 |
| HEAD | 是 | 是 | 只要响应头 |
| OPTIONS | 是 | 是 | 询问能力，预检用 |
| POST | 否 | 否 | 新建、提交、执行动作 |
| PUT | 否 | 是 | 整体替换目标资源 |
| PATCH | 否 | 通常否 | 局部修改 |
| DELETE | 否 | 是 | 删除目标资源 |

两个属性互相独立：

- **安全**：这个方法的语义不要求服务端改变资源状态。GET 会被爬虫、预取、缓存随意调用，所以不能有副作用（日志、计数这类副作用不可避免，但资源表示不能变）。
- **幂等**：执行一次与执行 N 次，最终状态是否相同。`DELETE /tasks/1` 第二次返回 404，但服务端状态仍是「不存在」，所以幂等。

`PATCH` 的幂等性取决于补丁形式：整体赋值的 JSON Merge Patch 可以幂等，带 `+1`、追加数组元素的补丁则不幂等。接口文档里要写清用的是哪一种。

> **面试**：常问「安全和幂等的区别？DELETE 第二次返回 404 还算幂等吗？」答：安全是不改资源，幂等是重复执行结果相同；404 只说明记录已不存在，服务端状态没变，仍算幂等。

### 3.4 状态码的分区与选择

| 区间 | 含义 | 常用码与场景 |
|---|---|---|
| 1xx | 信息性 | 101 协议升级、100 继续发送 |
| 2xx | 成功 | 200 查询/更新、201 创建、202 异步受理、204 无内容 |
| 3xx | 重定向与缓存复用 | 301/308 永久、302/307 临时（307/308 保持方法与请求体）、303 改看结果、304 未修改 |
| 4xx | 客户端问题 | 400 语法、401 未认证、403 无权限、404 不存在、405 方法不允许、409 冲突、412 前置条件失败、415 媒体类型不支持、422 语义校验、429 限流 |
| 5xx | 服务端问题 | 500 未捕获异常、502 上游非法响应、503 暂不可用、504 上游超时 |

几条容易混的边界：

- **400 与 422**：400 是「报文本身坏了」（JSON 语法错、类型不对），422 是「报文合法但业务规则不允许」（年龄填 -5）。
- **401 与 403**：401 必须带 `WWW-Authenticate`，语义是「重新认证」；403 是「认证过了，但不许」。
- **404 与 405**：路径存在但方法不支持是 405，且响应必须带 `Allow` 头。
- **301/302 与 307/308**：只有 307/308 保证第二跳仍是原方法与请求体；301/302 允许客户端把 POST 降级成 GET，`303` 则明确要求改用 GET 去看结果。
- **304 不是重定向**：它只出现在带验证器的条件请求里，没有响应体。
- **500 与 502/504**：500 是应用自己抛的；502/504 是网关对上游的判断，应用日志里往往什么都没有。

> **面试**：常问「401 和 403、502 和 504 分别怎么区分？」答：401 要重新认证（必须带 `WWW-Authenticate`）、403 是无权；502 是上游非法响应或连接早关，504 是上游超时。

### 3.5 表示、媒体类型与内容协商

HTTP 传的不是「对象」，是对象的**表示**（representation）。同一个任务可以是 JSON、XML、CSV，靠媒体类型区分。

| 头 | 方向 | 作用 |
|---|---|---|
| `Content-Type` | 发送方 | 我这份内容是什么格式 |
| `Accept` | 请求方 | 我希望收到什么格式，可带 `q` 权重 |
| `Content-Encoding` | 发送方 | 内容用了什么压缩（gzip、br） |
| `Accept-Encoding` | 请求方 | 我能解哪些压缩 |

协商失败的两个码：请求体的类型服务端不支持 → 415；`Accept` 里的类型一个都给不了 → 406。`charset` 只对文本类型有意义，JSON 按规范一律 UTF-8。

### 3.6 连接复用与协议版本

| 维度 | HTTP/1.1 | HTTP/2 | HTTP/3 |
|---|---|---|---|
| 传输层 | TCP | TCP | QUIC（UDP） |
| 并发 | 每连接一个请求，浏览器开 6 条 | 单连接多路复用 | 单连接多路复用 |
| 队头阻塞 | 应用层存在 | TCP 丢包时仍存在 | 只影响单个流 |
| 头部压缩 | 无 | HPACK | QPACK |
| 建连 | TCP + TLS 两轮 | TCP + TLS 两轮 | 合并握手，支持 0-RTT |

`Connection: keep-alive` 在 HTTP/1.1 里是默认行为，写不写都一样；真正要显式配的是**反向代理到上游**的那一段：`proxy_http_version 1.1` 加 `proxy_set_header Connection ""`，否则连接池形同虚设。HTTP/2 时代，域名分片、雪碧图这些 HTTP/1.1 的优化手段多半变成负优化。

### 3.7 TLS 握手与证书校验

TLS 解决三件事：机密性（对称加密）、完整性（AEAD）、身份（证书链）。

| 加密 | 速度 | 用在哪 |
|---|---|---|
| 对称（AES-GCM、ChaCha20） | 快 | 握手之后的全部数据 |
| 非对称（ECDHE、RSA） | 慢 | 握手阶段协商出对称密钥 |

TLS 1.3 把握手压到一轮往返，并且默认只允许前向安全的密钥交换。排查证书问题看三样：**有效期、域名匹配（含 SNI）、链是否完整**。自签证书在浏览器报错、在 `curl` 报 `certificate verify failed`，都属于同一类问题，与接口逻辑无关。

`HSTS` 让浏览器在指定时间内强制走 HTTPS，配置错（比如给还没上 HTTPS 的域名加）会把站点锁死，上线前要确认全站可用。

### 3.8 无状态、Cookie 与令牌

HTTP 本身无状态，服务端不记得上一个请求是谁。维持会话有两种载体：

| | Cookie + Session | Bearer Token |
|---|---|---|
| 状态存哪 | 服务端（内存、Redis） | 令牌自包含 |
| 谁自动携带 | 浏览器同域自动带 | 前端代码手动加头 |
| 跨站调用 | 需要 `SameSite=None` + `Secure` + CORS | 放请求头即可 |
| 主动失效 | 删 session 立即生效 | 未到期前仍有效，需要黑名单或短有效期 |
| 适合 | 服务端渲染、同域后台 | 前后端分离、移动端、开放 API |

`Set-Cookie` 的几个属性决定安全边界：

| 属性 | 作用 | 常见错误 |
|---|---|---|
| `HttpOnly` | 禁止 JS 读取 | 登录态 Cookie 漏写，XSS 直接偷走 |
| `Secure` | 仅 HTTPS 发送 | 本地 http 调试时带上，导致 Cookie 发不出去 |
| `SameSite=Lax` | 跨站 POST 不发送 | 跨站前端调接口时忘了改 `None` |
| `Max-Age` | 相对过期秒数，优先于 `Expires` | 同时写 `Expires`，以为后者生效；`Max-Age=0` 是删除，不是「不过期」 |

`SameSite=None` 必须同时有 `Secure`，否则浏览器直接丢弃这个 Cookie。反过来，`Max-Age=0` 会让浏览器立刻删掉这条 Cookie，是服务端「登出」的标准写法，不能拿它表示「永不过期」。

### 3.9 同源策略与 CORS 的判定

同源 = 协议、域名、端口三者完全相同。跨域不等于「请求发不出去」：简单请求会照常发出，只是浏览器不把响应交给 JS；非简单请求先发预检，预检不通过则真实请求根本不会发。所以「CORS 报错」既可能是响应头不对，也可能是请求压根没发出去。

预检（OPTIONS）在满足以下任一条件时触发：方法不是 GET/HEAD/POST；带了自定义请求头（包括 `Authorization`）；`Content-Type` 不是 `text/plain`、`multipart/form-data`、`application/x-www-form-urlencoded`。

因此**绝大多数 JSON 接口都会走预检**。

```mermaid
flowchart TD
    classDef client fill:#DBEAFE,stroke:#2563EB,color:#1E3A8A
    classDef service fill:#DCFCE7,stroke:#16A34A,color:#14532D
    classDef data fill:#FEF3C7,stroke:#D97706,color:#78350F
    classDef normal fill:#F1F5F9,stroke:#64748B,color:#334155

    A["前端发起请求"]:::client --> B{"与页面同源"}:::normal
    B -->|"是"| C["直接发出，不做跨域检查"]:::service
    B -->|"否"| D{"属于简单请求"}:::normal
    D -->|"是"| E["直接发出"]:::service
    D -->|"否"| F["先发 OPTIONS 预检"]:::data
    F --> G{"预检 2xx 且允许方法与头"}:::normal
    G -->|"否"| H["预检失败，真实请求不发出"]:::normal
    G -->|"是"| I["发出真实请求"]:::service
    E --> J{"响应头的 Allow-Origin 与凭证匹配"}:::normal
    I --> J
    J -->|"否"| L["响应被丢弃，JS 拿到 CORS 错误"]:::normal
    J -->|"是"| K["响应交给 JS"]:::service
    linkStyle default stroke:#94A3B8,stroke-width:1.5px
```

| 现象 | 原因 | 处理 |
|---|---|---|
| 预检 401/403 | 安全框架拦了 OPTIONS | 放行 OPTIONS，或让 CORS 过滤器先于安全链 |
| 带 Cookie 时报 wildcard 错误 | `Allow-Origin: *` 与 `Allow-Credentials: true` 不能共存 | 回显具体 Origin |
| 前端读不到自定义响应头 | 没列进 `Access-Control-Expose-Headers` | 显式暴露需要的头 |
| 每次请求都预检 | 没设 `Access-Control-Max-Age` | 设一个合理缓存时间 |

CORS 是浏览器的自愿约定，`curl` 和 Postman 完全不受约束。接口安全靠认证与鉴权，不能靠 CORS。

> **面试**：常问「什么时候触发预检？为什么加了 `Allow-Origin` 还报 CORS？」答：非简单方法、自定义头、非表单类型会预检；预检本身被拦或 Origin 与凭据不匹配，加了头也不生效。

### 3.10 缓存的两个层次

```mermaid
flowchart TD
    classDef client fill:#DBEAFE,stroke:#2563EB,color:#1E3A8A
    classDef service fill:#DCFCE7,stroke:#16A34A,color:#14532D
    classDef data fill:#FEF3C7,stroke:#D97706,color:#78350F
    classDef normal fill:#F1F5F9,stroke:#64748B,color:#334155

    A["请求资源"]:::client --> B{"本地有副本"}:::normal
    B -->|"否"| C["回源取完整响应"]:::service
    B -->|"是"| D{"副本仍在新鲜期"}:::normal
    D -->|"是"| E["直接使用副本"]:::service
    D -->|"否"| F["带验证器发起条件请求"]:::data
    F --> G{"服务端判定未变"}:::normal
    G -->|"是"| H["304 复用副本"]:::service
    G -->|"否"| C
    linkStyle default stroke:#94A3B8,stroke-width:1.5px
```

| 指令 | 含义 |
|---|---|
| `max-age=N` | N 秒内可直接用副本 |
| `s-maxage=N` | 只对共享缓存（CDN、代理）生效，优先级高于 `max-age` |
| `no-cache` | 可以存，但每次用前必须验证 |
| `no-store` | 不存，任何缓存都不许留 |
| `private` | 只允许浏览器存，CDN 不许 |
| `public` | 允许共享缓存存 |
| `immutable` | 新鲜期内绝不验证，连刷新都不回源 |

取舍：`no-store` 最安全但完全放弃缓存收益；`private, max-age=60` 能挡住短时间内的重复请求，又不会让数据过期太久。个性化接口的底线是 `private`（禁止共享缓存），数据本身敏感或一次性时直接 `no-store`，别为了省一点带宽去赌。

> **面试**：常问「`no-cache` 和 `no-store` 有什么区别？个性化接口怎么设？」答：前者可以存但每次用前要验证，后者完全不存；个性化接口至少 `private`，敏感响应用 `no-store`。

### 3.11 验证器与条件请求

| 验证器 | 请求头 | 响应头 | 精度 |
|---|---|---|---|
| ETag | `If-None-Match` | `ETag` | 内容级，最精确 |
| Last-Modified | `If-Modified-Since` | `Last-Modified` | 秒级 |

两者同时存在时，`If-None-Match` 优先。命中返回 304，**没有响应体**，但可以带新的 `Cache-Control`、`ETag` 等头。

`ETag` 分强弱：`"abc"` 是强验证器，要求字节完全一致；`W/"abc"` 是弱验证器，只保证语义等价。压缩传输时用弱 ETag 更合适，因为同一个表示可能有多种编码形式。

写操作的并发控制也用它：`If-Match` 不匹配返回 412，就是乐观锁。这比「先查再改」可靠，因为查与改之间没有原子性。

### 3.12 代理链与转发头

经过代理后，后端看到的 `remote_addr` 是代理的 IP，`scheme` 是代理到后端那一段的协议。三个头负责把真实信息带下去：

| 头 | 含义 | 注意 |
|---|---|---|
| `X-Forwarded-For` | 客户端 IP 链，逗号分隔 | 可伪造，只能信任最近一层代理追加的值 |
| `X-Forwarded-Proto` | 原始协议 | 生成绝对 URL、判断是否加 `Secure` Cookie 时要用 |
| `X-Forwarded-Host` | 原始 Host | 多域名共用一个后端时必需 |

`Forwarded` 是标准化后的写法，但生态里 `X-Forwarded-*` 仍然是事实标准。后端要显式开启「信任代理头」，否则重定向会跳到内网地址、Cookie 会丢掉 `Secure`。

### 3.13 资源建模与 URL 结构

REST 的核心不是「URL 里没有动词」，而是**用资源与统一方法来表达意图**。

| 反例 | 正例 | 问题 |
|---|---|---|
| `GET /getAllUsers` | `GET /users` | 动词进了路径 |
| `POST /users/create` | `POST /users` | 创建由方法表达 |
| `POST /task/delete?id=1` | `DELETE /tasks/1` | 删除由方法表达 |
| `GET /users/delete/1` | `DELETE /users/1` | GET 产生副作用 |
| `GET /api_v2/Task_List` | `GET /v2/tasks` | 大小写、下划线、版本位置混乱 |
| `GET /tasks/list.json` | `GET /tasks` | 扩展名不属于 API |

层级表达从属关系：`GET /users/1/tasks` 比 `GET /tasks?userId=1` 更能表达「属于」，但嵌套超过两层就该退回查询参数，否则路径会变成 `GET /users/1/tasks/3/comments/5/replies` 这种难维护的形状。

动作不是增删改查时，允许 `POST /tasks/1/complete` 这类子资源动作，但优先考虑「改状态字段」：`PATCH /tasks/1 {"status":"done"}` 更通用，也更容易做权限与审计。

### 3.14 列表接口的参数设计

| 方案 | 参数 | 优点 | 代价 |
|---|---|---|---|
| 页码 | `page=1&size=20` | 直观，前端好做分页器 | 翻页期间数据变动会重复或遗漏 |
| 偏移 | `limit=20&offset=40` | 语义清晰 | 深分页要扫描并丢弃大量行 |
| 游标 | `cursor=xxx&limit=20` | 深分页稳定且快 | 不能随机跳到第 N 页 |

三个必须写进文档的约定：`page` 从 1 还是 0 开始；`size` 的上限（如 100）；排序的默认值与多字段写法（`sort=-priority,createdAt`，前缀 `-` 表示降序）。

筛选参数用重复键表达多值（`status=todo&status=doing`）比逗号分隔更标准，因为逗号本身可能是值的一部分。范围查询用 `createdAfter`、`createdBefore` 这类语义化名字，不要用 `start`、`end` 这种看不出含哪一端的写法。

### 3.15 错误契约与业务码

一套错误结构要能让前端写出**一个**拦截器，而不是每个接口写一遍：

```json
{
  "code": 40901,
  "message": "任务标题已存在",
  "errors": [{"field": "title", "message": "已经有一个同名任务"}],
  "traceId": "a1b2c3d4e5f6",
  "timestamp": "2026-10-21T10:14:33+08:00"
}
```

| 字段 | 给谁看 | 要求 |
|---|---|---|
| HTTP 状态码 | 网关、监控、通用客户端 | 必须与错误性质一致 |
| `code` | 业务代码 | 团队内唯一、稳定，不随文案变 |
| `message` | 人 | 可直接展示，不含堆栈与 SQL |
| `errors` | 表单 | 字段级，能落到具体输入框 |
| `traceId` | 排障 | 与日志、链路追踪打通 |

最常见的坏实践是「HTTP 200 + 业务码 500」：前端拦截器、网关重试、监控告警、缓存策略全部失效，错误被藏进成功里。业务码是补充，不是替代。

### 3.16 幂等键与安全重试

重试的前提是「重复执行不会带来额外副作用」。GET、HEAD、OPTIONS 不改数据，本身没有这个问题；改数据的方法里 PUT、DELETE 天然幂等，POST 必须靠外部机制：

| 场景 | 机制 |
|---|---|
| 用户连点提交 | 前端禁用按钮 + 服务端幂等键 |
| 网关/客户端超时重试 | 客户端生成 `Idempotency-Key`，服务端按键唯一索引 |
| 支付回调重复 | 用流水号做唯一约束，重复插入返回首次结果 |
| 消息重复消费 | 消费端按业务唯一键去重 |

幂等键的三个要点：由**客户端**生成（服务端生成无法区分重试）；与请求体绑定（同键不同体要拒绝）；有**有效期**（一般 24 小时），过期后允许键复用。

---

## 四、冷门知识汇总

| 知识点 | 为什么冷门 | 用到时的关键词 |
|---|---|---|
| `Transfer-Encoding: chunked` | 现代框架自动处理，手工拼报文时才接触 | 分块传输、长度未知、流式响应 |
| `Range` 与 206 | 只有断点续传、视频拖动才用 | `Content-Range`、`Accept-Ranges` |
| `Vary` | 配了缓存但没配它，问题延迟暴露 | `Vary: Accept-Encoding`、缓存键 |
| `ETag` 与 gzip | 症状只是「没命中 304」，不比对两次响应头看不出来 | 弱 ETag、`Vary: Accept-Encoding`、`curl --compressed` 对比 |
| `stale-while-revalidate` | 需要 CDN 支持，配置项偏门 | 先旧后新、后台刷新 |
| `Retry-After` | 只在 429/503 时有人看 | 退避、限流、维护窗口 |
| 请求签名 | 开放平台才需要，内部接口用不上 | `appId`、`nonce`、`timestamp`、HMAC |
| 健康检查端点 | 上了 K8s 才成为必答题 | `/healthz`、`/readyz`、探针 |
| 请求合并与批处理 | REST 天然一请求一资源，批量要另设计 | `POST /batch`、部分成功 |
