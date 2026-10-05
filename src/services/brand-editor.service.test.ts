import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetServerEnvCache } from "@/lib/env";
import { buildBrandAgentPrompt, parseBrandContextBlock } from "@/ai/prompts/brand-agent";
import { getRepositories } from "@/repositories";
import { clearStoredBrandProfile } from "@/repositories/mock/store";
import type { BusinessProfile, OwnerTwin } from "@/types";

import {
  approveBrandDraft,
  saveBrandDraft,
  saveBusinessSettings,
  saveOwnerSettings,
} from "./brand-editor.service";

const previousSource = process.env.DATA_SOURCE;
process.env.DATA_SOURCE = "mock";
resetServerEnvCache();
const repositories = getRepositories();
let originalBusiness: BusinessProfile;
let originalOwner: OwnerTwin;

const manualDraft = {
  factsConfirmed: true,
  positioning: "为家庭提供可核实来源的海产选择",
  brandStory: "我们根据实际商品资料介绍产地、储存和做法，不编造经营经历。",
  slogan: "把海味说明白",
  ipConcept: "认真讲商品的人",
  targetAudience: ["年轻家庭"],
  brandValues: ["真实"],
  brandPersonality: ["务实"],
  toneOfVoice: ["亲切"],
  visualKeywords: ["干净"],
};

beforeAll(async () => {
  originalBusiness = structuredClone((await repositories.business.getProfile())!);
  originalOwner = structuredClone((await repositories.business.getOwnerTwin())!);
});

beforeEach(() => clearStoredBrandProfile());

afterEach(async () => {
  await repositories.business.updateProfile({
    name: originalBusiness.name,
    shortName: originalBusiness.shortName,
    description: originalBusiness.description ?? "",
    owner: originalBusiness.owner,
    location: originalBusiness.location,
    mainCategory: originalBusiness.mainCategory,
    channels: originalBusiness.channels,
  });
  await repositories.business.updateOwnerTwin(originalOwner);
  clearStoredBrandProfile();
});

afterAll(() => {
  if (previousSource === undefined) delete process.env.DATA_SOURCE;
  else process.env.DATA_SOURCE = previousSource;
  resetServerEnvCache();
});

describe("品牌资料人工维护", () => {
  it("商家自述和不同经营者偏好进入品牌生成上下文", () => {
    const prompt = buildBrandAgentPrompt({ context: {
      business: { name: "另一家海产店", description: "由林姐经营，只卖自家核实过的商品。" },
      ownerTwin: { displayName: "林姐", avatarLabel: "林", businessPhilosophy: ["如实介绍"], tone: ["朴素"], salesStyle: "不催单", targetCustomers: ["家庭采购"], forbiddenExpressions: ["全网最低"] },
      products: [],
    } });
    expect(prompt).toContain("由林姐经营");
    expect(parseBrandContextBlock(prompt)?.business.description).toContain("由林姐经营");
    expect(parseBrandContextBlock(prompt)?.ownerTwin?.displayName).toBe("林姐");
  });

  it("无需 AI 就能建立、修改和确认品牌档案", async () => {
    const saved = await saveBrandDraft(manualDraft);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.data.aiVersion).toBe("manual-v1");
    expect(saved.data.approved).toBe(false);

    const approved = await approveBrandDraft();
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.data.approved).toBe(true);

    const edited = await saveBrandDraft({ ...manualDraft, brandStory: "由商家重新核实并修改的故事。" });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.data.brandStory).toContain("重新核实");
    expect(edited.data.approved).toBe(false);
  });

  it("商家与经营者资料可自定义，修改依据后旧品牌需要重新确认", async () => {
    await saveBrandDraft(manualDraft);
    await approveBrandDraft();

    const business = await saveBusinessSettings({
      name: "另一家真实海产店",
      shortName: "海边小店",
      description: "夫妻共同经营，每天介绍实际到货商品。",
      owner: "林姐",
      location: "福建宁德",
      mainCategory: "海产干货",
      channels: ["微信社群"],
    });
    expect(business.ok).toBe(true);
    if (!business.ok) return;
    expect(business.data.description).toContain("夫妻共同经营");
    expect((await repositories.brand.getProfile())?.approved).toBe(false);

    await approveBrandDraft();
    const owner = await saveOwnerSettings({
      displayName: "林姐",
      businessPhilosophy: ["如实介绍"],
      tone: ["朴素"],
      salesStyle: "不催单",
      targetCustomers: ["家庭采购"],
      forbiddenExpressions: ["全网最低"],
    });
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    expect(owner.data.displayName).toBe("林姐");
    expect((await repositories.brand.getProfile())?.approved).toBe(false);
  });

  it("占位档案不能直接确认；输入无效时不修改现存资料", async () => {
    await saveBrandDraft(manualDraft);
    await repositories.brand.update({ riskNotes: ["【Mock】占位数据"] });
    const blocked = await approveBrandDraft();
    expect(blocked.ok).toBe(false);

    const unchecked = await saveBrandDraft({ ...manualDraft, factsConfirmed: false });
    expect(unchecked.ok).toBe(false);
    expect((await repositories.brand.getProfile())?.riskNotes).toContain("【Mock】占位数据");

    const invalid = await saveBusinessSettings({ name: "", shortName: "", description: "", owner: "", location: "", mainCategory: "", channels: [] });
    expect(invalid.ok).toBe(false);
    expect((await repositories.business.getProfile())?.name).toBe(originalBusiness.name);
  });
});
