---
title: "Rust特征与错误处理"
category: "05-后端"
---

# Rust特征与错误处理

> 这篇从共享行为的抽象讲起，经过 trait 定义与默认实现、泛型约束、标准库常用 trait、`Option` 与 `Result`，最后落到用 `?`、`thiserror`、`anyhow` 组织一条可定位的错误链。
>
> 学完能为一个模块设计 trait 边界、在静态分发与动态分发之间做选择，并把散落的 `unwrap` 改造成带上下文、可分类处理的错误路径。

## 一、特征：共享行为的契约

trait（特征）定义一组方法签名，任何类型都可以声明实现它。trait 是 Rust 多态的基础：泛型约束、trait 对象、运算符重载都建立在它上面。

```rust
trait Shape {
    // 只有签名，没有函数体：实现者必须提供
    fn area(&self) -> f64;

    // 有默认实现：实现者可以覆盖，也可以直接复用
    fn describe(&self) -> String {
        format!("面积 {:.2}", self.area())
    }
}

struct Circle { radius: f64 }
struct Rect { w: f64, h: f64 }

impl Shape for Circle {
    fn area(&self) -> f64 {
        std::f64::consts::PI * self.radius * self.radius
    }
}

impl Shape for Rect {
    fn area(&self) -> f64 { self.w * self.h }

    // 覆盖默认实现：同样一个方法名，行为按类型定制
    fn describe(&self) -> String {
        format!("矩形 {:.2}x{:.2}", self.w, self.h)
    }
}

fn main() {
    let c = Circle { radius: 1.0 };
    let r = Rect { w: 2.0, h: 3.0 };
    println!("{}", c.describe()); // 面积 3.14
    println!("{}", r.describe()); // 矩形 2.00x3.00
}
```

trait 与接口的区别在三点：trait 可以提供默认实现；trait 可以为外部类型实现（孤儿规则限制在「类型或 trait 至少一个在本地 crate」）；trait 可以带关联类型和关联常量，表达比方法集合更强的约束。

### 1.1 孤儿规则与实现位置

实现 `impl Trait for Type` 时，`Trait` 或 `Type` 至少有一个必须在当前 crate 内，否则报 `E0117`。这条规则防止两个库分别为同一个外部类型实现同一个外部 trait，导致下游无法确定用哪份实现。

```rust
// 可以：trait 是本地定义的
trait Local { fn tag(&self) -> &'static str; }
impl Local for String {
    fn tag(&self) -> &'static str { "string" }
}

// 可以：类型是本地定义的（Circle 沿用本章开头的定义）
impl std::fmt::Display for Circle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Circle(r={})", self.radius)
    }
}

fn main() {
    println!("{}", String::from("x").tag());
    println!("{}", Circle { radius: 2.0 });
}
```

> 边界：想为 `Vec<T>` 实现 `Display` 做不到，因为 `Vec` 和 `Display` 都在标准库。正确做法是定义本地包装类型 `struct Wrapper(Vec<T>)`，或用扩展 trait 提供新方法名。

### 1.2 trait 作为参数：`impl Trait` 与 `dyn Trait`

两种写法都接受「实现了某个 trait 的值」，但分发方式和限制不同。以下代码沿用本章开头的 `Shape`、`Circle`、`Rect` 定义。

```rust
fn draw_static(item: &impl Shape) -> String {
    // 单态化：编译器为每个具体类型生成一份函数
    item.describe()
}

fn draw_dynamic(item: &dyn Shape) -> String {
    // 虚表分发：一份函数处理所有实现，运行期查表
    item.describe()
}

fn draw_boxed(items: &[Box<dyn Shape>]) -> usize {
    // 异构集合必须装箱：元素大小不同，无法放进同一个 Vec
    items.len()
}

fn main() {
    let c = Circle { radius: 1.0 };
    let r = Rect { w: 2.0, h: 3.0 };
    println!("{}", draw_static(&c));
    println!("{}", draw_dynamic(&r));
    println!("{}", draw_boxed(&[Box::new(c), Box::new(r)]));
}
```

| 维度 | `impl Trait` / 泛型 | `dyn Trait` |
|---|---|---|
| 分发时机 | 编译期单态化 | 运行期虚表 |
| 性能 | 可内联，无间接跳转 | 一次指针间接 + 不能内联 |
| 代码体积 | 每个类型一份，膨胀 | 一份 |
| 异构集合 | 不支持 | `Vec<Box<dyn Trait>>` 支持 |
| 对象安全 | 无限制 | 方法不能返回 `Self`、不能有泛型参数 |

> 边界：优先用泛型；只有需要「运行期决定类型」或「集合里放不同实现」时才用 `dyn`。trait 含泛型方法或返回 `Self` 时不是对象安全的，不能写成 `dyn Trait`。

## 二、泛型与约束

泛型让一份代码适配多种类型，trait bound 规定这些类型必须具备什么能力。约束越窄，可复用的类型越多；约束缺失，函数体里就调不到需要的方法。

### 2.1 泛型函数

```rust
// T: PartialOrd 表示 T 支持比较；没有这个约束，`>` 无法编译
fn largest<T: PartialOrd>(list: &[T]) -> Option<&T> {
    let mut iter = list.iter();
    let mut result = iter.next()?; // 空切片返回 None，避免索引越界
    for item in iter {
        if item > result {
            result = item;
        }
    }
    Some(result)
}

fn main() {
    let nums = vec![3, 7, 2];
    println!("{:?}", largest(&nums));    // Some(7)
    let words = vec!["apple", "fig"];
    println!("{:?}", largest(&words));   // Some("fig")
    println!("{:?}", largest::<i32>(&[])); // None
}
```

`largest` 返回 `Option<&T>` 而不是 `&T`：空输入没有最大值，用类型把「可能不存在」编码进签名，调用方必须处理。

### 2.2 多重约束与 where

约束超过两个，或者带关联类型时，用 `where` 子句比尖括号内堆叠更可读。

```rust
use std::fmt;

fn report<T>(item: &T) -> String
where
    T: Summary + fmt::Debug,
{
    // Debug 用于诊断输出，Summary 用于业务摘要，两个约束各司其职
    format!("{:?} => {}", item, item.summarize())
}

trait Summary {
    fn summarize(&self) -> String;
}

#[derive(Debug)]
struct Article {
    title: String,
}

impl Summary for Article {
    fn summarize(&self) -> String {
        format!("《{}》", self.title)
    }
}

fn main() {
    let a = Article { title: String::from("所有权") };
    println!("{}", report(&a));
}
```

多个类型参数各自带约束：

```rust
use std::ops::Add;

fn pair_sum<T, U>(a: T, b: T, tag: U) -> T
where
    T: Copy + Add<Output = T>,
    U: std::fmt::Display,
{
    println!("tag={}", tag); // U 只需要能打印
    a + b
}

fn main() {
    println!("{}", pair_sum(2, 3, "整数"));       // 5
    println!("{}", pair_sum(1.5, 2.5, 1));        // 4
}
```

`Add<Output = T>` 是关联类型约束：`+` 的结果必须还是 `T`，否则 `a + b` 无法作为返回值。

### 2.3 泛型结构体与方法

```rust
#[derive(Debug)]
struct Pair<T> {
    first: T,
    second: T,
}

// 约束只加在需要比较的方法上，而不是整个类型上
impl<T: PartialOrd> Pair<T> {
    fn larger(&self) -> Option<&T> {
        if self.first >= self.second {
            Some(&self.first)
        } else {
            Some(&self.second)
        }
    }
}

impl<T> Pair<T> {
    fn new(first: T, second: T) -> Self {
        Self { first, second }
    }
}

fn main() {
    let p = Pair::new(3, 9);
    println!("{:?}", p.larger()); // Some(9)

    let s = Pair::new("a".to_string(), "b".to_string());
    println!("{:?}", s); // 不调用 larger 就不需要 PartialOrd
}
```

> 边界：约束写在 `impl` 上而不是 `struct` 上。`struct Pair<T>` 不要求 `T: PartialOrd`，否则连存字符串对都不行，类型会被无谓地限制死。

### 2.4 `impl Trait` 作为返回类型

返回 `impl Trait` 表示「返回某个实现了该 trait 的具体类型」，但调用方看不到具体类型名。适合返回迭代器、闭包这类无法手写的类型。

```rust
fn evens(limit: u32) -> impl Iterator<Item = u32> {
    // 返回类型由编译器推断，调用方只知道可迭代
    (0..limit).filter(|n| n % 2 == 0)
}

fn make_adder(delta: i32) -> impl Fn(i32) -> i32 {
    move |x| x + delta // 闭包类型没有名字，只能用 impl Trait 返回
}

fn main() {
    let v: Vec<u32> = evens(10).collect();
    println!("{:?}", v); // [0, 2, 4, 6, 8]
    let add5 = make_adder(5);
    println!("{}", add5(10)); // 15
}
```

> 边界：`impl Trait` 返回值只有一个具体类型。分支里返回两种不同迭代器会报 `E0308`，解决方式是 `Box<dyn Iterator<Item = T>>` 或 `Either`。

## 三、标准库常用 trait

派生宏（derive）能为结构体和枚举自动生成一批 trait 实现。选错派生会带来语义错误，比编译错误更难查。

### 3.1 derive 清单

| 派生 | 生成行为 | 使用前提 |
|---|---|---|
| `Debug` | `{:?}` 格式化 | 所有字段实现 `Debug` |
| `Clone` | 逐字段复制 | 所有字段实现 `Clone` |
| `Copy` | 按位复制 | 所有字段 `Copy`，且无 `Drop` |
| `PartialEq` / `Eq` | `==` / 全等 | 字段可比较；`Eq` 要求无浮点 |
| `PartialOrd` / `Ord` | `<`、排序 | 字段可排序；`Ord` 是全序 |
| `Hash` | 可作 `HashMap` key | 与 `Eq` 一起派生 |
| `Default` | `Default::default()` | 所有字段有默认值 |

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
struct UserId(u64);

#[derive(Debug, Clone, PartialEq)]
struct Point {
    x: f64,
    y: f64,
}

fn main() {
    let a = UserId(7);
    let b = a; // 派生了 Copy，赋值是复制，a 仍然可用
    println!("{:?} {:?}", a, b);
    println!("{}", UserId::default().0); // 0

    let p1 = Point { x: 1.0, y: 2.0 };
    let p2 = Point { x: 1.0, y: 2.0 };
    println!("{}", p1 == p2); // true，浮点比较在这里是精确相等

    let mut ids = vec![UserId(3), UserId(1), UserId(2)];
    ids.sort(); // Ord 派生按字段字典序
    println!("{:?}", ids);
}
```

> 边界：含 `f64` 的类型不要派生 `Eq`、`Ord`、`Hash`，因为 `NaN != NaN` 破坏全序和哈希一致性，编译器会拒绝。浮点比较需要自己定义误差语义。

### 3.2 Display 与 Debug

`Debug` 面向开发者，`Display` 面向用户，后者必须手写。

```rust
use std::fmt;

struct Money {
    cents: i64,
}

impl fmt::Display for Money {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // 整数分转元，避免浮点误差
        write!(f, "{}.{:02}", self.cents / 100, self.cents.abs() % 100)
    }
}

fn main() {
    let m = Money { cents: 12345 };
    println!("{}", m); // 123.45
}
```

这个结构体没有派生 `Debug`，写 `println!("{:?}", m)` 会报 `E0277`：`Money` doesn't implement `Debug`。这是刻意的分层：`Display` 面向用户，`Debug` 面向开发者。

> 边界：实现 `Display` 不自动获得 `Debug`，反之亦然。库类型两者都该提供；日志里用 `{:?}`，面向用户的输出用 `{}`。

### 3.3 From / Into 与类型转换

`From<A> for B` 实现后，`B::from(a)` 与 `a.into()` 都可用；`Into` 由标准库根据 `From` 自动提供，不要手写。

```rust
#[derive(Debug)]
struct Celsius(f64);

impl From<f64> for Celsius {
    fn from(v: f64) -> Self {
        Celsius(v)
    }
}

impl From<Celsius> for f64 {
    fn from(c: Celsius) -> f64 {
        c.0
    }
}

fn main() {
    let t: Celsius = 36.5.into();  // 目标类型由标注推断
    println!("{:?}", t);           // Celsius(36.5)
    let raw: f64 = t.into();
    println!("{}", raw);           // 36.5
}
```

`From` 最重要的用途是给 `?` 提供错误转换：函数返回 `Result<T, MyError>` 时，内部对 `Result<T, io::Error>` 用 `?`，编译器会自动调用 `From<io::Error> for MyError`。

### 3.4 运算符重载与 Drop

运算符就是标准库的 trait：`Add`、`Sub`、`Index`、`Deref`。`Drop` 在值离开作用域时自动执行，用来释放外部资源。

```rust
use std::ops::Add;

#[derive(Debug, Clone, Copy, PartialEq)]
struct Vec2 {
    x: f64,
    y: f64,
}

impl Add for Vec2 {
    type Output = Vec2;

    fn add(self, rhs: Vec2) -> Vec2 {
        // 按值接收，小类型 Copy，避免额外借用
        Vec2 { x: self.x + rhs.x, y: self.y + rhs.y }
    }
}

struct Guard {
    name: String,
}

impl Drop for Guard {
    fn drop(&mut self) {
        // 不能在 Drop 里 panic：panic 期间再 panic 会直接 abort
        println!("[drop] {}", self.name);
    }
}

fn main() {
    let v = Vec2 { x: 1.0, y: 2.0 } + Vec2 { x: 3.0, y: 4.0 };
    println!("{:?}", v); // Vec2 { x: 4.0, y: 6.0 }

    {
        let _g = Guard { name: String::from("g1") };
        println!("作用域内");
    } // 离开作用域，自动打印 [drop] g1
}
```

> 边界：不要用 `Deref` 模拟继承。`Deref` 的语义是「智能指针解引用」，滥用会让方法解析变得难以预测。

## 四、Option：缺失值进入类型系统

`Option<T>` 是 `Some(T)` 或 `None`，编译器强制调用方处理 `None`。Rust 没有 `null`，因此不存在空指针解引用。

```rust
fn find_user(id: u32) -> Option<&'static str> {
    match id {
        1 => Some("张三"),
        2 => Some("李四"),
        _ => None, // 查不到不是错误，是正常结果，用 None 表达
    }
}

fn main() {
    println!("{:?}", find_user(1)); // Some("张三")
    println!("{:?}", find_user(99)); // None

    // if let：只关心有值的情况
    if let Some(name) = find_user(2) {
        println!("找到 {}", name);
    }

    // let else：必须有值，否则提前返回
    let Some(name) = find_user(1) else {
        println!("用户不存在");
        return;
    };
    println!("{}", name);
}
```

### 4.1 组合子：把嵌套 match 压平成链

```rust
fn main() {
    let name: Option<&str> = Some("Tom");

    println!("{:?}", name.map(str::len));                 // Some(3)
    println!("{:?}", name.map(|s| s.to_uppercase()));     // Some("TOM")
    println!("{:?}", name.and_then(|s| s.chars().next())); // Some('T')
    println!("{:?}", name.unwrap_or("default"));          // "Tom"
    println!("{:?}", None::<i32>.unwrap_or(0));           // 0

    // 把 Option 转成 Result，错误信息由调用方决定
    let e: Result<&str, &str> = name.ok_or("缺失");
    println!("{:?}", e); // Ok("Tom")
}
```

| 方法 | 作用 | 边界 |
|---|---|---|
| `map` | 有值时转换 | 闭包返回普通值 |
| `and_then` | 有值时再返回 `Option` | 避免 `Option<Option<T>>` |
| `unwrap_or` | 无值时给默认值 | 默认值会立即求值 |
| `unwrap_or_else` | 无值时调用闭包 | 默认值昂贵时用 |
| `ok_or` / `ok_or_else` | 转成 `Result` | 需要给出错误 |
| `filter` | 条件不满足转 `None` | 谓词只在 `Some` 上执行 |

### 4.2 何时可以 unwrap

`unwrap()` 在 `None` 时 panic。允许的场景只有三种：示例代码；已经用 `if` 判断过；逻辑上不可能为 `None` 且有注释说明。

```rust
fn main() {
    let config = "port=8080";
    // split_once 的结果由前面的 contains 保证存在，属于"逻辑上不可能"
    let port = config.split_once('=').map(|(_, v)| v).unwrap();
    println!("{}", port);
}
```

> 边界：库代码、服务端请求路径、外部输入解析，一律不用 `unwrap`。用 `?` 或 `expect("上下文")`，后者至少能在日志里看到失败位置。

## 五、Result 与 `?` 运算符

`Result<T, E>` 是 `Ok(T)` 或 `Err(E)`。与 `Option` 的区别是：`None` 表示「没有」，`Err` 表示「失败」，并且携带失败原因。

```rust
use std::num::ParseIntError;

fn parse_count(raw: &str) -> Result<u32, ParseIntError> {
    // parse 的错误类型固定，直接作为返回类型
    raw.parse::<u32>()
}

fn main() {
    println!("{:?}", parse_count("42")); // Ok(42)
    println!("{:?}", parse_count("x"));  // Err(ParseIntError { kind: InvalidDigit })
}
```

### 5.1 `?` 的三件事

`?` 放在返回 `Result` 的表达式后，做三件事：`Ok` 时取出值继续执行；`Err` 时提前返回；返回前调用 `From` 把错误类型转换成函数声明的错误类型。

```rust
use std::num::ParseIntError;

fn parse_len(raw: &str) -> Result<usize, ParseIntError> {
    // ? 取出 usize，失败则直接返回 Err
    let n: usize = raw.parse()?;
    Ok(n * 2)
}

fn main() {
    println!("{:?}", parse_len("21")); // Ok(42)
    println!("{:?}", parse_len("x"));  // Err(ParseIntError { kind: InvalidDigit })
}
```

`?` 只能用在返回 `Result`、`Option` 或实现了 `FromResidual` 的函数里。在 `main` 里用 `?`，需要把 `main` 改成返回 `Result`：

```rust
use std::fs;
use std::io;

fn read_first_line(path: &str) -> Result<String, io::Error> {
    // ? 在 read_to_string 失败时提前返回，不写 match
    let content = fs::read_to_string(path)?;
    Ok(content.lines().next().unwrap_or("").to_string())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Box<dyn Error> 能接收任意错误类型，适合应用入口
    let line = read_first_line("Cargo.toml")?;
    println!("首行: {}", line);
    Ok(())
}
```

> 边界：`?` 在 `Option` 上使用要求函数也返回 `Option`，不能与 `Result` 混用。需要互转时用 `ok_or`、`.ok()`、`transpose()`。

### 5.2 错误的三种传播粒度

| 粒度 | 写法 | 适用 |
|---|---|---|
| 立即终止 | `panic!` / `unwrap` | 不可恢复的程序错误 |
| 向上传播 | `?` + 具体错误类型 | 库、可复用模块 |
| 分类处理 | `match` 错误枚举 | 调用方要按类型重试或降级 |

服务端请求处理里，最外层通常 `match` 一次错误枚举，映射成 HTTP 状态码；内层全部用 `?`。不要在每层都 `match` 一次再包一层。

## 六、自定义错误类型

错误类型是一个普通的 `enum`，每个变体表示一类失败。派生 `thiserror::Error` 自动生成 `Display`、`Error` 和 `From`，手写则要几十行样板代码。

### 6.1 thiserror：库和模块边界

```rust
#[derive(Debug, thiserror::Error)]
enum LoadError {
    #[error("读取文件失败: {0}")]
    Io(#[from] std::io::Error),

    #[error("第 {line} 行格式错误: {reason}")]
    Format { line: usize, reason: String },

    #[error("缺少字段 {0}")]
    Missing(String),
}
```

三个要点：

1. `#[error("...")]` 定义 `Display`，字段可以直接插值；
2. `#[from]` 生成 `From<std::io::Error>`，于是 `fs::read_to_string(path)?` 能自动转换；
3. `#[source]` 只标记错误来源，不生成 `From`，用于手工构造的包装错误。

### 6.2 anyhow：应用入口和脚本

`anyhow::Result<T>` 是 `Result<T, anyhow::Error>` 的别名，错误类型可以 heterogeneous，附带上下文链。适合二进制程序，不适合公开库 API。

```rust
use anyhow::{Context, Result};

fn read_port(text: &str) -> Result<u16> {
    let raw = text.trim();
    // with_context 给原始错误加上业务上下文，日志里能直接定位
    let port: u16 = raw
        .parse()
        .with_context(|| format!("端口不是合法数字: {raw}"))?;
    if port < 1024 {
        anyhow::bail!("端口 {port} 需要 root 权限，拒绝启动");
    }
    Ok(port)
}

fn main() -> Result<()> {
    println!("{}", read_port("8080")?);
    // 错误链会按 "上下文: 原因" 逐层打印
    Ok(())
}
```

### 6.3 选型

| 场景 | 选择 | 理由 |
|---|---|---|
| 公开库、SDK | `thiserror` + 自定义枚举 | 调用方能 `match`，API 稳定 |
| 应用入口、脚本 | `anyhow` | 少写样板，上下文可读 |
| 库内部模块 | 自定义枚举，边界再转 | 内部错误不必暴露 |
| 原型验证 | `Box<dyn Error>` | 零依赖，够用 |

> 边界：`anyhow::Error` 不能 `match` 具体变体（要 `downcast`），因此不能作为库的公开错误类型。库导出 `thiserror` 枚举，应用层再用 `anyhow` 包一层，是常见组合。

## 七、完整程序与调试

下面的程序把 trait、泛型、`dyn`、`Display` 串起来：同一份报告逻辑既支持同构切片（静态分发），也支持异构集合（动态分发）。

```rust
use std::fmt;

// trait 定义共享行为：任何实现 Summary 的类型都能被 summarize 打印
trait Summary {
    fn summarize(&self) -> String;

    // 默认实现：实现者可以整个复用
    fn preview(&self) -> String {
        format!("{}...", self.summarize())
    }
}

struct Article {
    title: String,
    author: String,
}

struct Video {
    title: String,
    minutes: u32,
}

impl Summary for Article {
    fn summarize(&self) -> String {
        format!("《{}》，作者 {}", self.title, self.author)
    }
}

impl Summary for Video {
    fn summarize(&self) -> String {
        format!("《{}》视频，{} 分钟", self.title, self.minutes)
    }
}

// 静态分发：泛型 + trait bound，编译期单态化
fn print_report<T: Summary>(items: &[T]) {
    for (idx, item) in items.iter().enumerate() {
        println!("{}. {}", idx + 1, item.summarize());
    }
}

// 动态分发：trait 对象，运行期查虚表
fn total_preview(items: &[Box<dyn Summary>]) -> usize {
    items.iter().map(|item| item.preview().len()).sum()
}

// Display 让类型直接用于 println! 的 {}
impl fmt::Display for Article {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // write! 也返回 Result，? 把格式化错误向上传播
        write!(f, "Article({} by {})", self.title, self.author)
    }
}

fn main() {
    let articles = vec![
        Article { title: String::from("所有权入门"), author: String::from("张三") },
        Article { title: String::from("并发模型"), author: String::from("李四") },
    ];
    print_report(&articles);

    let mixed: Vec<Box<dyn Summary>> = vec![
        Box::new(Article { title: String::from("异步"), author: String::from("王五") }),
        Box::new(Video { title: String::from("tokio 实战"), minutes: 18 }),
    ];
    println!("动态分发项数: {}", mixed.len());
    println!("preview 总字节数: {}", total_preview(&mixed));

    let a = Article { title: String::from("错误处理"), author: String::from("赵六") };
    println!("{}", a);
}
```

预期输出：

```text
1. 《所有权入门》，作者 张三
2. 《并发模型》，作者 李四
动态分发项数: 2
preview 总字节数: 70
Article(错误处理 by 赵六)
```

### 7.1 常见编译错误

| 错误码 | 含义 | 第一条改法 |
|---|---|---|
| `E0277` | trait bound 不满足 | 补 `derive` 或加约束 |
| `E0308` | 类型不匹配 | 看 `expected` 与 `found` |
| `E0599` | 方法不存在 | trait 未导入或约束缺失 |
| `E0117` | 违反孤儿规则 | 用本地包装类型 |
| `E0038` | trait 非对象安全 | 去掉泛型方法或返回 `Self` |
| `E0507` | 不能移出借用内容 | 用 `clone` 或改借用 |

`E0599` 最容易误判：方法明明存在，编译器却说找不到，通常是因为 trait 没有 `use` 进来。

```rust
// 片段：Read trait 未导入时，read_to_string 报 E0599
// use std::io::Read;
// let mut s = String::new();
// std::fs::File::open("Cargo.toml")?.read_to_string(&mut s)?;
```

```bash
cargo check 2>&1 | grep -A3 '^error'
rustc --explain E0277 | head -40
```

### 7.2 调试错误链

`Error` trait 的 `source()` 返回底层错误链。`anyhow` 的 `{:?}` 会打印完整链，`{}` 只打印最外层。

```rust
use anyhow::Context;

fn load(path: &str) -> anyhow::Result<String> {
    // with_context 在最外层加业务信息，原始 io::Error 保留在 source 链里
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("加载配置 {path} 失败"))?;
    Ok(text)
}

fn main() {
    if let Err(err) = load("/no/such/file") {
        println!("display: {}", err); // 只打印最外层
        println!("debug: {:?}", err);  // 打印整条错误链
    }
}
```

预期输出：

```text
display: 加载配置 /no/such/file 失败
debug: 加载配置 /no/such/file 失败

Caused by:
    No such file or directory (os error 2)
```

> 边界：日志里用 `{:?}` 记录错误链，返回给用户的响应只给稳定文案和追踪 ID，不要把内部错误原样暴露。

## 八、最佳实践案例

### 8.1 案例背景

一个服务启动时需要从文本读取端口、工作线程数、超时和调试开关。配置来源是环境变量拼成的多行文本，运维可能写错字段名、漏字段、把数字写成字符串。

目标：一次加载给出明确的失败原因；进程退出码区分失败类型，便于启动脚本判断是否重试；解析代码不为每个字段重复写一遍。

约束：不能引入重量级配置框架；错误类型要能同时被日志和退出码使用；新增字段时改动集中在一处。

### 8.2 案例实操

`Cargo.toml`：

```toml
[package]
name = "config-loader"
version = "0.1.0"
edition = "2024"

[dependencies]
thiserror = "2"
```

`src/main.rs`：

```rust
use std::collections::BTreeMap;
use std::env;

// 自定义错误：枚举区分失败原因，thiserror 派生 Display
#[derive(Debug, thiserror::Error)]
enum ConfigError {
    #[error("缺少必填项: {0}")]
    MissingKey(String),
    #[error("字段 {key} 不是数字: {value}")]
    BadNumber { key: String, value: String },
    #[error("未知配置项: {0}")]
    UnknownKey(String),
}

impl ConfigError {
    // 退出码：调用方（启动脚本）按码区分失败类型
    fn exit_code(&self) -> i32 {
        match self {
            ConfigError::MissingKey(_) => 2,
            ConfigError::BadNumber { .. } => 3,
            ConfigError::UnknownKey(_) => 4,
        }
    }
}

#[derive(Debug, Default)]
struct Config {
    port: u16,
    workers: u32,
    timeout_ms: u64,
    debug: bool,
}

// 解析一行 key=value；错误携带字段名，定位到具体配置项
fn parse_pair(pair: &str) -> Result<(String, String), ConfigError> {
    let (key, value) = pair
        .split_once('=')
        .ok_or_else(|| ConfigError::UnknownKey(pair.to_string()))?;
    Ok((key.trim().to_string(), value.trim().to_string()))
}

// 从整段配置文本构造 Config，所有错误用 ? 向上传播
fn load_config(text: &str) -> Result<Config, ConfigError> {
    let mut pairs: BTreeMap<String, String> = BTreeMap::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let (key, value) = parse_pair(line)?;
        if !matches!(key.as_str(), "port" | "workers" | "timeout_ms" | "debug") {
            // 白名单外直接拒绝，避免拼写错误的配置被静默忽略
            return Err(ConfigError::UnknownKey(key));
        }
        pairs.insert(key, value);
    }

    let get = |key: &str| -> Result<&String, ConfigError> {
        pairs
            .get(key)
            .ok_or_else(|| ConfigError::MissingKey(key.to_string()))
    };

    Ok(Config {
        port: parse_field("port", get("port")?)?,
        workers: parse_field("workers", get("workers")?)?,
        timeout_ms: parse_field("timeout_ms", get("timeout_ms")?)?,
        debug: parse_field("debug", get("debug")?)?,
    })
}

// 泛型 + FromStr：一份解析代码覆盖 u16/u32/u64/bool
fn parse_field<T>(key: &str, raw: &str) -> Result<T, ConfigError>
where
    T: std::str::FromStr,
{
    raw.parse().map_err(|_| ConfigError::BadNumber {
        key: key.to_string(),
        value: raw.to_string(),
    })
}

fn main() {
    // 命令行参数优先；未提供时用内置默认配置
    let text = env::args().nth(1).unwrap_or_else(|| {
        "port=8080\nworkers=4\ntimeout_ms=3000\ndebug=false".to_string()
    });

    match load_config(&text) {
        Ok(config) => {
            println!("配置加载成功: {:?}", config);
            println!("监听端口: {}", config.port);
            println!("workers={} timeout={}ms debug={}",
                config.workers, config.timeout_ms, config.debug);
        }
        Err(e) => {
            eprintln!("配置加载失败: {}", e);
            std::process::exit(e.exit_code());
        }
    }
}
```

正常配置：

```bash
cargo run -q
```

```text
配置加载成功: Config { port: 8080, workers: 4, timeout_ms: 3000, debug: false }
监听端口: 8080
workers=4 timeout=3000ms debug=false
```

三类失败分别验证：

```bash
cargo run -q -- $'port=abc\nworkers=4\ntimeout_ms=3000\ndebug=false'; echo "exit=$?"
cargo run -q -- $'port=8080\nworkers=4'; echo "exit=$?"
cargo run -q -- $'port=8080\nworker=4\ntimeout_ms=1\ndebug=true'; echo "exit=$?"
```

预期输出：

```text
配置加载失败: 字段 port 不是数字: abc
exit=3
配置加载失败: 缺少必填项: timeout_ms
exit=2
配置加载失败: 未知配置项: worker
exit=4
```

### 8.3 案例结果

四类结果全部命中：合法配置一次通过；数字错误、缺字段、未知字段分别给出 `exit=3/2/4`，启动脚本可以直接按码决定是否重试。字段解析由 `parse_field<T>` 统一处理，新增一个 `u32` 字段只需加一行。

失败模式与复盘：

- 第一版在 `map_err` 闭包里写 `get("port")?`，触发 `E0277`：闭包不返回 `Result`，`?` 不能穿透。改为先 `get` 再 `parse_field`，错误构造与解析分离；
- 若错误变体存 `&str`，`parse_field` 无法把错误活过入参生命周期，必须持有 `String`；这是错误类型常见的一次必要复制；
- 未知字段选择报错而不是忽略：配置拼写错误在启动时暴露，比运行中行为异常便宜；
- 没有用 `Box<dyn Error>`：退出码需要 `match` 具体变体，`anyhow` 的错误无法直接 `match`，因此保留 `thiserror` 枚举。

下一篇 [Rust集合与智能指针](../02-Rust常用库/01-Rust集合与智能指针.md) 处理数据的存放与共享，`Box<dyn Trait>` 的堆分配在那里展开。
