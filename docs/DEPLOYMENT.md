# 部署指南

海创Buddy是带服务端接口的 Next.js 应用，需要 Node.js 24、pnpm 12.6.0 和可写存储。本指南描述当前代码支持的 Node.js 部署方式。

## 选择数据方案

| 方案 | 配置 | 适用场景 |
| :--- | :--- | :--- |
| 本地持久化 | `DATA_SOURCE=local` | 单台机器、单应用实例；无需安装 PostgreSQL |
| 远程数据库 | `DATA_SOURCE=db` | 长期运行或需要共享数据库；提供 PostgreSQL 连接与商品图片存储 |
| 内存示例 | `DATA_SOURCE=mock` | 短期体验、CI；重启后业务记录还原 |

AI 独立配置：`AI_PROVIDER=mock` 无外部调用，`AI_PROVIDER=dashscope` 使用真实通义千问。

## 本地运行生产构建

按 [README](../README.md#快速启动) 安装依赖并创建 `.env.local`，然后执行：

```bash
pnpm build
pnpm start
```

打开 `http://localhost:3000`。生产构建与开发服务器不要同时连接同一个本地数据库目录。

## 服务器部署

### 1. 安装与配置

```bash
git clone https://github.com/yy9659/haichuang-buddy.git
cd haichuang-buddy
pnpm install --frozen-lockfile
```

创建 `.env.local` 或由运行平台注入环境变量；已有配置不应被模板覆盖。

单实例本地库示例：

```dotenv
DATA_SOURCE=local
LOCAL_DB_DIR=.data/pgdata
AI_PROVIDER=dashscope
DASHSCOPE_API_KEY=your-dashscope-api-key
ADMIN_EMAILS=your-admin@example.com
```

`ADMIN_EMAILS` 填自己已注册账号的邮箱。全新本地库由启动钩子自动应用迁移。

### 2. 构建并启动

```bash
pnpm build
pnpm start --hostname 127.0.0.1 --port 3000
```

使用自己服务器已有的进程管理器或服务管理器托管该命令，工作目录须为项目根目录。对本地库只运行一个应用实例，不使用集群模式共用 `LOCAL_DB_DIR`。服务账号须能写入 `.data`。

### 3. HTTPS 反向代理

将域名的 HTTPS 请求转发到 `127.0.0.1:3000`，保留 `Host`、`X-Forwarded-For` 和正确的 `X-Forwarded-Proto`。配置 WebSocket 转发与合理的请求超时。

反向代理的上传限制应不小于 **6 MiB**：应用支持单张商品图片最多 **5 MiB**，Server Actions 留有额外表单空间。真实 AI 请求可能比普通页面响应更慢，应用默认单次模型超时为 90 秒，可通过 `AI_TIMEOUT_MS` 调整。

HTTPS 影响生产会话 Cookie 和浏览器摄像头权限；代理须覆盖客户端伪造的转发头。反向代理与进程管理的通用参考见 [Next.js 官方自托管指南](https://nextjs.org/docs/app/guides/self-hosting)。

## 远程 PostgreSQL 与商品图片

配置示例：

```dotenv
DATA_SOURCE=db
DATABASE_URL=postgresql://user:password@database-host:5432/postgres
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
AI_PROVIDER=dashscope
DASHSCOPE_API_KEY=your-dashscope-api-key
```

上面的地址与凭据均为示例。当前远程商品图片实现使用 Supabase Storage：默认 bucket 为 `product-images`，照片通过公共图片地址展示。连接池用于日常查询时，应遵循服务商配置；迁移应使用支持迁移的直连或会话连接。

在停止相关写入并完成备份后，使用迁移连接执行：

```bash
pnpm db:migrate
pnpm build
pnpm start
```

当前向量字段使用 PostgreSQL 原生数组，检索在应用层计算；无需为首次部署额外安装 pgvector。数据库切换不会自动搬迁本地业务记录和图片，应单独安排迁移。

## 持久化与备份

| 路径或服务 | 保存内容 | 备份方式 |
| :--- | :--- | :--- |
| `LOCAL_DB_DIR`，默认 `.data/pgdata` | 本地账号、商户、商品、销售、知识与任务记录 | 停止全部使用该目录的进程后，备份整个目录 |
| `.data/product-images` | 本地模式的商品照片 | 与数据库同时备份并恢复 |
| `.data/poster-backgrounds` | 万相生成的背景、生成任务与引用文件 | 两种数据库模式都需保留该目录 |
| 远程 PostgreSQL | 远程业务记录 | 使用数据库服务商的备份 / 导出方式 |
| Supabase `product-images` | 远程商品照片 | 备份存储对象及对应数据库记录 |

服务重启、更新和恢复时保持这些位置一致；只复制源码不能恢复商户数据。数据库备份不应从正在写入的 PGlite 目录直接复制。

## 更新与运行限制

1. 备份配置、业务数据库与相关文件，停止本地库的应用实例。
2. 获取更新，执行 `pnpm install --frozen-lockfile` 与 `pnpm build`。
3. 远程模式执行新增迁移；本地模式在下次启动时自动迁移。
4. 启动后检查登录、商品图片、销售与管理端任务记录。

`pnpm demo:reset` 会删除选定的本地数据库，不属于更新或故障恢复流程。

当前文件存储依赖持久化磁盘，运行任务主要由应用进程承担。静态托管无法执行这些服务端能力；没有持久磁盘的 Serverless 环境需先改造背景存储与任务生命周期。使用远程数据库也不会自动消除这些文件和任务要求。

## 故障排查

- 端口占用：停止占用端口的本项目实例，或显式使用其他端口。
- 登录后跳回：检查数据库、会话及反向代理的 HTTPS 转发头。
- 模型请求失败：检查接口地域、密钥权限、额度、网络与超时；不要在日志中打印密钥。
- 本地数据库报 `Aborted()`：先停止所有共用数据目录的进程，保留日志并备份；不要删除数据库或运行重置代替修复。
- 海报背景重启后消失：检查 `.data/poster-backgrounds` 是否真正持久化。

更多页面行为与错误说明见 [技术与使用指南](技术与使用指南.md#常见问题)。
