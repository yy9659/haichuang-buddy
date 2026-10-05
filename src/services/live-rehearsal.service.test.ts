import { beforeEach, describe, expect, it } from "vitest";

import { resetServerEnvCache } from "@/lib/env";
import { getRepositories } from "@/repositories";
import { resetStoredLive } from "@/repositories/mock/store";
import { AI_REHEARSAL_AUTHOR, MAX_REHEARSAL_QUESTIONS } from "@/types";

import { endLiveSession } from "./live-agent.service";
import { generateRehearsalQuestion, saveHostTranscript, scoreLiveRehearsal } from "./live-rehearsal.service";

process.env.DATA_SOURCE = "mock";
process.env.AI_PROVIDER = "mock";
resetServerEnvCache();

const repositories = getRepositories();

async function sessionId(): Promise<string> {
  const session = await repositories.live.getSession();
  if (!session) throw new Error("预期有演示彩排场次");
  return session.id;
}

beforeEach(() => resetStoredLive());

describe("直播彩排辅助能力", () => {
  it("AI 出题只有主动调用才写入，并标明模拟观众", async () => {
    const id = await sessionId();
    const before = (await repositories.live.listComments(id)).filter((item) => item.authorName === AI_REHEARSAL_AUTHOR);
    expect(before).toHaveLength(0);

    const result = await generateRehearsalQuestion(id);
    expect(result.ok).toBe(true);
    const after = (await repositories.live.listComments(id)).filter((item) => item.authorName === AI_REHEARSAL_AUTHOR);
    expect(after).toHaveLength(1);
    expect(after[0]?.content).toContain("？");
  });

  it("每场最多五个 AI 模拟问题，结束后不能继续出题", async () => {
    const id = await sessionId();
    for (let index = 0; index < MAX_REHEARSAL_QUESTIONS; index += 1) {
      await repositories.live.appendComment({ sessionId: id, authorName: AI_REHEARSAL_AUTHOR, content: `问题 ${index + 1}？` });
    }
    const capped = await generateRehearsalQuestion(id);
    expect(capped.ok).toBe(false);
    await endLiveSession(id);
    const ended = await generateRehearsalQuestion(id);
    expect(ended.ok).toBe(false);
  });

  it("仅结束且有口播与问题时可评分；修改文字会撤销旧评分", async () => {
    const id = await sessionId();
    await repositories.live.appendComment({ sessionId: id, authorName: "模拟观众", content: "这款商品怎么保存？" });
    expect((await scoreLiveRehearsal(id)).ok).toBe(false);
    await endLiveSession(id);
    expect((await scoreLiveRehearsal(id)).ok).toBe(false);

    const saved = await saveHostTranscript(id, "这款商品请按照包装说明保存，具体以标签为准。");
    expect(saved.ok).toBe(true);
    const scored = await scoreLiveRehearsal(id);
    expect(scored.ok).toBe(true);
    if (!scored.ok) return;
    expect(scored.data.basis).toBe("text_only");
    expect(scored.data.isMock).toBe(true);
    expect((await repositories.live.getSession())?.rehearsalReport?.score).toBe(scored.data.score);

    const revised = await saveHostTranscript(id, "我会先核对商品包装信息，再回答储存与保质期问题。");
    expect(revised.ok).toBe(true);
    expect((await repositories.live.getSession())?.rehearsalReport).toBeNull();
  });
});
