---
title: "TypeScript类型标注"
category: "04-前端"
---

# TypeScript类型标注

> 这篇从 TypeScript 在编译期的职责讲起，经过环境与 `tsconfig`、基础标注、对象类型、联合类型收窄、泛型、工具类型与类型运算、声明文件，最后落到订单域建模、类型安全 API 层和 Vue 3.5 组件类型。
>
> 学完能给一个中等规模前端项目建立类型边界，让编译期发现大部分字段拼写、空值和分支遗漏问题。

## 一、类型系统的职责与边界

TypeScript 只在编译期工作：检查通过后类型被擦除，运行时没有类型信息。它保证的是“代码内部自洽”，不是“接口数据可信”。

判断类型标注是否合格：

- 外部数据先经过运行时校验，再进入类型系统；
- 业务对象有明确的状态联合，不用任意 `string` 兜底；
- `any` 只出现在与不可控第三方交互的边界，并集中标注；
- 类型错误在 `tsc --noEmit` 和编辑器里同时可见。

边界：类型不能防止后端返回错字段，也不能替代表单校验。`fetch` 的 `res.json()` 返回 `any`，直接断言成 `Order` 只是把错误推迟到运行时。正确做法是 `unknown` + 校验函数。

```mermaid
graph LR
  R[接口原始数据 unknown] --> V[运行时校验]
  V --> T[业务类型]
  T --> C[组件 / 状态]
  C --> B[构建产物 无类型]
  classDef blue fill:#eff6ff,stroke:#93c5fd,color:#1e3a8a;
  classDef green fill:#ecfdf5,stroke:#86efac,color:#166534;
  classDef gray fill:#f8fafc,stroke:#cbd5e1,color:#334155;
  class R blue;
  class V,T green;
  class C,B gray;
```

### 1.1 结构类型与可靠性缺口

TypeScript 是结构类型：只要形状匹配就兼容，不要求来自同一个声明。

```ts
interface Point { x: number; y: number }

const p = { x: 1, y: 2, z: 3 };
const point: Point = p; // 允许，多余字段不报错（变量赋值不做多余属性检查）
```

直接写字面量时才有“多余属性检查”：

```ts
const q: Point = { x: 1, y: 2, z: 3 }; // 报错：对象字面量只能指定已知属性
```

三个可靠性缺口：

- `any` 关闭检查，并会沿调用链扩散；
- 类型断言 `as` 不做运行时验证；
- `!` 非空断言只消除编译错误，值仍可能是 `null`。

企业项目里把这三类写法收进 lint 规则，比事后排查便宜。

## 二、环境与最小验证

TypeScript 5.9 + Vite 7，`tsc` 负责类型检查，Vite 负责转译和开发服务器。

### 2.1 安装

```bash
npm create vite@latest ts-lab -- --template vanilla-ts
cd ts-lab
npm install
npm run dev
```

Vite 模板自带 `typescript` 和 `tsconfig.json`，另装 `tsx` 方便直接跑单文件：

```bash
npm i -D typescript tsx vue-tsc
npx tsc --version
```

预期输出：

```text
Version 5.9.3
```

### 2.2 tsconfig

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "jsx": "preserve",
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
```

| 选项 | 打开的收益 | 代价 |
|---|---|---|
| `strict` | 空值、隐式 `any`、函数参数全检查 | 老代码报错集中出现 |
| `noUncheckedIndexedAccess` | 数组下标访问返回 `T \| undefined` | 需要显式判空 |
| `exactOptionalPropertyTypes` | 可选属性不能显式赋 `undefined` | 与部分库类型冲突 |
| `verbatimModuleSyntax` | 强制 `import type`，类型导入不被保留 | 需要改导入写法 |
| `isolatedModules` | 保证单文件转译安全 | 禁止 `const enum` 跨文件 |

`noEmit` 让 `tsc` 只做检查；产物由 Vite 生成。库项目需要产物时单独开 `tsc -p tsconfig.build.json`。

### 2.3 最小验证

```ts
// src/main.ts
type OrderStatus = 'open' | 'progress' | 'done';

interface Order {
  id: string;
  status: OrderStatus;
}

const order: Order = { id: 'SO-1', status: 'open' };
console.log(order.status);
```

```bash
npx tsc --noEmit
```

预期输出：没有输出，退出码 0。改一个错误值：

```ts
const bad: Order = { id: 'SO-2', status: 'closed' };
```

```text
src/main.ts:11:34 - error TS2322: Type '"closed"' is not assignable to type 'OrderStatus'.
```

### 2.4 调试入口

| 方式 | 命令 | 用途 |
|---|---|---|
| 全量检查 | `npx tsc --noEmit` | CI 门禁 |
| 单文件执行 | `npx tsx file.ts` | 快速验证逻辑 |
| 类型追踪 | `npx tsc --noEmit --generateTrace trace` | 分析类型性能 |
| Vue 检查 | `npx vue-tsc --noEmit` | 模板与 `script setup` |
| 编辑器 | VS Code 内置 | 悬停看推导类型 |

边界：`tsx` 只擦除类型，不做类型检查；类型错误仍要靠 `tsc` 或编辑器发现。

## 三、基础标注与推断

标注写在“需要约束的地方”，其余交给推断。冗余标注不会更安全，只会增加维护成本。

### 3.1 原始类型与数组

```ts
const count: number = 0;
const name: string = '张岚';
const active: boolean = true;
const ids: string[] = ['SO-1', 'SO-2'];
const matrix: number[][] = [[1, 2], [3, 4]];
const pair: [string, number] = ['SO-1', 499]; // 元组：长度和位置类型都固定
```

函数返回类型建议显式写，尤其是导出的函数：

```ts
export function toCents(yuan: number): number {
  // 显式返回类型让调用方不依赖实现细节，重构时更安全
  return Math.round(yuan * 100);
}

export function formatCents(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}
```

### 3.2 字面量类型与 as const

```ts
const status = 'open';            // 类型是 "open"，不是 string
let mutable = 'open';             // 类型被放宽为 string
const STATUSES = ['open', 'progress', 'done'] as const;
// 类型是 readonly ["open", "progress", "done"]

type OrderStatus = (typeof STATUSES)[number]; // "open" | "progress" | "done"
```

`as const` 让对象和数组变成只读字面量，是推导联合类型和配置表的常用手段。

### 3.3 unknown、any、never

| 类型 | 含义 | 使用场景 |
|---|---|---|
| `unknown` | 未知，使用前必须收窄 | 外部输入、`catch` 参数 |
| `any` | 关闭检查 | 不推荐，仅迁移期临时 |
| `never` | 不可能存在的值 | 穷尽检查、抛错函数 |
| `void` | 无返回值 | 事件回调 |

```ts
function parse(input: unknown) {
  // input 不能直接读属性，必须先判断
  if (typeof input === 'string') return input.trim();
  return '';
}

function assertNever(value: never): never {
  throw new Error(`未处理的分支: ${JSON.stringify(value)}`);
}
```

`catch` 的变量在 `strict` 下是 `unknown`，不要直接 `err.message`：

```ts
try {
  await save();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
}
```

### 3.4 函数类型

```ts
type Handler = (id: string, signal?: AbortSignal) => Promise<void>;

const onClick: Handler = async (id, signal) => {
  // 参数类型从 Handler 推导，不用重复写
  await remove(id, signal);
};

function sum(...nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}

function greet(name = '访客'): string {
  return `你好，${name}`; // 默认参数让类型带上 undefined 的调用方式
}
```

边界：可选参数必须放在必选参数之后；回调参数用 `void` 返回类型表示“返回值不被使用”，不要写 `undefined`。

## 四、对象类型：interface 与 type

两者多数场景可互换；选择依据是“要不要合并声明”和“要不要表达能力”。

### 4.1 interface

```ts
interface Order {
  readonly id: string;      // 只读，防止业务代码误改主键
  title: string;
  status: OrderStatus;
  owner?: string;           // 可选，读取时类型自动带 undefined
}

interface Order {
  amountCents: number;      // 同名 interface 会合并，适合扩展第三方类型
}
```

`interface` 支持声明合并、`extends` 继承，适合描述公开对象形状和需要被扩展的契约。

### 4.2 type

```ts
type OrderStatus = 'open' | 'progress' | 'done'; // 联合类型只能用 type

type OrderWithMeta = Order & {
  slaMinutes: number; // 交叉类型组合
};

type OrderKey = keyof Order; // "id" | "title" | "status" | "owner" | "amountCents"
```

`type` 支持联合、交叉、条件类型、映射类型，适合做类型运算。

### 4.3 索引签名与 Record

```ts
interface StatusCount {
  [status: string]: number; // 任意字符串键都返回 number
}

type StatusMap = Record<OrderStatus, number>; // 三个键必须齐全
const counts: StatusMap = { open: 12, progress: 8, done: 96 };
```

`Record<联合类型, T>` 比索引签名更严格：少一个键就报错，适合状态到文案/颜色的映射。

```ts
const STATUS_TEXT: Record<OrderStatus, string> = {
  open: '待处理',
  progress: '处理中',
  done: '已解决',
};
```

### 4.4 多余属性检查

```ts
interface User { name: string; age?: number }

const u1: User = { name: '张岚', age: 30 };
const u2: User = { name: '李澄', agge: 28 }; // 报错：拼写错误被字面量检查抓住

const raw = { name: '王晴', agge: 28 };
const u3: User = raw; // 不报错：变量赋值绕过多余属性检查，拼写错误漏掉
```

需要同时校验形状又保留字面量类型时用 `satisfies`：

```ts
const config = {
  pageSize: 20,
  status: 'open',
} satisfies { pageSize: number; status: OrderStatus };
// config.status 的类型仍是 "open"，不是 OrderStatus
```

## 五、联合类型与收窄

收窄（narrowing）是 TypeScript 最实用的能力：把宽类型按运行时判断缩小成具体分支。

### 5.1 常见收窄方式

```ts
function describe(value: string | number | null) {
  if (value === null) return '空';
  if (typeof value === 'string') return value.toUpperCase(); // 此分支只剩 string
  return value.toFixed(2); // 此分支只剩 number
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function handle(err: unknown) {
  if (err instanceof ApiError) {
    console.log(err.status); // instanceof 收窄到 ApiError
  } else if (err instanceof Error) {
    console.log(err.message);
  }
}
```

`in` 操作符收窄对象的可选字段：

```ts
type Draft = { title: string };
type Published = { title: string; publishedAt: string };

function isPublished(post: Draft | Published): post is Published {
  // 类型谓词：返回 true 时调用方把参数当成 Published
  return 'publishedAt' in post;
}
```

### 5.2 可辨识联合

给每个分支一个共同的字面量字段，`switch` 就能自动收窄，并做穷尽检查。

```ts
type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; data: Order[] }
  | { kind: 'error'; message: string };

function render(state: LoadState): string {
  switch (state.kind) {
    case 'idle':
      return '等待加载';
    case 'loading':
      return '加载中…';
    case 'success':
      return `共 ${state.data.length} 条`; // 此分支自动有 data
    case 'error':
      return state.message;
    default:
      return assertNever(state); // 新增分支未处理时，这里编译报错
  }
}
```

这是前端状态建模的首选写法：不可能同时“加载中且有数据”，用联合类型把非法状态排除掉。

### 5.3 断言函数

```ts
interface OrderDraft {
  id: string;
  title: string;
}

function assertOrderDraft(value: unknown): asserts value is OrderDraft {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('order 必须是对象');
  }
  const o = value as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.title !== 'string') {
    throw new TypeError('id 和 title 必须是字符串');
  }
}

function handle(raw: unknown) {
  assertOrderDraft(raw);
  console.log(raw.title); // 断言后，raw 被收窄为 OrderDraft
}
```

断言函数适合在入口一次性校验，但函数体必须真的检查，否则只是把断言换了个位置。

### 5.4 收窄的边界

- 收窄依赖控制流，回调里不会保留外层的收窄结果；
- 把变量赋给新变量、放进数组后，窄类型可能被放宽；
- `as` 和 `!` 会打断收窄链，优先级低于真实判断；
- 可辨识联合的判别字段必须是字面量类型，不能是 `string`。

## 六、泛型

泛型把“类型之间的依赖关系”写出来：输入什么类型，输出就跟着变，而不是退化成 `any`。

### 6.1 泛型函数

```ts
function first<T>(items: readonly T[]): T | undefined {
  return items[0]; // 返回类型跟随元素类型，不丢信息
}

const id = first(['SO-1', 'SO-2']);      // string | undefined
const amount = first([100, 200]);         // number | undefined
```

约束让泛型只能接受满足形状的类型：

```ts
function pluck<T extends Record<string, unknown>, K extends keyof T>(
  items: readonly T[],
  key: K,
): T[K][] {
  return items.map((item) => item[key]); // key 必须存在于 T 上
}

const orders = [{ id: 'SO-1', amountCents: 100 }];
const ids = pluck(orders, 'id'); // string[]
```

### 6.2 默认参数与推断

```ts
interface Page<T, Meta = { total: number }> {
  items: T[];
  meta: Meta;
}

const page: Page<Order> = {
  items: [],
  meta: { total: 0 },
};
```

调用时显式给部分参数，其余由默认值补上。不要给每个函数都加泛型，能用一个具体类型说清就不用泛型。

### 6.3 const 类型参数

```ts
function tuple<const T extends readonly unknown[]>(items: T): T {
  return items;
}

const t = tuple(['open', 'done']); // readonly ["open", "done"]，不会放宽成 string[]
```

`const` 类型参数在 TS 5.0 引入，适合写配置表和路由表，保留字面量。

### 6.4 泛型组件

```ts
interface SelectProps<T> {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  getLabel: (option: T) => string;
}

function createSelect<T>(props: SelectProps<T>) {
  return props; // 组件实现省略，重点是 props 之间的类型联动
}
```

边界：泛型过度使用会让错误信息难读。一个函数如果只在内部用一次 `T`，通常说明它不需要泛型。

## 七、工具类型与类型运算

工具类型是类型层面的函数；会用 `keyof`、`typeof`、条件类型和映射类型，才能从已有类型派生新类型。

### 7.1 内置工具类型

| 工具类型 | 作用 | 示例结果 |
|---|---|---|
| `Partial<T>` | 全部变可选 | `{ id?: string }` |
| `Required<T>` | 全部变必选 | 去掉 `?` |
| `Readonly<T>` | 全部只读 | 不能赋值 |
| `Pick<T, K>` | 选取字段 | `Pick<Order, 'id'>` |
| `Omit<T, K>` | 排除字段 | `Omit<Order, 'owner'>` |

```ts
type OrderPatch = Partial<Pick<Order, 'title' | 'owner'>>;
type OrderPreview = Pick<Order, 'id' | 'title' | 'status'>;

function updateOrder(id: string, patch: OrderPatch) {
  // patch 里每个字段都可选，且只允许改标题和负责人
}
```

### 7.2 keyof、typeof、索引访问

```ts
const order = { id: 'SO-1', title: '打印机离线', status: 'open' as OrderStatus };

type OrderShape = typeof order;        // 从值反推类型
type Keys = keyof OrderShape;            // "id" | "title" | "status"
type Status = OrderShape['status'];      // OrderStatus

function get<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}
```

`typeof` 在类型位置使用，取的是变量的类型；`keyof` 取键的联合；`T[K]` 取字段类型。

### 7.3 条件类型与 infer

```ts
type Unwrap<T> = T extends Promise<infer U> ? U : T;

type A = Unwrap<Promise<Order>>; // Order
type B = Unwrap<string>;          // string

type ElementOf<T> = T extends readonly (infer E)[] ? E : never;
type C = ElementOf<Order[]>;      // Order
```

条件类型在联合类型上会分发：

```ts
type ToArray<T> = T extends unknown ? T[] : never;
type D = ToArray<string | number>; // string[] | number[]
```

需要阻止分发时用 `[T] extends [U]`。

### 7.4 映射类型

```ts
type Nullable<T> = { [K in keyof T]: T[K] | null };

type Getters<T> = {
  [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K];
};

type OrderGetters = Getters<Pick<Order, 'id' | 'title'>>;
// { getId: () => string; getTitle: () => string }
```

映射类型可以加 `readonly`、`?` 修饰符，也可以用 `-readonly`、`-?` 移除。

```ts
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Concrete<T> = { [K in keyof T]-?: T[K] };
```

### 7.5 模板字面量类型

```ts
type OrderEvent = `order:${'created' | 'updated' | 'cancelled'}`;
// "order:created" | "order:updated" | "order:cancelled"

type ApiPath = `/api/${'orders' | 'customers'}/${string}`;

function emit(event: OrderEvent, payload: unknown) {
  // 事件名拼错会在编译期报错
}
```

模板字面量类型适合约束事件名、CSS 变量名和路由路径，但过度嵌套会让类型检查变慢。

## 八、声明文件与第三方类型

声明文件描述“运行时有、但没有类型定义”的东西；它不产生代码，只影响检查。

### 8.1 模块声明

```ts
// src/types/assets.d.ts
declare module '*.svg' {
  const src: string;
  export default src;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}
```

Vite 项目通常已内置 `vite/client` 类型；自己补声明时确认 `tsconfig` 的 `include` 覆盖到 `.d.ts`。

### 8.2 全局扩展

```ts
// src/types/global.d.ts
export {}; // 有 import/export 才是模块，declare global 才合法

declare global {
  interface Window {
    __APP_VERSION__: string;
  }
}
```

不要在全局声明里加业务对象；全局类型会污染所有文件，优先用模块导出。

### 8.3 模块增强

```ts
// src/types/vue-router.d.ts
import 'vue-router';

declare module 'vue-router' {
  interface RouteMeta {
    title?: string;
    requiresAuth?: boolean;
  }
}
```

增强第三方模块时先 `import` 原模块，再在 `declare module` 里合并同名接口；直接写 `declare module 'vue-router'` 会覆盖原声明。

### 8.4 查找顺序

```text
./node_modules/@types/<pkg>
./node_modules/<pkg>/package.json 的 types / typings
./node_modules/<pkg>/index.d.ts
```

`types` 字段缺失时，先在 `@types` 找；都没有就自己补声明。`skipLibCheck: true` 跳过 `.d.ts` 内部的类型检查，能加快检查速度，但也会掩盖声明文件里的错误。

## 九、与 Vue 3.5 / React 19 结合

框架的类型能力集中在 props、事件、模板引用和状态；写法比原生 DOM 更依赖泛型。

### 9.1 Vue 3.5

```vue
<script setup lang="ts">
import { ref, computed } from 'vue';

interface Props {
  orderId: string;
  editable?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  editable: false, // 默认值由编译器转成运行时 props 默认
});

const emit = defineEmits<{
  saved: [id: string];           // 元组语法：参数名和类型都写清
  cancel: [];
}>();

const title = ref('');
const canSave = computed(() => title.value.trim().length > 0);

async function save() {
  if (!canSave.value || !props.editable) return;
  emit('saved', props.orderId);
}
</script>

<template>
  <form @submit.prevent="save">
    <input v-model="title" />
    <button :disabled="!canSave">保存</button>
  </form>
</template>
```

泛型组件：

```vue
<script setup lang="ts" generic="T extends { id: string }">
const props = defineProps<{
  items: T[];
  selectedId?: string;
}>();

const emit = defineEmits<{
  select: [item: T];
}>();
</script>

<template>
  <ul>
    <li v-for="item in props.items" :key="item.id">
      <button @click="emit('select', item)">{{ item.id }}</button>
    </li>
  </ul>
</template>
```

依赖注入用 `InjectionKey<T>` 保证提供方和注入方类型一致：

```ts
// keys.ts
import type { InjectionKey, Ref } from 'vue';
export const orderStoreKey: InjectionKey<Ref<Order[]>> = Symbol('orderStore');
```

Vue 3.5 的响应式 props 解构已稳定：解构出的变量在模板和 `computed` 中仍保持响应。但把它当作普通值传给函数时，函数拿到的是调用当时的快照，需要持续响应就用 `toRef` 或直接访问 `props`。

### 9.2 React 19

```tsx
import { useState, useRef, type ReactNode, type ComponentProps } from 'react';

type ButtonProps = ComponentProps<'button'> & {
  variant?: 'primary' | 'ghost';
};

function Button({ variant = 'primary', className = '', ...rest }: ButtonProps) {
  // 透传原生属性，不手写 onClick/disabled/type
  return <button className={`btn btn--${variant} ${className}`} {...rest} />;
}

function Search({ onSearch }: { onSearch: (q: string) => void }) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault(); // React 事件类型从 JSX 自动推导
        onSearch(q);
      }}
    >
      <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} />
    </form>
  );
}

function List<T extends { id: string }>({
  items,
  render,
}: {
  items: T[];
  render: (item: T) => ReactNode;
}) {
  return <ul>{items.map((item) => <li key={item.id}>{render(item)}</li>)}</ul>;
}
```

React 19 不再需要 `React.FC` 包裹函数组件；直接写函数并标注 props 即可。`ReactNode` 覆盖字符串、数字、元素、数组和 `null`，比 `JSX.Element` 宽。

### 9.3 对照

| 能力 | Vue 3.5 | React 19 |
|---|---|---|
| Props | `defineProps<Props>()` | 函数参数类型 |
| 事件 | `defineEmits` 元组语法 | 回调 prop 类型 |
| 模板引用 | `ref<HTMLElement \| null>(null)` | `useRef<T>(null)` |
| 泛型组件 | `generic="T extends ..."` | 泛型函数组件 |
| 类型检查 | `vue-tsc` | `tsc` / 编辑器 |

## 十、迁移与排障

类型问题通常不是“类型写错”，而是“数据形状没有被校验”或“配置项没对齐”。

| 现象 | 最可能原因 | 第一条检查 |
|---|---|---|
| `Object is possibly 'undefined'` | 未判空或索引访问 | 加 `if` 或可选链 |
| `Type 'string' is not assignable to 'never'` | 联合分支没穷尽 | 补 `default: assertNever(x)` |
| `Cannot find module './x'` | `moduleResolution` 或后缀 | 改 `bundler`，检查导出 |
| 类型检查突然变慢 | 类型递归过深/大联合 | `--generateTrace` 找热点 |
| 第三方库没类型 | `@types` 缺失 | `npm i -D @types/pkg` |
| `verbatimModuleSyntax` 报错 | 类型导入没写 `type` | 改 `import type` |
| `exactOptionalPropertyTypes` 报错 | 显式传 `undefined` | 用 `?` 或改类型 |

迁移顺序：

1. 先开 `strict` 和 `noImplicitAny`，把隐式 `any` 清掉；
2. 再开 `noUncheckedIndexedAccess`，处理数组和字典；
3. 外部接口全部改成 `unknown` + 校验函数；
4. 最后开 `exactOptionalPropertyTypes` 和 `verbatimModuleSyntax`。

```bash
# 统计还有多少显式 any，作为迁移进度指标
grep -rn ": any\|as any" src --include='*.ts' --include='*.tsx' | wc -l
```

边界：不要为了消错把类型改成 `any`；`// @ts-expect-error` 只用于确认第三方类型错误，且要写原因。

## 十一、最佳实践案例

### 11.1 案例背景

某售后系统的订单模块从 JavaScript 迁移到 TypeScript。旧代码把接口响应直接当对象用，字段拼写错误和空值问题在运行时才暴露；订单状态用字符串，前端出现“已取消”这种后端从未定义的值；API 层每个函数各自 `as Order`，等于没有校验。

目标是：建立订单域类型、把接口入口收成 `unknown` + 校验、用可辨识联合表达加载状态、给 Vue 组合式函数补齐泛型，并让 `tsc --noEmit` 成为 CI 门禁。

约束：接口暂时不能改；迁移期允许 `any` 只出现在第三方 SDK 边界；不引入运行时 schema 库，用原生类型谓词实现。

### 11.2 案例实操

先定义域类型，主键用品牌类型防止和普通字符串混用：

```ts
// src/domain/order.ts
declare const orderIdBrand: unique symbol;

export type OrderId = string & { readonly [orderIdBrand]: 'OrderId' };

export const ORDER_STATUSES = ['open', 'progress', 'done'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface Order {
  readonly id: OrderId;
  title: string;
  status: OrderStatus;
  amountCents: number;
  owner: string;
  updatedAt: string;
}

export type OrderPatch = Partial<Pick<Order, 'title' | 'owner' | 'status'>>;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function toOrderId(raw: string): OrderId {
  if (!/^SO-\d{4}$/.test(raw)) {
    throw new TypeError(`非法订单号: ${raw}`);
  }
  return raw as OrderId; // 只有这里允许断言，校验已经完成
}
```

运行时校验集中在 API 边界，返回类型谓词而不是布尔值：

```ts
// src/domain/parse.ts
import {
  ORDER_STATUSES,
  toOrderId,
  type Order,
  type OrderStatus,
  type Page,
} from './order';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string'
    && (ORDER_STATUSES as readonly string[]).includes(value);
}

export function parseOrder(raw: unknown): Order {
  if (!isRecord(raw)) throw new TypeError('order 必须是对象');

  const { id, title, status, amountCents, owner, updatedAt } = raw;

  if (typeof id !== 'string') throw new TypeError('id 必须是字符串');
  if (typeof title !== 'string' || title.length === 0) throw new TypeError('title 不能为空');
  if (!isStatus(status)) throw new TypeError(`未知状态: ${String(status)}`);
  if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents)) {
    throw new TypeError('amountCents 必须是安全整数');
  }
  if (typeof owner !== 'string') throw new TypeError('owner 必须是字符串');
  if (typeof updatedAt !== 'string') throw new TypeError('updatedAt 必须是字符串');

  return {
    id: toOrderId(id),
    title,
    status,
    amountCents,
    owner,
    updatedAt,
  };
}

export function parseOrderPage(raw: unknown): Page<Order> {
  if (!isRecord(raw)) throw new TypeError('page 必须是对象');
  if (!Array.isArray(raw.items)) throw new TypeError('items 必须是数组');
  if (typeof raw.total !== 'number' || typeof raw.page !== 'number') {
    throw new TypeError('分页字段缺失');
  }

  return {
    items: raw.items.map(parseOrder), // 每条都校验，坏数据不会混进页面
    total: raw.total,
    page: raw.page,
    pageSize: typeof raw.pageSize === 'number' ? raw.pageSize : 20,
  };
}
```

API 层只依赖一个可注入的 `fetch`，测试时不需要网络：

```ts
// src/api/request.ts
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

export async function request<T>(
  path: string,
  parse: (raw: unknown) => T,
  fetcher: Fetcher = fetch,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers); // 用 Headers 合并，避免直接展开 HeadersInit
  headers.set('Accept', 'application/json');

  const res = await fetcher(path, { ...init, headers });
  const body = await res.text(); // 先读文本，错误响应也能带出内容

  if (!res.ok) {
    throw new ApiError(res.status, body.slice(0, 300));
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new TypeError('响应不是合法 JSON');
  }

  return parse(json); // 类型收口只在这一处
}
```

加载状态用可辨识联合，非法组合在编译期就写不出来：

```ts
// src/domain/state.ts
import type { Order } from './order';

export type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; data: Order[]; total: number }
  | { kind: 'error'; message: string };

export function assertNever(value: never): never {
  throw new Error(`未处理的状态: ${JSON.stringify(value)}`);
}

export function stateLabel(state: LoadState): string {
  switch (state.kind) {
    case 'idle': return '等待加载';
    case 'loading': return '加载中…';
    case 'success': return `共 ${state.total} 条`;
    case 'error': return state.message;
    default: return assertNever(state); // 新增状态时这里报错，强制处理
  }
}
```

Vue 组合式函数把类型带到视图层：

```ts
// src/composables/useOrders.ts
import { computed, ref } from 'vue';
import { request } from '../api/request';
import { parseOrderPage } from '../domain/parse';
import type { OrderStatus } from '../domain/order';
import type { LoadState } from '../domain/state';

export function useOrders(initialStatus: OrderStatus | 'all' = 'all') {
  const state = ref<LoadState>({ kind: 'idle' });
  const status = ref<OrderStatus | 'all'>(initialStatus);
  const controller = ref<AbortController | null>(null);

  const items = computed(() =>
    state.value.kind === 'success' ? state.value.data : [],
  );

  async function load(): Promise<void> {
    controller.value?.abort();
    const current = new AbortController();
    controller.value = current;
    state.value = { kind: 'loading' };

    try {
      const query = status.value === 'all' ? '' : `?status=${status.value}`;
      const page = await request(`/api/orders${query}`, parseOrderPage, fetch, {
        signal: current.signal,
      });

      if (controller.value !== current) return; // 过期响应不写状态
      state.value = { kind: 'success', data: page.items, total: page.total };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      state.value = {
        kind: 'error',
        message: err instanceof Error ? err.message : '未知错误',
      };
    }
  }

  return { state, status, items, load };
}
```

运行校验逻辑（不依赖后端）：

```ts
// src/demo.ts
import { request, type Fetcher } from './api/request';
import { parseOrderPage } from './domain/parse';
import { stateLabel } from './domain/state';

const fixture = {
  items: [
    { id: 'SO-0001', title: '打印机无法连接', status: 'progress', amountCents: 49900, owner: '张岚', updatedAt: '11-13 10:24' },
    { id: 'SO-0002', title: 'VPN 证书过期', status: 'open', amountCents: 0, owner: '李澄', updatedAt: '11-13 09:47' },
  ],
  total: 2,
  page: 1,
  pageSize: 20,
};

const fakeFetcher: Fetcher = async () =>
  new Response(JSON.stringify(fixture), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const page = await request('/api/orders', parseOrderPage, fakeFetcher);
page.items.forEach((o) => {
  console.log(`${o.id} ${o.status} ¥${(o.amountCents / 100).toFixed(2)}`);
});
console.log(stateLabel({ kind: 'success', data: page.items, total: page.total }));

try {
  parseOrderPage({ items: [{ id: 'X-1', title: '', status: 'closed' }], total: 1, page: 1 });
} catch (err) {
  console.log('校验拦截:', err instanceof Error ? err.message : err);
}
```

```bash
npx tsc --noEmit
npx tsx src/demo.ts
```

预期输出：

```text
SO-0001 progress ¥499.00
SO-0002 open ¥0.00
共 2 条
校验拦截: title 不能为空
```

### 11.3 案例结果

| 指标 | 迁移前 | 迁移后 |
|---|---|---|
| 显式 `any` | 14 处 | 0 处（第三方边界除外） |
| 接口字段拼写错误 | 运行时才暴露 | 编译期拦截 |
| 非法状态值 | 页面出现“已取消” | 校验函数拒绝 |
| 分页字段缺失 | 白屏 | 明确的错误提示 |
| CI 类型检查 | 无 | `tsc --noEmit` 阻断 |

数字为示例场景的统计口径，用于说明迁移收益的量级。

失败模式与复盘：

- 第一版把 `parseOrder` 写成布尔判断后仍 `as Order`，等于没校验；改成类型谓词并在返回值里逐字段收窄；
- `amountCents` 用了 `number`，后端传 `1.5` 也能通过；加 `Number.isSafeInteger` 后金额才真正可控；
- `LoadState` 起初用 `loading: boolean` + `data?: Order[]`，出现过“加载中且有旧数据”的非法组合；改成可辨识联合后不可能写出该状态；
- 组合式函数里 `controller` 用普通变量，多个组件共享时互相覆盖；改成 `ref` 并在请求后比较引用；
- 迁移期给第三方 SDK 加了 `any`，但集中放在 `src/types/vendor.d.ts`，没有扩散到业务代码。

复盘：TypeScript 的收益不在“多写类型”，而在把不可信输入收口到少数校验函数、把非法状态从类型层面排除。边界越少，类型越值钱。
