/**
 * 数据库仓储共享查询
 *
 * 「当前商家是谁」这个问题在商品、商家、知识库等十几个仓储里都要用，
 * 口径必须统一 —— 因此集中在这里，且**答案来自请求级会话上下文**。
 *
 * 在 S7 之前，答案是「库里最早创建的那条商家记录」。单商家 Demo 下永远正确，
 * 但第二个账号注册进来后两个人会共用同一份数据，且页面上没有任何迹象。
 * 现在改为：登录用户看到自己的商家；请求内无有效会话**拿不到任何商家**
 * （返回 null / 抛 UNAUTHORIZED），而不是静默回落到第一个租户。
 *
 * 例外：维护工具、测试、CRON 这类**没有请求作用域**的运行
 * 仍然回落到「最早的商家」，否则种子脚本自己都读不到刚写进去的数据。
 * 两条路径的辨别由 `getSessionContext()` 负责。
 */

import { asc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import { businesses, ownerProfiles } from "@/db/schema";
import { AppError } from "@/lib/result";

import { mapBusinessRow, mapOwnerProfileRow } from "./mappers";
import { getSessionContext } from "./session-context";

/** 「当前商家 id」的解析结果，附带空值的成因 */
type CurrentBusinessResolution =
  | { kind: "resolved"; businessId: string }
  | { kind: "unauthenticated" }
  | { kind: "uninitialized" };

/**
 * 解析「当前商家 id」，并把两种「空」分开。
 *
 * 分开是必须的：未登录该抛 UNAUTHORIZED（前端跳登录页），
 * 库为空该抛 VALIDATION_FAILED（提示先注册账号）。合成一种就分不清了。
 */
async function resolveCurrentBusiness(): Promise<CurrentBusinessResolution> {
  const context = await getSessionContext();

  if (context.kind === "request") {
    // 请求里：只认会话所属的 businessId。无会话 → 未登录，绝不回落。
    return context.businessId
      ? { kind: "resolved", businessId: context.businessId }
      : { kind: "unauthenticated" };
  }

  // 无请求作用域（脚本 / 测试 / CRON）：回落最早创建的商家
  const rows = await getDb()
    .select({ id: businesses.id })
    .from(businesses)
    .orderBy(asc(businesses.createdAt))
    .limit(1);

  const businessId = rows[0]?.id;
  return businessId ? { kind: "resolved", businessId } : { kind: "uninitialized" };
}

/**
 * 取当前商家 id；读不到时返回 null。
 *
 * 用于「读不到就当作尚未开始」的场景（例如品牌档案：还没建档就返回 null，
 * 界面进入 empty 态，而不是把「数据未初始化」当成错误抛出去）。
 * 未登录与库为空都返回 null —— 调用方不关心成因时用这个；
 * 需要区分「该去登录」还是「尚未开通商家」时用 `resolvePrimaryBusinessId()`。
 */
export async function findPrimaryBusinessIdOrNull(): Promise<string | null> {
  const resolution = await resolveCurrentBusiness();
  return resolution.kind === "resolved" ? resolution.businessId : null;
}

/**
 * 取当前商家 id；读不到时抛错。
 *
 * - 未登录（请求内无有效会话）→ UNAUTHORIZED，前端据此跳登录页
 * - 库为空（尚未开通商家）→ VALIDATION_FAILED，给出可操作提示
 */
export async function resolvePrimaryBusinessId(): Promise<string> {
  const resolution = await resolveCurrentBusiness();

  if (resolution.kind === "resolved") {
    return resolution.businessId;
  }

  if (resolution.kind === "unauthenticated") {
    throw new AppError({
      code: "UNAUTHORIZED",
      message: "请先登录",
      detail: "请求未携带有效会话，无法确定当前商家。",
      retryable: false,
    });
  }

  throw new AppError({
    code: "VALIDATION_FAILED",
    message: "尚未创建商家档案",
    detail:
      "businesses 表为空。请先注册账号，再填写商家资料。",
    retryable: false,
  });
}

/** 读取当前商家 + 老板数字分身（同一事务语义下的两条查询） */
export async function findPrimaryBusiness() {
  const businessId = await resolvePrimaryBusinessId();

  const businessRows = await getDb()
    .select()
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);

  const ownerRows = await getDb()
    .select()
    .from(ownerProfiles)
    .where(eq(ownerProfiles.businessId, businessId))
    .limit(1);

  const businessRow = businessRows[0];
  return {
    businessId,
    business: businessRow ? mapBusinessRow(businessRow) : null,
    ownerTwin: ownerRows[0] ? mapOwnerProfileRow(ownerRows[0]) : null,
  };
}
