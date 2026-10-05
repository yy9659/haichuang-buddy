/**
 * Demo 种子知识的自动索引（S5 · Task 81 第十六 ~ 二十三节）
 *
 * 解决的演示问题：Task 79 之前，Mock 种子知识是「只有文档、没有切片」的
 * `pending` 状态 —— 比赛现场打开 /customer-service，第一件事竟是手动点
 * 「建立索引」，否则问什么都是依据不足。现在这份工作在**页面渲染前**
 * 自动补齐，开箱即用。
 *
 * ## 四条纪律（都来自任务书，违反任何一条都会在演示现场出事故）
 *
 * 1. **只在 Mock 数据源下运行**（§23）。生产数据库绝不能因为
 *    「有人打开了网页」就被写进 Demo 知识 —— DB 模式的种子只有
 *    `pnpm db:seed` 这一个显式入口。
 * 2. **必须走正式 Knowledge Service**（§17）。禁止在这里硬编码 Mock chunks、
 *    禁止复制一套「Mock 专用索引流程」—— 那样 Mock 模式验证过的链路
 *    和真实链路就不是同一条了。
 * 3. **绝不在模块 import 时偷偷执行**（§18）。异步索引挂在 import 上
 *    会不可控、难测、容易 race；本模块只导出显式函数，由页面渲染
 *    这个明确的生命周期调用。
 * 4. **幂等**（§19）。重复调用只做一次廉价的状态检查（`ensureKnowledgeIndexed`
 *    的职责），不会每次刷新页面都重新 Embedding。
 */

import { getDataSource } from "@/lib/env";
import { MOCK_BUSINESS, MOCK_KNOWLEDGE_DOCUMENTS } from "@/lib/mock";
import { attempt, ok, toAppError, type Result } from "@/lib/result";
import { getRepositories } from "@/repositories";

import { ensureKnowledgeIndexed } from "./knowledge.service";

/** 一次自动索引的执行摘要（也供测试断言「第二次没有重复 Embedding」） */
export interface DemoKnowledgeBootstrapSummary {
  /** 检查了多少份种子文档 */
  checked: number;
  /** 本次真实重建索引的数量（0 = 全部已是最新，一次 Embedding 都没做） */
  rebuilt: number;
  /** 不存在的种子数（被商家删除的，跳过 —— 删除是显式动作，不该被复活） */
  missing: number;
}

/**
 * 执行一次自动索引。
 *
 * 种子文档在 Mock store 初始化时就已经落库（`pending`、无切片），
 * 因此这里**不创建文档**，只对存在的种子逐份 `ensureKnowledgeIndexed`：
 * 无切片 / 旧 indexVersion → 重建；已是最新 → 跳过。
 * 商家删除过的种子不复活 —— 「删了又自己长回来」比「少一份演示知识」恶劣得多。
 */
async function runBootstrap(): Promise<Result<DemoKnowledgeBootstrapSummary>> {
  // DB 模式一票否决：这里没有任何「顺手也把 db 初始化了」的余地（§23）
  if (getDataSource() !== "mock") {
    return ok({ checked: 0, rebuilt: 0, missing: 0 });
  }

  return attempt(
    async () => {
      const repositories = getRepositories();
      const businessId = MOCK_BUSINESS.id;

      let checked = 0;
      let rebuilt = 0;
      let missing = 0;

      for (const seed of MOCK_KNOWLEDGE_DOCUMENTS) {
        const document = await repositories.knowledgeDocuments.findDocumentByKey({
          businessId,
          type: seed.type,
          name: seed.name,
        });
        if (!document) {
          missing += 1;
          continue;
        }
        checked += 1;

        const ensured = await ensureKnowledgeIndexed(document.id);
        if (!ensured.ok) {
          /**
           * 单份失败不中断其余种子：Demo 场景下最可能的失败是
           * Embedding Provider 没配好，那会让**每一份**都失败，
           * 中不中断结果一样；而偶发失败不该连累其它文档。
           * 失败的那份保持 pending，页面知识面板的「建立索引」按钮
           * 就是它的人工兜底 —— 提醒能力仍然保留（§24）。
           */
          console.warn(
            `[demo-knowledge] 种子《${seed.name}》自动索引失败：${ensured.error.message}`,
          );
          continue;
        }
        if (ensured.data.rebuilt) {
          rebuilt += 1;
        }
      }

      return { checked, rebuilt, missing };
    },
    (cause) => toAppError(cause, "DB_ERROR", "初始化演示知识库失败"),
  );
}

/**
 * 幂等的自动索引入口。
 *
 * 并发去重：页面渲染是并发场景（用户狂刷、多个标签页），两次 bootstrap
 * 同时跑会对同一批文档做两遍 Embedding。用模块级 in-flight Promise
 * 合并它们 —— 后到的调用等先到的结果，拿到的是同一份摘要。
 */
let inflight: Promise<Result<DemoKnowledgeBootstrapSummary>> | null = null;

export function ensureDemoKnowledgeIndexed(): Promise<
  Result<DemoKnowledgeBootstrapSummary>
> {
  if (!inflight) {
    inflight = runBootstrap().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}
