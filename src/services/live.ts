/**
 * AI 直播间视图装配（S6）
 *
 * 页面只从这里取数（禁止直接 import 仓储 / Mock）。本模块做三件事：
 * 1. 读当前场次的评论与建议；
 * 2. 用**纯函数**算出真实指标与热点（`lib/live-topics`）；
 * 3. 组一份**提词器视图**——它的三块内容全部来自真实数据
 *    （商品 / Product DNA / Brand Profile / 最新一条高优先级建议），
 *    而不是一段写死的脚本文案（任务书第二十五节）。
 *
 * 关于「真实」与「模拟」的边界（任务书第四十二 / 四十三节）：
 * - `realMetrics`：评论数 / AI 处理数 / 高优先级数 / 有依据数 —— 全部由本场数据实时算出；
 * - `simulatedStats`：在线人数 / 点赞 / 涨粉 —— 没有真实来源，字段上明确标注为演示数据。
 * 两者在类型与界面上都分开，绝不混在一起。
 */

import { getRepositories, getDataSourceStatus, type DataSourceStatus } from "@/repositories";
import { attempt, toAppError, type Result } from "@/lib/result";
import { aggregateLiveHotTopics } from "@/lib/live-topics";
import { MOCK_LIVE_QUICK_COMMENTS } from "@/lib/mock";
import type {
  LiveComment,
  LiveHotTopic,
  LiveRealMetrics,
  LiveSession,
  LiveStats,
  LiveSuggestion,
  LiveTeleprompterView,
} from "@/types";

/** 商品选项（切换直播商品用；不暴露仓储） */
export interface LiveProductOption {
  id: string;
  name: string;
  category: string;
  /** 是否已有 Product DNA（决定营销建议的依据多少） */
  hasDna: boolean;
}

/** AI 直播间所需数据 */
export interface LiveView {
  /** 为 null 表示当前没有进行中的直播场次 */
  session: LiveSession | null;
  /** **模拟**指标（演示数据；无场次时为 null） */
  simulatedStats: LiveStats | null;
  /** **真实**可计算指标 */
  realMetrics: LiveRealMetrics;
  comments: LiveComment[];
  suggestions: LiveSuggestion[];
  hotTopics: LiveHotTopic[];
  /** 主播提词器；无场次时为 null */
  teleprompter: LiveTeleprompterView | null;
  /** 快捷评论按钮：只是帮用户填评论，点击后仍走真实链路（§41） */
  quickComments: readonly string[];
  /** 可切换的直播商品 */
  products: LiveProductOption[];
  dataSource: DataSourceStatus;
  /**
   * 直播模块在当前数据源下不可用时的原因；可用时为 null。
   *
   * S7 起直播已接上数据库，正常情况恒为 null；仅在某个数据源仍抛
   * `NOT_IMPLEMENTED`（防御性探针命中）时给出，界面据此显示
   * 「该模块尚未启用」，而**不是**显示「当前没有进行中的直播场次」——
   * 后者会让商家以为「点一下开始直播就有了」，然后一直点。
   */
  unavailableReason: string | null;
}

/** 真实指标：全部由本场评论实时算出 */
export function computeRealMetrics(
  comments: readonly LiveComment[],
  suggestions: readonly LiveSuggestion[],
): LiveRealMetrics {
  const successful = suggestions.filter(
    (suggestion) => suggestion.failureMessage === null,
  );
  return {
    commentCount: comments.length,
    aiHandledCount: successful.length,
    highPriorityCount: successful.filter((item) => item.priority === "high").length,
    groundedCount: successful.filter((item) => item.grounded).length,
  };
}

/** 组装提词器视图（商品 + DNA + 品牌 + 最新高优先级建议） */
function buildTeleprompter(input: {
  session: LiveSession;
  sellingPoints: string[];
  brandTone: string[];
  suggestions: readonly LiveSuggestion[];
}): LiveTeleprompterView {
  const latestHigh = input.suggestions.find(
    (suggestion) =>
      suggestion.failureMessage === null && suggestion.priority === "high",
  );
  const latestAny = input.suggestions.find(
    (suggestion) => suggestion.failureMessage === null,
  );

  return {
    productId: input.session.productId,
    productName: input.session.productName,
    sellingPoints: input.sellingPoints,
    dnaNotice:
      input.sellingPoints.length > 0
        ? null
        : "商品尚未完成 AI 分析，营销建议依据较少。",
    brandTone: input.brandTone,
    brandNotice:
      input.brandTone.length > 0
        ? null
        : "尚未生成品牌档案，品牌语气能力减少。",
    latestSuggestion: latestHigh ?? latestAny ?? null,
  };
}

/** 空视图：既用于「无场次」，也用于「该数据源下直播模块尚未启用」 */
function buildEmptyLiveView(input: {
  products: LiveProductOption[];
  unavailableReason: string | null;
}): LiveView {
  return {
    session: null,
    simulatedStats: null,
    realMetrics: {
      commentCount: 0,
      aiHandledCount: 0,
      highPriorityCount: 0,
      groundedCount: 0,
    },
    comments: [],
    suggestions: [],
    hotTopics: [],
    teleprompter: null,
    quickComments: MOCK_LIVE_QUICK_COMMENTS,
    products: input.products,
    dataSource: getDataSourceStatus(),
    unavailableReason: input.unavailableReason,
  };
}

export async function getLiveView(): Promise<Result<LiveView>> {
  const repositories = getRepositories();

  /**
   * 先探一次直播场次，并把「未实现」单独接住（防御性）。
   *
   * S7 起直播仓储已接上数据库，正常路径不再抛 NOT_IMPLEMENTED；这一层保留
   * 探针是为了守住 `db/index.ts` 的承诺 ——「由服务层显式降级并标注，不会 500」，
   * 防止某个数据源将来退回未实现时整页（乃至 `next build` 预渲染）一起挂掉。
   *
   * 注意只接 `NOT_IMPLEMENTED`：真正的数据库故障（连不上、表被删）仍然照常失败。
   * 把「没实现」和「读不到」混为一谈，会让数据库故障被当成正常状态藏起来。
   */
  const sessionProbe = await attempt(
    () => repositories.live.getSession(),
    (cause) => toAppError(cause, "DB_ERROR", "加载直播场次失败"),
  );

  if (!sessionProbe.ok) {
    if (sessionProbe.error.code === "NOT_IMPLEMENTED") {
      return {
        ok: true,
        data: buildEmptyLiveView({
          products: [],
          unavailableReason: sessionProbe.error.message,
        }),
      };
    }
    return sessionProbe;
  }

  return attempt(
    async () => {
      const session = sessionProbe.data;

      /** 无场次：返回空视图，界面进入「未开播」态 */
      if (!session) {
        return buildEmptyLiveView({
          products: await listLiveProductOptions(repositories),
          unavailableReason: null,
        });
      }

      const [comments, suggestions, stats, dna, brandProfile, products] =
        await Promise.all([
          repositories.live.listComments(session.id),
          repositories.live.listSuggestions(session.id),
          repositories.live.getStats(),
          repositories.productDna.getByProductId(session.productId),
          repositories.brand.getProfile(),
          listLiveProductOptions(repositories),
        ]);

      const teleprompter = buildTeleprompter({
        session,
        sellingPoints: dna?.sellingPoints ?? [],
        brandTone: brandProfile?.toneOfVoice ?? [],
        suggestions,
      });

      return {
        session,
        simulatedStats: stats,
        realMetrics: computeRealMetrics(comments, suggestions),
        comments,
        suggestions,
        hotTopics: aggregateLiveHotTopics(comments),
        teleprompter,
        quickComments: MOCK_LIVE_QUICK_COMMENTS,
        products,
        dataSource: getDataSourceStatus(),
        unavailableReason: null,
      } satisfies LiveView;
    },
    (cause) => toAppError(cause, "DB_ERROR", "加载 AI 直播间数据失败"),
  );
}

/** 商品选项：优先有 DNA 的在前（§38：优先选择有 Product DNA 的商品） */
async function listLiveProductOptions(
  repositories: ReturnType<typeof getRepositories>,
): Promise<LiveProductOption[]> {
  const products = await repositories.products.list();
  const withDna = await Promise.all(
    products.map(async (product) => {
      const dna = await repositories.productDna
        .getByProductId(product.id)
        .catch(() => null);
      return {
        id: product.id,
        name: product.name,
        category: product.category,
        hasDna: dna !== null,
      } satisfies LiveProductOption;
    }),
  );
  return withDna.sort((left, right) => Number(right.hasDna) - Number(left.hasDna));
}
