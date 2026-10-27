# Shell 脚本

## 一、工程案例：一个不会把备份做丢的脚本

**场景**：给一台服务器写每日 MySQL 备份。要求：

- 每天 03:00 自动跑，失败要能被发现
- 备份要压缩、要能自动清理旧文件
- 不能因为「磁盘满了」「密码错了」「上一次还没跑完」而静默失败

**为什么这件事值得写脚本**：手工备份一定会漏。而**写错的备份脚本比没有更危险**——它会每天报成功，直到你真的需要恢复那天。

### 1.1 主线：一个能上生产的最小脚本

```bash
#!/usr/bin/env bash
set -euo pipefail                    # 任何一步失败就停，别带着错误往下跑

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_NAME="${DB_NAME:-app}"
DB_USER="${DB_USER:-backup}"
DB_PASS="${DB_PASS:-}"
BACKUP_DIR="${BACKUP_DIR:-/data/backup/mysql}"
KEEP_DAYS="${KEEP_DAYS:-7}"
MIN_FREE_MB="${MIN_FREE_MB:-2048}"

log() { printf '%s [%s] %s\n' "$(date '+%F %T')" "$1" "${*:2}"; }
die() { log ERROR "$@"; exit 1; }

# ① 前置检查：宁可现在退出，也别生成一个空文件
[ -n "$DB_PASS" ] || die "DB_PASS 未设置"
command -v mysqldump >/dev/null || die "找不到 mysqldump"
mkdir -p "$BACKUP_DIR"

free_mb=$(df -Pm "$BACKUP_DIR" | awk 'NR==2 {print $4}')
[ "$free_mb" -ge "$MIN_FREE_MB" ] || die "剩余空间不足：${free_mb}MB < ${MIN_FREE_MB}MB"

# ② 单实例锁：上次没跑完就跳过，不排队
exec 200>"/tmp/$(basename "$0").lock"
flock -n 200 || die "已有实例在运行，本次跳过"

# ③ 备份：先写临时文件，成功后再改名
ts=$(date +%F_%H%M%S)
out="${BACKUP_DIR}/${DB_NAME}_${ts}.sql.gz"
tmp="${out}.part"

log INFO "开始备份 ${DB_NAME} -> ${out}"
if ! mysqldump \
      --single-transaction --quick --routines --triggers --events \
      -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" \
      2>"${out}.err" | gzip >"$tmp"; then
    log ERROR "mysqldump 失败：$(tail -1 "${out}.err")"
    rm -f "$tmp"
    exit 2
fi

# ④ 验收：文件必须非空、且真的是 gzip
[ -s "$tmp" ] || { rm -f "$tmp"; die "备份文件为空"; }
gzip -t "$tmp" || { rm -f "$tmp"; die "备份文件损坏"; }
mv "$tmp" "$out"
log INFO "备份完成 $(du -h "$out" | cut -f1)"

# ⑤ 清理：DRY_RUN=1 只打印，确认后再真删
if [ "${DRY_RUN:-0}" = "1" ]; then
    find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -type f -mtime "+$KEEP_DAYS" -print
else
    find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -type f -mtime "+$KEEP_DAYS" -delete
fi
log INFO "已清理 ${KEEP_DAYS} 天前的备份（DRY_RUN=${DRY_RUN:-0}）"
```

挂到 crontab：

```bash
# /etc/cron.d/app-backup（多一个用户字段）
0 3 * * * root . /opt/app/app.env && /usr/bin/bash /opt/scripts/mysql-backup.sh >> /var/log/mysql-backup.log 2>&1
```

### 1.2 验收（6 项，全部要真跑）

| # | 场景 | 怎么做 | 通过标准 |
|---|---|---|---|
| 1 | 正常备份 | 直接跑 | 退出码 0，目录里有 `.sql.gz`，`gzip -t` 通过 |
| 2 | 密码错误 | `DB_PASS=wrong ./script.sh` | 退出码 2，日志有「mysqldump 失败」，**没有残留文件** |
| 3 | 缺变量 | `env -u DB_PASS ./script.sh` | 立刻退出，提示「DB_PASS 未设置」 |
| 4 | 并发 | 同时跑两个 | 第二个直接跳过，不产生两个文件 |
| 5 | 空间不足 | 把 `MIN_FREE_MB` 设成 999999 | 前置检查就退出 |
| 6 | **恢复验证** | 拿备份到测试库 `gunzip < x.sql.gz \| mysql testdb` | 能导入，表和数据都在 |

> **第 6 项是唯一真正重要的**。「备份成功」不等于「能恢复」——过期密码、权限变更、表结构不兼容，都只有恢复时才暴露。

---

## 二、高频问答：会卡住你的地方，也是面试最常问的

### 2.1 `set -e` 没生效，脚本还是继续往下跑

**现场**

让每条命令自己报退出码，就能看出是哪条没停。

```bash
set -euo pipefail

# ✘ 这条失败不会停，因为它在 if 里
if mycmd; then ...

# ✘ cmd 在管道中间，失败也看不见（没有 pipefail 时）
cmd | gzip > x

# ✔ 显式判断最稳
mycmd || { echo "mycmd 失败"; exit 1; }
```

**要点**

- `set -e` 有一堆**例外**：`if` 条件里、`&&`/`||` 左边、`!` 取反、管道中间（除非 `pipefail`）、`local x=$(cmd)` 的赋值。
- 它是「兜底」，不是「保证」，关键步骤显式写 `|| die` 才可靠。
- 管道要连中间段的失败一起传出来，还得再开 `pipefail`。

**追问**

- 为什么 `if mycmd` 失败也不停？→ 退出码被 `if` 消费了，它属于「被检查的条件」。
- `local x=$(cmd)` 为什么会漏？→ 拿到的是 `local` 这条内建命令的退出码，不是命令替换的。
- 那三件套还值得写吗？→ 值得，它能兜住大多数意外，例外处自己补判断。

> `set -e` 是「兜底」，不是「保证」。**关键步骤显式写 `|| die`**，别指望它。

### 2.2 `-u` 报 `unbound variable`，明明赋过值

**现场**

用 `${var:-默认值}` 的写法试一次，看是否还报。

```bash
set -u
name="${1:-}"                 # 位置参数没传也不报错
echo "${name:-未命名}"

arr=()
for x in "${arr[@]:-}"; do echo "$x"; done   # 空数组的兼容写法
```

**要点**

- 报错说的是「执行到这条命令时这个变量没有值」，不是「变量从来不存在」。
- 三个高发点：`$1` 没传、`${arr[@]}` 在空数组上、变量只在某个 `if` 分支里才赋值。
- 兼容写法是 `${var:-}`、`${arr[@]:-}`，给一个空默认值。

**追问**

- `set -u` 下 `$1` 怎么安全用？→ 写 `${1:-}`，或用 `$#` 先判断个数。
- `${var:-}` 和 `${var-}` 差在哪？→ 带冒号时空值也算未设置，不带冒号只管完全未定义。

### 2.3 变量赋值后 `-u` 仍然报错：等号两边有空格

**现场**

报错通常是 `VAR: command not found`，不是语法错误提示。

```bash
VAR="x"        # ✔
VAR = "x"      # ✘ command not found
```

**要点**

- `VAR = "x"` 会被当成「执行一个叫 VAR 的命令」，参数是 `=` 和 `x`，而不是赋值。
- 赋值语句**等号两边不能有空格**，这是语法层面的硬规定。
- 认错的标志是报错里出现变量名加 `command not found`。

**追问**

- 为什么报的是 command not found？→ 这一行的第一个词被当成命令名了。
- `VAR= x` 又是什么？→ 空赋值的临时环境变量前缀，真正执行的是命令 `x`。

### 2.4 `[ -n $VAR ]` 在变量为空时结果为真

**现场**

```bash
# ✘
[ -n $VAR ] && echo "有值"

# ✔ 总是加引号
[ -n "$VAR" ] && echo "有值"
[[ -n $VAR ]] && echo "有值"     # [[ ]] 内部不会做分词，不加引号也安全
```

用 `bash -x` 看展开后的命令，就能看到 `[ -n ]` 只剩一个参数。

**要点**

- 变量为空又没加引号时，这一行展开成 `[ -n ]`，只剩一个参数，`[` 认为它是「非空字符串」→ 为真。
- 根因是分词：没引号的空变量直接消失，要判断的对象都没了。
- 默认写法就是加引号；`[[ ]]` 内部不分词，不加也安全。

**追问**

- 为什么 `[` 对一个参数返回真？→ 单参数的 `[` 等价于判断「这个字符串非空」。
- `[[ ]]` 为什么安全？→ 它是语法不是命令，不做分词和通配符展开。
- `[[ ]]` 有什么代价？→ 只有 bash/ksh 有，`sh`(dash) 里没有。

> **`[` 是命令，`[[` 是语法**。`[[ ]]` 更安全（不做分词、支持 `=~`），但只存在于 bash/ksh，`sh`(dash) 里没有。

### 2.5 脚本在终端能跑，cron 里失败

**现场**

用空环境复现，一次就能看出来是环境问题。

```bash
env -i /bin/bash --noprofile --norc -c '/opt/scripts/x.sh'
```

**要点**

- 脚本本身没坏，是 cron 的环境和你的登录终端不一样。
- 四个差异：PATH 短、没有 LANG（中文乱码）、工作目录是 `$HOME`、不读 `~/.bashrc`。
- 修法三件套：脚本开头设 `PATH`、`cd` 到固定目录、所有命令用绝对路径。

**追问**

- 为什么手动跑好好的？→ 你登录时 `~/.bashrc` 已经替你把 PATH 和 LANG 补好了。
- cron 的 PATH 到底多短？→ 通常只有 `/usr/bin:/bin`，`/usr/local/bin` 里的东西它就找不到。
- crontab 里 `%` 有什么坑？→ 不转义会被当换行，命令被截断。

### 2.6 脚本把生产文件删多了

**现场**

**先 `echo` 再执行**，把要删的清单当预览看一遍。

```bash
# ✔ 危险动作先打印
find "$DIR" -name "*.log" -mtime +30 -print      # 先看会删哪些
find "$DIR" -name "*.log" -mtime +30 -delete     # 确认后再删

# ✔ 路径变量必须有值
: "${DIR:?DIR 未设置}"        # 为空就直接退出
rm -rf -- "${DIR:?}/tmp"
```

**要点**

- 删多了通常不是 `find`/`rm` 有 bug，而是路径变量为空或通配符写宽。
- 变量为空会把路径变成 `/` 或当前目录，通配符写宽是同一类问题。
- `find -delete` 少了 `-type f` 会连目录一起删。

**追问**

- `rm -rf "$VAR"/*` 有多危险？→ `VAR` 为空时就变成 `rm -rf /*`。
- 最便宜的保险是什么？→ `: "${DIR:?DIR 未设置}"`，为空立刻退出。
- 命令里为什么写 `--`？→ 终止选项解析，防文件名以 `-` 开头被当参数。

> `rm -rf "$VAR"` 在 `VAR` 为空时等价于 `rm -rf ""`（多数情况无害），但 `rm -rf "$VAR"/*` 会变成 `rm -rf /*`。**加 `:?` 是最便宜的保险**。

### 2.7 并发跑出两份备份 / 两个进程互相踩

**现场**

用 `flock` 之后问题消失，这是验证方式也是解法。

```bash
exec 200>/tmp/my.lock
flock -n 200 || { echo "已在运行"; exit 0; }
# ... 业务 ...
# 脚本退出时 fd 关闭，锁自动释放
```

**要点**

- 加 `if` 判断进程在不在解决不了：`ps | grep` 有竞态，检查完到启动之间可能被插进来。
- `flock` 是内核级的锁，检查和加锁在同一步完成，不存在这个窗口。
- 它比 pid 文件可靠：进程被 `kill -9` 时 pid 文件会残留，而锁随进程消失自动释放。

**追问**

- 锁文件为什么要 `exec 200>`？→ fd 绑在脚本生命周期上，脚本一退就关闭、就释放。
- `flock -n` 和 `-w` 差在哪？→ 前者拿不到立刻失败，后者等指定秒数。
- 跳过了要不要报错退出？→ 通常 `exit 0`，「已有实例在跑」不是失败。

> **`flock` 比 pid 文件可靠**：进程被 `kill -9` 时，pid 文件会残留，而 `flock` 随进程消失自动释放。

### 2.8 中文输出乱码

**现场**

两步：`locale` 看环境，`file -I` 看文件本身。

```bash
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
# 文件统一存成 UTF-8，不要混 GBK
```

**要点**

- 终端本身多半没问题，是运行环境没有 `LANG`，默认 `C`/POSIX，非 ASCII 直接出乱码。
- 也可能是文件本身就是 GBK，那就跟环境无关。
- 定位顺序：先看环境 (`locale`)，再看文件编码 (`file -I`)。

**追问**

- 为什么本地正常、cron 乱码？→ cron 不继承你登录时的 locale 环境。
- `LANG` 和 `LC_ALL` 谁优先？→ `LC_ALL` 优先，设了它 `LANG` 基本就不起作用。
- 文件编码怎么管？→ 一律存 UTF-8，别在同一套脚本里混 GBK。

### 2.9 脚本退出码永远 0，监控发现不了失败

**现场**

故意制造一次失败，看 `echo $?` 到底返回什么。

```bash
set -euo pipefail            # 必须三件套
trap 'exit_code=$?; log ERROR "第 $LINENO 行失败"; exit $exit_code' ERR
```

**要点**

- 最后一条命令的退出码就是脚本的退出码，`echo`/`log` 会把前面的失败覆盖掉。
- 用了管道却没开 `pipefail` 时，取的是最后一段的退出码。
- 想被监控发现，必须让失败真的变成非 0，而不是只写一行日志。

**追问**

- 加了 `set -e` 为什么还是 0？→ 失败之后的命令成功了，退出码被后面这条覆盖。
- `trap` 里为什么要先存 `$?`？→ 一进 trap 就会执行别的命令，`$?` 立刻被改掉。
- 监控该怎么看？→ 只看退出码，别去 grep 日志里的「成功」。

### 2.10 `for` 循环处理文件名带空格的文件出错

**现场**

造一个带空格的文件名试一次，一次就能复现。

```bash
# ✘
for f in $(ls *.log); do rm "$f"; done

# ✔ 通配符 + 引号
for f in *.log; do rm -- "$f"; done

# ✔ find 输出交给 while read
find . -name "*.log" -print0 | while IFS= read -r -d '' f; do rm -- "$f"; done
```

**要点**

- `for f in $(ls)` 会按空白分词，`a b.txt` 被拆成两个名字。
- 根因是命令替换的结果一定会被再分词，加引号也救不回中间那一步。
- 正确写法是通配符 + 引号：`for f in *.log`，用的时候 `"$f"`。

**追问**

- 文件名里连换行都有怎么办？→ `find -print0` 配 `read -r -d ''`。
- `*.log` 没匹配到时呢？→ 原样保留字面量，要 `[ -e "$f" ] || continue`。
- `rm -- "$f"` 里的 `--` 干什么？→ 终止选项解析，防文件名以 `-` 开头。

---

## 三、核心知识：从零开始要建立的东西

### 3.1 脚本的构成与执行

**一个文本文件，里面是「你平时一条条敲的命令」，交给 Shell 批量执行。**

```bash
#!/usr/bin/env bash     # ← 这一行叫 shebang
echo "hello"
date
```

三行里有两个知识点：

**① shebang（`#!` 开头那一行）告诉内核「用哪个解释器跑这个文件」。**

```bash
#!/bin/bash            # 直接指定路径。服务器脚本更推荐这个：行为可预期
#!/usr/bin/env bash    # 从 PATH 里找 bash；机器间可移植，但 PATH 意外时可能找错解释器
#!/bin/sh              # POSIX sh：在 Ubuntu 上其实是 dash，很多 bash 语法不支持
```

**服务器脚本用 `#!/bin/bash`**：`env` 版的可移植性换来的是不确定性——cron 和 systemd 的 PATH 很短，如果某个目录里放了一个不同版本的 bash，脚本行为就会变。容器或跨机器分发才优先考虑 `env` 版。

**用 `#!/bin/sh` 却写了 `[[ ]]`、数组、`local`，就会报错**——这是新手最常见的失败原因之一。

**② 脚本要能执行，需要两点**：文件有执行权限（`chmod +x`），并且用 `./script.sh` 或绝对路径调用（当前目录通常不在 `PATH` 里）。

```bash
chmod +x backup.sh      # 加执行权限
./backup.sh             # 方式一：当命令跑
bash backup.sh          # 方式二：显式用 bash 解释（不需要 x 权限）
source backup.sh        # 方式三：在当前 shell 执行（见 3.2）
```

### 3.2 子进程执行与 source

```mermaid
flowchart LR
    classDef a fill:#DBEAFE,stroke:#2563EB,color:#1E3A8A
    classDef b fill:#DCFCE7,stroke:#16A34A,color:#14532D
    classDef c fill:#FEF3C7,stroke:#D97706,color:#78350F

    T["你的终端（bash 进程 A）"]:::a --> N["启动新进程 B 跑脚本"]:::b
    N --> E["B 里 cd / export 只影响 B"]:::c
    E --> R["B 结束，A 什么都没变"]:::a
    linkStyle default stroke:#94A3B8,stroke-width:1.5px
```

| 执行方式 | 是否新进程 | 能否改当前 shell 的 cd / 变量 |
|---|---|---|
| `./script.sh` | 是 | 不能 |
| `bash script.sh` | 是 | 不能 |
| `source script.sh` / `. script.sh` | **否** | **能** |

**这个区别的实际用途**：

- **要改当前环境**（`cd`、`export`、定义函数）→ 必须 `source`。所以 `~/.bashrc`、`/opt/app/app.env` 都是被 `source` 的。
- **要做一件事**（备份、清理）→ 用 `./` 或 `bash`，别污染当前 shell。

> **`source` 的坑**：如果被 source 的文件里有 `exit`，会把你的终端一起关掉。

> **面试**：常问「`./script.sh` 和 `source script.sh` 有什么区别？」答：前者起子进程，cd 和变量只影响子进程；后者在当前 shell 执行。

### 3.3 脚本基本结构

一个能用的脚本长这样，**五部分**：

```bash
#!/usr/bin/env bash      # ① shebang
set -euo pipefail        # ② 严格模式

# ③ 配置：集中放最上面，带默认值
BACKUP_DIR="${BACKUP_DIR:-/data/backup}"
KEEP_DAYS="${KEEP_DAYS:-7}"

# ④ 函数
log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# ⑤ 主逻辑，放在 main 里
main() {
    [ -d "$BACKUP_DIR" ] || die "目录不存在：$BACKUP_DIR"
    log "开始"
}

main "$@"                # 最后调用，把参数传进去
```

**为什么要 `main`**：函数里的变量用 `local` 就不会污染全局；`main` 让「定义」和「执行」分开，便于 `source` 进来做单元测试。

### 3.4 严格模式

三个选项各管一件事，**三个都要写**：

| 选项 | 作用 | 不写会怎样 |
|---|---|---|
| `-e` | 命令失败（非 0）就退出 | 出错继续跑，后面基于错误状态继续操作 |
| `-u` | 用未定义变量就退出 | `rm -rf "$TYPO/"` 变成删根 |
| `-o pipefail` | 管道任一段失败即整体失败 | **备份失败但脚本报成功**（最常见事故） |

**`-e` 的例外**（必须知道，否则会误以为它万能）：`if` 条件里、`&&`/`||` 左边、`!` 取反、管道中间、`local x=$(cmd)`。

**`pipefail` 为什么最重要**：没有它，`mysqldump | gzip > x.gz` 里 mysqldump 失败了，退出码取的是 gzip 的 0。

```bash
set -o pipefail
false | true; echo $?        # 有 pipefail：1；没有：0
```

> **面试**：常问「`set -euo pipefail` 三个选项各管什么？」答：-e 失败即退、-u 未定义变量即退、pipefail 让管道任一段失败即整体失败。

### 3.5 变量与参数

**赋值**：等号两边**不能有空格**。

```bash
NAME="web01"          # ✔
NAME = "web01"        # ✘ 被当成执行命令
```

**引用**：默认加双引号，除非你明确要分词。

| 写法 | 含义 |
|---|---|
| `$VAR` | 分词 + 通配符展开（危险） |
| `"$VAR"` | 原样一个参数（**默认就这么写**） |
| `'$VAR'` | 单引号里**不展开**，原样输出 `$VAR` |
| `${VAR}` | 明确变量名边界（`${VAR}_x` 才不会读成 `$VAR_x`） |

**默认值三兄弟**（非常常用）：

| 写法 | 含义 |
|---|---|
| `${VAR:-默认}` | 为空或未定义 → 用默认值 |
| `${VAR:=默认}` | 同上，并**赋值**给 VAR |
| `${VAR:?错误}` | 为空 → 打印错误并退出（危险操作的保险） |

**字符串处理**（够用就行）：

```bash
${#VAR}              # 长度
${VAR%.*}            # 去掉最后一个 . 及其后面（取文件名）
${VAR%/*}            # 去掉最后一个 / 及其后面（取目录）
${VAR#*/}            # 去掉第一个 / 及其前面
${VAR/old/new}       # 替换第一个
${VAR//old/new}      # 替换全部
```

**命令替换**：把命令的输出当成值。

```bash
NOW=$(date +%F)          # 推荐，可嵌套
NOW=`date +%F`           # 老写法，不能嵌套
```

**位置参数**：`$0` 脚本名、`$1` 第一个参数、`$#` 参数个数、`"$@"` 所有参数（**必须加引号**）。

### 3.6 条件判断

| 写法 | 归属 | 特点 |
|---|---|---|
| `[ ]` | POSIX 命令 | 兼容性最好，**必须加引号**，不支持 `=~` |
| `[[ ]]` | bash 语法 | 推荐使用，安全（不分词）、支持 `&&`/`\|\|`/`=~`，**只在 bash/ksh 有** |
| `(( ))` | bash 算术 | `if (( n > 10 ))`，比 `[ $n -gt 10 ]` 可读 |

**最常用的判断**：

```bash
# 字符串
[ -z "$VAR" ]        # 为空
[ -n "$VAR" ]        # 非空
[ "$A" = "$B" ]      # 相等（注意 = 两边有空格）

# 数字（用 -eq/-gt 这类，不能用 < >）
[ "$n" -gt 10 ]
(( n > 10 ))         # 更直观

# 文件[ -f file ]          # 是普通文件
[ -d dir ]           # 是目录
[ -e path ]          # 存在（不分类型）
[ -r file ]          # 可读
[ -s file ]          # 存在且非空（判断备份是否为空就用它）
[ -x file ]          # 可执行
```

**数字判断的坑**：`[ "$n" -gt 10 ]` 在 `n` 为空或不是数字时会报 `integer expression expected`；`(( n > 10 ))` 把空值当 0，不报错。要严格校验先判断格式：

```bash
[[ "$n" =~ ^[0-9]+$ ]] || die "n 不是整数：$n"
```

**`&&` 和 `||` 的短路用法**（比 `if` 简洁，但别嵌套太深）：

```bash
[ -d /data ] || mkdir -p /data          # 不存在才建
[ -n "$DB_PASS" ] || die "密码未设置"     # 为空就退出
```

> **面试**：常问「`[ ]` 和 `[[ ]]` 有什么区别？」答：前者是 POSIX 命令、必须加引号，后者是 bash 语法、不分词且支持 `=~`。

### 3.7 循环

```bash
# ① 遍历列表
for env in dev test prod; do
    echo "部署 $env"
done

# ② 遍历文件（用通配符，不要用 $(ls)）
for f in /data/logs/*.log; do
    [ -e "$f" ] || continue          # 没有匹配时通配符会原样保留，要跳过
    gzip "$f"
done

# ③ 按行读文件（最不容易出错）
while IFS= read -r line; do
    echo "$line"
done < hosts.txt

# ④ 数字循环
for i in $(seq 1 5); do echo "$i"; done
for ((i=1; i<=5; i++)); do echo "$i"; done
```

**三个坑**：

| 坑 | 说明 |
|---|---|
| `for f in $(ls)` | 按空格分词，文件名带空格会被拆开（见 2.10） |
| 管道里的 `while` 在子 shell | `cat f \| while read` 里改的变量，循环外看不到。用 `while ... done < f` |
| 没有匹配时 `*.log` 原样保留 | 要 `[ -e "$f" ] \|\| continue`，或 `shopt -s nullglob` |

### 3.8 函数

```bash
log() {
    local level="$1"; shift           # ① local：变量只在函数内有效
    printf '%s [%s] %s\n' "$(date '+%F %T')" "$level" "$*"
}                                     # ② $* 是所有参数拼成一个串
```

**两个必须知道的**：

- **`local` 一定要写**：不写就是全局变量，会意外改掉外面的同名变量
- **`return` 只能返回 0–255**：要返回字符串，用 `echo` + 命令替换 `result=$(myfunc)`

**参数相关**：`$1` 第一个参数、`$#` 个数、`"$@"` 全部（各自保留引号）、`shift` 把参数左移一位（常用于「取第一个，剩下继续处理」）。

### 3.9 退出码与错误处理

**退出码是脚本和外界沟通的唯一方式**：`0` 成功，非 0 失败。

```text
1    一般错误
2    用法/参数错误
126  权限不够（无法执行）
127  命令找不到
128+n 被信号 n 杀掉（130 = Ctrl+C）
```

**自己约定业务退出码**，让调用方（cron、监控）能区分：

```bash
die() { echo "$*" >&2; exit "${2:-1}"; }
die "参数错误" 1
die "备份失败" 2      # 监控看到 2 就知道是备份问题
```

> **`echo "$*" >&2` 很关键**：错误信息要写 stderr，否则混在正常输出里会被当成数据。

**`trap` 是清理的唯一正确姿势**：

```bash
TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT               # 正常结束、异常退出、被信号杀掉都会执行

trap 'echo "第 $LINENO 行出错"' ERR
```

| 信号 | 时机 |
|---|---|
| `EXIT` | 脚本结束（无论成功失败） |
| `ERR` | 某条命令失败（配合 `set -e`） |
| `INT` / `TERM` | Ctrl+C / kill |

> **`trap ... EXIT` 里不要再写会失败的命令**，否则退出码被覆盖，调用方看到的是「成功」。

> **面试**：常问「备份脚本怎么保证失败能被监控发现？」答：让失败真的返回非 0，关键步骤显式 `|| die`，再用 `trap` 把原始退出码存下来。

### 3.10 日志与输出

| 运行方式 | 推荐 | 原因 |
|---|---|---|
| 手工执行 | `echo` 到终端 | 直接看 |
| cron | `>> /var/log/xxx.log 2>&1` | cron 没有终端，不重定向就丢 |
| systemd | 写 stdout，交给 journald | `journalctl -u xxx` 统一查 |

**一条好日志包含四样**：时间、级别、关键参数、结果。

```bash
log INFO "备份完成 file=$out size=12M"
```

**别写只写「失败」的日志**——要能回答「谁失败了、失败在哪一步、当时的参数是什么」。

### 3.11 调试方法

```bash
bash -x script.sh          # 逐行打印「展开后」的命令（最常用）
bash -n script.sh          # 只做语法检查，不执行
set -x / set +x            # 在脚本内部局部开启/关闭
```

**让 `-x` 的输出更有用**：

```bash
PS4='+${BASH_SOURCE}:${LINENO}: '     # 打印文件名和行号
```

**静态检查**：`shellcheck script.sh` 能抓出大部分坑（未加引号、`cd` 未检查、变量拼写），**建议装**。

### 3.12 可维护性

| 做法 | 理由 |
|---|---|
| 顶部集中定义变量与默认值 | 改配置不用翻全文 |
| `main()` + 底部 `main "$@"` | 逻辑集中，便于测试 |
| 一个函数只做一件事 | 出错时容易定位 |
| 用 `(cd x && cmd)` 而不是 `cd x` | 不影响后续逻辑 |
| 危险操作用 `: ${VAR:?}` 兜底 | 变量为空时立刻退出 |
| 不留注释掉的死代码 | 版本管理会记住历史 |

---

## 四、冷门知识汇总

| 知识点 | 为什么冷门 | 用到时的关键词 |
|---|---|---|
| `shopt -s nullglob` | 通配符没匹配时才需要 | 默认会原样保留 `*.log` |
| 进程替换 `<(...)` | 需要「把命令输出当文件」时 | `diff <(sort a) <(sort b)` |
| `${!name}` 间接引用 | 写通用校验函数时才会用 | `ref="VAR_x"; echo "${!ref}"` |
| `${VAR@Q}` | bash 5 才有，输出带引号的安全形式 | `printf '%q'` 的替代 |
| 关联数组 `declare -A` | 需要 map 结构时才用 | `declare -A m; m[k]=v` |
| `mapfile` / `readarray` | 一次读文件进数组 | `mapfile -t lines < f` |
| `wait -n` | 并发任务等「任意一个」完成 | bash 4.3+ |
| `printf` 对齐 | 需要表格化输出时 | `printf "%-20s %s\n"` |
| `numfmt` | 字节转人类可读 | `numfmt --to=iec 1048576` |
| `mktemp -d` | 临时目录，配合 `trap` 清理 | `TMP=$(mktemp -d)` |
| `PS4` 自定义 | 调试时让 `-x` 带行号 | `PS4='+${BASH_SOURCE}:${LINENO}: '` |
| `time` / `$SECONDS` | 统计脚本耗时 | `SECONDS=0; ...; echo $SECONDS` |
| `bc` / `awk` | bash 只支持整数运算 | `echo "scale=2; 7/3" \| bc` |
| `jq` | 处理 JSON 返回值 | `curl ... \| jq -r '.data.id'` |
| `crontab -r` 危险 | 无确认直接清空所有任务 | 别在生产上按 |
| 退出码 128+n | 被信号杀掉的判定方式 | `$?` = 130 → SIGINT |
| `BASH_SOURCE` | 取当前脚本路径（找同目录的其他文件） | `cd "$(dirname "${BASH_SOURCE[0]}")"` |
