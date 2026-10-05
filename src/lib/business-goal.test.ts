/**
 * 经营目标组装单测（S4-2）
 *
 * 这一层同时被**服务端**（决定真正发给模型与落库的那句话）与**客户端**
 * （输入时实时预览）使用，因此测试的核心不是「拼得对不对」，
 * 而是三条不能破的约定：
 *
 *   1. 长度上限与 AI 契约（`BusinessPlanSchema.goal` 的 120 字）**同一个数**。
 *      两边口径不一致，商家会看到一个毫无道理的「模型输出格式错误」。
 *   2. **不做静默截断**。超长要如实标出来让人自己精简 ——
 *      被自动截掉的很可能正是「今晚」「年轻家庭」这类决定计划方案的关键限定词。
 *   3. **不猜平台**。渠道清单只能是真实支持的六个内容平台，
 *      形态跟着平台走（抖音就是短视频、朋友圈就是海报文案），
 *      不让用户配出「朋友圈 × 短视频脚本」这种现实中不存在的组合。
 */

import { describe, expect, it } from "vitest";

import { CONTENT_FORMATS, CONTENT_PLATFORMS } from "./content-options";
import {
  BUSINESS_GOAL_CHANNELS,
  MAX_BUSINESS_GOAL_LENGTH,
  buildBusinessGoalText,
  isBusinessGoalChannel,
  resolveBusinessGoalChannels,
} from "./business-goal";

describe("BUSINESS_GOAL_CHANNELS：渠道清单", () => {
  it("只包含真实支持的六个内容平台，且不重复", () => {
    const platforms = BUSINESS_GOAL_CHANNELS.map((channel) => channel.platform);
    expect(platforms).toEqual([...CONTENT_PLATFORMS]);
    expect(new Set(platforms).size).toBe(platforms.length);
  });

  it("形态跟着平台走，且每个渠道都有展示名", () => {
    for (const channel of BUSINESS_GOAL_CHANNELS) {
      expect(CONTENT_FORMATS).toContain(channel.format);
      expect(channel.label.length).toBeGreaterThan(0);
      expect(channel.formatLabel.length).toBeGreaterThan(0);
    }

    const byPlatform = new Map(
      BUSINESS_GOAL_CHANNELS.map((channel) => [channel.platform, channel.format]),
    );
    // 行业常识：抖音/视频号是短视频，朋友圈与投放是海报文案
    expect(byPlatform.get("douyin")).toBe("short-video");
    expect(byPlatform.get("shipinhao")).toBe("short-video");
    expect(byPlatform.get("wechat")).toBe("poster-copy");
    expect(byPlatform.get("ads")).toBe("poster-copy");
  });

  it("isBusinessGoalChannel 只认清单内的平台", () => {
    expect(isBusinessGoalChannel("douyin")).toBe(true);
    expect(isBusinessGoalChannel("weibo")).toBe(false);
    expect(isBusinessGoalChannel("")).toBe(false);
  });
});

describe("resolveBusinessGoalChannels：从表单勾选解析渠道", () => {
  it("未知名被忽略，而不是让整次规划失败（商家什么都没做错）", () => {
    const channels = resolveBusinessGoalChannels(["douyin", "weibo", "hack"]);
    expect(channels.map((channel) => channel.platform)).toEqual(["douyin"]);
  });

  it("结果按清单顺序而不是勾选顺序 —— 同一组选择永远得到同一句话", () => {
    const channels = resolveBusinessGoalChannels(["wechat", "douyin", "xiaohongshu"]);
    expect(channels.map((channel) => channel.platform)).toEqual([
      "douyin",
      "xiaohongshu",
      "wechat",
    ]);
  });

  it("优先级是「清单顺序」而不是「用户点击顺序」的补充说明：重复勾选不产生重复渠道", () => {
    const channels = resolveBusinessGoalChannels(["douyin", "douyin"]);
    expect(channels).toHaveLength(1);
  });

  it("空数组 / undefined → 没有指定渠道（走保守规划）", () => {
    expect(resolveBusinessGoalChannels([])).toEqual([]);
    expect(resolveBusinessGoalChannels(undefined)).toEqual([]);
  });
});

describe("buildBusinessGoalText：组装成一句给人读的话", () => {
  it("只填目标 → 原话返回，不带空括号", () => {
    const draft = buildBusinessGoalText({ goal: "今晚把鲍鱼卖爆" });
    expect(draft.text).toBe("今晚把鲍鱼卖爆");
    expect(draft.enriched).toBe(false);
    expect(draft.tooLong).toBe(false);
  });

  it("明确选择全链路时保存协同范围，已有全链路字样不重复追加", () => {
    const selected = buildBusinessGoalText({ goal: "准备新品上线", fullChain: true });
    expect(selected.text).toBe("准备新品上线（协同方式：六岗位全链路）");
    const named = buildBusinessGoalText({ goal: "做一次六岗位全链路", fullChain: true });
    expect(named.text).toBe("做一次六岗位全链路");
  });

  it("带主推商品 / 目标人群 / 渠道 → 用括号把补充条件缀在句尾", () => {
    const draft = buildBusinessGoalText({
      goal: "为今晚准备推广内容",
      productName: "连江鲜活鲍鱼",
      targetAudience: "注重食材新鲜度的年轻家庭",
      channels: resolveBusinessGoalChannels(["douyin", "wechat"]),
    });

    expect(draft.text).toBe(
      "为今晚准备推广内容（主推商品：连江鲜活鲍鱼；目标用户：注重食材新鲜度的年轻家庭；渠道：抖音短视频脚本、朋友圈海报文案）",
    );
    expect(draft.enriched).toBe(true);
  });

  it("补充信息的顺序固定为 商品 → 人群 → 渠道", () => {
    const withChannels = buildBusinessGoalText({
      goal: "推一把",
      channels: resolveBusinessGoalChannels(["douyin"]),
    });
    expect(withChannels.text).toBe("推一把（渠道：抖音短视频脚本）");

    const withProduct = buildBusinessGoalText({
      goal: "推一把",
      productName: "连江鲜活鲍鱼",
      channels: resolveBusinessGoalChannels(["douyin"]),
    });
    expect(withProduct.text.indexOf("主推商品")).toBeLessThan(
      withProduct.text.indexOf("渠道"),
    );
  });

  it("空白串按「没填」处理，不产生「主推商品：」这样的残句", () => {
    const draft = buildBusinessGoalText({
      goal: "  推一把  ",
      productName: "   ",
      targetAudience: "",
      channels: [],
    });
    expect(draft.text).toBe("推一把");
    expect(draft.enriched).toBe(false);
  });

  it("超长时**如实标出并保留全文**，绝不静默截断", () => {
    const goal = "要".repeat(MAX_BUSINESS_GOAL_LENGTH);
    const draft = buildBusinessGoalText({
      goal,
      productName: "连江鲜活鲍鱼",
      channels: resolveBusinessGoalChannels(["douyin"]),
    });

    expect(draft.tooLong).toBe(true);
    // 长度与文本都是真实的：界面要靠 length 告诉商家「当前 XX 字」
    expect(draft.length).toBe(draft.text.length);
    expect(draft.text.length).toBeGreaterThan(MAX_BUSINESS_GOAL_LENGTH);
    // 目标原话一字不少地留在里面（截断掉的可能是「今晚」这类关键限定词）
    expect(draft.text.startsWith(goal)).toBe(true);
  });

  it("长度上限与计划契约的 goal 上限同值（口径只有一处）", () => {
    expect(MAX_BUSINESS_GOAL_LENGTH).toBe(120);

    const exactly = buildBusinessGoalText({
      goal: "要".repeat(MAX_BUSINESS_GOAL_LENGTH),
    });
    expect(exactly.tooLong).toBe(false);

    const oneMore = buildBusinessGoalText({
      goal: "要".repeat(MAX_BUSINESS_GOAL_LENGTH + 1),
    });
    expect(oneMore.tooLong).toBe(true);
  });
});
