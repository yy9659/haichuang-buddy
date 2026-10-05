/**
 * Content Asset Schema 单测（S3-2 Task 1 / Task 7）
 *
 * 这组测试盯的是**契约边界**，而不是「字段能填进去」：
 *   - 对格式宽容：模型把列表写成 `"镜头一；镜头二"` 也要能过 → 否则会无谓地触发纠错重试；
 *   - 对字段缺失严格：缺键必须失败 → 否则脏结果会静默补空数组蒙混过关；
 *   - 枚举与 UI 下拉共用同一份清单（`src/lib/content-options.ts`），非法平台必须被拦下；
 *   - 改名只在一处：AI 契约名（type / scenes / tags / callToAction）
 *     与领域名（format / shotList / hashtags / cta）的映射必须完整且不串位；
 *   - **平台与形态以请求为准**：模型复述错误不能改写槽位，但也不能被静默丢弃。
 */

import { describe, expect, it } from "vitest";

import {
  CONTENT_AI_VERSION,
  CONTENT_SCENE_MAX_LENGTH,
  ContentAssetSchema,
  alignContentDraftToRequest,
  normalizeContentDraft,
  normalizeContentTag,
  toNewContentInput,
  type ContentAssetDraft,
} from "./content";

/** 一份完整合法的模型输出（各用例在此基础上做变形） */
function validDraft(): Record<string, unknown> {
  return {
    platform: "douyin",
    type: "short-video",
    title: "会做饭的人，家里都常备一盒鲍鱼",
    hook: "连江鲍鱼 128 就能买到 500g，蒸 8 分钟直接上桌。",
    body: "很多人觉得鲍鱼是餐厅才吃得到的东西，其实在家做比想象中简单。\n\n刷洗干净上锅蒸 8 分钟就好。",
    scenes: ["0-2s 渔港晨景", "2-6s 手部刷洗特写", "6-12s 蒜蓉上锅"],
    tags: ["#连江鲍鱼", "#家庭海鲜", "#快手菜"],
    callToAction: "点击下方商品，今晚就能安排。",
    visualSuggestions: ["开场用渔港晨雾航拍 2 秒", "结尾用全家夹菜的实拍画面"],
    voiceover: "连江的鲍鱼，当天捞当天发，回家蒸八分钟就是一道硬菜。",
    riskNotes: [],
    confidence: 0.62,
  };
}

describe("ContentAssetSchema：格式宽容", () => {
  it("列表字段写成中文分隔符字符串也能通过", () => {
    const parsed = ContentAssetSchema.safeParse({
      ...validDraft(),
      scenes: "0-2s 渔港晨景、2-6s 刷洗特写；6-12s 蒜蓉上锅",
      tags: "#连江鲍鱼,#家庭海鲜",
      visualSuggestions: "开场航拍\n结尾全家试吃",
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.scenes).toEqual([
      "0-2s 渔港晨景",
      "2-6s 刷洗特写",
      "6-12s 蒜蓉上锅",
    ]);
    expect(parsed.data.tags).toEqual(["#连江鲍鱼", "#家庭海鲜"]);
    expect(parsed.data.visualSuggestions).toEqual(["开场航拍", "结尾全家试吃"]);
  });

  it("数组里的非字符串项被转成字符串并剔除空条目", () => {
    const parsed = ContentAssetSchema.safeParse({
      ...validDraft(),
      tags: ["#连江鲍鱼", 2026, null, "  ", "#家庭海鲜"],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.tags).toEqual(["#连江鲍鱼", "2026", "#家庭海鲜"]);
  });

  it("置信度允许字符串百分比与 0-100 的数值（模型常见两种写法）", () => {
    const asPercent = ContentAssetSchema.safeParse({
      ...validDraft(),
      confidence: "62%",
    });
    expect(asPercent.success).toBe(true);
    if (asPercent.success) {
      expect(asPercent.data.confidence).toBeCloseTo(0.62, 5);
    }

    const asHundred = ContentAssetSchema.safeParse({
      ...validDraft(),
      confidence: 62,
    });
    expect(asHundred.success).toBe(true);
    if (asHundred.success) {
      expect(asHundred.data.confidence).toBeCloseTo(0.62, 5);
    }
  });

  it("置信度缺失或无法解析时回落 0.5，不因一个数字让整次生成失败", () => {
    const parsed = ContentAssetSchema.safeParse({
      ...validDraft(),
      confidence: "不知道",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.confidence).toBe(0.5);
    }
  });

  it("riskNotes 允许为空数组（「没发现风险」是合法结论，不逼模型编造）", () => {
    const parsed = ContentAssetSchema.safeParse({ ...validDraft(), riskNotes: [] });
    expect(parsed.success).toBe(true);
  });

  it("riskNotes 为 null 时归一为空数组（模型把「空」写成 null 是常见格式习惯）", () => {
    const parsed = ContentAssetSchema.safeParse({ ...validDraft(), riskNotes: null });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.riskNotes).toEqual([]);
    }
  });
});

describe("ContentAssetSchema：字段缺失与非法值严格", () => {
  /**
   * 除 `confidence` 外的全部字段都必须在缺失时失败。
   * `confidence` 单独测：它带 `.catch(0.5)`，缺失时会回落 0.5 而不是失败 ——
   * 这是刻意的（一个置信度写错不该拖垮整份产出），因此不能混在这条通用断言里。
   */
  const requiredKeys = [
    "platform",
    "type",
    "title",
    "hook",
    "body",
    "scenes",
    "tags",
    "callToAction",
    "visualSuggestions",
    "voiceover",
    "riskNotes",
  ] as const;

  for (const key of requiredKeys) {
    it(`缺少 ${key} 时校验失败`, () => {
      const draft = validDraft();
      delete draft[key];
      expect(ContentAssetSchema.safeParse(draft).success).toBe(false);
    });
  }

  it("缺少 confidence 时回落 0.5 而不是整份失败", () => {
    const draft = validDraft();
    delete draft.confidence;
    const parsed = ContentAssetSchema.safeParse(draft);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.confidence).toBe(0.5);
    }
  });

  it("非法的 platform / type 被拦下（枚举与 UI 下拉共用同一份清单）", () => {
    expect(
      ContentAssetSchema.safeParse({ ...validDraft(), platform: "kuaishou" }).success,
    ).toBe(false);
    expect(
      ContentAssetSchema.safeParse({ ...validDraft(), type: "podcast" }).success,
    ).toBe(false);
  });

  it("正文与标题的空值被拦下（不能发布一条没有正文的内容）", () => {
    expect(
      ContentAssetSchema.safeParse({ ...validDraft(), title: "   " }).success,
    ).toBe(false);
    expect(
      ContentAssetSchema.safeParse({ ...validDraft(), body: "" }).success,
    ).toBe(false);
  });

  it("超长正文被拦下（1200 字上限）", () => {
    expect(
      ContentAssetSchema.safeParse({ ...validDraft(), body: "啊".repeat(1201) }).success,
    ).toBe(false);
    expect(
      ContentAssetSchema.safeParse({ ...validDraft(), body: "啊".repeat(1200) }).success,
    ).toBe(true);
  });

  it("列表超过 8 条被拦下（防止模型灌入超长内容）", () => {
    expect(
      ContentAssetSchema.safeParse({
        ...validDraft(),
        scenes: Array.from({ length: 9 }, (_, index) => `镜头 ${index}`),
      }).success,
    ).toBe(false);
  });

  it("图文配图场景允许完整说明，但过长内容仍被拦下", () => {
    expect(
      ContentAssetSchema.safeParse({
        ...validDraft(),
        scenes: ["画".repeat(CONTENT_SCENE_MAX_LENGTH)],
      }).success,
    ).toBe(true);
    expect(
      ContentAssetSchema.safeParse({
        ...validDraft(),
        scenes: ["画".repeat(CONTENT_SCENE_MAX_LENGTH + 1)],
      }).success,
    ).toBe(false);
    expect(
      ContentAssetSchema.safeParse({
        ...validDraft(),
        visualSuggestions: ["画".repeat(61)],
      }).success,
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 归一化                                                              */
/* ------------------------------------------------------------------ */

describe("normalizeContentTag", () => {
  it("统一补上一个 # 前缀", () => {
    expect(normalizeContentTag("连江鲍鱼")).toBe("#连江鲍鱼");
    expect(normalizeContentTag("#连江鲍鱼")).toBe("#连江鲍鱼");
    expect(normalizeContentTag("##连江鲍鱼")).toBe("#连江鲍鱼");
  });

  it("去掉标签内部的空白（平台话题标签不允许空格）", () => {
    expect(normalizeContentTag("#家庭 海鲜")).toBe("#家庭海鲜");
    expect(normalizeContentTag("  连江 鲍鱼  ")).toBe("#连江鲍鱼");
  });

  it("空标签返回空串，交由调用方剔除", () => {
    expect(normalizeContentTag("   ")).toBe("");
    expect(normalizeContentTag("#")).toBe("");
  });
});

describe("normalizeContentDraft", () => {
  it("标签去重并统一成 # 形式（模型三种写法其实是同一条）", () => {
    const parsed = ContentAssetSchema.parse(validDraft());
    const normalized = normalizeContentDraft({
      ...parsed,
      tags: ["连江鲍鱼", "#连江鲍鱼", "##连江鲍鱼", "#家庭海鲜"],
    });

    expect(normalized.tags).toEqual(["#连江鲍鱼", "#家庭海鲜"]);
  });

  it("列表项去重，场景与视觉建议分别按自己的上限裁剪", () => {
    const parsed = ContentAssetSchema.parse(validDraft());
    const normalized = normalizeContentDraft({
      ...parsed,
      scenes: ["0-2s 渔港晨景", "0-2s 渔港晨景", "x".repeat(180)],
      visualSuggestions: ["y".repeat(80)],
    });

    expect(normalized.scenes).toHaveLength(2);
    expect(normalized.scenes[1]).toHaveLength(CONTENT_SCENE_MAX_LENGTH);
    expect(normalized.visualSuggestions[0]).toHaveLength(60);
  });

  it("文本字段两侧空白被裁掉", () => {
    const parsed = ContentAssetSchema.parse(validDraft());
    const normalized = normalizeContentDraft({
      ...parsed,
      title: "  带空白的标题  ",
      hook: "\n 钩子 \n",
    });

    expect(normalized.title).toBe("带空白的标题");
    expect(normalized.hook).toBe("钩子");
  });
});

/* ------------------------------------------------------------------ */
/* 事实对齐                                                            */
/* ------------------------------------------------------------------ */

describe("alignContentDraftToRequest", () => {
  const draft = ContentAssetSchema.parse(validDraft()) satisfies ContentAssetDraft;

  it("平台与形态一致时不产生任何提示", () => {
    const result = alignContentDraftToRequest(draft, {
      platform: "douyin",
      format: "short-video",
    });
    expect(result.notes).toEqual([]);
    expect(result.draft.platform).toBe("douyin");
  });

  it("模型复述错误时以请求为准，但不静默丢弃这个信号", () => {
    const result = alignContentDraftToRequest(draft, {
      platform: "xiaohongshu",
      format: "article",
    });

    expect(result.draft.platform).toBe("xiaohongshu");
    expect(result.draft.type).toBe("article");
    expect(result.notes).toHaveLength(2);
    expect(result.notes[0]).toContain("平台");
    expect(result.notes[1]).toContain("内容形态");
  });
});

/* ------------------------------------------------------------------ */
/* 映射                                                                */
/* ------------------------------------------------------------------ */

describe("toNewContentInput", () => {
  it("四处改名完整且不串位（type→format / scenes→shotList / tags→hashtags / callToAction→cta）", () => {
    const draft = ContentAssetSchema.parse(validDraft());
    const input = toNewContentInput(draft, {
      productId: "prod_001",
      productName: "连江鲜活鲍鱼",
    });

    expect(input.format).toBe(draft.type);
    expect(input.shotList).toEqual(draft.scenes);
    expect(input.hashtags).toEqual(draft.tags);
    expect(input.cta).toBe(draft.callToAction);
    // 未改名的字段
    expect(input.platform).toBe(draft.platform);
    expect(input.title).toBe(draft.title);
    expect(input.hook).toBe(draft.hook);
    expect(input.body).toBe(draft.body);
    expect(input.visualSuggestions).toEqual(draft.visualSuggestions);
    expect(input.voiceover).toBe(draft.voiceover);
    expect(input.riskNotes).toEqual(draft.riskNotes);
    expect(input.confidence).toBe(draft.confidence);
  });

  it("AI 产出默认是草稿（必须由商家确认后才能排期发布）", () => {
    const draft = ContentAssetSchema.parse(validDraft());
    const input = toNewContentInput(draft, {
      productId: "prod_001",
      productName: "连江鲜活鲍鱼",
    });
    expect(input.status).toBe("draft");
    expect(input.aiVersion).toBe(CONTENT_AI_VERSION);
  });

  it("商品名是快照：内容脱离商品也能独立展示", () => {
    const draft = ContentAssetSchema.parse(validDraft());
    const input = toNewContentInput(draft, {
      productId: "prod_001",
      productName: "写进内容时的商品名",
    });
    expect(input.productName).toBe("写进内容时的商品名");
  });

  it("列表字段是拷贝，改动入参不会反过来改到已保存的记录", () => {
    const draft = ContentAssetSchema.parse(validDraft());
    const input = toNewContentInput(draft, {
      productId: "prod_001",
      productName: "连江鲜活鲍鱼",
    });

    input.hashtags.push("#被追加的");
    expect(draft.tags).not.toContain("#被追加的");
  });

  it("businessId 可选：不传时不会在入参里留一个 undefined 键", () => {
    const draft = ContentAssetSchema.parse(validDraft());
    const withoutBusiness = toNewContentInput(draft, {
      productId: "prod_001",
      productName: "连江鲜活鲍鱼",
    });
    expect("businessId" in withoutBusiness).toBe(false);

    const withBusiness = toNewContentInput(draft, {
      productId: "prod_001",
      productName: "连江鲜活鲍鱼",
      businessId: "biz_001",
    });
    expect(withBusiness.businessId).toBe("biz_001");
  });
});
