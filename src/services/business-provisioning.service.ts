/**
 * 新账号的商家开通（S7）
 *
 * 注册一个账号时，「这个人属于哪个商家」必须先有答案，否则登录进去
 * 每个页面都会撞上「尚未创建商家档案」。这一步就是那个答案的来源。
 *
 * ## 两种情形
 *
 * | 库里的状态 | 处理 |
 * | ---------- | ---- |
 * | 已有商家、但一个账号都没有 | **认领**：首个账号接手既有的演示商家 |
 * | 其它（全新库 / 已有账号） | **新建**：为这个账号单独建空白商家，不冒用演示商家的商品与知识 |
 *
 * 认领分支用于兼容已有的未认领演示数据。
 * 全新本地数据库没有既有商家，新账号获得独立的空白经营空间。
 *
 * ## 为什么只给被认领的演示商家灌数据
 *
 * 演示数据只给**被首个账号认领、且一件商品都没有**的演示商家写。已存在同名的商品 /
 * 知识文档一律跳过 —— 用户在页面上改过的东西，不能因为「又走了某条注册路径」
 * 被覆盖回去。这个判断放在这里，而不是靠调用方自觉。
 */

import { getRepositories } from "@/repositories";
import { attempt, type Result } from "@/lib/result";
import { DEMO_BUSINESS, DEMO_PRODUCTS, resolveSeedProductId } from "@/lib/mock/demo-business";
import { MOCK_KNOWLEDGE_DOCUMENTS } from "@/lib/mock";

import { createKnowledgeDocument } from "./knowledge.service";

export interface BusinessProvisionResult {
  businessId: string;
  /** true = 认领了已有商家（演示商家），false = 为本账号新建 */
  claimedExisting: boolean;
  /** 本次写入的商品数（已有商品的商家为 0） */
  createdProducts: number;
  /** 本次写入的知识文档数 */
  createdKnowledgeDocuments: number;
}

/**
 * 为新账号准备商家与起步数据。
 *
 * 返回 `Result` 而不是抛异常：调用方（注册服务）需要在失败时
 * **中止后续注册步骤**（账号不建、会话不发），并给出明确提示。
 */
export async function provisionBusinessForNewAccount(input: {
  /** 账号昵称，用于给新商家起名 */
  accountName: string;
  /** 是否这是本库的第一个账号（由调用方查一次 `users.count()` 传入） */
  isFirstAccount: boolean;
}): Promise<Result<BusinessProvisionResult>> {
  return attempt(async () => {
    const repositories = getRepositories();

    /**
     * 用 `findEarliestProfile()` 而不是 `getProfile()`：
     * 注册发生在会话建立之前，`getProfile()` 会按「未登录」返回 null，
     * 于是「有没有可认领的演示商家」就永远答不出来。
     */
    const existing = await repositories.business.findEarliestProfile();
    const shouldClaim = input.isFirstAccount && existing !== null;

    const businessId = shouldClaim && existing
      ? existing.id
      : (
          await repositories.business.create({
            name: `${input.accountName}的店铺`,
            shortName: input.accountName.slice(0, 8),
            description: "",
            owner: input.accountName,
            location: "",
            mainCategory: "",
            storeCount: 0,
            channels: [],
          })
        ).id;

    // 认领现有商家时保留原有表达偏好；新商家从空白个人资料开始，不继承演示人物。
    if (!shouldClaim) {
      await repositories.business.updateOwnerTwin(
        {
          displayName: input.accountName,
          avatarLabel: input.accountName.slice(0, 1).toUpperCase(),
          businessPhilosophy: [],
          tone: [],
          salesStyle: "",
          targetCustomers: [],
          forbiddenExpressions: [],
        },
        { businessId },
      );
    }

    // 新商家从真实资料开始，不继承另一家店的商品、知识和履约承诺。
    if (!shouldClaim) {
      return {
        businessId,
        claimedExisting: false,
        createdProducts: 0,
        createdKnowledgeDocuments: 0,
      };
    }

    // —— 演示数据：只往「被认领且一件商品都没有」的商家灌 ——
    // 用 countForBusiness 而不是 products.list()：后者不做商家过滤，
    // 只要库里任何一个商家有商品，第二个注册的人就永远拿不到起步数据。
    const existingProductCount = await repositories.products.countForBusiness(businessId);
    if (existingProductCount > 0) {
      return {
        businessId,
        claimedExisting: shouldClaim,
        createdProducts: 0,
        createdKnowledgeDocuments: 0,
      };
    }

    /**
     * 商品的真实 id 直接从 `create()` 的返回值收集，**不再回来 list 一次**：
     * `products.list()` 不做商家过滤，多个账号的起步商品同名（都叫「连江鲜活鲍鱼」），
     * 用名字回查会串到别人的商品上 —— 而知识挂错商品是检索时才暴露、且不报错的错误。
     */
    const productIdByName = new Map<string, string>();
    for (const definition of DEMO_PRODUCTS) {
      const created = await repositories.products.create({
        businessId,
        name: definition.name,
        description: definition.description,
        category: definition.category,
        subCategory: definition.subCategory,
        price: definition.price,
        unit: definition.unit,
        stock: definition.stock,
        origin: definition.origin,
        specification: definition.specification,
        storageMethod: definition.storageMethod,
        shelfLife: definition.shelfLife,
        tags: [...definition.tags],
      });
      productIdByName.set(created.name, created.id);
    }

    /**
     * 知识文档走正式 Service（切片 + 向量化 + 落索引），
     * 而不是直接插表 —— 那样会得到「文档在、但检索不到」的假知识。
     */
    let createdKnowledgeDocuments = 0;
    for (const seed of MOCK_KNOWLEDGE_DOCUMENTS) {
      const existingDocument = await repositories.knowledgeDocuments.findDocumentByKey({
        businessId,
        type: seed.type,
        name: seed.name,
      });
      if (existingDocument) {
        continue;
      }

      const productId = resolveSeedProductId(seed, productIdByName);
      /**
       * 起步知识是**尽力而为**：正文切片 + 向量化要调模型，
       * 模型不可用 / 网络不通 / 配额耗尽时这份文档建不出来。
       * 但那只该让用户少看到一篇示例知识 —— **绝不能因此让整个注册失败**，
       * 否则「模型挂了」就变成「新用户注册不了」。
       * 所以这里不抛错，只在成功时计数（计数不虚增，
       * 否则「注册结果里写 7 篇、实际 0 篇」会变成一个没人能解释的现象）。
       */
      const created = await createKnowledgeDocument({
        businessId,
        name: seed.name,
        type: seed.type,
        summary: seed.summary,
        content: seed.content,
        ...(productId ? { productId } : {}),
      });
      if (created.ok) {
        createdKnowledgeDocuments += 1;
      }
    }

    return {
      businessId,
      claimedExisting: shouldClaim,
      createdProducts: DEMO_PRODUCTS.length,
      createdKnowledgeDocuments,
    };
  });
}

/** 演示商家的展示名，供注册页文案引用（避免把名字写死在两处） */
export const DEMO_BUSINESS_DISPLAY_NAME = DEMO_BUSINESS.name;
