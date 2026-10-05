# 参与贡献

欢迎通过 Issue 描述问题、讨论改进，或提交 Pull Request。先阅读 [README](README.md) 与 [技术与使用指南](docs/技术与使用指南.md)，了解现有能力和数据边界。

## 开发环境

使用 Node.js 24 与 pnpm 12.6.0，按 README 安装依赖并创建 `.env.local`。开发时推荐 `DATA_SOURCE=local`；无需真实模型的改动使用 `AI_PROVIDER=mock`。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

## 提交改动

1. 从 `main` 创建分支，围绕一个清晰问题修改。
2. 沿用现有组件、样式、类型与 `Result<T>` 错误处理。
3. 业务变化补充能验证实际行为的测试；只改文字或样式时说明检查方式。
4. 更新受影响的使用说明或环境模板。
5. 提交 Pull Request，说明变化、使用方式和验证结果；界面变化附截图。

提交前运行：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## 数据库集成测试

`pnpm test:db` 会创建并写入本地 PGlite 数据库。当前测试配置会读取 `.env.local` 的 `LOCAL_DB_DIR`，因此应显式指定一个仅用于测试的目录。

Windows PowerShell：

```powershell
$env:LOCAL_DB_DIR = ".data/pgdata-contributor-tests"
pnpm test:db
Remove-Item Env:LOCAL_DB_DIR
```

macOS / Linux：

```bash
LOCAL_DB_DIR=.data/pgdata-contributor-tests pnpm test:db
```

测试目录不能与运行中的应用共用。运行真实模型验证脚本会调用外部 API；各脚本顶部注明前置条件和运行方式。

## 代码边界

- 页面和组件通过 Action 或接口调用业务服务，不直接访问数据库或模型密钥。
- 业务流程放在 `services/`；数据访问通过 `repositories/`；模型实现放在 `ai/provider/`。
- AI 输出契约放在 `ai/schemas/`，输入输出都应校验。模型失败保持明确错误，不能悄悄返回 Mock 结果。
- 商品价格、规格、知识来源和销售计算保留可核对的依据。
- `DATA_SOURCE=local` 与 `db` 共享迁移与数据库仓储；修改表结构时同时更新 Schema 和迁移。
- 维护商户数据隔离、管理员权限与来源不足时的人工确认流程。

## 维护工具

| 命令 | 用途 |
| :--- | :--- |
| `pnpm db:generate` / `pnpm db:check` | 生成 / 检查 Drizzle 迁移 |
| `pnpm db:migrate` | 迁移远程 PostgreSQL；本地模式启动时自动迁移 |
| `pnpm db:studio` | 打开 Drizzle 数据库管理界面 |
| `pnpm db:seed` | 写入或更新示例资料，仅用于专门的测试或体验环境 |
| `pnpm demo:reset` | 删除指定的本地示例库并重建；运行前停服务、核对目标并备份 |

日常启动不需要运行种子或重置。数据库 Schema 改动与数据维护流程见 [部署指南](docs/DEPLOYMENT.md)。

## 报告问题

请提供操作步骤、预期与实际结果、系统与 Node.js 版本，以及相关的脱敏错误。报告 UI 问题可附截图。不要提交 API Key、`.env.local`、会话 Cookie、真实客户记录、数据库备份或工具缓存。

项目原创代码使用 [MIT License](LICENSE)。新增依赖、代码和素材须有可确认的来源及适用许可。
