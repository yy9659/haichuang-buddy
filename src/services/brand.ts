/**
 * 品牌中心读取服务
 *
 * 页面只调用这里，拿到的是一份「页面直接用」的视图：
 * 商家资料（顶栏/脚注）、老板数字分身、以及**可能还不存在**的品牌档案。
 *
 * 品牌档案存在与否决定了页面的主分支（empty / completed），
 * 而「生成中 / 失败」这类**过程状态**由 Brand Agent 服务从 agent_tasks 派生，
 * 因此这里把两者一起返回 —— 页面不需要知道它们来自两个不同的数据源。
 */

import type { BrandProfile, BusinessProfile, OwnerTwin } from "@/types";
import { getRepositories } from "@/repositories";
import { attempt, toAppError, unwrapOrThrow, type Result } from "@/lib/result";
import {
  getBrandGenerationState,
  getBrandSourceProduct,
  type BrandGenerationState,
  type BrandSourceProduct,
} from "./brand-agent.service";

/** 品牌中心所需数据 */
export interface BrandView {
  business: BusinessProfile | null;
  owner: OwnerTwin | null;
  /** 为 null 表示品牌档案尚未生成 */
  brand: BrandProfile | null;
  /** 生成状态（empty / generating / completed / failed）+ 最近一次生成记录 */
  generation: BrandGenerationState;
  /**
   * 本次生成将采用的主依据商品。
   * 为 null 表示**一件商品都没有** —— 此时按钮应当禁用并提示先添加商品。
   */
  sourceProduct: BrandSourceProduct | null;
  /** 商家可明确选择本次品牌草稿重点参考哪件商品。 */
  sourceProducts: Array<{ id: string; name: string }>;
}

export async function getBrandView(): Promise<Result<BrandView>> {
  const loaded = await attempt(
    async () => {
      const repositories = getRepositories();
      const [business, owner, brand, products] = await Promise.all([
        repositories.business.getProfile(),
        repositories.business.getOwnerTwin(),
        repositories.brand.getProfile(),
        repositories.products.list(),
      ]);
      return { business, owner, brand, sourceProducts: products.map((product) => ({ id: product.id, name: product.name })) };
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载品牌档案失败"),
  );
  if (!loaded.ok) {
    return loaded;
  }

  /**
   * 生成状态与依据商品单独取，并且**不吞错**：它们读的是 agent_tasks 与商品/DNA，
   * 与上面那份查询是两件事；失败时必须上抛，否则页面会把
   * 「读不到任务记录」误显示成「品牌还没生成过」——那是在骗用户。
   */
  const generation = unwrapOrThrow(
    await getBrandGenerationState(loaded.data.brand),
  );
  const sourceProduct = unwrapOrThrow(await getBrandSourceProduct());

  return { ok: true, data: { ...loaded.data, generation, sourceProduct } };
}
