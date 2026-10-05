"use server";

/**
 * 智能客服的 Server Actions（S5 · Task 80）
 *
 * 为什么客户端组件只能碰这里（任务书第三十二 / 三十三节）：
 * 会话要检索企业知识库、要调大模型、要读写数据库。这三件事没有一件
 * 能放到浏览器里 —— 模型凭证会泄漏，检索逻辑会被绕过，
 * 「回答有没有依据」这个判断会变成客户端说了算。
 *
 * 因此链路固定为：
 *
 *   Client Component → Server Action → Service → Agent / Knowledge Service → Repository
 *
 * 本文件只做四件事：解析入参 → 解析当前商家 → 调服务 → 失效缓存。
 * **不含任何业务规则** —— 那些在 Service 里，Mock 与 DB 两套数据源共用同一份。
 */

import { revalidatePath } from "next/cache";

import { fail, ok, type Result } from "@/lib/result";
import {
  closeConversation,
  createConversation,
  handoffConversation,
  resolveActiveBusinessId,
  sendCustomerMessage,
  type CreateConversationInput,
  type SendCustomerMessageResult,
} from "@/services/customer-service";
import {
  createKnowledgeDocument,
  deleteKnowledgeDocument,
  getKnowledgeDocument,
  listKnowledgeDocuments,
  reindexKnowledgeDocument,
  updateKnowledgeDocument,
  createKnowledgeForGap,
  type CreateKnowledgeForGapResult,
  type KnowledgeDocumentInput,
  type KnowledgeDocumentPatch,
} from "@/services/knowledge.service";
import type { CustomerConversation, KnowledgeDocument } from "@/types";

/** 客服数据出现在哪些页面：改动后统一失效，避免切换到旧数据 */
function revalidateCustomerServiceSurfaces(): void {
  revalidatePath("/customer-service");
}

/** 新建模拟消费者会话（任务书第十九节） */
export async function createConversationAction(
  input: CreateConversationInput,
): Promise<Result<CustomerConversation>> {
  const created = await createConversation(input);
  if (!created.ok) {
    return created;
  }
  revalidateCustomerServiceSurfaces();
  return created;
}

/**
 * 消费者发一句话并取得 AI 回复。
 *
 * 返回 `ok` 且 `data.failure !== null` 表示「消息已保存，但 AI 这次没答上来」——
 * 界面必须据此显示可重试提示，而**不能**把它当成发送失败（见 service 文件头）。
 *
 * 这里**只对 `failure` 剥掉 `detail`**，其余错误原样返回，理由是两类 `detail`
 * 的来源不同：
 * - 校验类（内容为空 / 过长、会话已关闭、知识正文太短）的 detail 是**写给商家的
 *   中文解释**，剥掉它只会让「索引知识失败」变成一句没有下文的提示；
 * - 而 `failure` 来自模型层（`MODEL_TIMEOUT` / `SCHEMA_INVALID`），它的 detail 里
 *   可能夹着模型原始输出与提示词片段。那些东西一旦进浏览器，
 *   等于把企业内部知识库的原文交到任何能打开控制台的人手里。
 */
export async function sendCustomerMessageAction(input: {
  conversationId: string;
  content: string;
}): Promise<Result<SendCustomerMessageResult>> {
  const result = await sendCustomerMessage(input);
  if (!result.ok) {
    return result;
  }

  /**
   * 无论 AI 有没有答上来都要刷新：
   * 消费者消息已经落库，列表预览、排序、未读数、会话状态都可能变了。
   */
  revalidateCustomerServiceSurfaces();

  if (!result.data.failure) {
    return result;
  }
  const { failure } = result.data;
  return {
    ok: true,
    data: {
      ...result.data,
      failure: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
    },
  };
}

/** 结束会话 */
export async function closeConversationAction(
  conversationId: string,
): Promise<Result<CustomerConversation>> {
  const closed = await closeConversation(conversationId);
  if (!closed.ok) {
    return closed;
  }
  revalidateCustomerServiceSurfaces();
  return closed;
}

/** 转人工（AI 仍可继续回答，状态只是给页面一个持续可见的提示） */
export async function handoffConversationAction(
  conversationId: string,
): Promise<Result<CustomerConversation>> {
  const handed = await handoffConversation(conversationId);
  if (!handed.ok) {
    return handed;
  }
  revalidateCustomerServiceSurfaces();
  return handed;
}

/* ------------------------------------------------------------------ */
/* 企业知识库管理（任务书第二十七 ~ 三十一节）                          */
/* ------------------------------------------------------------------ */

/**
 * 校验文档归属当前商家。
 *
 * 为什么不直接在 Action 里把 id 丢给 `updateKnowledgeDocument`：
 * 那个服务是按 id 取文档、用**文档自己的** businessId 继续操作的，
 * 因此它无法回答「这份文档是不是当前商家的」。
 * 判断放在这里，等于在写入前补上唯一缺失的那一道归属校验 ——
 * 返回 `NOT_FOUND` 而不是「无权访问」，理由与 `requireConversation` 一致。
 */
async function requireOwnedDocument(
  documentId: string,
): Promise<Result<KnowledgeDocument>> {
  const businessId = await resolveActiveBusinessId();
  if (!businessId.ok) {
    return businessId;
  }

  const loaded = await getKnowledgeDocument(documentId);
  if (!loaded.ok) {
    return loaded;
  }
  if (loaded.data.businessId !== businessId.data) {
    return fail("NOT_FOUND", "知识文档不存在", `documentId=${documentId}`);
  }
  return loaded;
}

/** 入参里的 businessId 由**服务端**解析，客户端无权指定（跨商家写入不可接受） */
export type KnowledgeDocumentActionInput = Omit<
  KnowledgeDocumentInput,
  "businessId" | "source"
>;

export async function createKnowledgeDocumentAction(
  input: KnowledgeDocumentActionInput,
): Promise<Result<KnowledgeDocument>> {
  const businessId = await resolveActiveBusinessId();
  if (!businessId.ok) {
    return businessId;
  }

  const created = await createKnowledgeDocument({
    ...input,
    businessId: businessId.data,
  });
  if (!created.ok) {
    return created;
  }
  revalidateCustomerServiceSurfaces();
  return created;
}

/**
 * 编辑知识。
 *
 * **必须走 `updateKnowledgeDocument`**：它会「先重建索引成功、再替换旧的」，
 * 因此正文与向量永远一致。若直接改仓储的文档行，正文变了、向量还是旧的，
 * 检索会继续命中已被改掉的内容 —— 而且永远不会自愈（任务书第二十九节）。
 */
export async function updateKnowledgeDocumentAction(
  documentId: string,
  patch: KnowledgeDocumentPatch,
): Promise<Result<KnowledgeDocument>> {
  const owned = await requireOwnedDocument(documentId);
  if (!owned.ok) {
    return owned;
  }

  const updated = await updateKnowledgeDocument(owned.data.id, patch);
  if (!updated.ok) {
    return updated;
  }
  revalidateCustomerServiceSurfaces();
  return updated;
}

/** 删除知识（文档删除后切片级联清理；不自动重开曾被它解决的缺口） */
export async function deleteKnowledgeDocumentAction(
  documentId: string,
): Promise<Result<void>> {
  const owned = await requireOwnedDocument(documentId);
  if (!owned.ok) {
    return owned;
  }

  const removed = await deleteKnowledgeDocument(owned.data.id);
  if (!removed.ok) {
    return removed;
  }
  revalidateCustomerServiceSurfaces();
  return removed;
}

/**
 * 重新索引（不新建文档）。
 *
 * 用途是「切片规则 / 向量模型升级后把旧向量重建一遍」——
 * 与「编辑正文」是两件事：正文没变也要重建，因为建索引的规则可能变了。
 */
export async function reindexKnowledgeDocumentAction(
  documentId: string,
): Promise<Result<KnowledgeDocument>> {
  const owned = await requireOwnedDocument(documentId);
  if (!owned.ok) {
    return owned;
  }

  const reindexed = await reindexKnowledgeDocument(owned.data.id);
  if (!reindexed.ok) {
    return reindexed;
  }
  revalidateCustomerServiceSurfaces();
  return reindexed;
}

/* ------------------------------------------------------------------ */
/* 批量建立索引                                                        */
/* ------------------------------------------------------------------ */

export interface IndexPendingResult {
  /** 本次成功建立索引的文档数 */
  indexed: number;
  /** 仍然失败（索引状态不是 indexed）的文档名与原因 */
  failures: Array<{ name: string; message: string }>;
}

/**
 * 把当前商家所有**尚未完成索引**的知识补上索引。
 *
 * 为什么需要它：种子知识刻意只带正文、不带切片 —— 索引必须由服务层真实跑一遍
 * （切片 → 向量化 → 原子写入），而不是在种子数据里手抄一份假装已经索引好的切片。
 * 这就意味着演示环境第一次打开时必须有一个动作把索引补上。
 *
 * 逐份调用 `reindexKnowledgeDocument`，**一份失败不影响其余**：
 * 一次「模型抖了一下」不该让另外五份本来能建好的知识一起作废。
 * 失败的照样留在列表里（状态仍是「待索引 / 索引失败」），商家可以再点一次。
 */
export async function indexPendingKnowledgeDocumentsAction(): Promise<
  Result<IndexPendingResult>
> {
  const businessId = await resolveActiveBusinessId();
  if (!businessId.ok) {
    return businessId;
  }

  const listed = await listKnowledgeDocuments();
  if (!listed.ok) {
    return listed;
  }

  const pending = listed.data.filter(
    (document) => document.indexStatus !== "indexed",
  );

  let indexed = 0;
  const failures: Array<{ name: string; message: string }> = [];

  for (const document of pending) {
    const result = await reindexKnowledgeDocument(document.id);
    if (result.ok) {
      indexed += 1;
    } else {
      failures.push({ name: document.name, message: result.error.message });
    }
  }

  revalidateCustomerServiceSurfaces();
  return ok({ indexed, failures });
}

/* ------------------------------------------------------------------ */
/* 缺口 → 补知识（任务书第二十四节）                                    */
/* ------------------------------------------------------------------ */

export interface ResolveKnowledgeGapActionInput {
  gapId: string;
  name: string;
  type: KnowledgeDocumentActionInput["type"];
  content: string;
  summary?: string;
  productId?: string | null;
}

/**
 * 用一份新知识解决一条缺口。
 *
 * 内部顺序由 `createKnowledgeForGap` 保证：**索引先成功，才允许标记缺口已解决**。
 * 因此「界面显示已解决」与「同一个问题真的答得上来了」永远同步 ——
 * 反过来会出现商家以为补过了、AI 却依然答不上来的情况。
 */
export async function resolveKnowledgeGapWithDocumentAction(
  input: ResolveKnowledgeGapActionInput,
): Promise<Result<CreateKnowledgeForGapResult>> {
  const businessId = await resolveActiveBusinessId();
  if (!businessId.ok) {
    return businessId;
  }

  const created = await createKnowledgeForGap(input.gapId, {
    businessId: businessId.data,
    name: input.name,
    type: input.type,
    content: input.content,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.productId !== undefined ? { productId: input.productId } : {}),
  });
  if (!created.ok) {
    return created;
  }
  revalidateCustomerServiceSurfaces();
  return created;
}
