# 公网试用部署指南

适用于开放注册的小规模试用。服务端运行 Node.js 24 与 pnpm 12.6.0。公网使用 `pnpm start`，不要公开 `pnpm dev`、PostgreSQL 端口、备份目录或 Next.js 应用监听端口。

## 配置与启动

先安装依赖；在服务器用权限受控的环境文件或 Secret Manager 注入配置。勿把真实值写进源码、CI 输出或 Shell 历史。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start --hostname 127.0.0.1 --port 3000
```

| 配置 | 公网值 / 说明 |
| :--- | :--- |
| `DATA_SOURCE` | `local` 单机单实例；`db` 共享 PostgreSQL。勿用 `mock` 接待真实商户。 |
| `APP_ORIGIN` | 实际 HTTPS 源，例如 `https://buddy.example.com`，不含路径、查询或片段。邮件链接和 Secure Cookie 不依赖请求 Host。 |
| `MAIL_MODE` / `MAIL_API_KEY` / `MAIL_FROM` | `resend`、Resend 发信权限密钥、已验证域名下的发件地址。配置 SPF/DKIM，并实际收信验证。关闭邮件用 `off`，不会返回重设链接或声称已发送。 |
| `TRUSTED_PROXY_SECRET` | 反代与应用共用随机凭据，至少 32 字符；仅服务端可读。无配置时忽略所有来源头并使用共享来源桶，易误限流。 |
| `LOCAL_DB_DIR` / `ASSET_DATA_DIR` | 默认 `.data/pgdata` 和 `.data`；可用绝对路径挂载持久盘。所有进程必须一致。 |
| `AI_PROVIDER` | `mock` 明示演示，无外部调用；`dashscope` 需要有效密钥及模型权限。模型失败不切 Mock。 |
| `AI_DAILY_CALL_LIMIT` / `AI_CONCURRENT_CALL_LIMIT` | 默认每商户每日 100 次、同时 2 次；每日设为 0 可关闭真实模型。所有实例须使用同样设置。 |

本机生产构建可以用 `APP_ORIGIN=http://localhost:3000` 且仅监听回环；本地与公网均可自行注册，使用持久化数据库时注册限流均生效。开发邮件可显式使用 `MAIL_MODE=file` 和回环源，输出至 `ASSET_DATA_DIR/dev-mail/*.eml`，仅本机操作者读取；这些文件含有效凭据，应限制权限、用完清理，不纳入备份。生产禁用此模式。

## HTTPS 与可信来源

让防火墙只公开代理的 HTTPS 端口，HTTP 跳转 HTTPS。启用 HTTPS 后在代理配置 HSTS，关闭认证/API/带 Cookie 页面缓存。示例 Nginx（固定域名；用私密的 include 注入 proof，下面只写占位符）：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host buddy.example.com;
    proxy_set_header X-Forwarded-Host buddy.example.com;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Buddy-Client-IP $remote_addr;
    proxy_set_header X-Buddy-Proxy-Proof "SERVER_ONLY_PLACEHOLDER";
    client_max_body_size 6m;
    proxy_read_timeout 330s;
}
```

代理必须**覆盖**两个 X-Buddy 头，不能透传客户端值。应用只在 proof 匹配时信任单个有效 IP（IPv6 按 /64 合并），不使用客户端 X-Forwarded-For；proof 不匹配拒绝。若代理后面还有 CDN/LB，只有明确限制上游来源并正确配置其可信网段后才解析真实 IP，否则按代理地址合并限流。禁止公网绕过代理直连应用；不要记录请求体、Cookie、proof、邮件正文或模型原始输出。代理还应按真实来源设连接和请求速率上限，拦住分布式/大体积请求。单文件最多 5 MiB。

## 账号、角色与限流

### 首次授予管理员

1. **先阻断公网访问**，备份并迁移。选定确由操作者掌控的**现有账号**，核验邮箱所有权及账号 ID，勿按旧白名单批量迁移。
2. 本地库停应用后运行；远程库使用受信任服务端连接。以现有账号执行：

   ```bash
   pnpm security:account lookup operator@example.com
   pnpm security:account grant operator@example.com <现有账号UUID> --confirm-existing-account
   ```

   查找与授权要求邮箱和 UUID 精确匹配。角色变化撤销旧会话；审计记录目标 ID、原角色、新角色、命令操作者与时间，无令牌。撤销用同样参数把 `grant` 改为 `revoke`，最后一个管理员也可由操作者用 CLI 重新授予。没有 Web 提权入口，`ADMIN_EMAILS` 不再生效。

3. 全新空库：仅在操作者可访问的本机/SSH 隧道内启动开发实例，绑定回环、设 `APP_ORIGIN=http://localhost:3000`、`AI_PROVIDER=mock`，创建自用账号后停服务，再执行第 2 步。新账号永不认领已有商户。完成角色授予后可启动生产服务。

已有账号保留原 scrypt 登录。用户填写邮箱、称呼和密码即可注册，无需邀请或邮件服务。自行填写的邮箱不会被自动标记为已验证，未经验证的账号不能通过邮件找回；线下确认邮箱**实际归属对应用户**后，可执行 `pnpm security:account verify <邮箱> <UUID> --confirm-existing-account`，该操作也审计。无法证明邮箱归属时不应标记验证。找回只给统一提示，投递不阻塞响应，进程中断时可重新申请。重设有效 30 分钟，成功后撤销所有会话与该账号其它重设链接。用户需要重新登录。

### 服务端限流与模型预算

| 操作 | 来源 / 目标配额（固定窗口） |
| :--- | :--- |
| 登录 | 15 分钟 40 / 邮箱 8 |
| 注册 | 1 小时 12 / 邮箱 5 |
| 找回 | 1 小时 15 / 邮箱 4 |
| 重设 | 30 分钟 15 / 凭据 5 |

固定窗口可能在边界短时累积，两维均执行，命中返回中文等待时间。无论账号是否存在，使用相同规则和提示。PostgreSQL 原子计数；PGlite 仅一实例。使用 `pnpm security:prune` 清理到期会话、历史邀请、重设、限流、租约及 90 天前的 AI 计数；建议每天执行，PGlite 需安排停机，远程库可由受控计划任务执行。审计记录单独保留。

配额按北京时间自然日、每次允许发出的真实模型请求计数，跨 Agent 共用；结构纠错重试、网络重试和嵌入批次分别计入，失败请求不退计数。商户级数据库锁串行化配额检查和占位，流式响应到消费结束才释放并发；图片任务提交占一个名额，收到确定终态即释放，状态不明的任务可保守保留至 24 小时租约到期。图片状态查询不计模型生成次数，但单独限流。次数、生成内容估算用量与账单不同，应用不读取真实账单；另设供应商预算报警、账单上限和密钥权限。厂商可能在本地超时/断网后继续处理，租约只保证应用侧请求准入。

## 迁移与回滚

- 停止写入并制作**数据库和图片同一时点**的备份。升级前确认实际 `LOCAL_DB_DIR` 或目标 PostgreSQL，不换库、不执行 seed/reset。
- PGlite 首次启动新版时应用 `0013_public_security`；远程库用支持 DDL 的直连或会话连接执行 `pnpm db:migrate`。先在隔离库/分支验证；运行期 DB 账号必须是这些应用表的所有者或经评估可绕过 RLS 的专用服务端角色。旧邀请表作为历史数据保留，系统不再签发或消费邀请，不需要额外迁移。迁移启用应用表 RLS，回收 anon/authenticated 的直接表权限，并把同库 `product-images` bucket 转为私有。不删除业务记录；可推断归属的旧任务回填商户，无法推断的任务仅管理端可见。
- 远程配置 `DATABASE_URL`、`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`（服务端）。若对象存储是另一项目，在 Storage 控制台手工将 bucket 私有化；确认无匿名/通用 authenticated 下载或写入策略。先验证旧公共 URL 不再能匿名访问，排查 CDN 旧缓存。保留原键和 DB 引用，应用按当前商户代理读图。
- 核对现有登录、角色、开放注册、重设、限流、跨商户与图片读取后才放行。失败先撤下公网；迁移为增量，避免手写 DROP 或倒改迁移日志。若须回退，保留新版数据快照，将**升级前**备份恢复至全新目录/数据库，验证后切换配置与旧应用版本。旧版本只能在私网运行；切回旧快照会丢失备份之后的变更，先保留并核对差异。

## 备份与恢复

### 单实例 PGlite

1. 停止所有应用、脚本及旧版本进程，确认无写入；勿强杀后立刻复制。进程运行时持有数据库目录旁的 `<LOCAL_DB_DIR>.buddy.lock`，同一目录只能由一个进程打开。异常退出留下的锁若记录了本机主机名，且原进程已不存在，下次启动会自动将旧锁改名留存并重新加锁；旧版无主机名、来自其他主机或内容异常的锁不会自动移动，须先核实来源和进程状态。不要直接删除数据库或盲删锁文件。
2. 在项目根指定父目录已存在、目标未创建的新路径。执行：

   ```bash
   pnpm data:backup /secure-backups/buddy-2026-11-12 --offline
   pnpm data:restore /secure-backups/buddy-2026-11-12 /isolated/buddy-restore
   ```

   两命令均不覆盖目录。备份包含 `pgdata`、`product-images`、`poster-backgrounds` 和文件 SHA-256 清单，不含环境文件及开发邮件。失败的半成品不可用。恢复校验文件清单与内容；不要从不可信来源恢复。

3. 在隔离实例设置 `LOCAL_DB_DIR=/isolated/buddy-restore/pgdata`、`ASSET_DATA_DIR=/isolated/buddy-restore`；先关闭真实模型与邮件、绑定回环，检查旧账号、商户/销售记录、商品图片和海报背景，再择机切换。备份恢复会带回快照中的历史会话及凭据状态；灾难恢复上线前在离线库撤销全部会话、历史邀请与重设凭据，要求用户重新登录：

   ```sql
   BEGIN;
   DELETE FROM sessions;
   DELETE FROM account_invites;
   DELETE FROM password_resets;
   COMMIT;
   ```

   上述 SQL 仅用于隔离的远程恢复库。PGlite 停服务后，将 `LOCAL_DB_DIR` 明确指向恢复包内的 `pgdata`，运行 `pnpm security:account invalidate-restored --confirm-isolated-restore`；命令要求恢复工具写入的校验标记。不要针对活跃业务库执行。

### 远程 PostgreSQL 与 Supabase Storage

停写后使用服务商快照/PITR 或与服务器版本匹配的 `pg_dump -Fc`，保存应用 schema 和 Drizzle 迁移记录。把数据库还原到隔离实例，不覆盖源。Supabase 数据库备份不包含对象字节；另用 [Storage 下载/迁移工具](https://supabase.com/docs/guides/storage/management/download-objects) 或 S3 客户端带专用配置文件备份私有 bucket，保留对象键、MIME 和校验和，复原时上传至新项目的同名私有 bucket。切换到新项目时，经核对后将 DB 中旧项目商品图 URL 前缀映射到新项目（保持对象键不变），再测试所有者读取及他人拒绝。同时备份本地 `poster-backgrounds` 和仍使用的 `product-images`；多实例需共享持久化资产目录。参考 [Supabase 数据库备份](https://supabase.com/docs/guides/platform/backups)。

可用服务配置文件避免在参数中放密码，例如：

```bash
pg_dump --dbname=service=buddy-source --format=custom --schema=public --schema=drizzle --file=buddy.dump
pg_restore --list buddy.dump
pg_restore --dbname=service=buddy-isolated --exit-on-error --single-transaction --no-owner buddy.dump
```

先验证目标为空、角色与扩展兼容；Supabase 托管项目优先遵循其官方迁移步骤。

建议最少保留 7 份日备份及 4 份周备份（按实际隐私与容量要求调整），加密离站存储、定期恢复抽查。密码哈希、会话/令牌哈希和业务资料仍是敏感数据；仅授权运维访问。密钥另存 Secret Manager，备份不包含密钥；泄露后轮换并撤销会话。回滚操作前均保留当前数据，避免覆盖。

## 可重复验证

`pnpm test:security` 只创建隔离临时 PGlite，并演练从旧迁移升级及备份恢复。可选浏览器验证：先停止使用本仓库开发构建缓存的其他开发实例，设置 `BUDDY_SMOKE_BROWSER` 为 Chrome/Edge 可执行文件绝对路径，运行 `pnpm test:browser`。验证实例仅监听本机 3917，使用独立数据库、临时浏览器配置和开发邮件；禁用真实模型请求，不使用生产账号。

## 公网开放前核对

- 仅 HTTPS 代理可达；Cookie 为 `__Host-`、Secure、HttpOnly、SameSite=Lax；限制代理体积、来源及频率。
- 已迁移并授予经确认的管理员；两个账号验证直接改 URL / Action 参数 / 图片地址不能跨商户。
- 注册不依赖邮件服务。启用密码找回时验证真实发信域、收信和重设全流程；检查邮件服务未记录凭据，关闭邮件点击追踪。
- 限额耗尽先拒绝再请求模型。开放注册允许攻击者创建多个商户，不能把每商户配额当作全站费用上限；在供应商侧设总预算，并在代理侧限制注册滥用。明确向试用者告知提交给 AI 与邮件供应商的数据范围。
- 完成同点备份和隔离恢复。多实例使用 PostgreSQL、共享资产、相同代理/额度配置及安全管理的 Next Server Actions 加密密钥；不要在 PGlite 上使用多实例。
- 管理员目前无 MFA；建议额外限制管理端为 VPN/IP 允许列表或通过受控网关做强认证。应用限流不能替代反代/WAF、日志告警、供应商费用保护和独立渗透测试。

实现参考：[Next.js 认证指南](https://nextjs.org/docs/app/guides/authentication)、[OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)、[OWASP Forgot Password](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)。
