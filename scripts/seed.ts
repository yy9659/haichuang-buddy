/**
 * 演示数据初始化脚本（pnpm db:seed）
 *
 * 做五件事：
 *   1. 写入 / 更新 Demo 商家（连江海创海产商贸）
 *   2. 写入 / 更新老板数字分身（Owner Twin）
 *   3. 写入 3 款连江海产品，并生成示例图片上传到 Supabase Storage
 *   4. 写入 / 索引 Demo 客服知识库（Task 81 §20）
 *   5. 打印结果摘要，方便确认「切到 db 后应该看到什么」
 *
 * 设计要点：
 * - **幂等**：按名称 / (商家, 商品名, 文档名) 查找，存在则更新，可反复执行。
 * - **诚实**：不预置 Product DNA、不预置物流时效 —— 商品等待商品经理 Agent 真实生成，
 *   知识库子里故意缺「多久发货」这条，留出 Task 80/81 的演示闭环（§21）。
 * - 没配 Storage 凭证时只跳过图片上传，其余照常写入，并明确告警。
 */

import "./lib/env";

import { and, eq } from "drizzle-orm";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { closeDb, getDb, isLocalDataSource } from "../src/db";
import { checkDatabaseConnection } from "../src/db/health";
import { businesses, ownerProfiles, products } from "../src/db/schema";
import { isStorageConfigured } from "../src/lib/env";
import { MOCK_KNOWLEDGE_DOCUMENTS } from "../src/lib/mock";
import {
  DEMO_BUSINESS,
  DEMO_OWNER,
  DEMO_PRODUCTS,
  resolveSeedProductId,
  type DemoProduct,
} from "../src/lib/mock/demo-business";
import { ensureKnowledgeIndexed, createKnowledgeDocument } from "../src/services/knowledge.service";
import { createInlineProductImage, ensureProductImageBucket, uploadProductImage } from "../src/storage";

import { SAMPLE_PALETTES, renderSampleProductImage } from "./lib/sample-image";

/* 演示数据本身定义在 @/lib/mock/demo-business —— 注册流程也要用同一份，
   因此不能留在脚本目录。详见该文件的头部说明。 */
function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function upsertBusiness(): Promise<{ id: string; created: boolean }> {
  const db = getDb();
  const existing = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.name, DEMO_BUSINESS.name))
    .limit(1);

  const current = existing[0];
  if (current) {
    await db
      .update(businesses)
      .set({ ...DEMO_BUSINESS, channels: [...DEMO_BUSINESS.channels], updatedAt: new Date() })
      .where(eq(businesses.id, current.id));
    return { id: current.id, created: false };
  }

  const inserted = await db
    .insert(businesses)
    .values({ ...DEMO_BUSINESS, channels: [...DEMO_BUSINESS.channels] })
    .returning({ id: businesses.id });

  const created = inserted[0];
  if (!created) {
    throw new Error("写入商家失败：数据库未返回记录");
  }
  return { id: created.id, created: true };
}

async function upsertOwnerTwin(businessId: string): Promise<boolean> {
  const db = getDb();
  const existing = await db
    .select({ id: ownerProfiles.id })
    .from(ownerProfiles)
    .where(eq(ownerProfiles.businessId, businessId))
    .limit(1);

  const values = {
    businessId,
    displayName: DEMO_OWNER.displayName,
    avatarLabel: DEMO_OWNER.avatarLabel,
    businessPhilosophy: [...DEMO_OWNER.businessPhilosophy],
    tone: [...DEMO_OWNER.tone],
    salesStyle: DEMO_OWNER.salesStyle,
    targetCustomers: [...DEMO_OWNER.targetCustomers],
    forbiddenExpressions: [...DEMO_OWNER.forbiddenExpressions],
  };

  const current = existing[0];
  if (current) {
    await db
      .update(ownerProfiles)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(ownerProfiles.id, current.id));
    return false;
  }

  await db.insert(ownerProfiles).values(values);
  return true;
}

/** 生成示例图片：本地模式内联为 data URL，远程模式上传到 Storage。 */
async function uploadSampleImage(product: DemoProduct): Promise<string | null> {
  const png = renderSampleProductImage({
    palette: SAMPLE_PALETTES[product.palette] ?? SAMPLE_PALETTES.seafood,
    seed: product.imageSeed,
  });

  // 本地（PGlite）演示模式：图片以 data URL 直接写进 products.image_url，
  // 与服务层 uploadImage 的本地分支走同一个实现，不依赖对象存储。
  // （此前这里的判断写反了：本地模式被漏进 Supabase 上传分支，seed 直接失败。）
  if (isLocalDataSource()) {
    const inlined = createInlineProductImage({
      data: new Uint8Array(png),
      contentType: "image/png",
      fileName: `${product.name}.png`,
      name: product.name,
    });
    if (!inlined.ok) {
      throw new Error(`生成「${product.name}」示例图片失败：${inlined.error.message}`);
    }
    return inlined.data.url;
  }

  if (!isStorageConfigured()) {
    return null;
  }

  const uploaded = await uploadProductImage({
    data: new Uint8Array(png),
    contentType: "image/png",
    fileName: `${product.name}.png`,
    name: product.name,
  });

  if (!uploaded.ok) {
    throw new Error(
      `上传「${product.name}」图片失败：${uploaded.error.message}${
        uploaded.error.detail ? `（${uploaded.error.detail}）` : ""
      }`,
    );
  }

  return uploaded.data.url;
}

async function upsertProduct(
  businessId: string,
  definition: DemoProduct,
): Promise<"created" | "updated"> {
  const db = getDb();

  // 与 products_business_name_unique 唯一索引同一口径，保证可重复执行
  const matched = await db
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        eq(products.businessId, businessId),
        eq(products.name, definition.name),
      ),
    )
    .limit(1);

  const imageUrl = await uploadSampleImage(definition);
  const fields = {
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
    // 新商品一律等待商品经理 Agent 分析
    analysisStatus: "pending" as const,
  };

  const target = matched[0];
  if (target) {
    await db
      .update(products)
      .set({
        ...fields,
        // 图片上传失败或未配置时保留原有图片，不要覆盖成空
        ...(imageUrl ? { imageUrl } : {}),
        updatedAt: new Date(),
      })
      .where(eq(products.id, target.id));
    return "updated";
  }

  await db
    .insert(products)
    .values({ ...fields, businessId, imageUrl });
  return "created";
}

export async function seedDemoData(): Promise<void> {
  log("=== 海创Buddy 演示数据初始化 ===\n");

  const health = await checkDatabaseConnection();
  if (!health.ok) {
    log(`✗ 数据库不可用：${health.error.message}`);
    if (health.error.detail) {
      log(`  ${health.error.detail}`);
    }
    log("\n请检查 .env.local 中的 DATABASE_URL，并先执行 pnpm db:migrate。");
    process.exitCode = 1;
    return;
  }
  log(
    `✓ 数据库连接正常（${health.data.serverVersion.split(",")[0]}，迁移 ${
      health.data.appliedMigrations
    } 条）`,
  );

  if (!health.data.migrationsApplied) {
    log("✗ 尚未应用数据库迁移，请先执行 pnpm db:migrate");
    process.exitCode = 1;
    return;
  }

  if (!isStorageConfigured() && !isLocalDataSource()) {
    log(
      "! 未配置 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，" +
        "本次跳过示例图片上传（商品仍会写入，image_url 保持为空）",
    );
  } else if (!isLocalDataSource()) {
    const bucket = await ensureProductImageBucket();
    if (!bucket.ok) {
      log(`✗ 初始化图片 Bucket 失败：${bucket.error.message}`);
      process.exitCode = 1;
      return;
    }
    log(
      bucket.data.created
        ? "✓ 已创建 product-images Bucket（公开读）"
        : "✓ product-images Bucket 已存在",
    );
  }

  const business = await upsertBusiness();
  log(
    `${business.created ? "✓ 新建" : "✓ 更新"}商家：${DEMO_BUSINESS.name}（${business.id}）`,
  );

  const ownerCreated = await upsertOwnerTwin(business.id);
  log(`${ownerCreated ? "✓ 新建" : "✓ 更新"}老板数字分身：${DEMO_OWNER.displayName}`);

  log("\n商品：");
  for (const definition of DEMO_PRODUCTS) {
    const action = await upsertProduct(business.id, definition);
    log(
      `  ${action === "created" ? "+" : "~"} ${definition.name}（${
        definition.category
      } · ¥${definition.price} / ${definition.unit}）`,
    );
  }

  log("\n客服知识库：");
  await upsertKnowledgeDocuments(business.id);

  log("\n=== 完成 ===");
  log("下一步：把 .env.local 里的 DATA_SOURCE 改为 local（本地库）或 db（远程库），然后 pnpm dev");
  log("预期结果：/products 显示 3 个商品，均带真实图片，状态为「待分析」");
  log("（Product DNA 由下一阶段的商品经理 Agent 真实生成，seed 不预置假结果）");

  const dataSource = process.env.DATA_SOURCE ?? "mock";
  if (dataSource === "mock") {
    log("\n提示：当前 DATA_SOURCE 是 mock，页面读的是内存演示数据，本次写入的库不会被用到。");
  } else {
    log(`\n提示：当前 DATA_SOURCE=${dataSource}，页面会读取本次写入的数据。`);
    log("注意：本地库（PGlite）同一数据目录**不能被两个进程同时打开**，");
    log("      运行本脚本前请先停掉 pnpm dev / pnpm start。");
  }
}

/**
 * Demo 客服知识库的 DB 种子（Task 81 §20）。
 *
 * 走正式 Knowledge Service：先按 (businessId, type, name) 查；不存在则
 * createKnowledgeDocument（自动 chunk + embed，落地为 indexed）；存在则
 * ensureKnowledgeIndexed（补索引 / 修旧版本号）。两条分支都是同一份
 * Service 调用，DB 与 Mock 模式共享同一条链路。
 *
 * 关键约束（§21 Seed Knowledge Contract）：MOCK_KNOWLEDGE_DOCUMENTS 故意
 * 不含「多久发货」「时效」这类承诺，把它留给演示场景中由商家补知识。
 * 这里的契约测试位于 src/lib/mock/knowledge.contract.test.ts。
 */
async function upsertKnowledgeDocuments(businessId: string): Promise<void> {
  const db = getDb();
  const {
    getRepositories,
  } = await import("../src/repositories");

  // 商品名 → id 的映射表：mock 种子的 productId 是 mock 用的占位 id（prod_001…），
  // 在 DB 里要换成本次 seed 写入的真实 productId
  const allProducts = await db
    .select({ id: products.id, name: products.name })
    .from(products)
    .where(eq(products.businessId, businessId));
  const productIdByName = new Map(allProducts.map((p) => [p.name, p.id]));

  for (const seed of MOCK_KNOWLEDGE_DOCUMENTS) {
    const productId = seed.productId
      ? resolveSeedProductId(seed, productIdByName)
      : null;

    const repositories = getRepositories();
    const existing = await repositories.knowledgeDocuments.findDocumentByKey({
      businessId,
      type: seed.type,
      name: seed.name,
    });

    if (!existing) {
      const created = await createKnowledgeDocument({
        businessId,
        name: seed.name,
        type: seed.type,
        summary: seed.summary,
        content: seed.content,
        ...(productId ? { productId } : {}),
      });
      if (!created.ok) {
        log(`  ✗ 《${seed.name}》写入失败：${created.error.message}`);
        continue;
      }
      log(
        `  + ${seed.name}（${seed.type} · ${
          created.data.chunkCount
        } 切片）`,
      );
      continue;
    }

    /**
     * 已存在：做一次幂等的索引校验，避免种子内容已更新却没切到最新向量。
     * 这种「索引版号落后」的情况在 Task 81 之后由 ensureKnowledgeIndexed
     * 内部判断（无切片 / 旧 indexVersion），不再重建 indexed 文档。
     */
    const ensured = await ensureKnowledgeIndexed(existing.id);
    if (!ensured.ok) {
      log(`  ! 《${seed.name}》已写入但索引校验失败：${ensured.error.message}`);
      continue;
    }
    log(
      `  ${ensured.data.rebuilt ? "+" : "~"} ${seed.name}（${seed.type} · ${
        ensured.data.document.chunkCount
      } 切片${ensured.data.rebuilt ? " · 已重建" : ""}）`,
    );
  }
}


const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentPath = path.resolve(fileURLToPath(import.meta.url));

if (invokedPath.toLowerCase() === currentPath.toLowerCase()) {
  seedDemoData()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`\n✗ seed 失败：${message}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDb();
    });
}
