---
title: "Shell脚本与自动化"
category: "07-运维"
---

# Shell脚本与自动化

> 这篇从 Shell 的执行模型讲起，经过变量与引号、条件与循环、函数与错误处理、文本处理与静态检查，最后落到 cron/systemd timer 定时任务和一个带健康检查与自动回滚的发布脚本。
>
> 学完能写出通过 ShellCheck 的健壮脚本，把重复的部署、巡检、清理工作变成可定时、可重试、可回滚的自动化流程。

## 一、Shell 的边界与执行模型

Shell 是命令解释器，也是一门编程语言，但它首先是“把已有命令粘起来”的工具。判断该不该用 Shell，只看一件事：任务的主体是不是调用外部命令、操作文件、编排流程。

适合 Shell 的场景：批量文件处理、日志清理、服务启停、发布编排、CI 中的胶水步骤、巡检采集。不适合的场景：复杂数据结构、大量计算、并发调度、需要单元测试的业务逻辑——这些交给 Python 或 Go，维护成本更低。

Shell 方言必须先分清：

| 方言 | 典型位置 | 兼容性 | 建议 |
|---|---|---|---|
| POSIX `sh` | `/bin/sh`（Ubuntu 为 dash） | 最广 | 只写 `sh` 可移植脚本时用 |
| Bash | `/bin/bash`，5.1+ | 广 | 服务器脚本默认选择 |
| Zsh | 交互式默认 shell | 与 Bash 有差异 | 不用于服务器脚本 |
| BusyBox `ash` | 容器、嵌入式 | 子集 | 容器内脚本需实测 |

`#!/bin/sh` 在 Ubuntu 上实际执行 dash，`[[ ]]`、数组、`local` 都可能不可用。服务器脚本统一写 `#!/usr/bin/env bash`，比写死 `/bin/bash` 更容易适配不同前缀的安装。

一条命令从输入到执行经过四步，理解它能解释大多“为什么变量没展开”“为什么空格把参数拆开了”的问题：

```mermaid
graph LR
  A[命令行文本] --> B["分词：按空白切分"]
  B --> C["展开：变量/命令/算术/通配"]
  C --> D["重定向：> >> 2>&1"]
  D --> E["执行：内建或外部命令"]
  classDef blue fill:#eff6ff,stroke:#93c5fd,color:#1e3a8a;
  classDef green fill:#ecfdf5,stroke:#86efac,color:#166534;
  classDef amber fill:#fffbeb,stroke:#fcd34d,color:#92400e;
  class A,B blue;
  class C amber;
  class D,E green;
```

关键点是展开顺序：分词发生在变量展开之前，所以未加引号的变量会再次被分词和通配。`f="a b.txt"; rm $f` 会删两个文件，`rm "$f"` 才删一个。

每个命令返回 0–255 的退出码，0 表示成功。`$?` 读取上一个命令的退出码；脚本的退出码是最后一条命令的退出码，除非显式 `exit`。自动化流程靠退出码判断成败，不靠解析输出文字。

> 边界：Shell 的算术是整数，浮点要用 `awk` 或 `bc`；没有真正的多线程，并发只能用后台进程加 `wait`；关联数组需要 Bash 4+，macOS 自带 Bash 3.2 不支持，必须用 `brew install bash` 后再指定解释器。

## 二、环境准备与第一个脚本

脚本能跑起来的前提是解释器、权限、静态检查工具三件事齐备。先装工具，再写第一行代码。

```bash
# Ubuntu 24.04/26.04
sudo apt update
sudo apt install -y shellcheck shfmt jq moreutils

# RHEL / Rocky 9/10（shfmt 若仓库未提供，用 go install 安装）
sudo dnf install -y ShellCheck jq moreutils
sudo dnf install -y shfmt || go install mvdan.cc/sh/v3/cmd/shfmt@latest

# macOS（系统自带 bash 3.2，需单独装新版）
brew install bash shellcheck shfmt jq coreutils gnu-sed

# Windows：推荐 WSL2 + Ubuntu，与生产一致；Git Bash 可用但路径与权限行为不同
wsl --install -d Ubuntu-24.04
```

版本基线（2026-11）：Bash 5.1+（Ubuntu 24.04 为 5.2，Rocky 9 为 5.1），ShellCheck 0.10+，shfmt 3.8+，jq 1.7+。版本差异主要影响关联数组、`mapfile`、`EPOCHSECONDS` 等特性。

最小脚本：

```bash
#!/usr/bin/env bash
# -E：ERR trap 继承到函数与子 shell，否则函数里的失败不会被捕获
# -e：任何未处理命令失败立即退出，避免带着错误继续跑
# -u：引用未定义变量即报错，防止空变量拼出危险路径
# -o pipefail：管道中任一环失败即算失败，而不是只看最后一个命令
set -Eeuo pipefail
IFS=$'\n\t'   # 默认按空格分词，改成换行与制表符，减少意外拆分

main() {
  local name=${1:-world}
  printf 'hello, %s\n' "$name"
}

main "$@"
```

```bash
chmod 750 hello.sh
./hello.sh                  # hello, world
./hello.sh ops              # hello, ops
bash -n hello.sh            # 只做语法检查，不执行
bash -x hello.sh ops        # 输出每一步展开后的命令，调试用
```

预期输出（`bash -x`）：

```text
+ main ops
+ local name=ops
+ printf 'hello, %s\n' ops
hello, ops
```

执行方式有差异，自动化里必须用对：

| 方式 | 是否需执行位 | 使用哪个解释器 | 适用 |
|---|---|---|---|
| `./script.sh` | 是 | shebang 指定 | 正式入口 |
| `bash script.sh` | 否 | 显式 bash | 调试、CI |
| `source script.sh` | 否 | 当前 shell | 加载函数库 |
| `sh script.sh` | 否 | sh（可能是 dash） | 仅 POSIX 脚本 |

`source` 会在当前 shell 执行，脚本里的 `exit`、`cd`、变量都会影响调用者，只用于函数库，不用于主流程。

> 边界：`bash -n` 只查语法，不查未定义变量与逻辑错误；真正的静态检查用 `shellcheck`。Windows 换行（CRLF）会让 shebang 变成 `bash\r`，报 `bad interpreter`，用 `dos2unix` 或 `.gitattributes` 统一为 LF。

## 三、变量、引号与参数

Shell 变量的值永远是字符串，数组是字符串的有序集合。引号决定展开后是否再次分词，是脚本里最高频的错误来源。

```bash
name="order api"          # 等号两边不能有空格
readonly BASE=/opt/app    # 只读，防止后续误改
export PATH="$PATH:/opt/app/bin"   # 导出给子进程

# 默认值、必填、替代值
: "${DB_HOST:?DB_HOST is required}"   # 未设置直接报错退出
port=${PORT:-8080}                     # 未设置或为空时用默认值
debug=${DEBUG:+1}                      # 已设置时取替代值
```

常用参数展开：

| 写法 | 含义 | 用途 |
|---|---|---|
| `${var}` | 取值 | 与后续字符分隔 |
| `${var:-x}` | 空则用 x | 默认值 |
| `${var:=x}` | 空则赋值 x | 初始化 |
| `${var:?msg}` | 空则报错 | 必填校验 |
| `${#var}` | 长度 | 校验非空 |
| `${var%.*}` | 去掉最短后缀 | 去扩展名 |
| `${var//a/b}` | 全部替换 | 路径处理 |

引号规则：

```bash
f="report 2026.txt"
rm "$f"              # 一个参数，正确
rm $f                # 两个参数，会删错文件
printf '%s\n' "$f"   # 变量永远放在双引号里

# 单引号不做任何展开，适合固定字符串
grep -F 'ERROR: $VAR' app.log
```

数组与关联数组：

```bash
files=("a.txt" "b c.txt" "d.txt")
for f in "${files[@]}"; do          # [@] 加引号，每个元素一个参数
  printf '%s\n' "$f"
done
printf 'count=%d\n' "${#files[@]}"  # 元素个数

declare -A svc_port=([api]=8080 [web]=80)
for name in "${!svc_port[@]}"; do
  printf '%s -> %s\n' "$name" "${svc_port[$name]}"
done
```

位置参数与 `shift`：

```bash
printf 'script=%s total=%d first=%s\n' "$0" "$#" "${1:-}"
shift                     # 丢掉第一个参数，$1 变成原来的 $2
printf 'all=%s\n' "$*"    # "$*" 合成一个字符串，通常不用
printf 'each=%s\n' "$@"   # "$@" 保留每个参数边界，转发时用它
```

`"$@"` 与 `"$*"` 的区别只在带引号时成立：前者展开为多个参数，后者合成一个。包装命令时写 `exec "$@"`，不要写 `exec $*`。

> 边界：命令替换 `$(...)` 会去掉输出末尾的换行，读二进制或需要保留空白时改用文件或 `read -d ''`。变量里存多行文本再 `for` 循环，会按 `IFS` 拆开，正确做法是用数组或 `while read`。

## 四、条件判断与分支

条件判断优先用 `[[ ]]`，它是 Bash 内建，不做分词和通配，字符串比较更安全。`[ ]` 只在需要 POSIX 兼容时使用。

```bash
if [[ -f /etc/app/config.yml && -r /etc/app/config.yml ]]; then
  echo "config readable"
elif [[ -d /etc/app ]]; then
  echo "config is a directory"
else
  echo "config missing" >&2
  exit 1
fi
```

常用测试：

| 测试 | 含义 | 注意 |
|---|---|---|
| `-e` | 路径存在 | 不区分类型 |
| `-f` / `-d` / `-L` | 文件/目录/软链 | 软链用 `-L` |
| `-r` / `-w` / `-x` | 当前用户权限 | root 常绕过读位 |
| `-s` | 非空文件 | 日志轮转后常见 |
| `-z` / `-n` | 字符串为空/非空 | 变量必须加引号 |
| `a -eq b` | 整数相等 | 字符串用 `=` |

字符串与模式：

```bash
[[ "$env" == "prod" ]]            # 字符串相等
[[ "$file" == *.log ]]            # 通配匹配，右侧不加引号
[[ "$tag" =~ ^v[0-9]+\.[0-9]+$ ]] # 正则匹配，Bash 3.2+
[[ "$n" -gt 10 ]]                 # 整数比较
```

`case` 适合多分支与参数解析：

```bash
case "$1" in
  start|stop|restart) systemctl "$1" myapp ;;
  status) systemctl status myapp --no-pager ;;
  *) echo "usage: $0 {start|stop|restart|status}" >&2; exit 2 ;;
esac
```

带选项的脚本用 `getopts`，不要手写 `$1 = -e` 的位移逻辑：

```bash
usage() { echo "usage: $0 -e env -d dir [-h]" >&2; }

env=""; dir="."
while getopts ":e:d:h" opt; do
  case "$opt" in
    e) env=$OPTARG ;;
    d) dir=$OPTARG ;;
    h) usage; exit 0 ;;
    :) echo "missing value for -$OPTARG" >&2; exit 2 ;;   # 冒号开头才能捕获缺参
    \?) echo "unknown option -$OPTARG" >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))    # 去掉已解析的选项，剩下的才是位置参数
```

> 边界：`[ $var = x ]` 在 `var` 为空时会变成 `[ = x ]` 直接报语法错，必须写 `[ "$var" = x ]`；`[[ ]]` 里变量不加引号也安全，但为了统一仍建议加。数值比较不要用 `=`，字符串 `"10" = "9"` 为假、`-gt` 才为真。

## 五、循环与输入处理

循环的正确写法取决于数据来源：文件用 `while read`，目录用通配或 `find -print0`，固定列表用数组，计数用 C 风格 `for`。

```bash
# 逐行读文件：-r 不解释反斜杠，IFS= 保留行首尾空白
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  printf '%s\n' "$line"
done < /var/log/app/errors.log

# 遍历目录：nullglob 让无匹配时展开为空，而不是保留字面量 *.log
shopt -s nullglob
for f in /var/log/app/*.log; do
  gzip -f "$f"
done

# 文件名可能含空格或换行，必须用 -print0 配 read -d ''
find /data -type f -name '*.tmp' -print0 |
  while IFS= read -r -d '' f; do
    rm -f -- "$f"
  done

# 把命令输出读进数组，避免 $(ls) 分词
mapfile -t pods < <(kubectl get pod -o name)
printf 'pods=%d\n' "${#pods[@]}"
```

`for i in $(seq 1 10)` 在数据量小时能用，但 `{1..10}` 是内建展开，更快且不依赖外部命令。计数循环也可以写成 C 风格：

```bash
for ((i = 1; i <= 3; i++)); do
  printf 'attempt %d\n' "$i"
done
```

管道会创建子 shell，循环里的变量在管道结束后丢失：

```bash
count=0
printf 'a\nb\n' | while IFS= read -r _; do
  count=$((count + 1))   # 这里的 count 属于子 shell
done
printf 'count=%d\n' "$count"   # 输出 0，不是 2

# 用进程替换把输入接到当前 shell，变量才能保留
count=0
while IFS= read -r _; do
  count=$((count + 1))
done < <(printf 'a\nb\n')
printf 'count=%d\n' "$count"   # 输出 2
```

`break`/`continue` 可以带层数，`break 2` 直接跳出两层循环，比设置标志变量清晰。

> 边界：`while read` 处理超大数据时逐行调用外部命令会非常慢，能在 `awk` 一次完成的不要放进循环。读取文件不要用 `cat file | while`，多一个进程且丢失变量；直接 `while ... done < file`。

## 六、函数、错误处理与信号

函数用于复用与分块，错误处理决定脚本失败时是“安静地做错”还是“立即停下并留下现场”。两者都靠退出码与 trap。

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  local level=$1; shift          # 先取出级别，剩余都是消息
  printf '%s [%s] %s\n' "$(date -u +%FT%TZ)" "$level" "$*" >&2
}

die() { log ERROR "$*"; exit 1; }

# 重试：只对可恢复错误使用，次数与退避都要有上限
retry() {
  local tries=$1 delay=$2; shift 2
  local i=1
  until "$@"; do
    ((i++))
    if ((i > tries)); then
      log ERROR "command failed after $tries tries: $*"
      return 1
    fi
    sleep "$delay"
    delay=$((delay * 2))
  done
}
```

`set -e` 有明确的失效场景，必须知道：

```bash
# 在 if / while / || / && 中的命令失败不会触发 -e，这是有意设计
if grep -q ERROR app.log; then
  log INFO "errors found"
fi

# local 与命令替换写在一起会吞掉退出码，必须拆开
local out
out=$(curl -fsS "$url") || die "curl failed"

# 算术表达式 ((i++)) 在 i=0 时返回 1，会触发 -e；改为前置自增
i=0
((++i))
```

信号与清理用 `trap`，临时目录必须回收：

```bash
TMP_DIR=""
cleanup() {
  local rc=$?
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf -- "$TMP_DIR"
  fi
  log INFO "exit rc=$rc"
}
trap cleanup EXIT                 # 正常退出、失败、Ctrl-C 都会执行
trap 'log ERROR "line $LINENO failed: $BASH_COMMAND"' ERR

TMP_DIR=$(mktemp -d)              # 每次运行独立目录，避免并发覆盖
```

预期输出（失败时）：

```text
2026-11-13T02:11:04Z [ERROR] line 42 failed: curl -fsS http://127.0.0.1:8080/health
2026-11-13T02:11:04Z [INFO] exit rc=22
```

并发互斥用 `flock`，不要用“检查 PID 文件是否存在”这种有竞态的做法：

```bash
# 锁文件放在应用目录下，目录属主是运行用户；/var/lock 普通用户不可写
exec 9>/opt/app/.deploy.lock       # 文件描述符 9 持有锁直到进程退出
if ! flock -n 9; then
  die "another deploy is running"
fi
```

> 边界：`trap ... EXIT` 里的 `$?` 必须是函数第一行保存，后面任何命令都会覆盖它。`set -e` 不是异常机制，不能替代显式检查；需要区分错误类型时，函数返回不同退出码并由调用方 `case` 处理。

## 七、文本处理与数据管道

文本处理的原则是“一个任务一个工具，管道组合”，不要把所有逻辑塞进一个 `awk`。选型按数据结构定：行用 `grep`，字段用 `awk`，替换用 `sed`，JSON 用 `jq`。

```bash
# grep：固定字符串用 -F 更快，递归搜索排除目录用 --exclude-dir
grep -Fn 'OutOfMemory' /var/log/app/*.log
grep -rIn --exclude-dir=.git 'TODO' ./src

# sed：-E 用扩展正则，-i 原地修改（先备份或先预览）
sed -n '1,20p' access.log
sed -E 's#^/old/(.*)$#/new/\1#' urls.txt

# awk：按列统计，END 汇总
awk '{sum += $NF} END {printf "total=%.0f\n", sum}' bytes.txt
awk -F, '$3 == "500" {count[$1]++} END {for (k in count) print k, count[k]}' access.csv

# jq：JSON 取值、筛选、拼装
jq -r '.items[] | select(.status == "failed") | "\(.id)\t\(.reason)"' result.json
jq -s 'map(.latency) | add / length' samples.json
```

`xargs` 的三个必要参数：

```bash
# -0 配 find -print0 处理任意文件名
# -r 无输入时不执行命令（GNU 专有）
# -n1 每次传一个参数，避免命令参数过长或批量失败
find /data -name '*.log' -print0 | xargs -0 -r -n1 gzip -f
```

排序统计的固定组合：

```bash
awk '{print $1}' access.log | sort | uniq -c | sort -nr | head -10
#   18231 10.0.2.15
#    9821 10.0.2.20
```

对比两个清单用 `comm`，前提是先排序：

```bash
comm -23 <(sort old.txt) <(sort new.txt)   # 只在 old 中
comm -13 <(sort old.txt) <(sort new.txt)   # 只在 new 中
```

| 任务 | 首选 | 说明 |
|---|---|---|
| 找字符串 | `grep -F` | 不当正则解释，速度快 |
| 改字段 | `awk` | 按列处理比 `sed` 稳 |
| 批量替换 | `sed -E` | 先不带 `-i` 预览 |
| JSON | `jq` | 不要用 `grep` 解析 JSON |
| 传文件列表 | `xargs -0` | 配 `-print0` |

> 边界：`sed -i` 在 macOS 与 GNU 上参数不同（macOS 必须给备份后缀），跨平台脚本用 `sed -i.bak` 再删备份。`jq` 默认输出带引号的 JSON 字符串，取原始值加 `-r`。管道中任一环失败默认不影响最终退出码，必须 `set -o pipefail`。

## 八、脚本工程化与静态检查

能跑的脚本和能维护的脚本差距在四件事：静态检查、日志、配置分层、幂等。前两件决定排错成本，后两件决定能否重复执行。

ShellCheck 是必过的门槛，按严重级别卡 CI：

```bash
shellcheck -S warning scripts/*.sh
```

典型问题与修法：

```text
In deploy.sh line 42:
  scp $artifact server:/opt/app/
      ^-------^ SC2086 (info): Double quote to prevent globbing and word splitting.

In cleanup.sh line 17:
  cd $DIR && rm -rf *
  ^-----^ SC2164 (warning): Use 'cd ... || exit' in case cd fails.
```

```bash
scp "$artifact" server:/opt/app/          # 修 SC2086
cd "$DIR" || exit 1                       # 修 SC2164
```

确实需要特殊行为时才禁用规则，并写明原因：

```bash
# 这里就是要按空格拆分多个 rsync 参数
# shellcheck disable=SC2086
rsync $RSYNC_OPTS "$src" "$dst"
```

格式统一用 `shfmt`，避免 review 里出现无意义的缩进争论：

```bash
shfmt -i 2 -ci -w scripts/     # 2 空格缩进，case 分支缩进
shfmt -d scripts/              # 只显示差异，用于 CI 检查
```

日志函数统一出口，禁止散落的 `echo`：

```bash
log() {
  local level=$1; shift
  printf '%s [%-5s] %s\n' "$(date -u +%FT%TZ)" "$level" "$*" >&2
}
log INFO "starting deploy app=$APP env=$ENV"
log WARN "health check slow: ${elapsed}ms"
```

配置分层固定为“默认值 → 配置文件 → 环境变量 → 命令行”，后者覆盖前者：

```bash
PORT=8080                                              # 1) 默认值
[[ -f /etc/app/app.env ]] && source /etc/app/app.env   # 2) 配置文件覆盖默认
PORT=${APP_PORT:-$PORT}                                # 3) 环境变量覆盖文件
# 4) 命令行参数在 getopts 中最后赋值，覆盖以上所有层
```

幂等意味着重复执行结果一致：目录用 `mkdir -p`，软链用 `ln -sfn`，用户用 `id -u name || useradd`，文件写入用“临时文件 + `mv`”避免半截内容。

```bash
# 原子写：先写临时文件，再 rename，读者永远看到完整内容
tmp=$(mktemp "$target.XXXXXX")
generate_config > "$tmp"
mv -f -- "$tmp" "$target"
```

> 边界：ShellCheck 不能发现业务逻辑错误，也不能替代 `bash -n` 之外的运行时验证；关键脚本仍要在测试环境跑失败路径。`source` 配置文件等于执行其中的代码，配置文件权限必须收紧到 640 且属主为服务账号。

## 九、定时任务与触发自动化

定时任务先选调度器：固定间隔、短任务用 cron；需要依赖、日志、随机延迟、补跑用 systemd timer。两者都不负责“任务是否成功”，成功判断仍靠脚本退出码与告警。

cron 的环境与登录 shell 完全不同：`PATH` 只有 `/usr/bin:/bin`，没有 `~/.bashrc`，`HOME` 可能是 `/root`。脚本里必须用绝对路径并显式设置环境。

```bash
crontab -e
```

```text
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=""
# 每天 02:30 清理，追加日志；% 在 cron 中要转义为 \%
30 2 * * * /opt/app/bin/cleanup.sh >> /var/log/app/cleanup.log 2>&1
# 每 5 分钟巡检，flock -n 防止上一轮未结束时叠加
# 锁目录 /opt/app/run 属主为运行用户，普通用户无法在 /var/lock 下建文件
*/5 * * * * flock -n /opt/app/run/check.lock /opt/app/bin/check.sh >/dev/null 2>&1
```

| 字段 | 含义 | 范围 |
|---|---|---|
| 第 1 列 | 分钟 | 0–59 |
| 第 2 列 | 小时 | 0–23 |
| 第 3 列 | 日 | 1–31 |
| 第 4 列 | 月 | 1–12 |
| 第 5 列 | 星期 | 0–7（0 和 7 都是周日） |

`/etc/cron.d/` 下的文件多一列用户字段，权限必须是 644 且属主 root，否则 cron 忽略。系统级任务不要写进个人 crontab。

systemd timer 把调度与执行分开，日志自动进 journal：

```ini
# /etc/systemd/system/app-cleanup.service
[Unit]
Description=Cleanup old app releases
After=network.target

[Service]
Type=oneshot
User=deploy
ExecStart=/opt/app/bin/cleanup.sh
```

```ini
# /etc/systemd/system/app-cleanup.timer
[Unit]
Description=Run app cleanup nightly

[Timer]
OnCalendar=*-*-* 02:30:00
RandomizedDelaySec=300
Persistent=true

[Install]
WantedBy=timers.target
```

`Persistent=true` 让关机错过的任务在开机后补跑；`RandomizedDelaySec` 打散多台机器同时启动的尖峰。启用与验证：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now app-cleanup.timer
systemctl list-timers --all | grep app-cleanup
journalctl -u app-cleanup.service -n 50 --no-pager
```

预期输出（示例）：

```text
NEXT                        LEFT     LAST                        PASSED  UNIT                ACTIVATES
Mon 2026-11-16 02:33:12 CST 2d 10h left Fri 2026-11-13 02:31:44 CST 14h ago app-cleanup.timer app-cleanup.service
```

> 边界：cron 的最小粒度是分钟，秒级调度要用 systemd timer 的 `OnCalendar=*:*:00/15` 或循环脚本；cron 任务默认会把输出邮寄给 `MAILTO`，未配置邮件时输出丢失，必须显式重定向到日志。容器里的 cron 不是 init，容器重启后任务丢失，长期任务用 K8s CronJob 或外部调度。

## 十、发布脚本与持续集成

发布脚本的目标不是“把文件拷过去”，而是“任何一步失败都能停下并回到上一个可用版本”。设计上固定五段：预检、准备、切换、验证、清理，回滚是独立命令而不是事后手工操作。

目录结构决定回滚成本：

```text
/opt/app/
├── releases/
│   ├── 20261113140211-a1b2c3d/
│   └── 20261112113002-9f8e7d6/
├── shared/
│   ├── config/
│   └── logs/
└── current -> /opt/app/releases/20261113140211-a1b2c3d
```

`current` 是指向版本的软链，切换版本只改这个链接；`shared` 存放跨版本复用的配置与日志。保留最近 5 个版本，既够回滚又不撑爆磁盘。

发布阶段的检查项：

| 阶段 | 检查 | 失败处理 |
|---|---|---|
| 预检 | 包存在、校验和、磁盘余量 | 直接退出，不动线上 |
| 准备 | 解包、软链 shared、权限 | 删除半成品目录 |
| 切换 | 更新 `current`、重启服务 | 保持旧版本可回 |
| 验证 | 健康检查连续通过 | 自动回滚 |
| 清理 | 删除超出保留数的旧版本 | 只记日志，不影响发布 |

数据库变更与发布解耦：先用“扩展”加字段、双写、回填，再“收缩”删旧字段，保证旧版本代码在新 schema 上仍能运行，否则回滚会失败。

发布账号不需要 root，只在 sudoers 中授权一个 unit 的重启动作，其余步骤都以 deploy 身份完成：

```text
deploy ALL=(root) NOPASSWD: /bin/systemctl restart order-api.service
```

CI 中调用发布脚本，密钥只放在 CI 的受保护变量里，脚本本身不保存凭证：

```bash
# GitLab CI 片段：只在 main 分支、手动触发时发布
deploy:prod:
  stage: deploy
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
      when: manual
  script:
    - mkdir -p ~/.ssh
    - printf '%s\n' "$DEPLOY_KEY" > ~/.ssh/id_ed25519 && chmod 600 ~/.ssh/id_ed25519
    - scp /tmp/order-api-${CI_COMMIT_SHORT_SHA}.tar.gz deploy@prod-01:/tmp/
    - ssh -o StrictHostKeyChecking=yes deploy@prod-01 \
        "/opt/app/bin/deploy.sh deploy /tmp/order-api-${CI_COMMIT_SHORT_SHA}.tar.gz"
```

> 边界：`ssh` 远程执行不会继承本地环境变量，参数必须显式传；`StrictHostKeyChecking=no` 会失去中间人防护，生产禁用。发布脚本不负责构建产物，构建与发布分离才能保证“同一产物在测试与生产一致”。

## 十一、最佳实践案例

### 11.1 案例背景

一套订单服务（Java 21 + Spring Boot 3.5）部署在 3 台 Ubuntu 24.04 节点上，前面是负载均衡，健康检查路径 `/health`。原来的发布方式是手工 `scp` 覆盖 jar 再 `systemctl restart`，出现过两次事故：一次覆盖到一半失败导致服务起不来，一次新版本健康检查不通过但无人发现，靠用户投诉才发现。

目标是把发布变成一条命令，要求：单节点发布不超过 60 秒、失败自动回滚、同一时刻只允许一个发布进程、保留 5 个历史版本。约束是不能改应用代码，节点逐个发布，负载均衡负责摘流。

### 11.2 案例实操

发布脚本 `/opt/app/bin/deploy.sh`：

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

APP="order-api"
BASE="/opt/${APP}"
RELEASES="${BASE}/releases"
SHARED="${BASE}/shared"
CURRENT="${BASE}/current"
KEEP=5
HEALTH_URL="http://127.0.0.1:8080/health"
LOCK="${BASE}/.deploy.lock"

log() {
  local level=$1; shift
  printf '%s [%-5s] %s\n' "$(date -u +%FT%TZ)" "$level" "$*" >&2
}
die() { log ERROR "$*"; exit 1; }

# 任何退出路径都清理临时目录；rc 先保存，避免被后续命令覆盖
TMP_DIR=""
cleanup() {
  local rc=$?
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf -- "$TMP_DIR"
  fi
  log INFO "finished rc=$rc"
}
trap cleanup EXIT
trap 'log ERROR "line $LINENO failed: $BASH_COMMAND"' ERR

acquire_lock() {
  # fd 9 持有排他锁，进程退出自动释放，避免 PID 文件的竞态
  exec 9>"$LOCK"
  flock -n 9 || die "another deploy is running"
}

health_check() {
  # 连续 3 次成功才算通过：重启后的前几秒旧进程可能还在响应
  local tries=${1:-20} ok=0 i
  for ((i = 1; i <= tries; i++)); do
    # -f 让 4xx/5xx 返回非 0，避免把“服务活着但不可用”当成成功
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
      ok=$((ok + 1))
      if ((ok >= 3)); then
        log INFO "health ok after ${i} tries"
        return 0
      fi
    else
      ok=0        # 失败一次就清零，要求连续成功
    fi
    sleep 1
  done
  return 1
}

switch_to() {
  local release=$1
  [[ -d "$release" ]] || die "release not found: $release"
  # -n 让软链替换是原子的，读者不会看到中间状态
  ln -sfn "$release" "$CURRENT"
  # 脚本以 deploy 运行，仅对这一个 unit 拿到 sudo 授权
  sudo systemctl restart "${APP}.service"
}

deploy() {
  local artifact=$1
  [[ -f "$artifact" ]] || die "artifact missing: $artifact"
  [[ $(df -Pk "$BASE" | awk 'NR==2 {print $4}') -gt 524288 ]] \
    || die "less than 512MB free on $BASE"

  local id sum
  sum=$(sha256sum "$artifact" | cut -c1-8)   # 拆开写，避免 local 吞掉命令的退出码
  id="${APP}-$(date +%Y%m%d%H%M%S)-${sum}"
  local release="${RELEASES}/${id}"
  local previous=""
  [[ -L "$CURRENT" ]] && previous=$(readlink -f "$CURRENT")

  mkdir -p "$release"
  # 先解到新目录，失败时只删这个半成品，不碰 current
  tar -xzf "$artifact" -C "$release" || { rm -rf -- "$release"; die "unpack failed"; }
  ln -sfn "${SHARED}/config" "${release}/config"
  ln -sfn "${SHARED}/logs" "${release}/logs"
  # 以 deploy 身份解包，文件属主已经是 deploy，不需要再 chown
  chmod 750 "$release"

  switch_to "$release"

  if ! health_check 20; then
    log ERROR "health check failed, rolling back"
    if [[ -n "$previous" && -d "$previous" ]]; then
      switch_to "$previous"
      health_check 20 || log ERROR "rollback health also failed"
    else
      # 首次发布就没有可回版本，至少移除指向坏版本的软链
      rm -f -- "$CURRENT"
    fi
    die "deploy failed, rolled back to ${previous:-none}"
  fi

  log INFO "deployed ${id}"
  cleanup_old
}

rollback() {
  local previous
  # 取第二新的版本，跳过 current 自身
  # -printf 是 GNU find 扩展，Ubuntu 默认满足；BusyBox 环境改用 ls -1dt
  previous=$(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' |
    sort -nr | awk 'NR==2 {print $2}')
  [[ -n "$previous" ]] || die "no previous release"
  switch_to "$previous"
  health_check 20 || die "rollback health check failed"
  log INFO "rolled back to $(basename "$previous")"
}

cleanup_old() {
  # 只处理 releases 下的时间戳目录，路径变量先做前缀校验，防止空值误删
  [[ "$RELEASES" == "${BASE}/releases" ]] || die "unexpected releases path"
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' |
    sort -nr | awk -v keep="$KEEP" 'NR>keep {print $2}' |
    while IFS= read -r old; do
      log INFO "remove old release $(basename "$old")"
      rm -rf -- "$old"
    done
}

case "${1:-}" in
  deploy)
    [[ -n "${2:-}" ]] || { echo "usage: $0 deploy <artifact>" >&2; exit 2; }
    acquire_lock
    deploy "$2"
    ;;
  rollback) acquire_lock; rollback ;;
  status)
    printf 'current=%s\n' "$(readlink -f "$CURRENT")"
    systemctl is-active "${APP}.service"
    curl -fsS "$HEALTH_URL" && echo
    ;;
  *) echo "usage: $0 {deploy <artifact>|rollback|status}" >&2; exit 2 ;;
esac
```

静态检查与语法验证：

```bash
shellcheck -S warning /opt/app/bin/deploy.sh
bash -n /opt/app/bin/deploy.sh
shfmt -d /opt/app/bin/deploy.sh
```

预期输出（通过时为空）：

```text
$ shellcheck -S warning /opt/app/bin/deploy.sh && echo "shellcheck ok"
shellcheck ok
```

一次正常发布：

```bash
./deploy.sh deploy /tmp/order-api-20261113.tar.gz
```

```text
2026-11-13T14:02:11Z [INFO ] health ok after 5 tries
2026-11-13T14:02:11Z [INFO ] deployed order-api-20261113140211-8f3a1c2d
2026-11-13T14:02:11Z [INFO ] remove old release order-api-20261105101010-11aa22bb
2026-11-13T14:02:11Z [INFO ] finished rc=0
```

失败注入：故意发布一个健康检查返回 500 的包。

```bash
./deploy.sh deploy /tmp/order-api-broken.tar.gz
```

```text
2026-11-13T14:08:23Z [ERROR] health check failed, rolling back
2026-11-13T14:08:35Z [INFO ] health ok after 3 tries
2026-11-13T14:08:35Z [ERROR] deploy failed, rolled back to /opt/order-api/releases/order-api-20261113140211-8f3a1c2d
2026-11-13T14:08:35Z [INFO ] finished rc=1
```

健康检查要求连续 3 次成功，且每次都用 `-f` 校验状态码，避免旧进程残留响应或 500 被当成健康。要求更严格时，可以让新版本先在独立端口启动，确认健康后再切流，这样新旧版本不会争同一个端口。

三节点滚动发布由外层循环完成，负载均衡在健康检查失败时自动摘流：

```bash
for host in prod-01 prod-02 prod-03; do
  scp /tmp/order-api-20261113.tar.gz "deploy@${host}:/tmp/"
  ssh "deploy@${host}" "/opt/app/bin/deploy.sh deploy /tmp/order-api-20261113.tar.gz" \
    || { echo "failed on ${host}, stop rolling" >&2; exit 1; }
  sleep 10
done
```

### 11.3 案例结果

三次真实发布与两次故障注入的结果（示例数据，口径来自一次复现实验）：

| 指标 | 手工方式 | 脚本方式 |
|---|---|---|
| 单节点发布时间 | 90–150 秒 | 32–45 秒 |
| 失败后恢复 | 10–30 分钟 | 12–18 秒自动回滚 |
| 发布期间 5xx | 偶发 | 0 |
| 历史版本 | 无 | 保留 5 个 |

复盘：

- 第一次故障注入时脚本没有回滚，原因是 `health_check` 里用了 `curl -s`，500 也被当成成功；改成 `-f` 后通过。健康检查必须校验状态码，不能只看“有响应”。
- `set -e` 与 `||` 组合让 `tar` 失败时没有进入清理分支，后来显式写了 `|| { rm -rf; die; }`，保证半成品目录不残留。
- 清理旧版本最初写成 `rm -rf "$RELEASES"/*`，在变量为空时会误删；改成 `find` 加路径前缀校验后才进入常态化运行。
- 数据库迁移没有纳入本脚本，回滚只回代码；涉及 schema 变更时必须按“扩展—回填—收缩”拆分发布，否则旧版本无法读新表。
