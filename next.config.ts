import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 开发预览不显示 Next.js 的 N 悬浮按钮及 Rendering 状态胶囊。
  devIndicators: false,
  agentRules: false,
  /**
   * 开发期可信来源。
   *
   * `localhost` 与 `127.0.0.1` 是同一个环回接口的两个门牌号，但 Next.js 只把
   * `localhost` 视作默认可信来源。用 `127.0.0.1:3000` 打开时会看到
   * 「Blocked cross-origin request to Next.js dev resource /_next/hmr」——
   * 页面能出（HTTP 200），但热更新与 dev overlay 失效，改代码不自动刷新，
   * 很容易被误判成「页面卡死了」。
   *
   * 这里只登记主机名（不要带协议和端口），仅影响开发模式，生产环境不读取。
   */
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    // 商品图片最多 5 MiB；为表单字段和 multipart 编码留出额外空间。
    serverActions: { bodySizeLimit: "6mb" },
  },
  /**
   * PGlite 是一个约 25MB、内含 WASM 与 PostgreSQL 数据文件的包，
   * 靠 `import.meta.url` 在运行期定位自身资源。
   *
   * 让打包器处理它会同时踩两个坑：WASM 被当普通模块内联后加载失败，
   * 以及运行期路径被重写导致找不到扩展 tar 包。声明为外部依赖后，
   * Next.js 保留 `require("@electric-sql/pglite")` 原样交给 Node 解析，
   * 行为与直接跑 tsx 脚本一致。
   *
   * 只在 DATA_SOURCE=local 时真正被加载，mock / db 模式下不会引入。
   */
  serverExternalPackages: ["@electric-sql/pglite"],
  images: {
    /**
     * 商品图片存放在 Supabase Storage，公共 URL 由环境变量决定，
     * 构建期不一定存在。这里统一关闭 Next.js 图片优化：
     * - 避免为了一个远程域名在 next.config 里做构建期耦合；
     * - Supabase Storage 本身已支持缓存与按需 CDN，演示场景收益不大。
     * 若后续要做响应式裁剪，改回优化模式并在此处补 remotePatterns。
     */
    unoptimized: true,
  },
};

export default nextConfig;
