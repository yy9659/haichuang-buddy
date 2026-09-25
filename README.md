# 海创Buddy —— 连江海产 AI 一人公司增长智能体

> 一个人，也可以拥有一支 AI 经营团队。
> 一张产品图，跑通一场生意。

## 当前进度

**Phase 0 —— 产品骨架与核心页面 UI（已完成）**

本轮只做前端骨架与 UI，**不包含**：AI Agent 逻辑、数据库、RAG、登录、第三方 API。
所有业务数据均来自 `src/lib/mock`（Mock 数据），并已在界面上明确标注。

已完成的页面：

| 路由 | 页面 | 说明 |
|---|---|---|
| `/` | — | 重定向到 `/dashboard` |
| `/dashboard` | AI经营驾驶舱 | 核心状态指标、6 张 AI 员工卡片、Agent Workflow、核心 CTA |
| `/products` | 商品中心 | 商品列表 + 前端筛选（关键词 / 分类 / 分析状态） |
| `/products/[id]` | Product DNA | 商品资料 + 商品经理 Agent 结构化输出 |
| `/brand` | 品牌中心 | 品牌定位、品牌资产、品牌故事、老板数字分身 |
| `/content` | AI内容工厂 | 内容生成表单、今日排期、内容资产（主从视图） |
| `/live` | AI直播间 | 三栏：直播数据/评论 · 主播提词器 · AI 直播导演 |
| `/customer-service` | 智能客服 | 会话列表 + 聊天区（含知识来源、转人工提示）+ 知识缺口 |
| `/analytics` | 经营分析 | 指标卡、趋势图、问题占比、内容/商品表现、任务完成率、经营日报 |

## 技术栈

- Next.js 16（App Router）+ TypeScript（`strict`，禁用 `any`）
- Tailwind CSS v4（`@theme inline` 设计令牌）
- shadcn/ui 风格组件（基于 Radix UI 手写，见 `src/components/ui`）
- Lucide React（图标）
- Recharts（图表）
- Motion（轻量入场动效）

## 运行

```bash
pnpm install
pnpm dev      # http://localhost:3000
pnpm lint
npx tsc --noEmit
```

> 说明：`pnpm-workspace.yaml` 中设置了 `nodeLinker: hoisted`。
> 本机（Windows / E 盘）环境下 pnpm 默认的 isolated 符号链接创建不稳定，
> hoisted 扁平 `node_modules` 可保证 `pnpm install` 与 `pnpm dev` 稳定可复现。

## 目录结构

```text
src/
├── app/
│   ├── layout.tsx              # 根布局（含全局 Provider）
│   ├── page.tsx                # 重定向到 /dashboard
│   ├── globals.css             # 设计系统（海洋蓝主题令牌）
│   └── (app)/                  # Dashboard 布局分组
│       ├── layout.tsx          # Sidebar + TopBar 统一布局
│       ├── dashboard/page.tsx
│       ├── products/page.tsx
│       ├── products/[id]/page.tsx
│       ├── brand/page.tsx
│       ├── content/page.tsx
│       ├── live/page.tsx
│       ├── customer-service/page.tsx
│       └── analytics/page.tsx
├── components/
│   ├── ui/                     # shadcn 风格基础组件
│   ├── common/                 # 跨页面复用组件（StatCard / SectionCard / TagSection …）
│   ├── layout/                 # Sidebar / TopBar / BrandMark
│   ├── motion/                 # 轻量动效容器
│   ├── dashboard/              # 驾驶舱组件
│   ├── products/               # 商品与 Product DNA 组件
│   ├── brand/                  # 品牌中心组件
│   ├── content/                # 内容工厂组件
│   ├── live/                   # 直播间组件
│   ├── customer-service/       # 智能客服组件
│   ├── analytics/              # 经营分析组件
│   └── providers/
├── lib/
│   ├── utils.ts                # cn / 数字与金额格式化
│   ├── navigation.ts           # 主导航与站点信息
│   ├── status-meta.ts          # 状态 → 文案 / 色调映射
│   ├── tone.ts                 # 语义色调与主题色 class 映射
│   └── mock/                   # Mock 数据（本轮唯一数据来源）
└── types/                      # 统一类型定义
```

## Mock 数据

所有 Mock 数据集中在 `src/lib/mock/`，后续接入数据库与 Agent 时按文件替换：

`business`（商家 / 老板数字分身）· `agents`（7 个 AI 员工）· `products`（6 个商品）·
`brand`（品牌档案）· `content`（7 条内容 + 今日排期）· `live`（直播场次、评论、AI 建议、提词器）·
`conversations`（6 个会话 + 消息 + 知识库 + 知识缺口）· `analytics`（指标、趋势、日报、目标）·
`workflow`（Workflow、今日任务、AI 任务通知）

## 后续阶段（本轮不做）

Phase 1 商品闭环 → Phase 2 品牌与内容 Agent → Phase 3 Agent Workflow →
Phase 4 RAG 智能客服 → Phase 5 AI 直播导演 → Phase 6 Analytics → Phase 7 Demo 优化。
