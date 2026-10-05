/**
 * Next.js URL 查询参数的读取工具
 *
 * 单独放这里的理由：`searchParams` 的形状（`Record<string, string | string[] | undefined>`）
 * 与「同一参数重复出现时取第一个值」这条规则，属于**框架层约定**，
 * 商品中心与内容工厂都要用。把它埋在任意一个业务 schema 文件里，
 * 都会让另一个领域形成没必要的依赖方向。
 */

/** 原始 searchParams（Next.js 页面组件传入的形状） */
export type RawSearchParams = Record<string, string | string[] | undefined>;

/**
 * 读取单个查询参数。
 * 缺失 / 非字符串 / 空数组一律返回空串，由调用方的 Schema 决定默认值 ——
 * 这里不抛错，因为 URL 是用户可随意编辑的输入。
 */
export function readParam(raw: RawSearchParams, key: string): string {
  const value = raw[key];
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return typeof value === "string" ? value : "";
}
