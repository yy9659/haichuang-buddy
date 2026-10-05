/**
 * 内容工厂读取服务
 *
 * 页面只调用这里，拿到的是一份「页面直接用」的视图：
 * 内容资产列表、今日排期、可选商品、经营小结，
 * 以及**当前选中槽位**的内容、生成状态与生成依据。
 *
 * 槽位的概念见 `src/types/content.ts`：一个「商品 × 平台 × 内容形态」的位置，
 * 同一位同时只保留一条内容。用户在页面上选的正是这个槽位，
 * 因此「当前有没有内容 / 正在生成没有 / 上次成功还是失败」都必须按槽位回答，
 * 而不是按商品回答 —— 否则给鲍鱼生成的抖音内容会让海带的小红书槽位显示「已生成」。
 *
 * 关于 `basis`（生成依据）：内容运营 Agent 能不能产出**有依据的内容**，
 * 取决于它读到了多少真实材料。把「有没有 DNA / 品牌档案 / 老板分身」如实返回给界面，
 * 用户才可能在点击之前就知道这次生成是「依据充分」还是「只能硬编」，
 * 而不是点了之后收到一句没头没尾的失败提示。
 */

import type { ContentItem, ContentPlanItem, ContentSlot } from "@/types";
import type { DataSourceId } from "@/lib/env";
import { getRepositories, getDataSourceStatus } from "@/repositories";
import { summarizeContents, type ContentSummary } from "@/analytics/metrics";
import { attempt, toAppError, unwrapOrThrow, type Result } from "@/lib/result";
import {
  getContentSlotState,
  getContentSourceProducts,
  resolveContentSlot,
  type ContentSlotState,
  type ContentSourceProduct,
} from "./content-agent.service";

/** 当前槽位的生成依据（供界面在点击之前如实说明「依据是否充分」） */
export interface ContentBasis {
  /** 该商品是否已有 Product DNA */
  hasDna: boolean;
  /** 是否已生成品牌档案 */
  hasBrandProfile: boolean;
  /** 是否已建立老板数字分身 */
  hasOwnerTwin: boolean;
}

/** 当前选中槽位的完整视图 */
export interface ContentView {
  /** 内容资产（最新在前） */
  contents: ContentItem[];
  /** 今日排期 */
  plan: ContentPlanItem[];
  /**
   * 可作为内容生成来源的商品（**已有 Product DNA 的排在前面**）。
   * 内容工厂的下拉框用的是这份数据，而不是全量商品列表：
   * 它额外带 `hasDna`，界面据此能在选择阶段就标出「依据充分 / 依据不足」。
   */
  sourceProducts: ContentSourceProduct[];
  summary: ContentSummary;
  /** 当前数据来源；界面据此如实说明「今日排期尚未接入数据源」 */
  dataSource: DataSourceId;
  /**
   * 当前选中的槽位。
   * 为 null 表示**一件商品都没有** —— 此时按钮应当禁用并提示先添加商品。
   */
  slot: ContentSlot | null;
  /** 当前槽位的状态（empty / generating / completed / failed）与当前内容；无商品时为 null */
  slotState: ContentSlotState | null;
  /** 当前槽位的生成依据；无商品时为 null */
  basis: ContentBasis | null;
}

/** 页面传来的槽位参数（来自 URL searchParams，全部可缺省） */
export interface ContentViewQuery {
  productId?: string | null;
  platform?: string | null;
  format?: string | null;
}

/**
 * 读取当前槽位的生成依据。
 *
 * 读取失败**直接上抛**（与下面槽位状态同一纪律）：
 * 把「读不到品牌档案」伪装成「没有品牌档案」，会让界面给出
 * 「请先生成品牌档案」这种**错误的指导**，比报错更糟。
 */
async function loadBasis(
  productId: string,
  sourceProducts: ContentSourceProduct[],
): Promise<ContentBasis> {
  const hasDna = sourceProducts.find((item) => item.id === productId)?.hasDna ?? false;
  const repositories = getRepositories();
  const rest = unwrapOrThrow(
    await attempt(
      async () => {
        const [brand, owner] = await Promise.all([
          repositories.brand.getProfile(),
          repositories.business.getOwnerTwin(),
        ]);
        return { hasBrandProfile: brand !== null, hasOwnerTwin: owner !== null };
      },
      (cause) => toAppError(cause, "DB_ERROR", "加载内容生成依据失败"),
    ),
  );
  return { hasDna, ...rest };
}

export async function getContentView(
  query: ContentViewQuery = {},
): Promise<Result<ContentView>> {
  const loaded = await attempt(
    async () => {
      const repositories = getRepositories();
      const [contents, plan] = await Promise.all([
        repositories.content.list(),
        repositories.content.getPlan(),
      ]);
      return { contents, plan };
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载内容工厂数据失败"),
  );
  if (!loaded.ok) {
    return loaded;
  }

  /**
   * 候选商品**只取一次**：它既要在下拉框里渲染，又要参与槽位解析。
   * 传进 `resolveContentSlot` 复用，避免同一份「商品 + DNA」查询跑两遍 ——
   * 更要紧的是，两处各取一次会让「下拉里选中的商品」与「解析出的商品」
   * 有机会来自两次不同的快照，出现界面与状态对不上的诡异现象。
   */
  const sourceProducts = unwrapOrThrow(await getContentSourceProducts());
  const slot = unwrapOrThrow(await resolveContentSlot(query, sourceProducts));

  const summary = summarizeContents(loaded.data.contents);
  const dataSource = getDataSourceStatus().dataSource;

  if (!slot) {
    return {
      ok: true,
      data: {
        ...loaded.data,
        sourceProducts,
        summary,
        dataSource,
        slot: null,
        slotState: null,
        basis: null,
      },
    };
  }

  /**
   * 槽位内容走 `findBySlot` 而不是在上面的列表里筛：
   * 仓储是「这个槽位里有什么」的唯一权威，页面展示用的列表顺序 / 截断都不该影响它。
   */
  const content = unwrapOrThrow(
    await attempt(
      () => getRepositories().content.findBySlot(slot),
      (cause) => toAppError(cause, "DB_ERROR", "读取槽位内容失败"),
    ),
  );

  const [slotState, basis] = await Promise.all([
    getContentSlotState(slot, content).then(unwrapOrThrow),
    loadBasis(slot.productId, sourceProducts),
  ]);

  return {
    ok: true,
    data: {
      ...loaded.data,
      sourceProducts,
      summary,
      dataSource,
      slot,
      slotState,
      basis,
    },
  };
}
