<div align="center">

![海创Buddy：一个人，也可以拥有一支 AI 经营团队](docs/images/readme-banner.png)

# 海创Buddy · Haichuang Buddy

### 一个人，也可以拥有一支 AI 经营团队。

面向海产小商户与 OPC 个体经营者的 AI 经营工作台。

用一个经营目标，连接商品、品牌、推广、答疑、直播准备与销售复盘。

![CI](https://github.com/yy9659/haichuang-buddy/actions/workflows/ci.yml/badge.svg)

![License: MIT](https://img.shields.io/badge/License-MIT-22D3EE?style=flat-square)

![Next.js](https://img.shields.io/badge/Next.js-16-111827?style=flat-square\&logo=nextdotjs)

![React](https://img.shields.io/badge/React-19-149ECA?style=flat-square\&logo=react)

![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square\&logo=typescript\&logoColor=white)

![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?style=flat-square\&logo=tailwindcss\&logoColor=white)

[界面预览](#界面预览) · [核心功能](#核心功能) · [快速启动](#快速启动) · [部署指南](docs/DEPLOYMENT.md) · [技术架构](#技术架构)

</div>

---

## 项目介绍

一家海产小店的经营者，往往要同时介绍商品、制作推广、回复顾客、准备直播和记录销售。海创Buddy把这些工作连接到同一个经营目标：经营大脑读取商户资料与已有成果，制定计划；商户确认后，工作流按依赖协调六类专业 Agent，记录过程并保存结果。

**一张产品图，跑通一场生意。** 从商品照片与已核对的价格、规格出发，生成推广内容、制作可下载海报、准备有来源的答复，再结合销售记录安排下一步行动。

当前项目处于应用原型阶段，已提供可运行的商户端与管理端，支持本地持久化和远程 PostgreSQL。AI 输出由商户核对，真实发布与经营决策由商户完成。

## 界面预览

### 商户工作台

经营大脑、当前目标、步骤进度与六个岗位入口集中展示，支持检索商品、素材和历史任务。商户可在顶部栏切换「深海夜航」和「海岸白昼」，管理端指挥大屏保持深色。

![商户工作台：AI 经营大脑、当前经营目标与六岗位入口](docs/images/dashboard.png)

<details>

<summary><strong>查看营销海报工作区</strong> · 文案编辑、设计预览与 PNG 下载</summary>

![推广素材：商品实拍、海报文案、档案价格与海报预览](docs/images/poster-studio.png)

海报保留商品实拍与档案价格。初始排版、AI 设计和可选的 AI 创意背景各有明确入口；下载前由商户核对。

</details>

<details>

<summary><strong>查看注册与登录入口</strong> · 海洋动态背景与玻璃质感卡片</summary>

![注册页面：海洋背景、品牌标识与创建账号表单](docs/images/register.png)

新用户可自行创建账号，并通过登录进入自己的经营空间。截图展示未填写的注册表单，页面同时提供已有账号的登录入口。

</details>

<details>

<summary><strong>查看平台管理端</strong> · 指挥大屏、运行监控与公共知识管理</summary>

![平台管理指挥大屏：海产品类、任务与渠道的可视化展示](docs/images/admin-dashboard.png)

这张截图选择了“演示展示”：128 家、3,450 份、1,280 次及图表比例属于示例数据。管理端可切换到平台实际记录；示例数字不代表实际用户规模或经营成果。

</details>

## 核心功能

### 一个经营大脑，六类专业岗位

| 岗位        | 主要能力                              | 页面                  |
| :-------- | :-------------------------------- | :------------------ |
| **商品经理**  | 管理图片、价格、规格与库存；生成商品理解、卖点、人群与使用场景   | `/products`         |
| **品牌经理**  | 整理店铺定位与店主表达偏好，生成可编辑、可确认的品牌档案      | `/brand`            |
| **内容运营**  | 按渠道与形式生成文案、分镜、口播或图文建议；设计并下载营销海报   | `/content`          |
| **智能客服**  | 模拟顾客提问，检索商户知识并展示来源；记录资料不足与人工确认需求  | `/customer-service` |
| **直播导演**  | 基于已核对的商品资料进行模拟观众问答、追问与按题复盘，支持弱项复练 | `/live`             |
| **经营分析师** | 汇总销售、商品与渠道表现，生成附数据依据的 AI 建议与下一步入口 | `/analytics`        |

工作台使用岗位名称，侧栏使用业务模块名称，两者指向同一页面。

### 从资料到可用结果

- **目标规划与执行**：商户确认计划后执行，支持依赖检查、成果复用、步骤跟踪、历史任务与失败重试。
- **营销海报**：文案驱动设计，支持一句话调整、竖版与方形 PNG 下载；通义万相可按需生成创意背景，商品照片保持实拍。
- **知识答疑**：知识切片、向量检索、回答引用与来源摘录；资料不足时提示人工确认并记录待补知识。
- **直播实战演练**：`/live` 先核对商品资料，再选择目标、难度、时长与模拟观众；逐题输入回答或使用浏览器语音转写，可暂停、恢复并查看追问、模拟认可度与趋势。结束后按题查看原话、引用和待核风险，针对弱项复练；镜头仅在浏览器本地预览，评分依据为文字。详见 [演练说明](docs/live-arena-implementation.md)。
- **销售记录与建议**：记一笔销售、粘贴表格、导入 Excel/CSV，支持列映射、预览核对与明细编辑；查看程序计算的商品与渠道表现，生成带数据依据的 AI 建议，保存并下载经营回顾。销售变化后提示更新旧建议。
- **平台管理与公共知识**：管理员查看任务成功与失败、耗时及脱敏错误摘要，核验并发布公共资料；登录商户可在 `/public-knowledge` 查阅已发布资料。公共资料目前不自动加入商户私有知识检索。

### 协作流程

```mermaid
flowchart TD
    Goal[商户提出经营目标] --> Brain[经营大脑读取资料与已有成果]
    Brain --> Plan[制定计划：职责、依赖与复用]
    Plan --> Confirm[商户确认]
    Confirm --> Workflow[工作流协调执行并记录状态]
    Workflow --> Product[商品经理]
    Workflow --> Brand[品牌经理]
    Product --> Content[内容运营]
    Brand --> Content
    Content --> Poster[文案、海报与商户核对]
    Workflow --> Customer[智能客服]
    Workflow --> Live[直播导演]
    Knowledge[商品资料与商户知识] --> Customer
    Knowledge --> Live
    Workflow --> Analyst[经营分析师]
    Sales[销售记录与程序汇总] --> Analyst
    Analyst --> Action[有数据依据的下一步建议]
    Action --> Goal
```

各 Agent 可以共用同一底层模型，区别在于职责、提示词、输入输出契约与执行流程。实际岗位和步骤随经营目标与资料状态变化。商品事实来自商户档案，销售金额由程序计算，模型负责理解、生成与解释。

## 快速启动

### 环境要求

- **Node.js 24**
- **pnpm 12.6.0**，版本已在 `package.json` 声明
- 首次体验不需要单独安装 PostgreSQL，也不需要模型密钥

```bash
git clone https://github.com/yy9659/haichuang-buddy.git
cd haichuang-buddy
pnpm install --frozen-lockfile
```

尚未安装 pnpm 时，运行 `npm install -g pnpm@12.6.0`。

### 创建配置

Windows PowerShell：

```powershell
if (!(Test-Path .env.local)) { Copy-Item .env.example .env.local }
```

macOS / Linux：

```bash
if [ ! -f .env.local ]; then
  cp .env.example .env.local
fi
```

在 `.env.local` 中设置：

```dotenv
DATA_SOURCE=local
AI_PROVIDER=mock
APP_ORIGIN=http://localhost:3000
```

```bash
pnpm dev --hostname localhost
```

打开 **<http://localhost:3000>**，注册并登录。注册无需邀请码，也无需配置邮件。全新本地数据库会自动建表；随后填写店铺、商品与品牌资料。下次只需执行 `pnpm dev`，按 `Ctrl+C` 停止。

`local` 模式默认把业务记录保存在 `.data/pgdata`，商品照片保存在 `.data/product-images`。`mock` 模型模式无需模型服务，新生成内容会带演示标记。常规启动无需执行种子或数据库重置命令。本地 PGlite 数据目录一次只能由一个进程使用；占用或异常锁的排查见 [常见问题](docs/技术与使用指南.md#常见问题)。

### 接入真实 AI

修改 `.env.local` 并重启服务：

```dotenv
AI_PROVIDER=dashscope
DASHSCOPE_API_KEY=your-dashscope-api-key
```

已接入阿里云百炼 / 通义千问的文本、图像理解与向量化能力。可选通义万相用于海报创意背景；具体模型、接口地域与超时配置见 [环境模板](.env.example) 和 [技术与使用指南](docs/技术与使用指南.md#ai-模型)。真实调用需要有效密钥、相应模型权限、额度与服务端网络。

| 配置            | 可用选项                    | 作用                            |
| :------------ | :---------------------- | :---------------------------- |
| `DATA_SOURCE` | `mock` / `local` / `db` | 内存示例、本地 PGlite 或远程 PostgreSQL |
| `AI_PROVIDER` | `mock` / `dashscope`    | 确定性示例或真实通义千问输出                |

这两组配置相互独立。其他模型提供方名称目前仅预留，尚未实现，调用会明确提示。

### 管理员入口

管理员由数据库角色决定。先在仅操作者可访问的环境准备账号，再用 `pnpm security:account lookup <邮箱>` 查找已存在的账号，按[首次授予步骤](docs/DEPLOYMENT.md#首次授予管理员)核对并授予。原有账号仍可登录；旧 `ADMIN_EMAILS` 不再授权任何账号。

### 账号、配额与数据维护

- `/register` 开放注册，无需邀请码；登录、注册和密码找回均有服务端限流。注册邮箱不会自动验证；只有确认归属并标记为已验证的邮箱，才能通过已配置的邮件服务找回密码。默认关闭邮件投递，配置方法见 [部署指南](docs/DEPLOYMENT.md#账号角色与限流)。
- 管理员权限记录在数据库角色中，通过受控命令授予或撤销；真实 AI 调用按商户限制每日次数与并发，默认上限及配置见 [部署指南](docs/DEPLOYMENT.md#账号角色与限流)。
- 本地 PGlite 提供离线备份与校验恢复命令 `pnpm data:backup <新备份目录> --offline`、`pnpm data:restore <备份目录> <新隔离目录>`。运行前须停止使用同一数据库目录的进程；恢复不会覆盖现有目录。操作步骤与远程 PostgreSQL / 对象存储备份要求见 [备份与恢复](docs/DEPLOYMENT.md#备份与恢复)。

公网开放前请完成 HTTPS、反向代理来源验证、邮件投递验证、数据库迁移和隔离恢复演练。安全部署步骤见 [部署指南](docs/DEPLOYMENT.md)。

## 部署

项目支持 **Node.js 服务部署**，使用 Next.js 服务端接口、数据库和文件存储。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

部署方式、环境配置、HTTPS 反向代理、远程数据库迁移以及持久化目录说明见 **[部署指南](docs/DEPLOYMENT.md)**。

- 单机体验：`DATA_SOURCE=local`，一个应用实例连接一个本地数据库目录。
- 长期部署：可选择远程 PostgreSQL 与 Supabase Storage；AI 背景目录仍需要持久化存储。远程数据库升级时先执行 `pnpm db:migrate`，应用直播演练迁移 `0014_live_arena` 后再启动新版。
- 当前实现不适合静态网页托管；使用临时文件系统的平台前需调整文件存储与任务执行方式。

## 技术架构

| 层级     | 技术                                                      |
| :----- | :------------------------------------------------------ |
| 全栈框架   | Next.js 16 App Router、React 19、TypeScript               |
| 界面     | Tailwind CSS 4、Radix UI、Lucide、Recharts、Motion          |
| AI 与校验 | DashScope 通义千问、可选通义万相、Zod 结构化输出                         |
| 编排与检索  | 经营目标规划、工作流依赖与复用、失败重试、知识切片与向量检索、引用校验                     |
| 数据与存储  | Drizzle ORM、PGlite / PostgreSQL、本地文件 / Supabase Storage |
| 安装与构建  | pnpm、TypeScript、GitHub Actions                          |

```text
src/
├── app/             商户端、管理端、认证页面与 Route Handlers
├── components/      业务组件与共享 UI
├── actions/         Server Actions：输入校验与服务调用
├── services/        业务编排与权限边界
├── ai/
│   ├── agents/      经营大脑与专业岗位 Agent
│   ├── prompts/     分岗位提示词
│   ├── schemas/     Zod 输出契约
│   ├── workflows/   依赖、复用、执行与重试
│   └── provider/    Mock、DashScope 与万相适配
├── rag/             知识切片、检索、引用与缺口
├── lib/live-arena/  直播演练状态、事件、评分与复练
├── repositories/    数据访问接口与实现
├── db/              Schema、迁移与数据库网关
├── storage/         商品图片与创意背景存储
└── analytics/       指标计算与销售分析依据
docs/                功能、部署与资源说明
```

调用链：**页面 → Server Action / Route Handler → Service → Agent / Repository → 数据库**。模型密钥与数据库连接保留在服务端。

## 构建检查

```bash
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` 包含安全集成测试、直播演练与本地锁测试；`pnpm test:security` 可单独运行安全测试。可选的浏览器冒烟测试分别为 `pnpm test:browser` 和 `pnpm test:arena:browser`，运行条件见 [部署指南](docs/DEPLOYMENT.md#可重复验证) 与 [演练说明](docs/live-arena-implementation.md#验证记录与剩余边界)。GitHub Actions 在主分支提交与 Pull Request 时检查类型、安全与直播测试、生产依赖审计及构建，使用 Mock 模式，无需仓库配置真实模型密钥。问题与建议欢迎通过 [GitHub Issues](https://github.com/yy9659/haichuang-buddy/issues) 提交。

## 项目文档

| 文档                         | 内容                         |
| :------------------------- | :------------------------- |
| [技术与使用指南](docs/技术与使用指南.md) | 页面能力、海报、销售、模型配置、管理端口径与故障排查 |
| [部署指南](docs/DEPLOYMENT.md) | 本地生产运行、服务器部署、数据持久化、迁移与备份   |
| [直播演练说明](docs/live-arena-implementation.md) | AI 实战演练流程、评分依据、演示方式与能力边界 |
| [资源说明](docs/ASSETS.md)     | 品牌文件、真实截图与替换方式             |
| [环境变量模板](.env.example)     | 配置项与默认模型；真实密钥填写在本地配置       |
| [MIT 许可证](LICENSE)         | 使用、修改与分发项目代码的许可条款          |

## 当前边界与后续方向

| 当前能力边界              | 后续方向             |
| :------------------ | :--------------- |
| 销售来自记账、粘贴或导入        | 对接获得授权的订单与销售系统   |
| 客服与直播使用站内模拟         | 对接获得授权的真实消息与评论，完善人工接管 |
| 公共资料可查阅，未自动进入私有检索   | 资料订阅、索引与来源版本管理   |
| 演练按提交的口播文字核验，摄像头为本地预览 | 更丰富的表达反馈与明确的数据授权 |
| 尚无实际增收、转化或节省成本的验证   | 真实商户试用与使用效果评估    |

## 许可证

项目原创代码采用 **[MIT License](LICENSE)**，允许使用、修改和分发，包括商业用途，须保留版权与许可证声明。第三方依赖遵循各自许可证；品牌与图像资源说明见 [ASSETS](docs/ASSETS.md)。

---

<div align="center">

**海创Buddy · 让一个人的经营，有团队的分工。**

[报告问题](https://github.com/yy9659/haichuang-buddy/issues) · [开始部署](docs/DEPLOYMENT.md)

</div>
