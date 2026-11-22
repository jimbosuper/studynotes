---
title: "Playwright端到端测试"
category: "04-前端"
---

# Playwright端到端测试

> 这篇从端到端测试在分层里的位置讲起，经过安装与最小用例、定位器与自动等待、断言、页面对象与夹具、登录态复用、并行分片，最后落到 Trace 调试、CI 集成和套件稳定性治理。
>
> 学完能为一个 Vue 3.5 管理后台搭起可并行、可复现、失败可诊断的 Playwright 端到端测试套件，并把 flaky 失败压到可接受范围。

## 一、E2E 的职责与边界

端到端测试（End-to-End Testing，E2E）用真实浏览器从用户入口走完整链路，验证“页面、前端状态、接口、数据库、鉴权”串起来之后仍然正确。它测的是**集成后的用户承诺**，不是单个函数的分支。

E2E 的单位成本最高：一条用例几秒到几十秒，失败时可能牵扯前端、接口、数据、环境和网络。因此它只覆盖三类路径：

- 收入路径：登录、下单、支付、退款、发布；
- 权限路径：不同角色能看到什么、不能做什么；
- 历史高风险路径：线上出过事故、或者改动频繁的流程。

单元测试能证明的规则不要搬到 E2E。一个金额计算有 12 个分支，用 Vitest 跑 12 条毫秒级用例；E2E 只验证“满减在结算页显示正确”这一条链路。

| 层次 | 覆盖对象 | 单条耗时 | 失败定位 |
|---|---|---|---|
| 单元测试 | 函数、组件逻辑 | 毫秒 | 直接指向代码行 |
| 组件测试 | 组件渲染与交互 | 百毫秒 | 组件边界 |
| 接口测试 | 契约、状态码、鉴权 | 百毫秒到秒 | 接口与数据 |
| E2E | 用户可见的完整流程 | 秒到分钟 | 跨层，需要 Trace |

> 边界：E2E 不负责穷举表单校验、不负责像素级视觉回归（交给截图对比或视觉测试）、不负责压测。把这三类塞进 E2E，套件会慢到没人愿意跑，最后被跳过。

### 1.1 什么样的项目值得上 Playwright

判断标准是“有没有必须跨层验证的用户承诺”，而不是“有没有前端”。

| 场景 | 建议 |
|---|---|
| 管理后台、SaaS、电商 | 必上，关键路径 20–60 条 |
| 营销页、静态官网 | 不必，Lighthouse + 少量冒烟即可 |
| 强依赖第三方登录/支付的流程 | 上，但第三方用拦截或沙箱账号 |
| 组件库 | 组件测试为主，E2E 只验文档站示例 |

Playwright 相对 Selenium 的关键差异：自带浏览器二进制与等待机制、同一套 API 跑 Chromium/WebKit/Firefox、内置 Trace 与并行调度。代价是只能测 Chromium 系与 WebKit/Firefox，不能覆盖旧版 IE 或国产双核浏览器的兼容内核。

## 二、安装与最小跑通

Playwright 1.5x 要求 Node.js 18 以上，实际项目用 Node 20 或 22 LTS。安装分两步：装测试运行器，再装浏览器二进制。

```bash
# 项目内安装，锁定小版本，避免 CI 与本地行为不一致
npm i -D @playwright/test@1.56

# 只装需要的浏览器；CI 里通常只装 chromium 省时间
npx playwright install chromium
```

| 系统 | 安装命令 | 备注 |
|---|---|---|
| Ubuntu/Debian | `npx playwright install --with-deps chromium` | 自动装 libnss3 等依赖 |
| Rocky/CentOS | `npx playwright install chromium` 后手动 `dnf install nss atk cups-libs` | 无官方 `--with-deps` |
| macOS | `npx playwright install chromium` | 无需额外依赖 |
| Windows | `npx playwright install chromium` | 在 PowerShell 执行 |

初始化脚手架与配置：

```bash
npm init playwright@latest
# 选择 TypeScript、tests 目录、添加 GitHub Actions
```

最小配置只保留四件事：测试目录、基址、失败留痕、本地开发服务器。

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // 每个用例独立上下文，默认就是隔离的；打开并行让文件内用例也并发
  fullyParallel: true,
  // CI 上禁止 test.only 混进主干
  forbidOnly: !!process.env.CI,
  // 本地不重试，避免把不稳定当正常；CI 重试 2 次只为区分 flaky 与真失败
  retries: process.env.CI ? 2 : 0,
  // CI 机器核数有限，显式限制避免互相抢 CPU 反而更慢
  workers: process.env.CI ? 4 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:5173',
    // 只在第一次重试时录 Trace：首次失败多半是环境抖动，重试时留下的证据足够定位
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // 测试自己拉起 dev server，本地已有服务就复用，避免端口冲突
  webServer: {
    command: 'npm run dev -- --port 5173',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

第一条用例：

```ts
// e2e/smoke.spec.ts
import { test, expect } from '@playwright/test';

test('登录页可以打开并校验必填', async ({ page }) => {
  await page.goto('/login');

  // 断言标题，确认拿到的是登录页而不是重定向后的错误页
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible();

  await page.getByRole('button', { name: '登录' }).click();

  // 自定义校验把错误写进 role="alert" 的元素；web-first 断言会自动重试
  await expect(page.getByRole('alert')).toHaveText('请输入邮箱');
});

test('错误凭据提示登录失败', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill('qa@example.com');
  await page.getByLabel('密码').fill('wrong-pass');
  await page.getByRole('button', { name: '登录' }).click();

  // 接口有 600ms 延迟，断言会等到文本变化，不需要 sleep
  await expect(page.getByRole('alert')).toHaveText('邮箱或密码不正确');
});
```

```bash
npx playwright test
```

预期输出（首次运行会编译 TypeScript，耗时略长）：

```text
Running 2 tests using 2 workers

  ✓  1 e2e/smoke.spec.ts:3:1 › 登录页可以打开并校验必填 (193ms)
  ✓  2 e2e/smoke.spec.ts:15:1 › 错误凭据提示登录失败 (986ms)

  2 passed (1.5s)

To open last HTML report run:

  npx playwright show-report
```

> 边界：如果表单用原生 `required` 而不是自定义校验，点击提交会被浏览器拦下，页面不会出现自定义错误文案，测试等到超时。这时应断言 `input.evaluate(el => el.validationMessage)`，或者给表单加 `novalidate` 改走自己的校验逻辑。表单校验的归属决定了断言写在哪里。

`webServer.command` 里的端口参数依赖具体脚手架：Vite 与 Nuxt 用 `--port`，Next 用 `next dev -p`。端口同时写在 `command` 和 `url` 两处，必须同步改，否则测试会一直等到启动超时。

## 三、定位器与自动等待

定位器的第一原则是**按用户感知的方式找元素**：角色、可访问名称、标签文本。这样定位器与 DOM 结构解耦，重构 class 或换组件库不会成批失效，同时逼着页面保持可访问性。

```ts
// 角色 + 可访问名称：按钮文案改了测试就该改，这是产品契约的一部分
page.getByRole('button', { name: '保存' });

// 表单控件按 label 关联，和读屏器看到的名称一致
page.getByLabel('客户名称');

// 链接按可见文本
page.getByRole('link', { name: '订单管理' });

// 表格行先按内容过滤，再在行内找操作按钮，避免 nth(3) 这类位置耦合
page.getByRole('row').filter({ hasText: 'SO-20261113-001' })
    .getByRole('button', { name: '查看' });
```

`data-testid` 只用于“没有稳定语义”的位置：图表容器、拖拽手柄、动态生成的单元格。不要把它当成默认方案，否则测试会退化成“白盒选择器”。

```ts
// 图表没有角色和文本，用 testid 是合理的例外
page.getByTestId('revenue-chart');
```

> 边界：页面文本匹配不到时先检查字符编码。`Content-Type` 不带 `charset=utf-8` 且页面没有 `<meta charset="utf-8">` 时，浏览器可能按其他编码解码，中文文本全部对不上，`getByText('删除')` 返回 0 个元素。静态文件服务器（如 `python3 -m http.server`）默认不带 charset，本地复现时最容易踩到。

### 3.1 严格模式

一个定位器匹配到多个元素时，Playwright 直接抛错而不是默默取第一个。这是**严格模式（strict mode）**，用来暴露“选择器太宽”的问题。

```text
Error: expect(locator).toBeVisible() failed

Locator: getByRole('button', { name: '删除' })
Expected: visible
Error: strict mode violation: getByRole('button', { name: '删除' }) resolved to 3 elements:
    1) <button>删除</button> aka getByRole('row', { name: '机械键盘 删除' }).getByRole('button')
    2) <button>删除</button> aka getByRole('row', { name: '显示器 删除' }).getByRole('button')
    3) <button>删除</button> aka getByRole('row', { name: '扩展坞 删除' }).getByRole('button')
```

报错里附带了每个元素“等价的更窄定位器”，直接抄第一条就是修法；不要用 `.first()` 把问题盖住：

```ts
const row = page.getByRole('row', { name: /机械键盘/ });
await row.getByRole('button', { name: '删除' }).click();
```

断言（`expect`）和动作（`click`）遇到多匹配都会立刻抛严格模式错误，不会重试到超时；动作的报错还会带调用日志，所以“定位器太宽”在断言处更容易先看清，把关键步骤前置成断言能更早发现问题。

### 3.2 自动等待做了什么

每个操作前，Playwright 对目标元素做可操作性（actionability）检查，全部通过才执行：

| 检查 | 含义 | 不满足时的典型场景 |
|---|---|---|
| Attached | 元素在 DOM 中 | 列表还没渲染 |
| Visible | 有非空盒模型且 `visibility` 可见 | 弹窗动画中 |
| Stable | 两帧内位置不变 | 过渡动画、骨架屏切换 |
| Receives events | 命中测试点没被遮挡 | 遮罩层、固定头 |
| Enabled | 未禁用 | 提交中按钮置灰 |
| Editable | 可输入 | `readonly` |

断言同理：`expect(locator)` 系列会在超时前反复重试。这就是**web-first assertion**。

```ts
// 会重试到 5s：元素出现、文本变成目标值
await expect(page.getByRole('status')).toHaveText('保存成功');

// 会重试：行数从 0 变成 1
await expect(page.getByRole('row')).toHaveCount(1);
```

所以**不要写固定睡眠**：

```ts
// 反例：网络快时白等 2 秒，网络慢时仍然失败
await page.waitForTimeout(2000);
await expect(page.getByText('保存成功')).toBeVisible();
```

只有在“等待一个没有 DOM 变化的事实”时才需要显式等待，例如等待某个请求完成：

```ts
// 用响应事件等待接口，条件明确，不依赖时间
const saved = page.waitForResponse(
  (res) => res.url().includes('/api/orders') && res.request().method() === 'POST',
);
await page.getByRole('button', { name: '保存' }).click();
expect((await saved).status()).toBe(201);
```

> 边界：自动等待只解决“元素何时可操作”，不解决“数据是否正确”。接口慢、后端返回旧数据、缓存不一致，仍然要断言业务结果。自动等待也不能替代稳定测试数据。

## 四、断言与可读的用例

断言要落在用户能感知的结果上：可见文本、URL、列表条数、下载文件名。断言内部实现（某个 class、某个 React 状态）会让测试在重构时误报。

```ts
test('筛选待发货订单', async ({ page }) => {
  await page.goto('/orders?status=pending');

  const rows = page.getByRole('row').filter({ has: page.getByRole('cell', { name: '待发货' }) });
  await expect(rows).not.toHaveCount(0);

  // 断言 URL 也重要：筛选条件要能被分享和刷新还原
  await expect(page).toHaveURL(/status=pending/);

  // 软断言：一条用例检查多个字段，全部结果一起报告
  await expect.soft(page.getByTestId('total')).toHaveText('¥1,998.00');
  await expect.soft(page.getByTestId('count')).toHaveText('3');
});
```

`expect.soft` 在失败后继续执行，适合“一次跑完整个详情页字段”的场景；普通断言在第一个失败处终止，适合有前置依赖的步骤。

轮询非 DOM 状态（例如后端最终一致）：

```ts
// expect.poll 反复调用回调直到通过，适合查接口或读外部系统
await expect.poll(async () => {
  const res = await page.request.get('/api/orders/SO-20261113-001');
  return (await res.json()).status;
}, { timeout: 10_000 }).toBe('SHIPPED');
```

用例结构上，用 `test.step` 把长流程分段，Trace 和报告里会显示每一步耗时：

```ts
test('创建订单并提交审核', async ({ page }) => {
  await test.step('填写订单', async () => {
    await page.goto('/orders/new');
    await page.getByLabel('客户名称').fill('杭州云杉科技');
    await page.getByLabel('金额').fill('499.00');
  });

  await test.step('提交并等待审核状态', async () => {
    await page.getByRole('button', { name: '提交审核' }).click();
    await expect(page.getByRole('status')).toHaveText('已提交审核');
  });
});
```

> 边界：断言不是越多越好。一个页面写 40 条 `expect` 会让失败信息淹没重点；按“这次改动最可能破坏什么”挑 3–5 条。

## 五、页面对象与夹具

页面对象模型（Page Object Model，POM）把“页面怎么操作”收在一处，用例只表达业务意图。它解决三个问题：定位器重复、流程重复、改版时散落修改。

```ts
// e2e/pages/orders-page.ts
import { type Page, type Locator } from '@playwright/test';

export class OrdersPage {
  readonly page: Page;
  readonly newOrderButton: Locator;
  readonly rows: Locator;
  readonly status: Locator;

  constructor(page: Page) {
    this.page = page;
    // 定位器只在构造函数里定义一次，页面改版只改这里
    this.newOrderButton = page.getByRole('button', { name: '新建订单' });
    this.rows = page.getByRole('row');
    this.status = page.getByRole('status');
  }

  async goto() {
    await this.page.goto('/orders');
    // 等到列表骨架消失再返回，后续步骤才有稳定起点
    await this.page.getByTestId('orders-loading').waitFor({ state: 'detached' });
  }

  async createOrder(input: { customer: string; amount: string }) {
    await this.newOrderButton.click();
    await this.page.getByLabel('客户名称').fill(input.customer);
    await this.page.getByLabel('金额').fill(input.amount);
    await this.page.getByRole('button', { name: '保存' }).click();
  }

  // 返回 Locator 而不是 ElementHandle，断言仍可用 web-first 重试
  row(customer: string): Locator {
    return this.rows.filter({ hasText: customer });
  }
}
```

POM 的边界：

- 方法返回 `Locator` 或业务数据，不返回 `ElementHandle`；
- 断言放在用例里，POM 只保留“必须成立才能继续”的前置等待（如列表加载完成）；
- 不为每个页面都建 POM，只有被两个以上用例复用的页面才值得抽象；
- 组件库封装（如 Element Plus 的下拉框）在 POM 里统一处理，用例不直接碰内部 DOM。

夹具（fixture）把 POM 注入用例，避免每个 `test` 里手动 `new`：

```ts
// e2e/fixtures.ts
import { test as base, expect } from '@playwright/test';
import { OrdersPage } from './pages/orders-page';

type Fixtures = { ordersPage: OrdersPage };

export const test = base.extend<Fixtures>({
  ordersPage: async ({ page }, use) => {
    const ordersPage = new OrdersPage(page);
    // 每个用例从列表页开始，失败时 Trace 的第一帧就能看清上下文
    await ordersPage.goto();
    await use(ordersPage);
  },
});

export { expect };
```

```ts
// e2e/orders.spec.ts
import { test, expect } from './fixtures';

test('新建订单后出现在列表顶部', async ({ ordersPage, page }) => {
  await ordersPage.createOrder({ customer: '杭州云杉科技', amount: '499.00' });

  await expect(ordersPage.status).toHaveText('保存成功');
  await expect(ordersPage.row('杭州云杉科技')).toBeVisible();
});
```

> 边界：fixture 里不要做“创建 50 条订单”这类重数据准备。数据准备走接口（`request` fixture）或数据库种子，UI 只走被测路径。

## 六、登录态复用与测试数据

每条用例都从登录页点一遍，是 E2E 套件最大的时间黑洞。Playwright 的做法是：登录一次，把浏览器上下文状态存成 `storageState`，其余用例直接带着状态启动。

```ts
// e2e/auth.setup.ts
import { test as setup, expect } from '@playwright/test';

const authFile = 'e2e/.auth/user.json';

setup('登录并保存状态', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(process.env.E2E_USER!);
  await page.getByLabel('密码').fill(process.env.E2E_PASS!);
  await page.getByRole('button', { name: '登录' }).click();

  // 等到工作台出现，确认登录真的成功，避免把半登录状态存下来
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();

  // 保存 cookie + localStorage；sessionStorage 与 IndexedDB 不在其中
  await page.context().storageState({ path: authFile });
});
```

```ts
// playwright.config.ts 片段
projects: [
  // setup 项目先跑，产出状态文件
  { name: 'setup', testMatch: /auth\.setup\.ts/ },
  {
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      storageState: 'e2e/.auth/user.json',
    },
    // 依赖 setup，Playwright 会保证顺序，不需要手写 sleep
    dependencies: ['setup'],
  },
],
```

| 状态存放位置 | storageState 是否保存 | 说明 |
|---|---|---|
| Cookie（httpOnly） | 保存 | 推荐放会话令牌 |
| localStorage | 保存 | 易受 XSS 影响，谨慎放令牌 |
| sessionStorage | 不保存 | 每个标签页独立 |
| IndexedDB | 不保存 | 需自行导出或走接口重建 |

`storageState` 里只有状态，没有“登录这个动作”的覆盖。登录本身的校验要单独一条用例，否则登录坏了整套测试都会以“未授权”失败，定位被掩盖。

测试数据的三条规则：

- 每条用例自造数据，名字带唯一后缀（`客户-${Date.now()}`），避免并行时互相覆盖；
- 只读用例共享种子数据，写用例不共享；
- 用例结束不依赖“清理成功”，清理失败不能让后续用例失败，用接口按前缀批量清理。

```ts
// 用接口造数据比走 UI 快一个数量级，UI 只测被测交互
const res = await page.request.post('/api/orders', {
  data: { customer: `客户-${Date.now()}`, amount: 499 },
});
expect(res.ok()).toBeTruthy();
```

> 边界：`storageState` 里的令牌会过期。长流水线要在 setup 里判断过期并重新登录，或者把 token 有效期覆盖到流水线时长；不要用“跑失败就重试”掩盖过期。

## 七、并行、分片与重试

Playwright 默认给每个用例一个独立的浏览器上下文（BrowserContext），cookie、localStorage、缓存互不干扰，这是并行安全的基础。同一个文件内的用例要并发，需要 `fullyParallel: true`。

```bash
# 本地 8 个 worker 跑全量
npx playwright test --workers=8

# CI 拆 4 片，每片跑 1/4，4 台机器并行
npx playwright test --shard=1/4
```

| 手段 | 加速方式 | 代价 |
|---|---|---|
| workers | 单机多进程 | 吃 CPU 和内存，超过核数会变慢 |
| shards | 多机分片 | 需要 CI 矩阵和结果合并 |
| 接口造数 | 跳过 UI 前置 | 需要接口权限 |
| storageState | 跳过重复登录 | 需要处理令牌过期 |
| 只跑受影响用例 | `--only-changed` | 依赖 git 历史，可能漏测 |

重试只用于区分 flaky 与真失败，不用于“让 CI 变绿”：

```ts
// 明确标记不稳定用例，进入隔离清单，限期修复
test.fixme('导出 Excel 在 Safari 下偶发超时', async ({ page }) => {
  // 记录 issue 链接，避免静默删除
});
```

`test.describe.serial` 只用于“后一步依赖前一步产物”的流程，例如“创建→审核→发货”。串行块内任一用例失败，后续跳过，这是预期行为。不要用它来规避并行冲突，那是测试数据设计问题。

> 边界：重试次数越多，CI 越慢，且会把真 bug 伪装成 flaky。retries=2 的前提是失败率低于 2%；如果一条用例每次都要重试才过，它已经失去信号价值。

## 八、调试与 Trace

失败排查顺序固定为：看报告 → 看 Trace → 本地复现 → 加日志。

```bash
# 打开最近一次 HTML 报告，失败用例自带截图和 Trace 入口
npx playwright show-report

# 直接打开某个 Trace 文件
npx playwright show-trace test-results/orders-新建订单/trace.zip

# 本地逐步执行，带 Inspector
npx playwright test e2e/orders.spec.ts --debug

# UI 模式：时间旅行、 watch、按用例重跑
npx playwright test --ui
```

Trace 里最有用的四块：

| 面板 | 回答什么 |
|---|---|
| Actions | 每步操作耗时、等待了多久、是否重试 |
| Source | 失败行对应的源码与调用栈 |
| Network | 请求顺序、状态码、响应体、耗时 |
| Console | 前端报错与自定义日志 |

常见失败在 Trace 里的样子：

- 点不到按钮：Actions 里该步一直等到超时，Snapshot 显示有遮罩层；
- 断言失败：Snapshot 显示旧值，Network 显示接口 500 或返回了缓存；
- 偶发超时：该步耗时接近超时阈值，说明是性能问题不是选择器问题。

`page.pause()` 配合 `--debug` 可以在关键步骤暂停，检查实时 DOM：

```ts
await page.getByRole('button', { name: '保存' }).click();
await page.pause(); // 仅在 --debug 下生效，提交前删除或加环境判断
```

> 边界：Trace 记录 DOM 快照和网络，可能包含用户数据。CI 产物要设置保留期和访问权限；生产环境账号不要用于 E2E。

## 九、CI 集成

CI 的目标不是“跑一遍”，而是“失败能定位、结果可追溯、时间可接受”。三件事：固定浏览器版本、上传产物、合并分片报告。

```yaml
# .github/workflows/e2e.yml
name: e2e
on: [pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    # 官方镜像已含浏览器与系统依赖，省掉 install-deps 的不确定性
    container: mcr.microsoft.com/playwright:v1.56.0-noble
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright test --shard=${{ matrix.shard }}/4
        env:
          BASE_URL: http://127.0.0.1:5173
          E2E_USER: ${{ secrets.E2E_USER }}
          E2E_PASS: ${{ secrets.E2E_PASS }}
      # 失败也上传，Trace 只在失败时才有内容
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: blob-report-${{ matrix.shard }}
          path: blob-report
          retention-days: 7
```

分片报告需要 `blob` reporter，再合并成一个 HTML：

```ts
// CI 下用 blob，本地用 list + html
reporter: process.env.CI ? [['blob']] : [['list'], ['html', { open: 'never' }]],
```

```bash
# 下载所有分片的 blob-report 后合并
npx playwright merge-reports --reporter=html ./blob-report
```

| 检查项 | 做法 |
|---|---|
| 浏览器版本 | 镜像 tag 与 `@playwright/test` 版本一致 |
| 超时 | 全局 30s，单条慢用例 `test.slow()` 放宽 3 倍 |
| 产物 | Trace、截图、视频、blob 报告全部 `if: always()` |
| 保留期 | 7 天，避免存储膨胀 |
| 冒烟 | 主干合并后跑 P0 子集，PR 跑全量或受影响集 |

> 边界：容器里跑 `webServer` 要注意 `localhost` 与容器网络。服务跑在 sidecar 容器时，`BASE_URL` 要用服务名，`reuseExistingServer` 在 CI 必须为 `false`。

## 十、现场手册：失败模式与第一条命令

| 现象 | 最可能原因 | 第一条命令 |
|---|---|---|
| 全部用例 401 | storageState 过期或 setup 失败 | `npx playwright test e2e/auth.setup.ts --debug` |
| 单条用例点不到按钮 | 遮罩层、动画未结束、选择器过宽 | 看 Trace 的 Actions 与 Snapshot |
| 断言拿到旧数据 | 接口缓存、乐观更新未回滚 | 看 Network 面板响应体 |
| CI 比本地慢一倍 | workers 超过核数、无分片 | `--workers=2` 对比耗时 |
| 偶发 strict mode violation | 列表数据重复、选择器未限定行 | Trace 里看解析到的元素列表 |
| 上传下载用例失败 | 未等待 `download`/`filechooser` 事件 | 改用 `page.waitForEvent('download')` |
| 移动端视口错乱 | 只设了 viewport 没设 deviceScaleFactor | 用 `devices['iPhone 15']` 预设 |

### 10.1 三个最容易犯的错

**用 CSS 类名定位。** 组件库升级会把 `el-button--primary` 改掉，测试大面积红。类名是样式实现，不是用户契约。

**在测试里修业务数据。** 为了让用例过而改数据库、改 mock，等于测试自己造答案。数据问题回到种子和接口。

**把 E2E 当回归全量。** 每次提交跑 400 条 E2E，20 分钟起步，最后被设置成“允许失败”。E2E 只保留关键路径，其余下沉。

## 十一、最佳实践案例

### 11.1 案例背景

某 B2B 管理后台，Vue 3.5 + Element Plus + Vite 7，前端 6 个业务模块。原有 120 条 Playwright 用例，CI 单次 22 分钟，flaky 率约 12%，失败原因集中在 `waitForTimeout`、登录重复和选择器过宽。

目标：CI 压到 8 分钟以内，flaky 降到 2% 以下，失败能在 5 分钟内定位到层。约束：业务代码只允许加 `data-testid`，不允许为测试改交互；测试环境账号只有一个，不能并发登录同一账号。

### 11.2 案例实操

**第一步：统计问题分布。** 先量化，再改。

```bash
# 固定睡眠出现次数（示例项目为 20）
grep -rn "waitForTimeout" e2e | wc -l
# 20

# 每条用例平均耗时，按文件排序
npx playwright test --reporter=json > result.json
node -e "
const r=require('./result.json');
const byFile={};
for (const s of r.suites) for (const sp of s.specs) for (const t of sp.tests) {
  const f=s.file; byFile[f]=(byFile[f]||0)+(t.results[0]?.duration||0);
}
console.log(Object.entries(byFile).sort((a,b)=>b[1]-a[1]).slice(0,5));
"
```

输出显示 5 个文件占 62% 时长，其中登录相关前置占 31%，固定睡眠累计约 140 秒。

**第二步：统一登录，改用 storageState。** 账号只有一个，因此 setup 串行执行一次，其余项目依赖它。

```ts
// e2e/auth.setup.ts
import { test as setup, expect } from '@playwright/test';

setup('登录一次，供全部用例复用', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('邮箱').fill(process.env.E2E_USER!);
  await page.getByLabel('密码').fill(process.env.E2E_PASS!);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: '工作台' })).toBeVisible();
  // 只保存 cookie 与 localStorage；sessionStorage 不在其中
  await page.context().storageState({ path: 'e2e/.auth/user.json' });
});
```

```ts
// playwright.config.ts 关键段
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? [['blob']] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/user.json' },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: 'npm run dev -- --port 5173',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
  },
});
```

**第三步：把固定睡眠改成条件等待。** 逐条替换，先找“等的是什么”。

```ts
// 改前：等 2 秒，网络慢就失败
await page.getByRole('button', { name: '保存' }).click();
await page.waitForTimeout(2000);

// 改后：等接口返回再断言 UI，条件和结果一一对应
const saved = page.waitForResponse(
  (res) => res.url().includes('/api/orders') && res.request().method() === 'POST',
);
await page.getByRole('button', { name: '保存' }).click();
expect((await saved).status()).toBe(201);
await expect(page.getByRole('status')).toHaveText('保存成功');
```

**第四步：收敛定位器。** 用角色 + 名称，行内操作先过滤行。

```ts
// 改前：位置耦合，列表加一列就错
await page.locator('.el-table__row').nth(2).locator('.el-button').click();

// 改后：业务语义定位
const row = page.getByRole('row').filter({ hasText: 'SO-20261113-001' });
await row.getByRole('button', { name: '查看' }).click();
// 仍不唯一的单元格才加 testid
await expect(row.getByTestId('order-status')).toHaveText('待发货');
```

**第五步：分片 + Trace。** CI 从单机串行改为 4 分片，失败自动上传产物。

```bash
npm ci
npx playwright test --shard=1/4
```

```text
Running 30 tests using 4 workers, shard 1/4

  ✓  1 e2e/orders.spec.ts:12:1 › 新建订单后出现在列表顶部 (2.3s)
  ✓  2 e2e/orders.spec.ts:41:1 › 必填项缺失时阻止提交 (1.1s)
  ✓  3 e2e/permissions.spec.ts:8:1 › 只读角色看不到删除按钮 (0.8s)
  ...
  30 passed (52.6s)
```

四片合并后测试执行约 3 分半；含依赖安装与报告合并的整条流水线约 6 分 40 秒（示例）。

### 11.3 案例结果

该项目流水线的记录（示例项目数据；改前基线为治理统计，改后为优化后一个月的中位数）：

| 指标 | 改前 | 改后 | 口径 |
|---|---|---|---|
| CI 时长 | 22 min | 6 min 40 s | 4 分片，含安装 |
| flaky 率 | 12% | 1.7% | 连续 30 次流水线 |
| 固定睡眠 | 20 处 | 0 处 | `grep` 计数 |
| 登录次数/轮 | 120 次 | 1 次 | setup 项目 |
| 平均定位时间 | 40 min | 6 min | 从失败到定位到层 |

改动集中在测试侧：没有改业务交互，只给 3 个无语义单元格加了 `data-testid`。剩下一部分失败来自测试环境数据竞争，用“每条用例唯一客户名 + 接口造数”解决。

复盘：

- flaky 的主因是固定睡眠和共享数据，不是 Playwright 本身；换工具不解决这两件事；
- `trace: 'on-first-retry'` 是成本与可诊断性的平衡点，全程录 Trace 会让 CI 产物膨胀数倍；
- 分片数不是越多越好，4 片时单片 52 秒，8 片时启动开销占比过高，收益反而下降；
- 登录只有单账号时，setup 必须串行，否则会出现“后登录的把前一个踢下线”的假失败；
- E2E 只保留 120 条里的 68 条（上面的 30 条/片是裁减前的分片示例），其余下沉到组件和接口测试，套件才可能长期被认真执行。
