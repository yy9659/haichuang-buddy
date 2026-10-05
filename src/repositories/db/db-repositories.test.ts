/**
 * 数据库仓储集成测试
 *
 * 运行条件（二者其一）：
 * - `.env.local` 配了 `DATABASE_URL` 且已 `pnpm db:migrate` → 打远程 Supabase
 * - `pnpm test:db` → 打本地 PGlite，数据落在 `.data/pgdata-test`
 *
 * 都没有时整组自动跳过，保证 `pnpm test` 在纯前端环境下依然全绿。
 * 开关与前置准备见 `./db-integration`。
 *
 * 测试自有数据：本组测试会新建一个独立的「集成测试商家」，商品与 DNA 都挂在它下面，
 * 结束后级联删除，不会污染真实业务数据。
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";

import { closeDb, getDb } from "@/db";
import { provisionBusinessForNewAccount } from "@/services/business-provisioning.service";
import { checkDatabaseConnection } from "@/db/health";
import { brandProfiles, businesses, products } from "@/db/schema";

import { createDbAgentTaskRepository } from "./agent-task.repository";
import { createDbAgentWorkflowRepository } from "./agent-workflow.repository";
import { createDbBrandRepository } from "./brand.repository";
import { createDbBusinessRepository } from "./business.repository";
import { createDbContentRepository } from "./content.repository";
import { createDbProductDnaRepository } from "./product-dna.repository";
import { createDbProductRepository } from "./product.repository";
import { resolvePrimaryBusinessId } from "./shared";
import { describeDbSuite, prepareDbForTests } from "./db-integration";
import { toWorkflowSummary } from "../agent-workflow";
import type { AgentWorkflowSummary } from "../types";

const dbSuite = describeDbSuite;

const productRepository = createDbProductRepository();
const productDnaRepository = createDbProductDnaRepository();
const businessRepository = createDbBusinessRepository();
const agentTaskRepository = createDbAgentTaskRepository();
const agentWorkflowRepository = createDbAgentWorkflowRepository();
const brandRepository = createDbBrandRepository();
const contentRepository = createDbContentRepository();

dbSuite("数据库仓储（集成测试）", () => {
  let businessId = "";
  const createdProductIds: string[] = [];
  /**
   * 商家仓储没有 businessId 参数（接口是「当前商家」语义），
   * 因此只有库中仅存在本测试创建的那一条商家记录时，
   * 才允许执行写操作，避免污染真实业务数据。
   */
  let mayWriteBusinessProfile = false;

  beforeAll(async () => {
    await prepareDbForTests();
    const inserted = await getDb()
      .insert(businesses)
      .values({
        name: "[集成测试] 海创Buddy 自动化测试商家",
        shortName: "集成测试",
        description: "由 pnpm test 自动创建，测试结束后删除",
        owner: "测试账号",
        location: "福建连江",
        mainCategory: "海产品",
        storeCount: 0,
        channels: ["douyin"],
      })
      .returning({ id: businesses.id });

    businessId = inserted[0]?.id ?? "";
    expect(businessId).not.toBe("");

    const all = await getDb().select({ id: businesses.id }).from(businesses);
    mayWriteBusinessProfile = all.length === 1 && all[0]?.id === businessId;
  });

  afterAll(async () => {
    if (businessId) {
      // 商品 / DNA / 品牌档案通过外键级联删除
      await getDb().delete(businesses).where(eq(businesses.id, businessId));
    }
    await closeDb();
  });

  it("健康检查能连上数据库且迁移已应用", async () => {
    const result = await checkDatabaseConnection();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.data.serverVersion).toContain("PostgreSQL");
    expect(result.data.migrationsApplied).toBe(true);
  });

  it("查询商品：返回列表且字段结构完整", async () => {
    const products = await productRepository.list();
    expect(Array.isArray(products)).toBe(true);
    for (const product of products) {
      expect(typeof product.id).toBe("string");
      expect(typeof product.price).toBe("number");
      expect(Array.isArray(product.tags)).toBe(true);
      expect(product.metrics).toHaveProperty("views");
    }
  });

  it("创建商品：字段完整映射且时间格式与 Mock 一致", async () => {
    const product = await productRepository.create({
      businessId,
      name: "[集成测试] 连江鲜活鲍鱼",
      description: "测试用商品",
      category: "海产品",
      subCategory: "鲍鱼",
      price: 128.5,
      unit: "500g",
      stock: 10,
      origin: "福建连江 · 黄岐半岛",
      specification: "8-10 头 / 500g",
      storageMethod: "0-4℃ 冷藏",
      shelfLife: "2 天",
      tags: ["测试", "鲜活"],
    });

    createdProductIds.push(product.id);

    expect(product.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(product.price).toBe(128.5);
    expect(typeof product.price).toBe("number");
    expect(product.stock).toBe(10);
    expect(product.tags).toEqual(["测试", "鲜活"]);
    expect(product.analysisStatus).toBe("pending");
    expect(product.metrics).toEqual({ views: 0, inquiries: 0, conversions: 0 });
    // 与 Mock 数据源保持同一展示格式，避免切数据源后页面视觉回归
    expect(product.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    const fetched = await productRepository.getById(product.id);
    expect(fetched?.name).toBe("[集成测试] 连江鲜活鲍鱼");
  });

  it("按筛选条件查询：类别 / 分析状态 / 关键词", async () => {
    const byCategory = await productRepository.list({ category: "礼盒" });
    expect(byCategory.every((product) => product.category === "礼盒")).toBe(true);

    const byStatus = await productRepository.list({ analysisStatus: "pending" });
    expect(byStatus.some((product) => product.id === createdProductIds[0])).toBe(true);

    const byKeyword = await productRepository.list({ keyword: "鲜活鲍鱼" });
    expect(byKeyword.some((product) => product.id === createdProductIds[0])).toBe(true);

    const noMatch = await productRepository.list({ keyword: "绝对不存在的关键词zzz" });
    expect(noMatch).toHaveLength(0);
  });

  it("非 uuid 的 id 返回 null 而不是抛数据库类型错误", async () => {
    expect(await productRepository.getById("none")).toBeNull();
    expect(await productRepository.getById("prod_001")).toBeNull();
  });

  it("更新商品：只改传入字段并刷新 updatedAt", async () => {
    const targetId = createdProductIds[0];
    expect(targetId).toBeDefined();

    const before = await productRepository.getById(targetId);
    const updated = await productRepository.update(targetId, {
      stock: 3,
      price: 199,
    });

    expect(updated.stock).toBe(3);
    expect(updated.price).toBe(199);
    // 未传入的字段保持不变
    expect(updated.name).toBe(before?.name);
    expect(updated.origin).toBe(before?.origin);
  });

  it("更新不存在的商品抛 NOT_FOUND", async () => {
    await expect(
      productRepository.update("00000000-0000-0000-0000-000000000000", { stock: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("Product DNA：create → 读取映射 → update", async () => {
    const targetId = createdProductIds[0];

    const created = await productDnaRepository.create({
      productId: targetId,
      category: "海产品",
      subCategory: "鲍鱼",
      visualFeatures: ["鲜活带壳", "壳面洁净"],
      coreFeatures: ["连江黄岐半岛养殖"],
      sellingPoints: ["产地直发", "规格统一"],
      targetUsers: ["年轻家庭"],
      consumptionScenarios: ["家庭聚餐", "节庆礼赠"],
      userPainPoints: ["担心不新鲜"],
      marketingAngles: ["产地故事"],
      riskNotes: ["鲜活产品不支持无理由退货"],
      aiVersion: "v1.0",
      confidence: 0.91,
      approved: false,
    });

    expect(created.productId).toBe(targetId);
    expect(created.consumptionScenarios).toEqual(["家庭聚餐", "节庆礼赠"]);

    // 商品仓储上的 getDna 应委托到同一份数据
    const viaProduct = await productRepository.getDna(targetId);
    expect(viaProduct?.sellingPoints).toEqual(["产地直发", "规格统一"]);

    const updated = await productDnaRepository.update(targetId, {
      approved: true,
      confidence: 0.95,
    });
    expect(updated.approved).toBe(true);
    expect(updated.confidence).toBe(0.95);

    // 同一商品重复 create 必须失败（唯一索引）
    await expect(
      productDnaRepository.create({
        productId: targetId,
        category: "海产品",
        subCategory: "鲍鱼",
        visualFeatures: [],
        coreFeatures: [],
        sellingPoints: [],
        targetUsers: [],
        consumptionScenarios: [],
        userPainPoints: [],
        marketingAngles: [],
        riskNotes: [],
        aiVersion: "v1.0",
        confidence: 0.5,
        approved: false,
      }),
    ).rejects.toMatchObject({ code: "DB_ERROR" });
  });

  it("商家仓储：能读到当前商家资料", async () => {
    const profile = await businessRepository.getProfile();
    expect(profile).not.toBeNull();
    expect(typeof profile?.name).toBe("string");
  });

  it("新商家不继承演示商家的商品与知识", async () => {
    const provisioned = await provisionBusinessForNewAccount({
      accountName: "新商家测试",
      isFirstAccount: false,
    });
    expect(provisioned.ok).toBe(true);
    if (!provisioned.ok) return;
    const secondBusinessId = provisioned.data.businessId;
    try {
      expect(provisioned.data.createdProducts).toBe(0);
      expect(provisioned.data.createdKnowledgeDocuments).toBe(0);
      expect(await productRepository.countForBusiness(secondBusinessId)).toBe(0);
    } finally {
      await getDb().delete(businesses).where(eq(businesses.id, secondBusinessId));
    }
  });

  it("商家仓储：更新后落库（仅当库中没有真实商家数据时执行）", async () => {
    if (!mayWriteBusinessProfile) {
      // 已存在真实商家数据，跳过写操作以免污染
      return;
    }

    const before = await businessRepository.getProfile();
    const updated = await businessRepository.updateProfile({
      storeCount: 3,
      mainCategory: "海产品 / 干货",
      description: "由商家亲自核实规格与产地后介绍商品。",
    });

    expect(updated.storeCount).toBe(3);
    expect(updated.mainCategory).toBe("海产品 / 干货");
    expect(updated.description).toContain("亲自核实");
    // 未传入字段保持原值
    expect(updated.name).toBe(before?.name);
    expect(updated.location).toBe(before?.location);

    // 重新查询确认已落库，而不是只改了返回值
    const reloaded = await businessRepository.getProfile();
    expect(reloaded?.storeCount).toBe(3);
    expect(reloaded?.description).toContain("亲自核实");

    // 老板数字分身：尚未建档时应能直接写入
    const twin = await businessRepository.updateOwnerTwin({
      displayName: "集成测试老板",
      tone: ["实在"],
      salesStyle: "先讲品质再谈价格",
    });
    expect(twin.displayName).toBe("集成测试老板");
    expect(twin.tone).toEqual(["实在"]);

    const twinReloaded = await businessRepository.getOwnerTwin();
    expect(twinReloaded?.displayName).toBe("集成测试老板");
  });

  it("删除商品：删掉后可查不到，重复删除抛 NOT_FOUND", async () => {
    const targetId = createdProductIds[0];
    await productRepository.delete(targetId);

    expect(await productRepository.getById(targetId)).toBeNull();
    expect(await productDnaRepository.getByProductId(targetId)).toBeNull();

    await expect(productRepository.delete(targetId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    createdProductIds.length = 0;
  });

  it("列表中不再包含已删除的测试商品", async () => {
    const products = await productRepository.list();
    expect(products.some((product) => product.name.includes("[集成测试]"))).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /* Agent 任务记录（S2-2 新增）                                       */
  /* ---------------------------------------------------------------- */

  it("Agent 任务：能创建独立任务（workflow_id 可空），字段完整落库", async () => {
    const product = await productRepository.create({
      businessId,
      name: "[集成测试] 手工鱼丸",
      category: "预制菜",
      price: 45,
    });
    createdProductIds.push(product.id);

    const task = await agentTaskRepository.create({
      agentType: "product_agent",
      title: `分析商品：${product.name}`,
      productId: product.id,
      status: "running",
      input: { productId: product.id, hasImage: false },
    });

    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(task.status).toBe("running");
    expect(task.progress).toBe(0);
    expect(task.productId).toBe(product.id);
    // 单点触发的分析不属于任何工作流 —— 这正是 S2-2 把 workflow_id 改为可空的原因
    expect(task.workflowId).toBeNull();
    expect(task.output).toBeNull();
    expect(task.completedAt).toBeNull();
    expect(task.durationMs).toBeNull();
    expect(task.input).toMatchObject({ hasImage: false });
    // 与 Mock 数据源保持同一展示格式
    expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("Agent 任务：状态流转写入 completedAt 与 durationMs", async () => {
    const product = createdProductIds[0];
    expect(product).toBeDefined();

    const task = await agentTaskRepository.create({
      agentType: "product_agent",
      title: "分析商品：集成测试",
      productId: product,
      status: "running",
    });

    const completed = await agentTaskRepository.update(task.id, {
      status: "completed",
      progress: 100,
      durationMs: 1234,
      output: { providerId: "mock", attempts: 1 },
    });

    expect(completed.status).toBe("completed");
    expect(completed.progress).toBe(100);
    expect(completed.durationMs).toBe(1234);
    expect(completed.completedAt).not.toBeNull();
    expect(completed.output).toMatchObject({ providerId: "mock" });

    // 重新查询确认真的落库，而不是只改了返回值
    const latest = await agentTaskRepository.findLatestByProduct(
      product,
      "product_agent",
    );
    expect(latest?.id).toBe(task.id);
    expect(latest?.durationMs).toBe(1234);
    expect(latest?.status).toBe("completed");
  });

  it("Agent 任务：失败态记录 errorMessage，且重复终态 patch 保留首次完成时间", async () => {
    const product = createdProductIds[0];
    expect(product).toBeDefined();

    const task = await agentTaskRepository.create({
      agentType: "product_agent",
      title: "分析商品：集成测试（失败）",
      productId: product,
    });

    const failed = await agentTaskRepository.update(task.id, {
      status: "failed",
      errorMessage: "模型服务暂时不可用",
    });
    expect(failed.completedAt).not.toBeNull();

    const patchedAgain = await agentTaskRepository.update(task.id, {
      errorMessage: "模型服务暂时不可用（重试后仍失败）",
    });
    expect(patchedAgain.completedAt).toBe(failed.completedAt);
    expect(patchedAgain.errorMessage).toContain("重试后仍失败");
    // 非终态不收口时耗时应被清空
    const backToRunning = await agentTaskRepository.update(task.id, {
      status: "running",
    });
    expect(backToRunning.completedAt).toBeNull();
    expect(backToRunning.durationMs).toBeNull();
  });

  it("Agent 任务：非 uuid 商品 id 返回 null / 空列表，不抛数据库类型错误", async () => {
    expect(
      await agentTaskRepository.findLatestByProduct("prod_001", "product_agent"),
    ).toBeNull();
    expect(
      await agentTaskRepository.listByProduct("none", "product_agent"),
    ).toEqual([]);
  });

  it("Agent 任务：按 agentType 隔离，且列表按时间倒序", async () => {
    const product = createdProductIds[0];
    expect(product).toBeDefined();

    const first = await agentTaskRepository.create({
      agentType: "product_agent",
      title: "分析商品：第 1 次",
      productId: product,
    });

    /**
     * 这里刻意等一小会儿再插第二条。
     *
     * `listByProduct` 按 `created_at desc` 排序，而 `created_at` 取的是
     * **数据库的** `now()`（PGlite 下精度到毫秒）。两次背靠背的 insert 有相当
     * 概率落在同一毫秒里，此时「谁在前」由存储引擎随意决定 —— 断言
     * `history[0] === second` 就会偶发失败（本文件就因此红过一次）。
     * 等过一个毫秒刻度，这个用例考的才是「排序规则对不对」，
     * 而不是「两次插入有没有恰好落在同一毫秒」。
     */
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await agentTaskRepository.create({
      agentType: "product_agent",
      title: "分析商品：第 2 次",
      productId: product,
    });

    const history = await agentTaskRepository.listByProduct(
      product,
      "product_agent",
    );
    expect(history[0]?.id).toBe(second.id);

    const limited = await agentTaskRepository.listByProduct(
      product,
      "product_agent",
      2,
    );
    expect(limited).toHaveLength(2);

    // 换一个 agent 类型不应命中
    expect(
      await agentTaskRepository.findLatestByProduct(product, "content_agent"),
    ).toBeNull();

    // 兜底清理，避免影响后续断言
    await agentTaskRepository.update(first.id, { status: "completed" });
    await agentTaskRepository.update(second.id, { status: "completed" });
  });

  it("Agent 任务：删除商品时任务级联清理", async () => {
    const product = await productRepository.create({
      businessId,
      name: "[集成测试] 待删除商品",
      category: "干货",
      price: 19.9,
    });

    const task = await agentTaskRepository.create({
      agentType: "product_agent",
      title: "分析商品：待删除商品",
      productId: product.id,
    });
    expect(
      await agentTaskRepository.findLatestByProduct(product.id, "product_agent"),
    ).not.toBeNull();

    await productRepository.delete(product.id);

    expect(
      await agentTaskRepository.findLatestByProduct(product.id, "product_agent"),
    ).toBeNull();
    expect(
      await agentTaskRepository.listByProduct(product.id, "product_agent"),
    ).toEqual([]);
    // 任务本体也应随之消失
    await expect(
      agentTaskRepository.update(task.id, { status: "completed" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  /* ---------------------------------------------------------------- */
  /* 品牌档案（S3-1 新增）                                             */
  /* ---------------------------------------------------------------- */

  it("品牌档案：未生成时读到 null，而不是抛错", async () => {
    // 读操作不受「是否只有测试商家」限制，任何环境都能跑
    const profile = await brandRepository.getProfile();
    expect(profile === null || typeof profile.positioning === "string").toBe(true);
  });

  /**
   * 写操作的对象是**当前商家**（接口是「当前商家」语义），
   * 因此只有库中仅存在本测试创建的那一条商家记录时才执行，
   * 否则会把真实业务数据里的品牌档案改掉。
   */
  it("品牌档案：create → 读取映射 → update 覆盖（仅当库中没有真实商家数据时执行）", async () => {
    if (!mayWriteBusinessProfile) {
      // 明确跳过而不是假装通过：写路径未被验证这件事必须看得见
      expect(mayWriteBusinessProfile).toBe(false);
      return;
    }

    // 先清掉可能残留的档案，保证从 create 这条路径开始
    await getDb().delete(brandProfiles).where(eq(brandProfiles.businessId, businessId));

    expect(await brandRepository.getProfile()).toBeNull();

    const created = await brandRepository.create({
      businessId,
      positioning: "连江直发 · 家庭海鲜餐桌的稳定供应者",
      brandStory: "从渔港到餐桌，把可核查的细节讲清楚。",
      slogan: "从黄岐半岛，到你的餐桌。",
      ipConcept: "以老板本人为原型的内容 IP。",
      brandValues: ["产地真实可查", "当天到货的新鲜"],
      targetAudience: ["年轻家庭", "节庆礼赠人群"],
      brandPersonality: ["实在", "专业"],
      toneOfVoice: ["口语化", "不夸张"],
      visualKeywords: ["海雾蓝", "鲜活质感"],
      riskNotes: ["避免使用绝对化用语"],
      sourceProductId: null,
      aiVersion: "v1.0",
      confidence: 0.7,
      approved: false,
    });

    expect(created.positioning).toBe("连江直发 · 家庭海鲜餐桌的稳定供应者");
    expect(created.brandPersonality).toEqual(["实在", "专业"]);
    expect(created.toneOfVoice).toEqual(["口语化", "不夸张"]);
    expect(created.visualKeywords).toEqual(["海雾蓝", "鲜活质感"]);
    expect(created.riskNotes).toEqual(["避免使用绝对化用语"]);
    // AI 产出默认未确认
    expect(created.approved).toBe(false);
    // completeness 是派生量：由档案内容现算，不落库
    expect(created.completeness).toBeGreaterThan(0);
    expect(created.completeness).toBeLessThanOrEqual(1);
    // 展示格式必须与 Mock 数据源一致，否则切数据源会看到时间格式变化
    expect(created.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    const reloaded = await brandRepository.getProfile();
    expect(reloaded?.slogan).toBe(created.slogan);
    expect(reloaded?.brandValues).toEqual(created.brandValues);

    const updated = await brandRepository.update({
      positioning: "连江直发 · 一人公司的海产供应链",
      approved: true,
    });
    expect(updated.positioning).toBe("连江直发 · 一人公司的海产供应链");
    expect(updated.approved).toBe(true);
    // 未传入的字段保持不变
    expect(updated.slogan).toBe(created.slogan);
    expect(updated.brandValues).toEqual(created.brandValues);

    // 同一商家不允许出现第二份档案（唯一索引），重新生成必须走 update
    await expect(
      brandRepository.create({
        businessId,
        positioning: "第二份档案",
        brandStory: "不应该写进去",
        slogan: "不该存在",
        ipConcept: "不该存在",
        brandValues: ["A"],
        targetAudience: ["B"],
        brandPersonality: ["C"],
        toneOfVoice: ["D"],
        visualKeywords: ["E"],
        riskNotes: [],
        aiVersion: "v1.0",
        confidence: 0.1,
        approved: false,
      }),
    ).rejects.toMatchObject({ code: "DB_ERROR" });
  });

  it("Agent 任务：findLatestByType 能取到不归属任何商品的任务", async () => {
    const task = await agentTaskRepository.create({
      agentType: "brand_agent",
      title: "生成品牌策略：[集成测试]",
      status: "running",
      // 品牌档案属于商家，任务可以没有 productId
      productId: null,
    });

    const latest = await agentTaskRepository.findLatestByType("brand_agent");
    expect(latest?.id).toBe(task.id);
    expect(latest?.productId).toBeNull();

    await agentTaskRepository.update(task.id, { status: "completed" });
    // 不同 agent 类型互不干扰
    expect(
      await agentTaskRepository.findLatestByType("content_agent"),
    ).toBeNull();
  });

  /* ---------------------------------------------------------------- */
  /* 内容资产（S3-2 新增）                                             */
  /* ---------------------------------------------------------------- */

  /** 内容测试用的商品（挂在本组测试的商家下，级联删除） */
  async function createContentTestProduct(name: string) {
    const product = await productRepository.create({
      businessId,
      name,
      description: "内容仓储集成测试用商品",
      category: "海产品",
      subCategory: "鲍鱼",
      price: 128,
      unit: "500g",
      stock: 10,
      origin: "福建连江 · 黄岐半岛",
      specification: "8-10 头 / 500g",
      storageMethod: "0-4℃ 冷藏",
      shelfLife: "2 天",
      tags: ["测试"],
    });
    createdProductIds.push(product.id);
    return product;
  }

  function contentInput(productId: string, productName: string) {
    return {
      businessId,
      productId,
      productName,
      platform: "douyin" as const,
      format: "short-video" as const,
      title: "会做饭的人，家里都常备一盒鲍鱼",
      hook: "连江鲍鱼 128 就能买到 500g。",
      body: "刷洗干净上锅蒸 8 分钟就好。",
      cta: "点击下方商品，今晚就能安排。",
      hashtags: ["#连江鲍鱼", "#家庭海鲜"],
      visualSuggestions: ["开场用渔港晨雾航拍 2 秒"],
      shotList: ["0-2s 渔港晨景", "2-6s 手部刷洗特写"],
      voiceover: "连江的鲍鱼，当天捞当天发。",
      status: "draft" as const,
      riskNotes: ["【Mock】占位数据"],
      aiVersion: "v1.0",
      confidence: 0.62,
    };
  }

  it("内容仓储：未生成时 findBySlot 读到 null，而不是抛错", async () => {
    const product = await createContentTestProduct("[集成测试] 内容空槽位商品");
    const found = await contentRepository.findBySlot({
      productId: product.id,
      platform: "douyin",
      format: "short-video",
    });
    expect(found).toBeNull();
  });

  it("内容仓储：create → 读取映射 → 字段与时间格式与 Mock 一致", async () => {
    const product = await createContentTestProduct("[集成测试] 内容映射商品");
    const created = await contentRepository.create(
      contentInput(product.id, product.name),
    );

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.productId).toBe(product.id);
    expect(created.productName).toBe(product.name);
    expect(created.platform).toBe("douyin");
    // AI 契约的 type ↔ 领域 / 数据库的 format，映射不能串位
    expect(created.format).toBe("short-video");
    expect(created.status).toBe("draft");
    expect(created.hashtags).toEqual(["#连江鲍鱼", "#家庭海鲜"]);
    expect(created.shotList).toEqual(["0-2s 渔港晨景", "2-6s 手部刷洗特写"]);
    expect(created.riskNotes).toEqual(["【Mock】占位数据"]);
    expect(created.aiVersion).toBe("v1.0");
    expect(created.confidence).toBe(0.62);
    // 新生成的内容尚未发布：经营数据必须全为 0，不能伪造
    expect(created.metrics).toEqual({
      views: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      engagementRate: 0,
    });
    // 与 Mock 数据源保持同一展示格式，避免切数据源后页面视觉回归
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(created.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    const reloaded = await contentRepository.findBySlot({
      productId: product.id,
      platform: "douyin",
      format: "short-video",
    });
    expect(reloaded?.id).toBe(created.id);
    expect(reloaded?.title).toBe(created.title);
    expect(reloaded?.shotList).toEqual(created.shotList);
  });

  it("内容仓储：同一槽位重复 create 被唯一索引拒绝（必须走 updateBySlot 重新生成）", async () => {
    const product = await createContentTestProduct("[集成测试] 槽位唯一性商品");
    await contentRepository.create(contentInput(product.id, product.name));

    await expect(
      contentRepository.create(contentInput(product.id, product.name)),
    ).rejects.toMatchObject({ code: "DB_ERROR" });
  });

  it("内容仓储：updateBySlot 覆盖同一槽位、刷新 updatedAt、且不改动槽位与创建时间", async () => {
    const product = await createContentTestProduct("[集成测试] 内容覆盖商品");
    const created = await contentRepository.create(
      contentInput(product.id, product.name),
    );

    const updated = await contentRepository.updateBySlot(
      { productId: product.id, platform: "douyin", format: "short-video" },
      {
        title: "重新生成后的标题",
        body: "重新生成后的正文",
        riskNotes: [],
      },
    );

    expect(updated.id).toBe(created.id);
    expect(updated.title).toBe("重新生成后的标题");
    expect(updated.body).toBe("重新生成后的正文");
    // 重新生成后旧风险提示不该残留
    expect(updated.riskNotes).toEqual([]);
    // 槽位与创建时间不变
    expect(updated.productId).toBe(created.productId);
    expect(updated.platform).toBe(created.platform);
    expect(updated.format).toBe(created.format);
    expect(updated.createdAt).toBe(created.createdAt);
    // 未传入的字段保持不变
    expect(updated.hashtags).toEqual(created.hashtags);
    expect(updated.voiceover).toBe(created.voiceover);

    // 覆盖而不是新增：该槽位仍然只有一条
    const all = await contentRepository.list();
    expect(
      all.filter(
        (item) => item.productId === product.id && item.platform === "douyin",
      ),
    ).toHaveLength(1);
  });

  it("内容仓储：updateBySlot 目标不存在时抛 NOT_FOUND", async () => {
    const product = await createContentTestProduct("[集成测试] 内容更新缺失商品");
    await expect(
      contentRepository.updateBySlot(
        { productId: product.id, platform: "xiaohongshu", format: "article" },
        { title: "不该存在的更新" },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("内容仓储：同一商品的不同平台是两个独立槽位，互不覆盖", async () => {
    const product = await createContentTestProduct("[集成测试] 多平台内容商品");
    const douyin = await contentRepository.create(
      contentInput(product.id, product.name),
    );
    const xhs = await contentRepository.create({
      ...contentInput(product.id, product.name),
      platform: "xiaohongshu",
      format: "article",
      title: "鲍鱼到底要蒸几分钟？",
    });

    expect(douyin.id).not.toBe(xhs.id);
    expect(
      await contentRepository.findBySlot({
        productId: product.id,
        platform: "douyin",
        format: "short-video",
      }),
    ).not.toBeNull();
    expect(
      await contentRepository.findBySlot({
        productId: product.id,
        platform: "xiaohongshu",
        format: "article",
      }),
    ).not.toBeNull();
    // 形态不同即不同槽位
    expect(
      await contentRepository.findBySlot({
        productId: product.id,
        platform: "douyin",
        format: "article",
      }),
    ).toBeNull();
  });

  it("内容仓储：list 按创建时间倒序（与 Mock 的「最新在前」同一口径）", async () => {
    const product = await createContentTestProduct("[集成测试] 内容排序商品");
    await contentRepository.create(contentInput(product.id, product.name));
    await contentRepository.create({
      ...contentInput(product.id, product.name),
      platform: "shipinhao",
      format: "short-video",
    });

    const all = await contentRepository.list();
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < all.length; index += 1) {
      const previous = all[index - 1]?.createdAt ?? "";
      const current = all[index]?.createdAt ?? "";
      expect(previous >= current).toBe(true);
    }
  });

  it("内容仓储：getPlan 在数据库下明确返回空数组（排期属 S4 Workflow，尚未落库）", async () => {
    expect(await contentRepository.getPlan()).toEqual([]);
  });

  it("内容仓储：删除商品时内容级联清理", async () => {
    const product = await createContentTestProduct("[集成测试] 内容级联删除商品");
    await contentRepository.create(contentInput(product.id, product.name));

    expect(
      await contentRepository.findBySlot({
        productId: product.id,
        platform: "douyin",
        format: "short-video",
      }),
    ).not.toBeNull();

    await productRepository.delete(product.id);

    expect(
      await contentRepository.findBySlot({
        productId: product.id,
        platform: "douyin",
        format: "short-video",
      }),
    ).toBeNull();
    expect(
      (await contentRepository.list()).some((item) => item.productId === product.id),
    ).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /* Agent 工作流（S4-1 新增）                                         */
  /* ---------------------------------------------------------------- */

  /** 构造一份带逐步报告的摘要，模拟 business-workflow 编排层的产出 */
  function workflowSummaryFixture(): AgentWorkflowSummary {
    return {
      totalTasks: 2,
      executed: 1,
      reused: 1,
      skipped: 0,
      failed: 0,
      steps: [
        {
          taskId: "task-1",
          agent: "product_agent",
          title: "分析商品：集成测试",
          status: "completed",
          outcome: "reused",
          note: "已有有效结果，直接复用",
          blockedBy: [],
          outputRef: null,
          durationMs: 0,
        },
        {
          taskId: "task-2",
          agent: "content_agent",
          title: "生成内容：集成测试",
          status: "completed",
          outcome: "executed",
          note: null,
          blockedBy: ["task-1"],
          outputRef: "content:prod_x:douyin:short-video",
          durationMs: 1200,
        },
      ],
    };
  }

  it("工作流仓储：create → jsonb 落库与读回映射，默认值为 idle / null", async () => {
    const plan = {
      goal: "为新品鲍鱼做一轮完整预热",
      summary: "先分析商品，再生成内容",
      tasks: [
        {
          id: "task-1",
          agent: "product_agent",
          title: "分析商品",
          reason: "内容需要商品卖点",
          dependsOn: [],
        },
      ],
      confidence: 0.8,
    };

    const created = await agentWorkflowRepository.create({
      businessId,
      goal: "为新品鲍鱼做一轮完整预热",
      plan,
    });

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.businessId).toBe(businessId);
    expect(created.status).toBe("idle");
    // 尚未开跑：summary / errorMessage / completedAt 必须是 null，不能伪造
    expect(created.summary).toBeNull();
    expect(created.errorMessage).toBeNull();
    expect(created.completedAt).toBeNull();
    // 展示格式与 Mock 数据源一致
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

    // 计划快照按 jsonb 原样读回（仓储层不解释 plan，服务层才会用 Zod 重新校验）
    const reloaded = await agentWorkflowRepository.findById(created.id);
    expect(reloaded?.goal).toBe("为新品鲍鱼做一轮完整预热");
    expect(reloaded?.plan).toEqual(plan);
  });

  it("工作流仓储：非 uuid id 返回 null，不抛数据库类型错误；不存在时抛 NOT_FOUND", async () => {
    expect(await agentWorkflowRepository.findById("wf_001")).toBeNull();
    expect(await agentWorkflowRepository.findById("none")).toBeNull();

    await expect(
      agentWorkflowRepository.markRunning("00000000-0000-0000-0000-000000000000"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      agentWorkflowRepository.markCompleted("00000000-0000-0000-0000-000000000000", {
        totalTasks: 0,
        executed: 0,
        reused: 0,
        skipped: 0,
        failed: 0,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("工作流仓储：markRunning → markCompleted 全程流转，summary 与 completedAt 正确落库", async () => {
    const created = await agentWorkflowRepository.create({
      businessId,
      goal: "[集成测试] 全程流转工作流",
    });

    const running = await agentWorkflowRepository.markRunning(created.id);
    expect(running.status).toBe("running");
    // running 是非终态：completedAt 必须被清空（防重复启动靠 status，不靠时间）
    expect(running.completedAt).toBeNull();

    const summary = workflowSummaryFixture();
    const completed = await agentWorkflowRepository.markCompleted(created.id, summary);

    expect(completed.status).toBe("completed");
    expect(completed.completedAt).not.toBeNull();
    expect(completed.errorMessage).toBeNull();
    // 带逐步报告的摘要经 jsonb 往返后，用共享规则读回应完整还原
    const parsed = toWorkflowSummary(completed.summary);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      return;
    }
    expect(parsed.totalTasks).toBe(2);
    expect(parsed.reused).toBe(1);
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps?.[0]).toMatchObject({
      taskId: "task-1",
      agent: "product_agent",
      outcome: "reused",
    });
    expect(parsed.steps?.[1]?.outputRef).toBe(
      "content:prod_x:douyin:short-video",
    );
    expect(parsed.steps?.[1]?.durationMs).toBe(1200);

    // 重新查询确认真的落库
    const reloaded = await agentWorkflowRepository.findById(created.id);
    expect(reloaded?.status).toBe("completed");
    expect(toWorkflowSummary(reloaded?.summary ?? null)?.executed).toBe(1);
  });

  it("工作流仓储：markPartiallyCompleted 同时落 summary 与 errorMessage", async () => {
    const created = await agentWorkflowRepository.create({
      businessId,
      goal: "[集成测试] 部分完成工作流",
    });
    await agentWorkflowRepository.markRunning(created.id);

    const partially = await agentWorkflowRepository.markPartiallyCompleted(
      created.id,
      {
        summary: {
          ...workflowSummaryFixture(),
          executed: 1,
          failed: 1,
        },
        errorMessage: "内容生成失败：模型服务暂时不可用",
      },
    );

    expect(partially.status).toBe("partially_completed");
    expect(partially.completedAt).not.toBeNull();
    expect(partially.errorMessage).toContain("模型服务暂时不可用");
    const parsed = toWorkflowSummary(partially.summary);
    expect(parsed?.failed).toBe(1);
    expect(parsed?.executed).toBe(1);
  });

  it("工作流仓储：markFailed 未传 summary 时保留上一轮统计，重跑时才作废", async () => {
    const created = await agentWorkflowRepository.create({
      businessId,
      goal: "[集成测试] 失败与重跑工作流",
    });
    await agentWorkflowRepository.markRunning(created.id);

    // 第一轮：部分统计已经写进去（中途失败的典型形态）
    const firstRound = await agentWorkflowRepository.markPartiallyCompleted(
      created.id,
      { summary: workflowSummaryFixture() },
    );
    expect(firstRound.status).toBe("partially_completed");

    // 第二轮直接标失败且不带 summary：上一轮的统计必须保留，
    // 否则界面会显示「什么都没跑过」，比「跑了一半失败」更误导
    const failed = await agentWorkflowRepository.markFailed(created.id, {
      errorMessage: "执行器异常退出",
    });
    expect(failed.status).toBe("failed");
    expect(failed.errorMessage).toBe("执行器异常退出");
    expect(failed.completedAt).not.toBeNull();
    /**
     * 完成时间应当**保持第一次终态的那一次**，而不是被后一次覆盖。
     *
     * 这是 `../lifecycle` 里写死的规则（「同一次执行里若状态被写两次终态，
     * 保留最早那次，避免耗时口径被后一次写覆盖」）——
     * 界面上的「耗时」是 `startedAt → completedAt`，若让失败那一刻覆盖它，
     * 一条跑了 3 秒、拖了 10 分钟才被判定失败的工作流会显示成「耗时 10 分钟」。
     *
     * 早先这里写的是 `not.toBe`（期望两次不同），与规则正好相反；因为整组用例
     * 长期处于「无 DATABASE_URL 即跳过」的状态，这个反向断言一直没被执行过。
     */
    expect(failed.completedAt).toBe(firstRound.completedAt);
    expect(toWorkflowSummary(failed.summary)?.totalTasks).toBe(2);

    // 重开新一轮：markRunning 必须作废上一轮的统计与错误
    const rerun = await agentWorkflowRepository.markRunning(created.id);
    expect(rerun.status).toBe("running");
    expect(rerun.summary).toBeNull();
    expect(rerun.errorMessage).toBeNull();
    expect(rerun.completedAt).toBeNull();
  });

  it("工作流仓储：findLatestRunning 只命中 running，且取最近一条", async () => {
    // 先确保有一条 running 的（前面用例结束时都不是 running）
    const running = await agentWorkflowRepository.create({
      businessId,
      goal: "[集成测试] 运行中工作流",
      status: "running",
    });
    // 刚创建的比早先的记录新：最近一条就是它
    const latest = await agentWorkflowRepository.findLatestRunning();
    expect(latest?.id).toBe(running.id);
    expect(latest?.status).toBe("running");

    // 收口后不再命中
    await agentWorkflowRepository.markCompleted(running.id, {
      totalTasks: 1,
      executed: 1,
      reused: 0,
      skipped: 0,
      failed: 0,
    });
    const afterClose = await agentWorkflowRepository.findLatestRunning();
    expect(afterClose?.id ?? "").not.toBe(running.id);
  });

  it("工作流仓储：listRecent 按创建时间倒序且尊重 limit", async () => {
    const first = await agentWorkflowRepository.create({
      businessId,
      goal: "[集成测试] 列表排序 1",
    });
    const second = await agentWorkflowRepository.create({
      businessId,
      goal: "[集成测试] 列表排序 2",
    });

    const recent = await agentWorkflowRepository.listRecent(5);
    expect(recent.length).toBeGreaterThanOrEqual(2);
    expect(recent.length).toBeLessThanOrEqual(5);
    // 最新在前
    expect(recent[0]?.id).toBe(second.id);
    expect(recent.some((item) => item.id === first.id)).toBe(true);

    const single = await agentWorkflowRepository.listRecent(1);
    expect(single).toHaveLength(1);
  });

  it("工作流仓储：删除商家时工作流级联清理", async () => {
    // 单独开一个商家验证级联，不动本组测试的主商家
    const inserted = await getDb()
      .insert(businesses)
      .values({
        name: "[集成测试] 工作流级联删除商家",
        shortName: "级联测试",
        description: "验证 agent_workflows 的 onDelete cascade",
        owner: "测试账号",
        location: "福建连江",
        mainCategory: "海产品",
        storeCount: 0,
        channels: [],
      })
      .returning({ id: businesses.id });
    const cascadeBusinessId = inserted[0]?.id ?? "";

    const workflow = await agentWorkflowRepository.create({
      businessId: cascadeBusinessId,
      goal: "[集成测试] 级联删除工作流",
    });

    await getDb().delete(businesses).where(eq(businesses.id, cascadeBusinessId));

    expect(await agentWorkflowRepository.findById(workflow.id)).toBeNull();
  });

  it("商品仓储：跨租户隔离 —— 别的商家的商品不可见、不可改、不可删", async () => {
    // 测试环境没有请求作用域，作用域回落到「最早创建的商家」（见 ./shared）
    const scopeBusinessId = await resolvePrimaryBusinessId();
    expect(scopeBusinessId).toBeTruthy();

    // 模拟另一个租户：单独开一个商家，商品挂它名下
    const inserted = await getDb()
      .insert(businesses)
      .values({
        name: "[集成测试] 隔壁租户商家",
        shortName: "隔壁租户",
        description: "验证商品跨租户隔离，结束后删除",
        owner: "别的账号",
        location: "福建连江",
        mainCategory: "海产品",
        storeCount: 0,
        channels: [],
      })
      .returning({ id: businesses.id });
    const otherBusinessId = inserted[0]?.id ?? "";
    expect(otherBusinessId).not.toBe("");
    // 刚创建的商家不可能成为「最早的那条」
    expect(otherBusinessId).not.toBe(scopeBusinessId);

    const otherProduct = await productRepository.create({
      businessId: otherBusinessId,
      name: "[集成测试] 隔壁租户的鲍鱼",
      description: "不应出现在当前商家的任何查询里",
      category: "海产品",
      subCategory: "鲍鱼",
      price: 99,
      tags: [],
    });
    const ownProduct = await productRepository.create({
      businessId: scopeBusinessId,
      name: "[集成测试] 本租户的鲍鱼",
      description: "应该出现在当前商家的列表里",
      category: "海产品",
      subCategory: "鲍鱼",
      price: 199,
      tags: [],
    });

    try {
      // 列表 / id 列表：只看得到自己商家的商品
      const listed = await productRepository.list();
      expect(listed.some((item) => item.id === otherProduct.id)).toBe(false);
      expect(listed.some((item) => item.id === ownProduct.id)).toBe(true);

      const ids = await productRepository.listIds();
      expect(ids).not.toContain(otherProduct.id);
      expect(ids).toContain(ownProduct.id);

      // 改 / 删别的租户商品：与「商品不存在」表现完全一致（NOT_FOUND）
      await expect(
        productRepository.update(otherProduct.id, { name: "越权改名" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(productRepository.delete(otherProduct.id)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });

      // 归属判断：隔壁的商品不属于当前商家，自己的商品属于
      expect(
        await productRepository.belongsToBusiness(scopeBusinessId, otherProduct.id),
      ).toBe(false);
      expect(
        await productRepository.belongsToBusiness(scopeBusinessId, ownProduct.id),
      ).toBe(true);
      expect(
        await productRepository.belongsToBusiness(otherBusinessId, otherProduct.id),
      ).toBe(true);

      // countForBusiness 是注册流程的「起步数据判断」，天然按显式商家计数
      expect(await productRepository.countForBusiness(otherBusinessId)).toBe(1);
      expect(await productRepository.countForBusiness(scopeBusinessId)).toBeGreaterThanOrEqual(1);
    } finally {
      // 隔壁租户商家整条级联删除（带走它的商品）；本租户商品单独清理
      await getDb().delete(businesses).where(eq(businesses.id, otherBusinessId));
      await getDb().delete(products).where(eq(products.id, ownProduct.id));
    }
  });
});
