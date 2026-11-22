---
title: "JavaScript核心与异步"
category: "04-前端"
---

# JavaScript核心与异步

> 这篇从 JavaScript 的单线程运行模型讲起，经过环境与最小验证、类型与值、作用域与闭包、原型与 `this`、ESM、Promise 与 `async/await`、事件循环，最后落到批量订单同步的并发控制与排障。
>
> 学完能独立写出不丢异常、不阻塞主线程、并发可控的异步代码，并能定位执行顺序和内存问题。

## 一、运行模型与职责边界

JavaScript 是单线程执行、事件驱动的语言：同一时刻只有一段同步代码在跑，异步任务由宿主环境排队，再回到主线程执行回调。

语言本身（ECMAScript）只规定语法、类型、对象和行为；定时器、网络、文件、DOM 由宿主提供。浏览器和 Node.js 的差异不在语法，而在宿主 API 和事件循环的细节。

判断一段异步代码是否合格：

- 每个 `await` 都有失败路径，异常不会被吞掉；
- 并发数有上限，不会一次打满下游；
- 长任务被切片，主线程不连续阻塞超过 50ms；
- 任务可以被取消，页面卸载后不再写状态。

边界：JavaScript 不负责多核并行计算。CPU 密集任务交给 Worker、子进程或服务端，不要靠 `Promise` 假装并行——`Promise` 只是调度，不产生新线程。

```mermaid
graph LR
  S[同步代码] --> C[调用栈]
  C --> M[微任务队列]
  M --> R[渲染 / 事件]
  R --> T[宏任务队列]
  T --> C
  classDef blue fill:#eff6ff,stroke:#93c5fd,color:#1e3a8a;
  classDef green fill:#ecfdf5,stroke:#86efac,color:#166534;
  classDef amber fill:#fffbeb,stroke:#fcd34d,color:#92400e;
  class S,C blue;
  class M,T amber;
  class R green;
```

### 1.1 版本基线

| 运行环境 | 基线 | 说明 |
|---|---|---|
| Node.js | 22 LTS | 内置 `fetch`、`AbortSignal.any`、`--watch` |
| 浏览器 | Chrome / Safari / Firefox 当前稳定版 | 均支持 ESM、顶层 `await` |
| 语言标准 | ES2024 为主 | 可选链、空值合并、`Array.at` 可用 |
| 构建 | Vite 7 | 开发态原生 ESM，生产态打包 |

语法特性按目标浏览器选择，不按教程发布时间。`structuredClone`、`Object.groupBy` 这类新 API 在旧环境需要降级或 polyfill。

## 二、环境与最小验证

Node.js 22 足以验证本篇全部语言特性；浏览器用于验证事件循环和渲染时序。

### 2.1 安装

```bash
# macOS
brew install node@22

# Ubuntu / Debian
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 22 && nvm use 22

# Rocky / CentOS：用 nvm，系统源版本通常过旧
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 22
```

Windows 用 `winget install OpenJS.NodeJS.LTS` 或 nvm-windows。验证：

```bash
node -v
node -e "console.log(process.versions.v8)"
```

预期输出：

```text
v22.20.0
12.4.254.21-node.57
```

V8 版本号随 Node 小版本变化，主版本固定为 12.4。

### 2.2 最小 ESM 项目

```bash
mkdir js-lab && cd js-lab
npm init -y
npm pkg set type=module
```

`"type": "module"` 让 `.js` 文件按 ESM 解析，否则 `import` 会报 `Cannot use import statement outside a module`。

```js
// main.js：顶层 await 在 ESM 中可用，脚本会等 Promise 完成再退出
const res = await fetch('https://httpbin.org/json');
const data = await res.json();
console.log(data.slideshow.title);
```

```bash
node main.js
```

预期输出：

```text
Sample Slide Show
```

### 2.3 调试入口

| 方式 | 命令 | 用途 |
|---|---|---|
| REPL | `node` | 快速验证表达式 |
| 单文件 | `node file.js` | 跑脚本 |
| 监听 | `node --watch file.js` | 改文件自动重启 |
| 断点 | `node --inspect-brk file.js` | Chrome DevTools 调试 |
| 浏览器 | Vite 页面 + Sources | 断点、调用栈、性能面板 |

边界：`--watch` 只监听被加载的模块，动态 `import()` 的路径不在依赖图里，新增文件需要重启。

## 三、类型与值

JavaScript 的值分两类：原始值按值比较，对象按引用比较。混淆这两条，后面所有异步和状态问题都会变形。

### 3.1 八种类型

| 类型 | 示例 | 判断方式 |
|---|---|---|
| `undefined` | `let a` | `a === undefined` |
| `null` | `null` | `a === null` |
| `boolean` | `true` | `typeof a` |
| `number` | `42`、`NaN` | `Number.isFinite` |
| `bigint` | `42n` | `typeof a` |
| `string` | `"abc"` | `typeof a` |
| `symbol` | `Symbol("id")` | `typeof a` |
| `object` | `{}`、`[]`、函数 | `typeof` 例外多 |

`typeof` 的三个历史包袱：

```js
typeof null          // "object"：早期实现遗留，判断 null 必须用 === null
typeof function () {} // "function"：函数是可调用对象，但 typeof 特判
typeof []            // "object"：数组要用 Array.isArray
```

### 3.2 数字

```js
0.1 + 0.2                    // 0.30000000000000004，IEEE 754 双精度无法精确表示 0.1
Number.isInteger(0.1 + 0.2)  // false

Number.isSafeInteger(2 ** 53)      // false，超过安全整数范围
Number.MAX_SAFE_INTEGER            // 9007199254740991

NaN === NaN                        // false，NaN 与任何值都不相等
Number.isNaN(NaN)                  // true，只对真正的 NaN 返回 true
Object.is(NaN, NaN)                // true，Object.is 用 SameValue 比较
```

金额不要用浮点数直接累加。落库用整数分，展示时除 100；需要任意精度时用 `BigInt` 或十进制库。

```js
const totalCents = 499_00 + 128_00; // 用整数分存金额，避免 0.1 类误差
const display = (totalCents / 100).toFixed(2); // 只在展示层转成元
```

### 3.3 强制转换与相等

```js
'5' == 5        // true：== 会做类型转换
'5' === 5       // false：=== 不做转换，默认使用
null == undefined // true，但 null === undefined 为 false
[] == false     // true：空数组转成 ""，再转成 0
```

规则：业务代码只用 `===`；判断空值用 `value == null` 可以同时覆盖 `null` 和 `undefined`，这是唯一推荐使用 `==` 的场景。

对象转原始值的顺序是 `Symbol.toPrimitive` → `valueOf` → `toString`。自定义对象时显式实现，不要依赖默认行为：

```js
class Money {
  constructor(cents) { this.cents = cents; }
  [Symbol.toPrimitive](hint) {
    // 明确区分字符串拼接和数值运算，避免 "¥" 参与算术
    return hint === 'string' ? `¥${(this.cents / 100).toFixed(2)}` : this.cents;
  }
}
```

### 3.4 引用与复制

```js
const a = { user: { name: '张岚' } };
const b = a;              // 同一个引用，改 b.user.name 会改到 a
const c = { ...a };       // 浅拷贝，user 仍是同一个对象
const d = structuredClone(a); // 深拷贝，支持 Date、Map、Set、ArrayBuffer

Object.freeze(a);         // 只冻结第一层，嵌套对象仍可改
```

边界：`structuredClone` 不能克隆函数、DOM 节点、类实例的原型；需要保留原型时自己写 `clone` 方法。

## 四、作用域与闭包

闭包不是语法技巧，而是“函数记住定义时的词法环境”这一机制的必然结果。

### 4.1 声明与提升

```js
console.log(a); // undefined：var 声明提升，赋值没有提升
var a = 1;

console.log(b); // ReferenceError：let 在声明前处于暂时性死区（TDZ）
let b = 2;

function f() {} // 函数声明整体提升，可以在定义前调用
```

`var` 的作用域是函数，`let`/`const` 是块。循环里用 `var` 保存回调，拿到的是最后一次的值：

```js
for (var i = 0; i < 3; i++) {
  setTimeout(() => console.log(i)); // 3 3 3
}

for (let j = 0; j < 3; j++) {
  setTimeout(() => console.log(j)); // 0 1 2，每轮都有独立的块级绑定
}
```

### 4.2 闭包

```js
function createCounter() {
  let count = 0;          // 被内部函数引用，函数返回后仍留在内存里
  return {
    inc: () => ++count,
    read: () => count,
  };
}

const counter = createCounter();
counter.inc();
counter.inc();
console.log(counter.read()); // 2
```

闭包保留的是变量本身，不是值的快照。多个函数共享同一个闭包时，改的是同一份状态。

```js
function once(fn) {
  let called = false;
  let result;
  return (...args) => {
    if (!called) {
      called = true;
      result = fn(...args); // 缓存结果，后续调用直接返回
    }
    return result;
  };
}
```

### 4.3 内存边界

闭包会延长变量生命周期。常见泄漏：

- 事件监听器捕获了大对象，元素移除后监听器没移除；
- 定时器回调引用组件状态，组件销毁后定时器还在跑；
- 缓存只增不减，没有淘汰策略。

```js
function mount(el) {
  const huge = new Array(1e6).fill('x');
  const onClick = () => console.log(huge.length);
  el.addEventListener('click', onClick);

  return () => {
    // 卸载时同时移除监听，闭包和 huge 才能被回收
    el.removeEventListener('click', onClick);
  };
}
```

## 五、原型与对象

JavaScript 的继承靠原型链，`class` 只是语法糖；理解原型才能解释 `instanceof`、`this` 和方法查找。

### 5.1 原型链

```js
const base = { greet() { return 'hi'; } };
const obj = Object.create(base);
obj.name = 'ticket';

obj.greet();                       // "hi"，沿原型链找到
Object.getPrototypeOf(obj) === base; // true
obj.hasOwnProperty('name');        // true
'greet' in obj;                    // true，in 会查原型链
```

属性查找顺序：自有属性 → 原型 → 原型的原型 → 直到 `null`。修改原型会影响所有实例，所以不要给 `Object.prototype` 加方法。

### 5.2 class

```js
class Ticket {
  #status = 'open';          // 私有字段，外部读不到，避免被随意改写
  static count = 0;          // 静态字段属于类本身

  constructor(id, title) {
    this.id = id;
    this.title = title;
    Ticket.count++;
  }

  get status() {
    return this.#status;
  }

  close() {
    this.#status = 'closed';
  }

  static create(row) {
    return new Ticket(row.id, row.title);
  }
}

const t = Ticket.create({ id: 'TK-1', title: '打印机离线' });
console.log(t.status); // "open"
```

`class` 声明不会被提升到可用位置，声明前使用会抛 `ReferenceError`；类内部默认严格模式。

### 5.3 this 的绑定规则

| 调用方式 | `this` 指向 |
|---|---|
| `fn()` | 严格模式下 `undefined` |
| `obj.fn()` | `obj` |
| `fn.call(x)` / `fn.apply(x)` | `x` |
| `new Fn()` | 新创建的实例 |
| 箭头函数 | 定义时外层 `this`，不可改变 |

```js
const button = {
  label: '提交',
  click() {
    console.log(this.label);
  },
};

const handler = button.click;
handler();                    // TypeError：模块是严格模式，方法被摘出来后 this 是 undefined

button.click();               // "提交"
button.click.call({ label: '保存' }); // "保存"

const obj = {
  label: '卡片',
  init() {
    // 箭头函数继承 init 的 this，适合做回调
    setTimeout(() => console.log(this.label), 0);
  },
};
```

边界：不要用箭头函数写对象方法或原型方法，它没有自己的 `this`，`new` 也会报错。

## 六、ESM 模块

ESM 是静态模块系统：导入导出在解析阶段确定，支持 tree-shaking、循环依赖和顶层 `await`。

### 6.1 导出与导入

```js
// math.js
export const add = (a, b) => a + b;
export default function multiply(a, b) { return a * b; }

// main.js
import multiply, { add } from './math.js'; // 默认导出可改名，具名导出必须匹配
console.log(add(1, 2), multiply(3, 4));    // 3 12
```

```js
// 统一导出，调用方从一个入口导入
export { add } from './math.js';
export * as format from './format.js';
```

### 6.2 实时绑定

ESM 导出的是绑定，不是值的拷贝：

```js
// counter.js
export let count = 0;
export function inc() { count++; }

// main.js
import { count, inc } from './counter.js';
inc();
console.log(count); // 1，导入方看到的是最新值
```

CommonJS 的 `module.exports` 是值拷贝，两者行为不同。混用时容易出现“导入后不更新”的问题，新项目统一用 ESM。

### 6.3 动态导入与顶层 await

```js
// 按需加载，首屏不引入体积大的模块
const { parse } = await import('./csv-parser.js');

// 条件加载，根据能力选择实现
const mod = navigator.gpu ? await import('./webgpu.js') : await import('./webgl.js');
```

顶层 `await` 只能在 ESM 中使用，它会让依赖它的模块等待完成。不要在入口做长时间阻塞的初始化，否则整个应用起不来。

### 6.4 循环依赖

```js
// a.js
import { b } from './b.js';
export const a = 'a';
console.log(b); // "b"：b 模块先完成求值；若在这里访问尚未初始化的 a，会触发 TDZ 错误

// b.js
import { a } from './a.js';
export const b = 'b';
```

ESM 用活绑定处理循环依赖，但访问尚未初始化的绑定时仍会抛 TDZ 错误。设计上让依赖单向，公共类型和常量放独立模块。

### 6.5 package.json 的入口

```json
{
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  }
}
```

`exports` 一旦声明，未列出的子路径就不能被导入。库作者必须同时提供 `types`、`import`、`require` 三个条件，否则使用方在 ESM/CJS 之间切换会失败。

## 七、Promise 与错误处理

Promise 把回调的嵌套改成链式，但不会自动处理错误；异常必须显式捕获。

### 7.1 状态与链

```js
const p = new Promise((resolve, reject) => {
  // executor 同步执行，抛错会变成 rejected
  setTimeout(() => resolve('ok'), 100);
});

p.then((v) => {
  console.log(v);
  return v.toUpperCase(); // 返回值进入下一个 then
})
  .then((v) => console.log(v))
  .catch((err) => console.error('失败', err))
  .finally(() => console.log('结束')); // finally 不改变结果
```

`.then` 返回新 Promise。回调里返回 Promise 会被展平，不需要手动嵌套。

### 7.2 组合器

| 方法 | 行为 | 适用 |
|---|---|---|
| `Promise.all` | 全部成功才成功，任一失败立即失败 | 强依赖的一组请求 |
| `Promise.allSettled` | 等全部结束，返回状态数组 | 批量任务，允许部分失败 |
| `Promise.race` | 第一个结束的胜出 | 超时、竞速 |
| `Promise.any` | 第一个成功的胜出 | 多源容灾 |

```js
const results = await Promise.allSettled(urls.map((u) => fetch(u)));
const failed = results.filter((r) => r.status === 'rejected');
console.log(`成功 ${results.length - failed.length}，失败 ${failed.length}`);
```

`Promise.all` 失败时其他请求不会取消，只是结果被忽略。需要真正停止，用 `AbortController`。

### 7.3 async/await

```js
async function loadOrder(id, signal) {
  const res = await fetch(`/api/orders/${id}`, { signal });
  if (!res.ok) {
    // fetch 只在网络失败时 reject，HTTP 4xx/5xx 仍是 resolved
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

try {
  const order = await loadOrder('SO-1');
  console.log(order.id);
} catch (err) {
  if (err.name === 'AbortError') return; // 主动取消不算错误
  console.error(err);
}
```

常见错误：

- `forEach` 里写 `async`，外层不会等待，异常也收不到；
- `return await` 与 `return` 在 `try/catch` 内行为不同，需要捕获时保留 `await`；
- 只 `await` 了创建 Promise 的函数，忘了 `await` 消费结果；
- `catch` 里再抛错但没有上层处理，变成 unhandled rejection。

```js
// 错误：forEach 不等待
items.forEach(async (item) => { await save(item); });
console.log('done'); // 立刻打印，save 还没完成

// 正确：串行
for (const item of items) {
  await save(item);
}

// 正确：并发（有上限见第九章）
await Promise.all(items.map(save));
```

## 八、事件循环与调度

事件循环决定“谁先执行”。同步代码永远先跑完，然后清空微任务，再取下一个宏任务。

### 8.1 浏览器的一轮

```js
console.log('1');

setTimeout(() => console.log('2'), 0);

queueMicrotask(() => console.log('3'));

Promise.resolve().then(() => console.log('4'));

console.log('5');

// 输出：1 5 3 4 2
```

顺序解释：

1. 同步代码 `1`、`5` 先执行；
2. 当前宏任务结束后清空微任务队列，`3`、`4` 按入队顺序执行；
3. 下一次事件循环取出定时器回调，打印 `2`。

`await` 之后的代码等价于 `.then` 回调，属于微任务：

```js
async function run() {
  console.log('a');
  await null;          // 让出当前同步执行，后续进入微任务
  console.log('b');
}

run();
console.log('c');

// 输出：a c b
```

### 8.2 渲染时机

浏览器在微任务清空后、下一次宏任务前，可能执行渲染：`requestAnimationFrame` → 样式计算 → 布局 → 绘制 → 合成。连续写 DOM 再读布局，会强制同步布局：

```js
// 错误：每次循环都读一次布局，触发多次重排
for (const el of items) {
  el.style.width = el.offsetWidth + 10 + 'px';
}

// 正确：先读后写，批量提交
const widths = items.map((el) => el.offsetWidth);
items.forEach((el, i) => { el.style.width = widths[i] + 10 + 'px'; });
```

### 8.3 Node.js 的事件循环

Node.js 一轮分六个阶段：timers → pending callbacks → idle/prepare → poll → check → close callbacks。`process.nextTick` 队列和 Promise 微任务在每个阶段之间清空。

```js
setTimeout(() => console.log('timeout'), 0);
setImmediate(() => console.log('immediate'));
Promise.resolve().then(() => console.log('promise'));
process.nextTick(() => console.log('nextTick'));

// 输出：promise nextTick timeout immediate
// ESM 顶层先清 Promise 微任务再清 nextTick；CJS 下两者顺序相反。timeout 与 immediate 在主模块中可能互换
```

在 I/O 回调里，`setImmediate` 总是先于 `setTimeout(0)`，因为 poll 阶段之后直接进入 check 阶段。

### 8.4 饥饿

微任务里再排微任务，会一直占住当前轮，渲染和定时器都得不到执行：

```js
function loop() {
  Promise.resolve().then(loop); // 永远清不完的微任务队列，页面卡死
}
loop();
```

长任务切片用宏任务或 `scheduler.yield()`：

```js
async function processInChunks(items, chunkSize = 500) {
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    chunk.forEach(handle);
    await new Promise((r) => setTimeout(r, 0)); // 让出主线程，渲染有机会插入
  }
}
```

## 九、异步工程模式

真实项目的难点不是写 `await`，而是控制并发、超时、重试和取消。

### 9.1 并发上限

一次 `Promise.all` 发 5000 个请求，会把连接池和下游打满。用固定数量的 worker 消费队列：

```js
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;      // 取号是同步的，不会两个 worker 拿到同一条
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}
```

`limit` 是同时进行的任务数，不是总任务数。结果按原数组下标写回，顺序与输入一致。

### 9.2 超时与取消

```js
function withTimeout(task, ms, signal) {
  const timeout = AbortSignal.timeout(ms);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  return new Promise((resolve, reject) => {
    if (combined.aborted) return reject(combined.reason);

    const onAbort = () => reject(combined.reason);
    combined.addEventListener('abort', onAbort, { once: true });

    task(combined).then(
      (value) => {
        combined.removeEventListener('abort', onAbort); // 成功后清掉监听，避免累积
        resolve(value);
      },
      (err) => {
        combined.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
```

`AbortSignal.timeout(ms)` 到点自动中止；`AbortSignal.any` 把用户取消和超时合并成一个信号。`fetch` 和 `addEventListener`（`{ signal }` 选项）都接受 `signal`；浏览器的全局 `setTimeout` 不接受，Node `node:timers/promises` 的 `setTimeout` 接受。

### 9.3 重试与退避

```js
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(id);
        reject(signal.reason);
      },
      { once: true },
    );
  });

async function retry(task, { retries = 3, base = 300, signal } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await task(attempt);
    } catch (err) {
      if (signal?.aborted) throw signal.reason; // 用户取消不再重试
      lastError = err;
      // 只重试网络错误、429 和 502/503；401、404、参数错误重试没有意义
      const status = (err as { status?: number })?.status;
      const retryable = status == null || status === 429 || status === 502 || status === 503;
      if (!retryable || attempt === retries) break;

      const jitter = Math.random() * 100;
      // 指数退避 + 抖动，避免大量客户端在同一时刻重试
      await sleep(base * 2 ** attempt + jitter, signal);
    }
  }

  throw lastError;
}
```

只对可重试的错误重试：网络超时、429、502/503。参数错误、401、404 重试没有意义。

### 9.4 流式读取

```js
const res = await fetch('/api/orders/export');
if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';       // 最后一行可能不完整，留到下一块
  lines.forEach(parseLine);
}
```

流式处理把内存占用从“整个响应”降到“一个分块”，适合导出大文件和实时日志。

## 十、调试与排障

异步问题的排查顺序：先确认执行顺序，再确认异常是否被吞，最后确认资源是否释放。

| 现象 | 最可能原因 | 第一条检查 |
|---|---|---|
| `await` 后面的代码不执行 | 前面的 Promise 永远 pending | 给请求加超时，打印状态 |
| 页面卡顿 | 微任务死循环或长任务 | Performance 面板看长任务 |
| 接口 200 但进入 catch | `fetch` 不会因 4xx reject | 检查 `res.ok` |
| 控制台报 unhandled rejection | 没有 `catch` 或没 `await` | 加 `try/catch` 或全局监听 |
| 内存持续上涨 | 监听器/定时器/缓存未释放 | 堆快照对比 |
| 重试把下游打挂 | 无退避、无并发上限 | 看重试曲线与 429 比例 |

```js
process.on('unhandledRejection', (reason) => {
  // 生产环境记录后退出，避免进程带病运行
  console.error('unhandledRejection', reason);
  process.exitCode = 1;
});
```

```bash
# 打开 Node 调试端口，Chrome 地址栏输入 chrome://inspect
node --inspect-brk app.js

# 打印警告的完整堆栈
node --trace-warnings app.js
```

浏览器侧：

- Sources 面板勾选 Async，调用栈会跨 `await` 串联；
- Performance 面板录制后看 Main 轨道，超过 50ms 的块标红；
- Memory 面板做两次堆快照，对比 Detached DOM 和闭包引用；
- Network 面板看请求瀑布，确认是否被串行化。

## 十一、最佳实践案例

### 11.1 案例背景

某电商后台需要把 5000 条历史订单同步到新的订单中心。旧脚本用 `for` 循环逐条 `await`，跑一次 82 秒，中途任何一条失败就整体中断，重跑会重复写入。下游接口限流 500 QPS，超时 5 秒，偶尔返回 503。

目标是：并发 8、单条超时 5 秒、可重试、可中止、有进度输出，并且失败条目能单独重跑。约束是不能引入第三方队列，只能用 Node.js 22 内置能力。

### 11.2 案例实操

先写可复现的模拟接口，保证案例不依赖外部服务：

```js
// sync.js
import { setTimeout as sleep } from 'node:timers/promises';

const TOTAL = 5000;
const CONCURRENCY = 8;
const TIMEOUT_MS = 5000;
const MAX_RETRIES = 3;

const orders = Array.from({ length: TOTAL }, (_, i) => ({
  id: `SO-${String(i + 1).padStart(5, '0')}`,
  amountCents: 1000 + i,
}));

const written = new Set();

// 模拟下游：5% 概率 503，0.1% 概率超时，其余 8–24ms 成功
async function pushOrder(order, signal) {
  await sleep(8 + Math.random() * 16, undefined, { signal });

  const roll = Math.random();
  if (roll < 0.05) {
    const err = new Error('503 Service Unavailable');
    err.status = 503;
    throw err;
  }
  if (roll < 0.051) {
    await sleep(6000, undefined, { signal }); // 超过 5 秒超时阈值
  }

  written.add(order.id); // 幂等写入：同一 id 重复成功不会产生重复数据
}
```

并发池、超时和重试组合起来：

```js
async function mapLimit(items, limit, fn, signal) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length || signal?.aborted) return;

      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        results[index] = { error: err }; // 单条失败不拖垮整批，留给结果汇总
      }

      done++;
      if (done % 500 === 0) {
        console.log(`进度 ${done}/${items.length}`);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

function withTimeout(task, ms, outerSignal) {
  const timeout = AbortSignal.timeout(ms);
  const signal = outerSignal
    ? AbortSignal.any([outerSignal, timeout])
    : timeout;

  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });

    task(signal).then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

async function retry(task, { retries, base = 200, signal }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await task();
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      lastError = err;

      // 只重试限流和服务端临时故障；超时是单条任务的总预算，不再重试
      const retryable = err.status === 429 || err.status === 503;
      if (!retryable || attempt === retries) break;

      // 300ms、600ms、1200ms 递增，加抖动避免重试风暴
      await sleep(base * 2 ** attempt + Math.random() * 100, undefined, { signal });
    }
  }
  throw lastError;
}
```

入口：整体 5 分钟超时，收到 SIGINT 时中止。

```js
const controller = new AbortController();
process.on('SIGINT', () => {
  console.log('收到中断，正在停止...');
  controller.abort(new Error('user aborted'));
});

const started = Date.now();

const results = await mapLimit(
  orders,
  CONCURRENCY,
  (order) =>
    withTimeout(
      (signal) =>
        retry(() => pushOrder(order, signal), {
          retries: MAX_RETRIES,
          signal,
        }),
      TIMEOUT_MS,
      controller.signal,
    ),
  controller.signal,
);

const failed = results
  .map((r, i) => ({ r, order: orders[i] }))
  .filter(({ r }) => r && r.error);

console.log(`完成 ${TOTAL - failed.length}/${TOTAL}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (failed.length) {
  console.log('失败样例：', failed.slice(0, 3).map(({ order, r }) => `${order.id}: ${r.error.message}`));
  process.exitCode = 1;
}
```

运行：

```bash
node sync.js
```

预期输出（示例，耗时会波动）：

```text
进度 500/5000
进度 1000/5000
...
进度 5000/5000
完成 4998/5000，耗时 19.8s
失败样例： [
  'SO-00030: The operation was aborted due to timeout',
  'SO-01642: The operation was aborted due to timeout'
]
```

失败条目单独重跑：

```js
const failedIds = new Set(failed.map(({ order }) => order.id));
const retryList = orders.filter((o) => failedIds.has(o.id));
await mapLimit(retryList, 4, (o) => retry(() => pushOrder(o), { retries: 5 }));
```

### 11.3 案例结果

| 指标 | 串行脚本 | 并发版 |
|---|---|---|
| 总耗时 | 82.4s | 19.8s |
| 峰值并发 | 1 | 8 |
| 单条超时 | 无，卡住整批 | 5s 中止 |
| 失败处理 | 整体中断 | 单条隔离 + 重试 |
| 可中止 | 否 | Ctrl+C 立即停止 |

并发版 19.8s 为本地模拟接口实测；串行 82.4s 按单条平均延迟乘 5000 推算（示例），真实下游会受网络和限流影响。

失败模式与复盘：

- 第一版把 `retry` 写在 `withTimeout` 外层，超时后重试会重新创建定时器，单条最多拖到 20 秒；正确做法是超时作为总预算包住重试，超时即放弃该条；
- 超时和用户取消都会让信号进入 aborted，`retry` 里必须先判断 `signal.aborted`，否则会把已超时的任务再排一轮；
- `pushOrder` 里的 `sleep` 必须接收 `signal`，否则中止后仍在等待，进程迟迟不退出；
- 结果数组按索引写回，`mapLimit` 不能返回 `push` 的顺序，否则失败条目对不上原订单；
- 重试只对 429/503 生效，超时作为单条总预算不重试，401 和参数错误重试只会放大问题；
- 进度日志每 500 条一次，高频 `console.log` 本身会拖慢同步。

结论：异步代码的正确性来自三个约束——并发有上限、每个等待可中止、失败可归因。缺一个，压测时就会以另一种形式暴露。
