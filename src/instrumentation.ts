/**
 * Next.js 服务启动钩子。
 *
 * 目前只做一件事：`DATA_SOURCE=local` 时把本地数据库的迁移跑到最新。
 *
 * 为什么放在这里而不是懒加载：
 * 本地库（PGlite）的表结构必须**先于任何请求**建好。如果等第一次查询时再迁，
 * 页面会在启动后的头几秒偶发「relation does not exist」—— 这类错误只在冷启动
 * 出现，最难排查。`register()` 在 server 起来时被 await，正好卡住这个时间点。
 *
 * 三重保护，避免误伤其他场景：
 * 1. 只在 Node.js runtime 跑（Edge runtime 没有文件系统，也不该拖入 25MB 的 WASM）
 * 2. 只在 DATA_SOURCE=local 时跑（mock / db 模式零开销）
 * 3. 构建期直接跳过（`next build` 会预渲染页面，此时不该创建数据目录）
 *
 * 迁移函数本身幂等且有全局单例保护，开发模式热更新重复调用也无副作用。
 */

export async function register(): Promise<void> {
  // Edge runtime 不支持文件系统，PGlite 也不该被打进 Edge bundle
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  // 构建期预渲染不建库
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return;
  }

  // 动态 import：保证 mock / db 模式下这段代码完全不被求值
  const { getDataSource } = await import("@/lib/env");
  if (getDataSource() !== "local") {
    return;
  }

  const { ensureLocalDatabaseReady } = await import("@/db/local");
  await ensureLocalDatabaseReady();
}
