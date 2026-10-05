import { beforeEach, describe, expect, it } from "vitest";

import { resetServerEnvCache } from "@/lib/env";
import { getRepositories } from "@/repositories";
import { resetStoredContents } from "@/repositories/mock/store";
import type { ContentSlot } from "@/types";

import { confirmContentStatus, saveContentBody, saveContentDraft } from "./content-editor.service";

process.env.DATA_SOURCE = "mock";
resetServerEnvCache();

const repository = getRepositories().content;
const slot: ContentSlot = {
  productId: "prod_005",
  platform: "ads",
  format: "voiceover",
};

beforeEach(async () => {
  resetStoredContents();
  await repository.create({
    ...slot,
    productName: "连江手工鱼丸",
    status: "draft",
    title: "鱼丸短视频旁白",
    hook: "下班十分钟做碗鱼丸汤",
    body: "冷冻鱼丸下锅煮至浮起。",
    cta: "查看商品详情",
    hashtags: [],
    visualSuggestions: [],
    shotList: [],
    voiceover: "鱼丸汤",
    riskNotes: [],
    aiVersion: "test",
    confidence: 1,
  });
});

describe("内容人工确认", () => {
  it("保存修改后回到草稿，且必须先确认才能标记发布", async () => {
    const directPublish = await confirmContentStatus(slot, "published");
    expect(directPublish.ok).toBe(false);

    const saved = await saveContentBody(slot, "  全程冷冻保存 90 天。  ");
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.data.body).toBe("全程冷冻保存 90 天。");
    expect(saved.data.status).toBe("draft");
    expect(saved.data.riskNotes?.join()).toContain("原有风险提示未重新扫描");

    const approved = await confirmContentStatus(slot, "approved");
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.data.status).toBe("approved");

    const published = await confirmContentStatus(slot, "published");
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.data.status).toBe("published");

    const editedAfterPublish = await saveContentBody(slot, "修改已发布内容");
    expect(editedAfterPublish.ok).toBe(false);
  });

  it("拒绝空正文与演示占位内容的审核", async () => {
    const empty = await saveContentBody(slot, " ");
    expect(empty.ok).toBe(false);

    await repository.updateBySlot(slot, { riskNotes: ["【Mock】演示占位文案"] });
    const approved = await confirmContentStatus(slot, "approved");
    expect(approved.ok).toBe(false);
    if (!approved.ok) expect(approved.error.message).toContain("占位内容");
  });

  it("标题、开头、行动引导可一并修改，修改已确认内容会重新变成草稿", async () => {
    const approved = await confirmContentStatus(slot, "approved");
    expect(approved.ok).toBe(true);

    const saved = await saveContentDraft(slot, {
      title: "鱼丸汤教程",
      hook: "冷冻鱼丸如何煮？",
      body: "沸水下锅，浮起后再煮两分钟。",
      cta: "查看鱼丸详情",
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.data.status).toBe("draft");
    expect(saved.data.title).toBe("鱼丸汤教程");
    expect(saved.data.hook).toBe("冷冻鱼丸如何煮？");
    expect(saved.data.cta).toBe("查看鱼丸详情");
  });
});
