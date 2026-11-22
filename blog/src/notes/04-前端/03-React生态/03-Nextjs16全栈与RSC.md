---
title: "Nextjs16全栈与RSC"
category: "04-前端"
---

# Nextjs16全栈与RSC

> 这篇从 Next.js 16 的渲染模型讲起，经过项目骨架、App Router 路由、服务端与客户端组件的边界、数据获取与缓存、Server Actions、代理层鉴权、metadata 与资源优化，最后落到构建部署和线上排障。
>
> 学完能独立搭起一个带鉴权、可缓存、能上线的 Next 16 全栈应用，并在页面空白、数据不更新、构建失败时按现象定位到具体一层。

## 一、Next 16 的定位与渲染模型

这一章解决“哪段代码在服务端跑、哪段代码进浏览器”的问题，它决定了后面每一章的写法。

Next.js 16 是以 React 服务端组件（React Server Components，RSC）为默认渲染单元的全栈框架。页面在服务端取数并渲染成 RSC Payload，浏览器只下载需要交互的那部分 JavaScript。默认导出的一切都是服务端组件，除非显式标注 `'use client'`。

### 1.1 与纯 React SPA 的差别

纯 SPA 的首屏是“空 HTML + 一大包 JS”，数据要等水合完成后再发一次请求；RSC 把取数和首屏渲染合并到同一次请求里。

| 维度 | React SPA（Vite） | Next 16 App Router |
|---|---|---|
| 首屏 HTML | 空壳，靠 JS 渲染 | 服务端直出完整内容 |
| 数据获取 | 水合后 fetch | 渲染时直接查库 |
| 首包 JS | 全量业务代码 | 只含客户端组件 |
| 密钥与数据库 | 不能放前端 | 只存在于服务端 |
| 路由 | 客户端路由 | 文件系统路由 + 预取 |

判断标准很简单：这段代码需不需要 `useState`、事件监听、浏览器 API。需要就进客户端组件，不需要就留在服务端。留在服务端的代码不会进入 bundle，这是 Next 16 最直接的性能收益。

### 1.2 一次页面请求的完整路径

请求先经过代理层（Next 16 起 `middleware.ts` 更名为 `proxy.ts`），再进入渲染，渲染时按需读缓存或查库，最后把 HTML 与 RSC Payload 流式返回。

```mermaid
graph TD
  A[浏览器请求 /orders] --> B{proxy 拦截}
  B -->|无会话| L[307 跳转 /login]
  B -->|有会话| C[服务端渲染]
  C --> D[读数据缓存]
  D -->|命中| E[生成 RSC Payload]
  D -->|未命中| F[查询数据库]
  F --> E
  E --> G[流式返回 HTML]
  G --> H[浏览器水合客户端组件]
  classDef blue fill:#eff6ff,stroke:#93c5fd,color:#1e3a8a;
  classDef green fill:#ecfdf5,stroke:#86efac,color:#166534;
  classDef amber fill:#fffbeb,stroke:#fcd34d,color:#92400e;
  classDef gray fill:#f8fafc,stroke:#cbd5e1,color:#334155;
  class A,B,C blue;
  class D,F amber;
  class E,G,H green;
  class L gray;
```

这条路径里有两个容易忽略的点：`proxy` 对每个匹配请求都执行，只适合做重定向、响应头和粗粒度拦截，不适合查库；缓存未命中后的查库发生在渲染层，`proxy` 拦不住慢查询。

### 1.3 渲染结果的三种形态

Next 16 把渲染结果分成静态、动态、流式三类，区别在于什么时候生成 HTML。

| 形态 | 生成时机 | 典型场景 | 代价 |
|---|---|---|---|
| 静态（prerender） | 构建时 | 营销页、文档 | 内容变化要重新验证 |
| 动态（dynamic） | 每次请求 | 带会话的后台页 | 无法 CDN 全量缓存 |
| 流式（streaming） | 请求中分段 | 慢查询、大列表 | 需要 Suspense 边界 |

开启 `cacheComponents: true` 之后，Next 16 不再靠“有没有用动态 API”去猜，而是显式声明：函数加 `'use cache'` 就可缓存，不加就是每次请求执行。猜测变成声明，是 16 相对 15 最重要的变化。

### 1.4 不该用 Next 的场景

纯内网工具、需要长时间 WebSocket 连接的服务、只做一个页面的活动页，用 Vite + React 更省事。Next 的收益来自“服务端渲染 + 文件路由 + 内置优化”，代价是构建复杂度、部署形态和一层额外的心智模型。团队没有 Node 运行时、只能用静态对象存储托管时，也要换方案。

版本基线（2026-11-13）：

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | 20.9+ / 22 LTS | 16 的最低要求是 20.9 |
| Next.js | 16.x | App Router 为默认 |
| React | 19.x | RSC 与 Actions 依赖 19 |
| TypeScript | 5.9+ | 类型化的路由与参数 |

## 二、项目准备与最小闭环

这一章把空目录变成一个能在浏览器里打开、能看到数据的项目，并确认版本和运行方式正确。

### 2.1 创建项目

`create-next-app` 会一次装好 TypeScript、Tailwind 4、ESLint 和 App Router 骨架。

```bash
# macOS / Ubuntu / Windows PowerShell 通用；npm 需 10+
npx create-next-app@latest admin-console \
  --ts --tailwind --eslint --app --src-dir --import-alias "@/*"

cd admin-console
npm run dev
```

预期输出：

```text
   ▲ Next.js 16.0.0 (Turbopack)
   - Local:        http://localhost:3000
   - Environments: .env.local

 ✓ Ready in 1.2s
```

Turbopack 在 16 里是开发和构建的默认打包器，不再需要 `--turbopack` 参数。若终端仍显示 webpack，说明项目锁在 15 的配置上，检查 `package.json` 的 `next` 版本。

Windows 下如果 `npx` 报执行策略错误，用管理员 PowerShell 执行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 后重开终端；Ubuntu 下 Node 用 `nvm install 22` 安装，不要用系统自带的旧 Node。

### 2.2 目录与文件约定

App Router 的目录就是路由表，文件名就是语义。

```text
admin-console/
├── src/
│   ├── app/
│   │   ├── layout.tsx          # 根布局，必须有 html 和 body
│   │   ├── page.tsx            # 路由 /
│   │   ├── globals.css
│   │   └── orders/
│   │       ├── layout.tsx      # 只作用于 /orders/*
│   │       ├── page.tsx        # 路由 /orders
│   │       ├── loading.tsx     # 该段的加载态
│   │       ├── error.tsx       # 该段的错误边界
│   │       └── [id]/page.tsx   # 路由 /orders/:id
│   ├── components/
│   ├── lib/
│   └── proxy.ts                # 16 起的请求拦截层
├── next.config.ts
└── package.json
```

### 2.3 最小页面

先确认渲染链路通，再谈缓存和鉴权。

```tsx
// src/app/page.tsx —— 默认就是服务端组件，不会打进浏览器 bundle
export default async function HomePage() {
  // 为什么放在组件里 await：Next 16 的 fetch 与数据库调用在服务端直接执行，
  // 不需要 useEffect，也不会产生客户端瀑布流
  const res = await fetch('https://api.example.com/health', { cache: 'no-store' })
  const { status } = await res.json()

  return (
    <main className="p-8">
      <h1 className="text-2xl font-semibold">运营后台</h1>
      <p className="mt-2 text-sm text-slate-600">上游状态：{status}</p>
    </main>
  )
}
```

```tsx
// src/app/layout.tsx —— 根布局必须存在，否则 build 直接失败
import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: { default: '运营后台', template: '%s | 运营后台' }, // 为什么用模板：子页面只写自己那一段标题
  description: '订单、客户与库存的统一工作台',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="bg-slate-50 text-slate-900">{children}</body>
    </html>
  )
}
```

访问 `http://localhost:3000`，页面直接出现“运营后台”和上游状态，查看源代码能看到完整 HTML，说明服务端渲染生效。

### 2.4 环境变量

服务端变量不加前缀，客户端变量必须以 `NEXT_PUBLIC_` 开头，这条规则由构建期替换实现，写错就会把密钥打进 bundle。

```bash
# .env.local —— 不要提交到仓库
DATABASE_URL="postgres://app:app@127.0.0.1:5432/admin"
SESSION_SECRET="replace-with-32-byte-random"
NEXT_PUBLIC_API_BASE="https://api.example.com"
```

```ts
// src/lib/env.ts —— 启动时校验，缺失立即失败，比运行到一半报错好排查
import { z } from 'zod'

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  NEXT_PUBLIC_API_BASE: z.string().url(),
})

export const env = EnvSchema.parse(process.env)
```

`env.ts` 只能在服务端导入。若被客户端组件引用，`DATABASE_URL` 会变成 `undefined` 并抛错，这正好起到隔离作用。

## 三、App Router 的路由与渲染单元

这一章解决页面怎么组织、加载态和错误态放在哪里，以及动态参数怎么拿。

### 3.1 文件约定

每个文件名对应一种职责，混用会让边界失效。

| 文件 | 职责 | 关键约束 |
|---|---|---|
| `page.tsx` | 路由出口 | 同目录只能有一个 |
| `layout.tsx` | 共享外壳 | 切换子路由不重新渲染 |
| `loading.tsx` | 段级加载态 | 自动包一层 Suspense |
| `error.tsx` | 段级错误边界 | 必须是客户端组件 |
| `not-found.tsx` | 404 | 由 `notFound()` 触发 |
| `route.ts` | HTTP 接口 | 与 `page.tsx` 互斥 |

`layout.tsx` 不重新渲染这一点很关键：侧边栏、导航的状态在路由切换时保留，滚动位置也不会重置。需要每次切换都重置的外壳，应该放在 `page.tsx` 里而不是 `layout.tsx`。

### 3.2 布局嵌套与路由组

布局按目录层级嵌套，路由组 `(group)` 只影响组织方式，不影响 URL。

```text
src/app/
├── (dashboard)/
│   ├── layout.tsx        # 带侧边栏的外壳
│   ├── orders/page.tsx   # URL 仍是 /orders
│   └── customers/page.tsx
└── (auth)/
    ├── layout.tsx        # 居中的登录外壳
    └── login/page.tsx    # URL 是 /login
```

```tsx
// src/app/(dashboard)/layout.tsx
import { Sidebar } from '@/components/sidebar'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />{/* 为什么放在 layout：路由切换时它不重新挂载，折叠状态得以保留 */}
      <div className="flex-1 p-6">{children}</div>
    </div>
  )
}
```

路由组还用来给不同区域套不同外壳：后台带侧边栏，登录页居中。URL 里不会出现 `(dashboard)`，不要把它当路径段用。

### 3.3 动态段与异步参数

Next 16 的 `params` 和 `searchParams` 都是 Promise，必须 `await`。

```tsx
// src/app/orders/[id]/page.tsx
import { notFound } from 'next/navigation'
import { getOrder } from '@/lib/orders'

type Props = {
  params: Promise<{ id: string }>        // 为什么是 Promise：16 把参数改成异步，支持流式渲染时先出骨架
  searchParams: Promise<{ tab?: string }>
}

export default async function OrderDetailPage({ params, searchParams }: Props) {
  const { id } = await params
  const { tab = 'basic' } = await searchParams
  const order = await getOrder(id)

  if (!order) notFound()               // 为什么用 notFound：交给最近的 not-found.tsx，而不是自己 return 一段文字

  return (
    <article>
      <h1 className="text-xl font-semibold">订单 {order.id}</h1>
      <p className="text-sm text-slate-600">当前页签：{tab}</p>
    </article>
  )
}
```

直接写 `params.id` 会得到 `undefined` 且不报错，这是 15 升级到 16 最常见的静默故障。TypeScript 配置正确时，`params: { id: string }` 会在编译期报错，所以不要用 `any` 绕过。

### 3.4 加载态与错误边界

`loading.tsx` 是 Suspense 的语法糖，`error.tsx` 必须声明 `'use client'`。

```tsx
// src/app/orders/loading.tsx
export default function Loading() {
  return (
    <div className="space-y-2" aria-busy="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-10 animate-pulse rounded bg-slate-200" />
      ))}
    </div>
  )
}
```

```tsx
// src/app/orders/error.tsx
'use client'                            // 为什么必须：错误边界依赖 componentDidCatch，只能在客户端运行

export default function OrdersError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div role="alert" className="rounded border border-red-200 bg-red-50 p-4">
      <p className="text-sm text-red-700">订单加载失败：{error.message}</p>
      <button onClick={reset} className="mt-2 rounded bg-red-600 px-3 py-1 text-sm text-white">
        重试
      </button>
    </div>
  )
}
```

生产环境的 `error.message` 会被替换成通用文案，真实信息在服务端日志里，靠 `digest` 关联。不要把堆栈直接渲染给用户。

### 3.5 并行路由与拦截路由

并行路由用 `@slot` 在同层渲染多个区域，拦截路由用 `(.)` 在前端打开详情而不整页跳转。

```text
src/app/orders/
├── layout.tsx
├── page.tsx
├── @summary/page.tsx      # 同层插槽，layout 接收 summary 参数
└── [id]/
    ├── page.tsx
    └── (.)photo/page.tsx  # 从列表点开时拦截，刷新后走完整页面
```

这两个能力解决的是“列表页内嵌详情”“同页多区域独立加载”，不属于最小闭环。团队没有明确的弹层路由需求时不要引入，拦截路由会让 URL 与渲染结果的关系变得难推理。

## 四、服务端组件与客户端组件的边界

这一章解决 `'use client'` 到底该加在哪一层，加错位置会同时损失性能和数据能力。

### 4.1 `'use client'` 的真实含义

`'use client'` 标记的是模块边界，不是“这个文件在客户端运行”。被标记的文件及其导入的模块会进入客户端 bundle，并在服务端预渲染一次。

```tsx
// src/components/status-filter.tsx
'use client'                            // 为什么加在这里：需要 useRouter 和点击事件

import { useRouter, useSearchParams } from 'next/navigation'

const STATUSES = ['all', 'pending', 'paid', 'shipped'] as const

export function StatusFilter() {
  const router = useRouter()
  const params = useSearchParams()

  return (
    <div className="flex gap-2" role="group" aria-label="按状态筛选">
      {STATUSES.map((s) => (
        <button
          key={s}
          aria-pressed={params.get('status') === s}
          onClick={() => {
            // 为什么用 URL 承载状态：可分享、可刷新、可被服务端读取，不用额外状态库
            const next = new URLSearchParams(params)
            s === 'all' ? next.delete('status') : next.set('status', s)
            router.replace(`/orders?${next}`)
          }}
          className="rounded border px-3 py-1 text-sm aria-pressed:bg-blue-50"
        >
          {s}
        </button>
      ))}
    </div>
  )
}
```

### 4.2 可序列化边界

从服务端组件传给客户端组件的 props 必须可序列化；普通函数（Server Action 除外）、类实例、数据库连接都不行。`Date`、`Map`、`Set`、`Promise` 可以跨边界，但客户端只应把它们当数据用。

| 可以传 | 不能传 |
|---|---|
| 字符串、数字、布尔、null | 普通函数（除 Server Action） |
| 数组、纯对象 | 类实例、未注册的 Symbol |
| `Date`、`Map`、`Set`、`Promise` | 数据库连接、文件句柄 |
| Server Action 引用 | 含函数属性的对象 |

```tsx
// 反例：把 ORM 实体直接传下去
// <OrderTable orders={orders} />   // orders 里若含 Decimal 实例，序列化会失败

// 正例：在服务端转成纯数据
const rows = orders.map((o) => ({
  id: o.id,
  customer: o.customerName,
  amount: Number(o.amount),          // 为什么转换：Decimal 不能跨边界，转成 number 后客户端才好格式化
  createdAt: o.createdAt.toISOString(),
}))
```

报错信息通常是 `Only plain objects can be passed to Client Components`，看到这句先找 props 里的类实例。

### 4.3 组合模式：把客户端组件当容器

需要客户端交互的容器里要放服务端内容时，用 `children` 传进去，而不是把整个页面标成客户端。

```tsx
// src/components/collapsible-panel.tsx
'use client'
import { useState } from 'react'

export function CollapsiblePanel({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <section className="rounded border border-slate-200 bg-white">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="font-medium">{title}</span>
        <span aria-hidden>{open ? '−' : '+'}</span>
      </button>
      {open && <div className="border-t border-slate-100 p-4">{children}</div>}
      {/* children 由服务端渲染好后传入，客户端组件只负责开合，不把子内容打进 bundle */}
    </section>
  )
}
```

```tsx
// 服务端页面里组合
<CollapsiblePanel title="最近订单">
  <OrderList />{/* 服务端组件，直接查库，不需要任何客户端 JS */}
</CollapsiblePanel>
```

### 4.4 常见边界错误

| 现象 | 原因 | 处理 |
|---|---|---|
| `useState is not defined` 报错 | 服务端组件里用了 Hook | 拆出客户端组件 |
| 数据库连接泄漏警告 | 客户端组件导入了 `lib/db` | 只在服务端模块导入 |
| 页面变大、首包 JS 暴涨 | 顶层 `layout` 标了 `'use client'` | 把标记下移到叶子组件 |
| `Event handlers cannot be passed` | 给服务端组件传了 `onClick` | 改由客户端组件内部处理 |

最后一条最隐蔽：在服务端组件里写 `<button onClick={...}>` 编译能过，运行时报错。判断方法看报错栈里有没有 `Client Component`。

## 五、数据获取与缓存

这一章解决“数据从哪来、缓存多久、什么时候失效”，是全栈应用最容易出错的部分。

### 5.1 显式缓存模型

开启 `cacheComponents` 后，没有 `'use cache'` 的函数每次请求都执行；加了才会被缓存。默认不缓存，比默认缓存更好排查。

```ts
// next.config.ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  cacheComponents: true,   // 为什么开：让 'use cache' 生效，缓存从隐式猜测变为显式声明
  output: 'standalone',    // 为什么开：Docker 镜像只带运行必需文件，镜像从 1.2GB 降到约 180MB
  reactCompiler: true,     // 为什么开：自动 memo 化，减少手写 useMemo/useCallback
  typedRoutes: true,       // 为什么开：Link 的 href 在编译期校验，路由改名不会留死链
}

export default nextConfig
```

### 5.2 `use cache` 与缓存标签

```ts
// src/lib/orders.ts
import { cacheLife, cacheTag } from 'next/cache'
import { db } from './db'

export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'cancelled'

export type Order = {
  id: string
  customer: string
  amount: number
  status: OrderStatus
  createdAt: string
}

export async function getOrders(): Promise<Order[]> {
  'use cache'                 // 为什么：列表页读多写少，缓存后命中时不碰数据库
  cacheLife('minutes')        // 为什么用分钟级：1 分钟后台刷新、最多 5 分钟陈旧，换取数据库压力下降
  cacheTag('orders')          // 为什么打标签：写操作后可按标签精确失效，不误伤其他缓存

  const rows = await db.order.findMany({ orderBy: { createdAt: 'desc' }, take: 50 })
  return rows.map((r) => ({
    id: r.id,
    customer: r.customerName,
    amount: Number(r.amount),
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  }))
}
```

`cacheLife` 接受预设（`seconds`、`minutes`、`hours`、`days`、`weeks`、`max`）或对象：

```ts
cacheLife({
  stale: 60,        // 客户端可用的陈旧时间，秒
  revalidate: 300,  // 后台重新验证间隔，秒
  expire: 3600,     // 超过后必须重新生成，秒
})
```

三个值的含义要在上线前对齐业务：`stale` 决定用户能看到多旧的数据，`revalidate` 决定多久后台刷新一次，`expire` 决定最坏情况下的数据年龄。

### 5.3 按参数缓存

带参数的查询要注意参数会进入缓存键，未做限制时枚举值多会导致缓存碎片。

```ts
export async function searchOrders(query: string, status: OrderStatus | 'all') {
  'use cache'
  cacheTag('orders', `orders:${status}`)   // 为什么分标签：按状态失效时只影响对应分组
  cacheLife('minutes')

  const normalized = query.trim().slice(0, 64)  // 为什么截断：避免超长输入把缓存键撑爆
  return db.order.findMany({
    where: {
      ...(status === 'all' ? {} : { status }),
      ...(normalized ? { customerName: { contains: normalized } } : {}),
    },
    take: 50,
  })
}
```

搜索关键词做缓存通常不划算：每个关键词一个缓存条目，命中率低还占内存。关键词搜索建议不缓存，只缓存状态筛选这类有限枚举。

### 5.4 失效的三个 API

缓存失效分“数据缓存”和“页面缓存”两层，用错会出现“接口返回新数据、页面还是旧的”。

| API | 作用对象 | 典型场景 |
|---|---|---|
| `updateTag(tag)` | 数据缓存 | 当前用户改完立即看到（读己之写） |
| `revalidateTag(tag, 'max')` | 数据缓存 | 后台任务改数据，下次请求重建 |
| `revalidatePath(path)` | 路由缓存 | 页面整体结构变化 |

```ts
// src/app/orders/actions.ts
'use server'

import { revalidatePath, updateTag } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireSession } from '@/lib/auth'

const UpdateSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['pending', 'paid', 'shipped', 'cancelled']),
})

export type ActionState = {
  ok: boolean
  message?: string
  fieldErrors?: Record<string, string[] | undefined>
}

export async function updateOrderStatus(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  // 为什么在 Action 里再校验身份：Action 编译后是一个公开 HTTP 端点，proxy 不能作为唯一防线
  const session = await requireSession()

  const parsed = UpdateSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    // Zod 4 用 z.flattenError 取代 schema 上的 .flatten()
    return { ok: false, fieldErrors: z.flattenError(parsed.error).fieldErrors }
  }

  await db.order.update({
    where: { id: parsed.data.id },
    data: { status: parsed.data.status },
  })
  await db.auditLog.create({
    data: { actor: session.userId, action: 'order.status', target: parsed.data.id },
  })

  updateTag('orders')          // 为什么：让本次请求之后的渲染立刻读到新数据，避免"改完还是旧状态"
  revalidatePath('/orders')    // 为什么：已生成的页面缓存一并失效，防止旧 HTML 继续命中

  return { ok: true, message: '状态已更新' }
}
```

`updateTag` 与 `revalidateTag` 的差别在时机：前者用于同一次用户操作内立即生效，后者用于“反正下次有人访问再重建”。Next 16 的 `revalidateTag` 必须带第二个参数（cacheLife 预设或 `{ expire }`），单参数写法已弃用；对外暴露的写接口用 `revalidateTag(tag, 'max')`，用户点完按钮要马上看到结果的用 `updateTag`。

### 5.5 并行取数，避免请求瀑布

串行 `await` 会让总耗时等于各段之和，独立的数据要并发拿。

```tsx
// 反例：串行，总耗时 = 订单 + 客户 + 库存
const orders = await getOrders()
const customers = await getCustomers()
const stock = await getStock()

// 正例：并发，总耗时 = 最慢的一段
const [orders, customers, stock] = await Promise.all([getOrders(), getCustomers(), getStock()])
```

```tsx
// 用 Suspense 让各区块独立流式输出，慢的那块不阻塞快的
export default function OrdersPage() {
  return (
    <div className="grid grid-cols-3 gap-4">
      <Suspense fallback={<CardSkeleton />}>
        <OrderStats />
      </Suspense>
      <Suspense fallback={<CardSkeleton />}>
        <CustomerStats />
      </Suspense>
      <Suspense fallback={<CardSkeleton />}>
        <StockStats />
      </Suspense>
    </div>
  )
}
```

### 5.6 直接在服务端查库

Next 16 不要求通过 HTTP 中转，服务端组件可以直接调 ORM，少一跳网络和一个接口层。

```ts
// src/lib/db.ts —— 开发环境复用连接，避免热更新时连接数暴涨
import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({ log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'] })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
```

边界：服务端查库只适用于“渲染时取数”。需要给移动端、第三方调用的接口，仍然要写 `route.ts`，不要指望别人能消费 RSC Payload。

## 六、Server Actions 与表单变更

这一章解决“页面上的写操作怎么做”，包括校验、错误回显、乐观更新和缓存失效。

### 6.1 Action 的定义与安全边界

Server Action 是一个标了 `'use server'` 的异步函数，编译后成为可被客户端调用的端点。它等价于公开 API，必须自己做鉴权和校验。

```ts
// src/app/orders/actions.ts
'use server'                    // 文件级标记，导出的每个函数都成为 Action
```

```mermaid
sequenceDiagram
  participant U as 浏览器
  participant S as 服务端
  participant D as 数据库
  U->>S: POST 携带 Action ID 与 FormData
  S->>S: 校验会话与 Zod Schema
  S->>D: UPDATE order
  D-->>S: 成功
  S->>S: updateTag 失效缓存
  S-->>U: 返回结果与新 RSC Payload
  U->>U: 乐观状态被真实数据替换
```

三条硬约束：

- 参数只能是可序列化的值或 `FormData`；
- 必须在函数内部重新鉴权，不能信任调用方传的 `userId`；
- 不能在 Action 里 `redirect()` 之后还返回数据，`redirect` 会抛异常终止。

### 6.2 `useActionState` 处理返回值

`useActionState` 把 Action 的返回值、pending 状态和 dispatch 一起给出，替代手写 `useState` + `try/catch`。

```tsx
// src/app/orders/status-form.tsx
'use client'

import { useActionState, useOptimistic } from 'react'
import { updateOrderStatus, type ActionState } from './actions'
import type { Order, OrderStatus } from '@/lib/orders'

const INITIAL: ActionState = { ok: true }

export function StatusForm({ order }: { order: Order }) {
  const [state, formAction, pending] = useActionState(updateOrderStatus, INITIAL)

  // 为什么用 useOptimistic：网络往返 200ms 内先显示新状态，失败时 React 自动回滚
  const [optimisticStatus, setOptimisticStatus] = useOptimistic(
    order.status,
    (_current, next: OrderStatus) => next,
  )

  async function submit(formData: FormData) {
    setOptimisticStatus(String(formData.get('status')) as OrderStatus)
    await formAction(formData)   // 必须 await，否则乐观更新会在结果回来前结束作用域
  }

  return (
    <form action={submit} className="flex items-center gap-2">
      <input type="hidden" name="id" value={order.id} />
      {/* 乐观值变化时重新挂载，defaultValue 才会反映新状态 */}
      <select
        name="status"
        key={optimisticStatus}
        defaultValue={optimisticStatus}
        disabled={pending}
        aria-label="订单状态"
        className="rounded border border-slate-300 px-2 py-1 text-sm"
      >
        <option value="pending">待付款</option>
        <option value="paid">已付款</option>
        <option value="shipped">已发货</option>
        <option value="cancelled">已取消</option>
      </select>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
      >
        {pending ? '保存中' : '保存'}
      </button>
      {!state.ok && state.fieldErrors?.status && (
        <span role="alert" className="text-xs text-red-600">
          {state.fieldErrors.status[0]}
        </span>
      )}
    </form>
  )
}
```

把 `submit` 传给 `<form action>` 时，React 会自动把它包进 transition，`useOptimistic` 才有合法的更新时机。在 `onClick` 里直接调 `setOptimisticStatus` 会报 “optimistic state update outside a transition”。

### 6.3 服务端校验与 Zod

客户端校验是为了体验，服务端校验是为了正确。两边共用同一份 Schema，避免规则漂移。

```ts
// src/lib/schemas.ts —— 前后端共用，放在 lib 下不标 'use server'
import { z } from 'zod'

export const OrderStatusSchema = z.enum(['pending', 'paid', 'shipped', 'cancelled'])

export const UpdateOrderSchema = z.object({
  id: z.string().min(1, '订单号不能为空'),
  status: OrderStatusSchema,
  note: z.string().max(200, '备注不能超过 200 字').optional(),
})

export type UpdateOrderInput = z.infer<typeof UpdateOrderSchema>
```

Zod 4 的错误格式化 API 变了：`schema.flatten()` 改为 `z.flattenError(error)`，`schema.format()` 改为 `z.treeifyError(error)`。升级时这两处必须改，否则运行时 `is not a function`。

### 6.4 错误处理与重定向

Action 里抛出的错误会冒泡到最近的 `error.tsx`，业务错误应该作为返回值，不要用异常传递。

```ts
export async function createOrder(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession()
  const parsed = CreateOrderSchema.safeParse(Object.fromEntries(formData))

  if (!parsed.success) {
    return { ok: false, fieldErrors: z.flattenError(parsed.error).fieldErrors }
  }

  // 业务规则失败也是返回值，前端能定位到字段
  const stock = await db.stock.findUnique({ where: { sku: parsed.data.sku } })
  if (!stock || stock.available < parsed.data.quantity) {
    return { ok: false, fieldErrors: { quantity: ['库存不足'] } }
  }

  const created = await db.order.create({ data: { ...parsed.data, ownerId: session.userId } })
  revalidatePath('/orders')
  redirect(`/orders/${created.id}`)   // 必须放最后：redirect 抛的是控制流异常，后面代码不会执行
}
```

### 6.5 Action 的运行时约束

| 约束 | 数值 | 说明 |
|---|---|---|
| 请求体上限 | 1MB（默认） | 上传大文件走预签名 URL |
| 超时 | 取决于部署平台 | Vercel 受函数时长限制 |
| 并发 | 无内置限流 | 需要自己加令牌桶 |
| 幂等 | 不保证 | 重复点击要前端禁用 + 后端幂等键 |

`next.config.ts` 里可以调整请求体上限：

```ts
const nextConfig: NextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: '2mb' }, // 为什么调：批量导入 CSV 超过默认 1MB，再大就该走对象存储
  },
}
```

## 七、代理层、鉴权与访问控制

这一章解决“未登录用户怎么被挡住”，以及为什么挡住之后还要再校验一次。

### 7.1 `proxy.ts` 的职责

Next 16 把 `middleware.ts` 更名为 `proxy.ts`，导出的函数名也改为 `proxy`。它固定运行在 Node.js 运行时（不能配置成 Edge），适合做重定向、加响应头、粗粒度拦截；不适合查库，因为它对每个匹配请求都执行，鉴权也不能只靠它。

```ts
// src/proxy.ts
import { NextResponse, type NextRequest } from 'next/server'

const PROTECTED = ['/orders', '/customers', '/settings']

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // 为什么先判公开路径：静态资源与登录页不能被拦，否则会死循环重定向
  if (!PROTECTED.some((p) => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  const session = request.cookies.get('session')?.value
  if (!session) {
    const url = new URL('/login', request.url)
    url.searchParams.set('next', pathname)   // 为什么带 next：登录后能回到原页面
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  // 只匹配页面路径，排除 _next 静态资源与图片优化接口
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

`proxy` 只应读 cookie 做有无判断，不应在这里验签或查库；它挡的是“没有凭证的访问”，不是“凭证是否有效”。真正的会话校验必须放在服务端数据层。

### 7.2 会话校验的实现

```ts
// src/lib/auth.ts
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { jwtVerify } from 'jose'
import { env } from './env'

const secret = new TextEncoder().encode(env.SESSION_SECRET)

export type Session = { userId: string; role: 'admin' | 'operator' }

export async function getSession(): Promise<Session | null> {
  // 为什么 await：Next 16 的 cookies() 是异步 API
  const token = (await cookies()).get('session')?.value
  if (!token) return null

  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] })
    return { userId: String(payload.sub), role: payload.role as Session['role'] }
  } catch {
    return null   // 过期或签名不对都当作未登录，不区分原因，避免泄露信息
  }
}

export async function requireSession(): Promise<Session> {
  const session = await getSession()
  if (!session) redirect('/login')
  return session
}

export async function requireAdmin(): Promise<Session> {
  const session = await requireSession()
  if (session.role !== 'admin') redirect('/403')
  return session
}
```

### 7.3 三层校验的分工

| 层 | 能做什么 | 不能做什么 |
|---|---|---|
| `proxy.ts` | 有无 cookie、路径重定向 | 验签、查库、判角色 |
| 服务端组件 | 验签、查库、按角色渲染 | 阻止 Action 被直接调用 |
| Server Action | 验签、查库、写操作授权 | 替代数据库行级权限 |

三层都要有。只做 proxy 会出现“伪造 cookie 直接访问 Action”；只做 Action 会出现“页面能打开、数据接口全 500”。

### 7.4 响应头与安全基线

```ts
// src/proxy.ts 里追加
const response = NextResponse.next()
response.headers.set('X-Frame-Options', 'DENY')                    // 禁止被第三方 iframe 嵌套
response.headers.set('X-Content-Type-Options', 'nosniff')          // 禁止浏览器猜 MIME
response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
return response
```

CSP 建议在 `next.config.ts` 的 `headers()` 里集中配置，不要散在 proxy 里，否则每次请求都要拼一遍字符串。

## 八、metadata、图片与字体

这一章解决“页面在搜索结果和社交平台里长什么样”，以及静态资源怎么不拖慢首屏。

### 8.1 静态与动态 metadata

`metadata` 导出在服务端组件里生效，子页面继承根布局的模板。

```tsx
// src/app/orders/[id]/page.tsx
import type { Metadata } from 'next'
import { getOrder } from '@/lib/orders'

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const order = await getOrder(id)

  if (!order) return { title: '订单不存在' }

  return {
    title: `订单 ${order.id}`,                     // 模板自动拼成 "订单 SO-001 | 运营后台"
    description: `客户 ${order.customer}，金额 ¥${order.amount}`,
    robots: { index: false, follow: false },       // 为什么禁止索引：后台页面不该进搜索引擎
    openGraph: { title: `订单 ${order.id}`, type: 'article' },
  }
}
```

后台类应用统一在根布局加 `robots: { index: false }`，避免内部单据被爬虫收录。对外站点则相反，需要 `sitemap.ts` 和 `robots.ts`。

### 8.2 图片优化

`next/image` 在构建时算出尺寸、按需转格式，避免布局抖动。

```tsx
import Image from 'next/image'

// 为什么写 sizes：告诉浏览器实际显示宽度，避免下载过大的图
// 首屏主图才设 priority，其余懒加载
<Image
  src="/products/keyboard.webp"
  alt="机械键盘商品图"
  width={320}
  height={200}
  sizes="(max-width: 640px) 100vw, 320px"
  className="rounded border border-slate-200 object-cover"
  priority={false}
/>
```

远程图片必须在配置里声明域名，16 已移除 `images.domains`：

```ts
const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'cdn.example.com', pathname: '/products/**' },
    ],
  },
}
```

### 8.3 字体自托管

```tsx
// src/app/layout.tsx
import { Inter } from 'next/font/google'

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',   // 为什么 swap：字体加载期间先用系统字体，避免文字不可见
  variable: '--font-sans',
})

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={inter.variable}>
      <body className="font-sans">{children}</body>
    </html>
  )
}
```

中文字体文件大，`next/font/google` 只适合拉丁字符。中文站点用 `next/font/local` 加子集化后的 `woff2`，否则首屏会多等几百 KB。

## 九、构建、部署与排障

这一章解决“本地能跑、线上能不能跑”，以及出问题时从哪一层开始查。

### 9.1 构建与产物

```bash
npm run build
```

预期输出（关键片段）：

```text
   ▲ Next.js 16.0.0
 ✓ Compiled successfully in 8.4s
 ✓ Generating static pages (12/12)

Route (app)                    Size     First Load JS
┌ ○ /                          1.2 kB         102 kB
├ ○ /login                    2.4 kB         110 kB
├ ƒ /orders                   0.9 kB         101 kB
└ ƒ /orders/[id]              1.1 kB         103 kB

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

`ƒ` 表示按请求渲染。如果本该静态的营销页显示 `ƒ`，说明里面用了 `cookies()`、`headers()` 或未缓存的 fetch，静态化被打破。

### 9.2 Docker 部署

`output: 'standalone'` 之后，运行阶段只需要 `.next/standalone`、`.next/static` 和 `public`。

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci                              # 为什么用 ci：锁文件不一致时直接失败，避免线上依赖漂移

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
USER nextjs                              # 为什么降权：容器进程不以 root 运行
EXPOSE 3000
CMD ["node", "server.js"]
```

```bash
docker build -t admin-console:1.0.0 .
docker run --rm -p 3000:3000 --env-file .env.production admin-console:1.0.0
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/orders   # 期望 307 跳登录
```

### 9.3 环境变量的三种来源

| 来源 | 生效时机 | 适用 |
|---|---|---|
| `.env.local` | 开发启动时 | 本地开发 |
| 构建参数 | `next build` 期间 | `NEXT_PUBLIC_*` 被内联 |
| 运行时环境 | 容器启动时 | 数据库、密钥 |

`NEXT_PUBLIC_*` 在构建时被字面替换，改值必须重新构建。服务端变量在运行时读取，重启容器即可。把密钥写成 `NEXT_PUBLIC_` 前缀是最常见的泄漏方式。

### 9.4 排障表

| 现象 | 最可能原因 | 第一条命令 |
|---|---|---|
| 页面 500，日志报 `params` undefined | 忘了 `await params` | 搜 `params.` 是否直接取值 |
| 改数据后页面仍旧 | 只 `revalidatePath` 没失效数据缓存 | 检查有没有 `updateTag`/`revalidateTag` |
| 构建报 `useSearchParams` 需 Suspense | 客户端组件在静态页里用了搜索参数 | 包一层 `<Suspense>` |
| 部署后静态资源 404 | 没拷 `.next/static` | `docker run` 后 `curl /_next/static/...` |
| Action 返回 405 | 请求打到了错误的路由 | 看 Network 里的 Action ID |
| 内存持续上涨 | 开发模式连接池未复用 | 检查 `globalThis` 缓存写法 |

```bash
# 现场第一条命令：确认产物和运行时版本
docker exec -it <container> node -e "console.log(process.version)"
docker exec -it <container> ls .next/static/chunks | head
```

### 9.5 上线检查清单

- `npm run build` 无 TypeScript 错误，路由表里的 `○/ƒ` 符合预期；
- 所有 Server Action 内部有 `requireSession` 或等价校验；
- `proxy.ts` 的 `matcher` 排除了 `_next` 静态资源；
- 缓存函数都有 `cacheTag`，写操作都有对应的失效调用；
- `NEXT_PUBLIC_*` 里没有密钥；
- 容器以非 root 运行，健康检查指向一个轻量路由；
- 日志里能通过 `digest` 关联错误边界和堆栈。

## 十、最佳实践案例

### 10.1 案例背景

某 B2B 电商的运营后台，原先用 Vite + React SPA：首屏要等 JS 下载完再发三次请求，订单列表首屏 3.2 秒；运营改完订单状态要手动刷新才看到结果；导出和详情页共用一套前端路由，权限只在前端隐藏按钮，直接调接口能绕过。

目标是迁到 Next 16：首屏直出、状态变更即时可见、鉴权落在服务端。约束是不能改后端 API（仍走同一个 PostgreSQL），部署在自有 K8s，镜像要走内网仓库，Node 版本限定 22。

现状与约束整理：

| 项 | 现状 | 目标 |
|---|---|---|
| 首屏 | 3.2s（示例） | < 1.2s |
| 状态变更 | 手动刷新 | 提交后立即生效 |
| 鉴权 | 前端隐藏按钮 | 服务端强制校验 |
| 部署 | 静态托管 | K8s + Docker |

### 10.2 案例实操

第一步，按第二章的骨架建项目并开启缓存与独立产物。

```ts
// next.config.ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  cacheComponents: true,
  output: 'standalone',
  typedRoutes: true,
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'cdn.example.com', pathname: '/products/**' }],
  },
}

export default nextConfig
```

第二步，把订单查询做成带标签的缓存函数。

```ts
// src/lib/orders.ts
import { cacheLife, cacheTag } from 'next/cache'
import { db } from './db'

export type Order = {
  id: string
  customer: string
  amount: number
  status: 'pending' | 'paid' | 'shipped' | 'cancelled'
  createdAt: string
}

export async function getOrders(status?: string): Promise<Order[]> {
  'use cache'
  cacheTag('orders')
  cacheLife('minutes')   // 运营能接受分钟级陈旧，换取数据库 QPS 下降

  const rows = await db.order.findMany({
    where: status && status !== 'all' ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  return rows.map((r) => ({
    id: r.id,
    customer: r.customerName,
    amount: Number(r.amount),
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  }))
}
```

第三步，列表页用 Suspense 隔离慢查询，外壳先出。

```tsx
// src/app/(dashboard)/orders/page.tsx
import { Suspense } from 'react'
import { getOrders } from '@/lib/orders'
import { OrderTable } from '@/components/order-table'
import { StatusFilter } from '@/components/status-filter'

export const metadata = { title: '订单' }

export default function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">订单</h1>
        <StatusFilter />
      </div>
      <Suspense fallback={<TableSkeleton />}>
        <OrderList searchParams={searchParams} />
      </Suspense>
    </section>
  )
}

async function OrderList({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams   // 为什么在子组件里 await：让外壳不必等参数就能先返回
  const orders = await getOrders(status)
  return <OrderTable orders={orders} />
}

function TableSkeleton() {
  return <div className="h-64 animate-pulse rounded bg-slate-200" aria-busy="true" />
}
```

第四步，写操作走 Action，成功后同时失效数据缓存和页面缓存。

```ts
// src/app/orders/actions.ts
'use server'

import { revalidatePath, updateTag } from 'next/cache'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireSession } from '@/lib/auth'

const Schema = z.object({
  id: z.string().min(1),
  status: z.enum(['pending', 'paid', 'shipped', 'cancelled']),
})

export type ActionState = { ok: boolean; fieldErrors?: Record<string, string[] | undefined> }

export async function updateOrderStatus(_p: ActionState, formData: FormData): Promise<ActionState> {
  await requireSession()                                  // Action 是公开端点，必须自己验身份
  const parsed = Schema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { ok: false, fieldErrors: z.flattenError(parsed.error).fieldErrors }

  await db.order.update({ where: { id: parsed.data.id }, data: { status: parsed.data.status } })
  updateTag('orders')
  revalidatePath('/orders')

  return { ok: true }
}
```

第五步，用 `useOptimistic` 让行内状态立刻变化。

```tsx
// src/components/order-row.tsx
'use client'

import { useActionState, useOptimistic } from 'react'
import { updateOrderStatus, type ActionState } from '@/app/orders/actions'
import type { Order } from '@/lib/orders'

export function OrderRow({ order }: { order: Order }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(updateOrderStatus, { ok: true })
  const [status, setStatus] = useOptimistic(order.status, (_c, next: Order['status']) => next)

  async function submit(formData: FormData) {
    setStatus(String(formData.get('status')) as Order['status'])
    await formAction(formData)
  }

  return (
    <tr className="border-b border-slate-100">
      <td className="px-3 py-2 font-mono text-xs">{order.id}</td>
      <td className="px-3 py-2">{order.customer}</td>
      <td className="px-3 py-2 text-right tabular-nums">¥{order.amount.toFixed(2)}</td>
      <td className="px-3 py-2">
        <form action={submit} className="flex items-center gap-2">
          <input type="hidden" name="id" value={order.id} />
          {/* 乐观值变化时重新挂载，defaultValue 才会反映新状态 */}
          <select
            name="status"
            key={status}
            defaultValue={status}
            disabled={pending}
            aria-label={`订单 ${order.id} 状态`}
            className="rounded border border-slate-300 px-2 py-1 text-xs"
          >
            <option value="pending">待付款</option>
            <option value="paid">已付款</option>
            <option value="shipped">已发货</option>
            <option value="cancelled">已取消</option>
          </select>
          <button type="submit" disabled={pending} className="text-xs text-blue-600 disabled:opacity-50">
            {pending ? '保存中' : '保存'}
          </button>
          {!state.ok && <span role="alert" className="text-xs text-red-600">校验失败</span>}
        </form>
      </td>
    </tr>
  )
}
```

第六步，代理层拦未登录访问，Action 内部再验一次。

```ts
// src/proxy.ts
import { NextResponse, type NextRequest } from 'next/server'

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (pathname.startsWith('/login')) return NextResponse.next()

  if (!request.cookies.get('session')) {
    const url = new URL('/login', request.url)
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

第七步，打包部署并验证跳转。

```bash
npm run build
docker build -t registry.internal/admin-console:1.0.0 .
docker run --rm -p 3000:3000 --env-file .env.production registry.internal/admin-console:1.0.0

curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/orders
# 307（跳转 /login）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login
# 200
```

迁移后的订单工作台：

![订单工作台界面](./assets/next-orders-console.svg)

### 10.3 案例结果

上线两周后的观测（示例数据，来自内部 Grafana）：

| 指标 | 迁移前 | 迁移后 |
|---|---|---|
| 列表首屏 LCP | 3.2s | 0.9s |
| 首包 JS | 412 KB | 118 KB |
| 列表 P95 响应 | 780ms | 140ms（缓存命中） |
| 状态变更生效 | 手动刷新 | 提交后 < 300ms |

失败模式与处理：

- 第一次上线出现“订单列表永远不更新”。原因是只调了 `revalidatePath`，数据缓存仍有旧值。加上 `updateTag('orders')` 后正常，顺序是先失效数据、再失效路由。
- 有人把 `params` 当同步对象用，详情页 500。报错被 `error.tsx` 吞成通用文案，靠 `digest` 才对到堆栈，之后把 `await params` 写进团队检查清单。
- 镜像首次构建 1.2GB。原因是没开 `standalone` 且把 `node_modules` 全拷进运行阶段，开启后降到 180MB。

复盘：Next 16 的收益不在“更快的框架”，而在把渲染位置、缓存时机、鉴权位置三件事显式化。这三件事只要有一件靠默认值，线上就会出现“看起来正常、数据是旧的”这类难查的问题。
