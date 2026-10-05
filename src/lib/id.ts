/**
 * ID 相关工具
 *
 * 背景：数据库主键是 uuid，而 URL 里的 id 完全由用户输入控制。
 * 如果直接把 "none" 这类非 uuid 字符串丢给 Postgres，会抛
 * `22P02 invalid input syntax for type uuid`，页面表现成 500 而不是 404。
 * 因此所有按 id 查询的仓储实现都必须先做格式校验。
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 是否为合法 uuid（用于查询前短路，避免数据库类型错误） */
export function isUuid(value: string | null | undefined): boolean {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * 生成带业务前缀的 id（Mock 数据源与内容哈希用，不作为数据库主键）。
 * 例如 createLocalId("prod") -> "prod_9f1c2ab3"
 */
export function createLocalId(prefix: string): string {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(16).slice(2, 14);
  return `${prefix}_${random}`;
}
